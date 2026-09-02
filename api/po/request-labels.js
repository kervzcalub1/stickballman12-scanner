// POST /api/po/request-labels  (supplier / ph_team / admin)  { poId, requested? }
//
// "I've packed these boxes — send me labels." The handoff in the manifest-first flow: the
// supplier declares the boxes and what's in them, then asks, and PH buys the labels
// against a manifest they can already see. Sets `labels_requested_at`, which is what the
// PH queue and the Home badge are keyed on.
//
// Cleared by `po/assign-labels` when the numbers land, and settable again afterwards —
// an order that grows another box has to be able to ask a second time rather than sitting
// there looking answered.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPoFull, setLabelsRequested, addPoComment, PO_FROZEN, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const requested = body.requested !== false;   // pass false to withdraw the request
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });

  try {
    const data = await getPoFull(poId);
    if (!data) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (user.role === 'supplier' && !isPrivileged(user.role)
        && Number(data.po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    if (PO_FROZEN.includes(data.po.status))
      return send(res, 409, { ok: false, error: `${data.po.po_code} is already ${data.po.status}.` });

    if (requested) {
      // Asking for labels against nothing is the one thing this must not allow — the
      // whole point of the new order is that we see the manifest before we pay.
      const own = (data.boxes || []).filter((b) => b.kind !== 'replacement');
      if (!own.length) return send(res, 400, { ok: false, error: 'Add the boxes you packed before asking for labels.' });
      const declared = (data.lines || []).reduce((n, l) => n + (Number(l.qty_expected) || 0), 0);
      if (!declared) return send(res, 400, { ok: false, error: 'Nothing is declared on this order yet — add what’s in the boxes first.' });
    }

    const who = user.name || user.username || '';
    const po = await setLabelsRequested(poId, requested ? who : null);
    await addPoComment({
      poId, kind: 'system',
      body: requested
        ? `Labels requested by ${who} — ${(data.boxes || []).filter((b) => b.kind !== 'replacement').length} box(es) declared.`
        : `Label request withdrawn by ${who}.`,
      author: { id: Number(user.uid) || null, name: who, role: user.role },
    }).catch((e) => console.warn('[po/request-labels] system comment:', e.message));
    return send(res, 200, { ok: true, po });
  } catch (e) {
    console.error('[po/request-labels]', e.message);
    return send(res, 500, { ok: false, error: 'Could not send that request.' });
  }
}
