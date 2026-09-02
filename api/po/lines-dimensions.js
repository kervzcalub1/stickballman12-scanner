// POST /api/po/lines-dimensions  (supplier / ph_team / admin)
//   { lineIds: [id, …], dimensions: '13 x 9 x 5 in' | { l, w, h, unit } }
//
// Set ONE carton size across many manifest lines at once. An empty-box order is
// routinely a run of thirty SKUs that all ship in the same box — declaring that
// thirty times, on a phone, is how a wrong number gets in — so the dimensions are
// declared once for the selection and per line only where a SKU differs
// (`po/line` with `dimensions` does the individual edit).
//
// Every line goes through the same `updatePoLine` a single edit does, so the merge
// rule is identical: two lines that end up on the same SKU + SIZE + dimensions become one
// line with their quantities summed. Sizes are untouched, so applying one carton size
// across sizes 8, 9 and 10 leaves three lines — which is the point. Nothing is written until
// every line has passed its own edit gate — a partial apply across a manifest is worse
// than a refusal, because nobody can tell which half landed.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPoLine, getPoBox, getPo, updatePoLine, dbConfigured } from '../_lib/db.js';
import { manifestEditBlock, isBoxesOrder, normalizeDimensions } from '../_lib/po-manifest.js';

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
    .map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
  const dimensions = normalizeDimensions(body.dimensions);
  if (!lineIds.length) return send(res, 400, { ok: false, error: 'Pick at least one line to apply the dimensions to.' });
  if (!dimensions) return send(res, 400, { ok: false, error: 'Give the box’s length, width and height — e.g. 13 x 9 x 5 in.' });

  try {
    // Pass 1: read every line and check it, before writing anything.
    const lines = [];
    for (const id of lineIds) {
      const line = await getPoLine(id);
      if (!line) return send(res, 404, { ok: false, error: `One of those lines no longer exists (#${id}) — reload the order.` });
      lines.push(line);
    }
    const poIds = [...new Set(lines.map((l) => Number(l.po_id)))];
    if (poIds.length > 1) return send(res, 400, { ok: false, error: 'Those lines belong to different orders.' });
    const po = await getPo(poIds[0]);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (user.role === 'supplier' && !isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    if (!isBoxesOrder(po))
      return send(res, 400, { ok: false, error: 'This order is for shoes — its lines carry sizes, not box dimensions.' });

    const onBehalf = user.role !== 'supplier';
    const uidNum = Number(user.uid);
    const enteredBy = onBehalf && Number.isInteger(uidNum) ? uidNum : null;
    // The gate is per LABEL, not per order: on a multi-label order the supplier may still
    // be filling box 3 while box 1 has already gone, and a bulk apply must not slip an
    // edit into the one that left.
    const boxCache = new Map();
    for (const line of lines) {
      const boxId = line.po_box_id == null ? null : Number(line.po_box_id);
      if (boxId != null && !boxCache.has(boxId)) boxCache.set(boxId, await getPoBox(boxId));
      const blocked = manifestEditBlock({ po, box: boxId == null ? null : boxCache.get(boxId), onBehalf });
      if (blocked) return send(res, blocked.code, { ok: false, error: blocked.error });
    }

    // Pass 2: apply. A line already carrying these dimensions is skipped rather than
    // rewritten, so a re-apply doesn't restamp the whole manifest with today's editor.
    let updated = 0; let merged = 0;
    for (const line of lines) {
      if (line.dimensions === dimensions) continue;
      const r = await updatePoLine(line.id, { dimensions, enteredBy, enteredOnBehalf: onBehalf });
      if (r.merged) merged += 1; else if (r.line) updated += 1;
    }
    return send(res, 200, { ok: true, dimensions, updated, merged, skipped: lines.length - updated - merged });
  } catch (e) {
    console.error('[po/lines-dimensions]', e.message);
    if (e.code === '23505') return send(res, 409, { ok: false, error: 'Those lines were just changed — reload the order and try again.' });
    return send(res, 500, { ok: false, error: 'Could not apply the dimensions.' });
  }
}
