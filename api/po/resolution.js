// POST /api/po/resolution  (warehouse / ph_team / admin)
//   { poId, step, undo?, outcome?, value?, amount?, carrierKey? }
// Ticks, unticks or fills in one step of a discrepancy's resolution:
//   contacted → outcome (refund | replacement | writeoff) → reference → settled
// Nothing is write-once: a refund that never lands has to be re-openable, so every step
// accepts `undo`. Each write posts a system line to the internal thread, which is what
// makes that thread the audit trail — there's no separate history table to keep in step.
//
// The replacement branch does real work: logging tracking creates a proper po_boxes row
// on the ORIGINAL order (registered with the tracking aggregator) and reopens the PO for
// receiving, because receiving against a reconciled/archived order is otherwise blocked.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  getPo, getPoResolution, setResolutionStep, addPoComment, addReplacementBox,
  reopenPoForReceiving, resolutionView, RESOLUTION_STEPS, RESOLUTION_OUTCOMES,
  stepsFor, dbConfigured,
} from '../_lib/db.js';
import { registerTracking } from '../_lib/tracking.js';

const money = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return NaN;
  return Math.round(n * 100) / 100;
};

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 90 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const step = String(body.step || '');
  const undo = body.undo === true;
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });
  if (!RESOLUTION_STEPS.includes(step))
    return send(res, 400, { ok: false, error: `Unknown step "${step}".` });

  const author = { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role };
  const who = author.name;

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    const before = await getPoResolution(poId);

    let outcome = null;
    let value = null;
    let amount = null;
    let boxId = null;
    let systemLine = '';
    let reopened = null;

    if (step === 'contacted') {
      systemLine = undo ? `${who} un-ticked “Supplier contacted”` : `${who} contacted the supplier`;

    } else if (step === 'outcome') {
      if (!undo) {
        outcome = String(body.outcome || '');
        if (!RESOLUTION_OUTCOMES.includes(outcome))
          return send(res, 400, { ok: false, error: 'Pick refund, replacement, or write off.' });
      }
      systemLine = undo
        ? `${who} cleared the agreed outcome`
        : `${who} set the outcome to ${outcome === 'writeoff' ? 'write off' : outcome}`;

    } else if (step === 'reference') {
      const current = before?.outcome;
      if (!undo && !current)
        return send(res, 409, { ok: false, error: 'Agree an outcome first.' });
      if (!undo && current === 'writeoff')
        return send(res, 409, { ok: false, error: 'A write-off has nothing to reference.' });

      if (!undo) {
        value = String(body.value ?? '').trim().slice(0, 120);
        if (!value) {
          return send(res, 400, {
            ok: false,
            error: current === 'refund' ? 'Enter the credit reference.' : 'Enter the tracking number.',
          });
        }
        if (current === 'refund') {
          amount = money(body.amount);
          if (Number.isNaN(amount)) return send(res, 400, { ok: false, error: 'Enter a valid refund amount.' });
          if (amount == null) return send(res, 400, { ok: false, error: 'Enter the amount the supplier agreed to refund.' });
          systemLine = `${who} logged credit ${value} for ${amount.toFixed(2)}`;
        } else {
          // Replacement: a real, tracked label on this same order.
          const box = await addReplacementBox(poId, {
            trackingNumber: value,
            carrierKey: Number(body.carrierKey),
            createdBy: who,
          });
          boxId = Number(box.id);
          registerTracking([{ number: value, carrier: box.carrier_key }])
            .catch((e) => console.warn('[po/resolution] registerTracking:', e.message));
          reopened = await reopenPoForReceiving(poId);
          systemLine = `${who} logged replacement tracking ${value}`
            + (reopened ? ` — ${po.po_code} reopened for receiving` : '');
        }
      } else {
        systemLine = `${who} cleared the reference`;
      }

    } else if (step === 'settled') {
      const current = before?.outcome;
      if (!undo && !current) return send(res, 409, { ok: false, error: 'Agree an outcome first.' });
      if (!undo && current === 'refund') {
        amount = money(body.amount);
        if (Number.isNaN(amount)) return send(res, 400, { ok: false, error: 'Enter a valid amount.' });
        if (amount == null) return send(res, 400, { ok: false, error: 'Enter the amount that actually arrived.' });
        const agreed = before?.ref_amount == null ? null : Number(before.ref_amount);
        const short = agreed != null && agreed - amount > 0.004;
        systemLine = `${who} recorded ${amount.toFixed(2)} received`
          + (short ? ` — ${(agreed - amount).toFixed(2)} short of the ${agreed.toFixed(2)} agreed` : '');
      } else if (!undo) {
        systemLine = current === 'writeoff'
          ? `${who} wrote this off`
          : `${who} confirmed the replacement arrived`;
      } else {
        systemLine = `${who} re-opened the resolution`;
      }
    }

    const resolution = await setResolutionStep({ poId, step, undo, outcome, value, amount, boxId, author });
    await addPoComment({ poId, body: systemLine, kind: 'system', author }).catch((e) =>
      console.warn('[po/resolution] system comment:', e.message));

    return send(res, 200, {
      ok: true,
      resolution: resolutionView(resolution),
      steps: stepsFor(resolution?.outcome),
      reopened: reopened ? reopened.status : null,
    });
  } catch (e) {
    console.error('[po/resolution]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the resolution.' });
  }
}
