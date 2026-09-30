// POST /api/online-orders/line
//   { lineId, action:'cancel', qty, reason:'oot'|'other', note?, refund:'refunded'|'needs_request', amount? }
//   { lineId, action:'refund', to:'requested'|'refunded'|'needs_request', amount?, note? }
//   { lineId, action:'restore' }
//   -> { ok }
// Cancel pairs off a line and TRACE the refund: came back with the cancellation, or needs
// following up (asked the store → waiting → refunded, with the amount). Every step lands
// in the order's history. PH (admin auto-allowed).
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured, getOnlineOrder, getOnlineOrderLine, cancelOnlineLine, setOnlineRefund, restoreOnlineLine } from '../_lib/db.js';
import { actorOf, idOf, MAX_MONEY } from './_shared.js';
import { REASON_LABEL } from '../../src/lib/onlineOrders.js';

const amountOf = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_MONEY ? Math.round(n * 100) / 100 : NaN;
};
const $ = (v) => `$${Number(v).toFixed(2)}`;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const lineId = idOf(b.lineId);
  if (!lineId) return send(res, 400, { ok: false, error: 'Which line?' });
  const actor = actorOf(user);
  try {
    const line = await getOnlineOrderLine(lineId);
    if (!line) return send(res, 404, { ok: false, error: 'That line no longer exists — reload.' });
    const what = `${line.sku} US ${line.size}`;

    if (b.action === 'cancel') {
      if (line.cancelled_at) return send(res, 409, { ok: false, error: 'That line is already cancelled.' });
      const order = await getOnlineOrder(line.order_id);
      if (order?.received_at) return send(res, 409, { ok: false, error: 'The warehouse already counted this order in — these pairs arrived, so there is nothing to cancel.' });
      const qty = Number(b.qty ?? line.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > line.qty) return send(res, 400, { ok: false, error: `Cancel between 1 and ${line.qty} pair(s).` });
      const reason = ['oot', 'other'].includes(b.reason) ? b.reason : null;
      if (!reason) return send(res, 400, { ok: false, error: 'Why was it cancelled — out of stock, or other?' });
      const refund = ['refunded', 'needs_request'].includes(b.refund) ? b.refund : null;
      if (!refund) return send(res, 400, { ok: false, error: 'Was it refunded with the cancellation, or does the refund need following up?' });
      const amount = amountOf(b.amount);
      if (Number.isNaN(amount)) return send(res, 400, { ok: false, error: 'The refund amount has to be a number, 0 or more.' });
      const note = String(b.note || '').trim().slice(0, 500) || null;
      const detail = `${qty} × ${what} — ${REASON_LABEL[reason]}${note ? ` (${note})` : ''} · ${refund === 'refunded' ? `refunded${amount != null ? ` ${$(amount)}` : ''}` : 'refund needs follow-up'}`;
      const ok = await cancelOnlineLine(line, { qty, reason, note, refund, amount }, actor, detail);
      if (!ok) return send(res, 409, { ok: false, error: 'That line changed while you were cancelling it — reload and try again.' });
      return send(res, 200, { ok: true });
    }

    if (b.action === 'refund') {
      if (!line.cancelled_at) return send(res, 409, { ok: false, error: 'Only a cancelled line has a refund to track.' });
      const to = ['requested', 'refunded', 'needs_request'].includes(b.to) ? b.to : null;
      if (!to) return send(res, 400, { ok: false, error: 'Refund to what state?' });
      const amount = amountOf(b.amount);
      if (Number.isNaN(amount)) return send(res, 400, { ok: false, error: 'The refund amount has to be a number.' });
      if (to === 'refunded' && !(amount > 0)) return send(res, 400, { ok: false, error: 'How much came back? The amount is what the audit checks.' });
      // Only the moves that mean something (the WHERE in setOnlineRefund enforces the same).
      const from = line.refund;
      const allowed = { requested: ['needs_request'], refunded: ['needs_request', 'requested'], needs_request: ['requested', 'refunded'] }[to];
      if (!allowed.includes(from)) {
        return send(res, 409, { ok: false, error: from === 'refunded' ? 'That refund is already marked received — use “Not actually back” first if it wasn’t.' : 'That refund isn’t at a step where this applies — reload to see where it stands.' });
      }
      const note = String(b.note || '').trim().slice(0, 500) || null;
      const detail = to === 'requested' ? `refund requested for ${line.qty} × ${what}${note ? ` (${note})` : ''}`
        : to === 'refunded' ? `refund received for ${line.qty} × ${what}: ${$(amount)}${note ? ` (${note})` : ''}`
          : `refund for ${line.qty} × ${what} back to needs follow-up`;
      const ok = await setOnlineRefund(line, { to, amount, note }, actor, detail);
      if (!ok) return send(res, 409, { ok: false, error: 'That line changed — reload and try again.' });
      return send(res, 200, { ok: true });
    }

    if (b.action === 'restore') {
      if (!line.cancelled_at) return send(res, 409, { ok: false, error: 'That line isn’t cancelled.' });
      if (line.cancel_reason === 'not_delivered') return send(res, 409, { ok: false, error: 'The warehouse counted these as not delivered — that is its count, not a cancellation to undo.' });
      const order = await getOnlineOrder(line.order_id);
      if (order?.received_at) return send(res, 409, { ok: false, error: 'The warehouse already counted this order in — a pair brought back now would be one nobody counted. Record it as a new order if it turns up.' });
      const ok = await restoreOnlineLine(line, actor, `cancellation of ${line.qty} × ${what} undone — coming after all`);
      if (!ok) return send(res, 409, { ok: false, error: 'That line changed — reload and try again.' });
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    if (e.status === 409) return send(res, 409, { ok: false, error: e.message });
    console.error('[online-orders/line]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update that line.' });
  }
}
