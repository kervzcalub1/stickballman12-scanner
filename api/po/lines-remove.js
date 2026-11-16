// POST /api/po/lines-remove  (supplier / ph_team / admin)   { lineIds: [id, …] }
//   -> { ok, removed, units }
//
// Remove MANY manifest lines at once. A supplier who typed a whole list and then has to
// split the order (some pairs go on another order, under another name tag) was pressing ✕
// once per line (asked 2026-11-17). This is the same removal `po/line { qty: 0 }` does, for
// a selection.
//
// Every line passes the SAME gate a single removal does (`poLineEditBlock`: the supplier's
// own order, never the receipt list of a buying-request order, the label's edit window, a
// store list's confirmed / audited state) and NOTHING is removed until all of them have —
// a partial removal across a manifest is worse than a refusal, because nobody can tell
// which half went. All the lines must belong to one order.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPoLine, getPoBox, getPo, updatePoLine, addPoComment, dbConfigured } from '../_lib/db.js';
import { poLineEditBlock } from '../_lib/po-manifest.js';

const MAX = 500;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const lineIds = [...new Set((Array.isArray(body.lineIds) ? body.lineIds : [])
    .map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!lineIds.length) return send(res, 400, { ok: false, error: 'Tick at least one item to remove.' });
  if (lineIds.length > MAX) return send(res, 400, { ok: false, error: `At most ${MAX} items at a time.` });

  try {
    // Pass 1: read and check every line before removing anything.
    const lines = [];
    for (const id of lineIds) {
      const line = await getPoLine(id);
      if (!line) return send(res, 404, { ok: false, error: 'One of those items is no longer on the manifest — reload the order.' });
      lines.push(line);
    }
    const poIds = [...new Set(lines.map((l) => Number(l.po_id)))];
    if (poIds.length > 1) return send(res, 400, { ok: false, error: 'Those items belong to different orders.' });
    const po = await getPo(poIds[0]);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    // The gate is per LABEL: on a multi-label order one box may have gone while another is
    // still being filled, and a bulk removal must not reach into the one that left.
    const boxCache = new Map();
    for (const line of lines) {
      const boxId = line.po_box_id == null ? null : Number(line.po_box_id);
      if (boxId != null && !boxCache.has(boxId)) boxCache.set(boxId, await getPoBox(boxId));
      const blocked = poLineEditBlock({ user, po, box: boxId == null ? null : boxCache.get(boxId) });
      if (blocked) return send(res, blocked.code, { ok: false, error: blocked.error });
    }

    // Pass 2: remove. A line someone else removed meanwhile just isn't counted.
    let removed = 0; let units = 0;
    const gone = [];
    for (const line of lines) {
      const r = await updatePoLine(line.id, { qty: 0 });
      if (!r.removed) continue;
      removed += 1; units += Number(line.qty_expected) || 0;
      gone.push(line);
    }
    // A confirmed store list is the invoice the audit is settled against: like a single
    // correction (`po/line`), a removal after confirmation goes on the order's history.
    const storeGone = gone.filter((l) => l.po_box_id == null && po.by_store);
    if (storeGone.length && po.list_confirmed_at) {
      const who = user.name || user.username || '';
      const uidNum = Number(user.uid);
      const what = storeGone.slice(0, 12).map((l) => `${l.sku} ${l.size} ×${l.qty_expected}`).join(', ');
      await addPoComment({
        poId: po.id, kind: 'system',
        body: `${who} removed ${storeGone.length} line${storeGone.length === 1 ? '' : 's'} from a confirmed store list: ${what}${storeGone.length > 12 ? `, and ${storeGone.length - 12} more` : ''}.`,
        author: { id: Number.isInteger(uidNum) ? uidNum : null, name: who, role: user.role },
      }).catch((e) => console.warn('[po/lines-remove] system comment:', e.message));
    }
    return send(res, 200, { ok: true, removed, units });
  } catch (e) {
    console.error('[po/lines-remove]', e.message);
    return send(res, 500, { ok: false, error: 'Could not remove those items.' });
  }
}
