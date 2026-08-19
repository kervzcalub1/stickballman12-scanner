// POST /api/po/manifest-import  (ph_team / admin)
//   { poId, boxes: [{ poBoxId, lines: [{ sku, size, qty, name? }] }] }
//   -> { ok, applied: [{ poBoxId, lines, units }], skipped: [{ poBoxId, reason }] }
//
// Bulk "add items on their behalf": the whole of a supplier's manifest PDF, parsed in
// the browser (src/lib/manifestPdf.js) and written in ONE request. Same effect as PH
// typing each line into the per-box scan modal — every line lands through `addPoScan`
// and is stamped entered_by + entered_on_behalf, so a supplier reading their own order
// still sees "entered by their staff", not a manifest they never sent.
//
// Why one endpoint instead of looping /api/po/scan from the client: a real manifest is
// ~18 boxes and 200+ lines, and po/scan is rate-limited to 120/min — the loop would
// 429 halfway and leave the order half-declared, which is worse than not importing at
// all. One call also means one permission check and one consistent answer.
//
// ONLY fills labels that have NOTHING declared. A label the supplier already scanned
// (or PH already entered) is left exactly as it is and reported as skipped: this
// imports what's missing, it never overwrites or doubles a manifest that already
// exists. That guard lives here, not only in the UI, so a stale preview can't apply
// twice.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPo, getPoBox, addPoScan, poBoxLineCounts, dbConfigured } from '../_lib/db.js';
import { manifestEditBlock, isReplacementBox } from '../_lib/po-manifest.js';

const MAX_BOXES = 200;
const MAX_LINES = 2000;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Staff only — this is the on-behalf path. A supplier declaring their own box uses
  // po/scan (their portal), where the lines are not stamped as entered-on-behalf.
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId) || 0;
  if (!poId) return send(res, 400, { ok: false, error: 'Missing purchase order.' });

  const boxes = (Array.isArray(body.boxes) ? body.boxes : []).slice(0, MAX_BOXES);
  if (!boxes.length) return send(res, 400, { ok: false, error: 'Nothing to import.' });

  // Sanitize before touching the database — never trust a parsed PDF.
  let totalLines = 0;
  const clean = [];
  for (const b of boxes) {
    const poBoxId = Number(b?.poBoxId) || 0;
    if (!poBoxId) continue;
    const lines = (Array.isArray(b?.lines) ? b.lines : []).map((l) => ({
      sku: String(l?.sku ?? '').trim().slice(0, 60),
      size: String(l?.size ?? '').trim().slice(0, 20),
      qty: Math.min(999, Math.max(1, parseInt(l?.qty, 10) || 0)),
      name: String(l?.name ?? '').trim().slice(0, 200) || null,
    })).filter((l) => l.sku && l.size && l.qty > 0);
    if (!lines.length) continue;
    totalLines += lines.length;
    clean.push({ poBoxId, lines });
  }
  if (!clean.length) return send(res, 400, { ok: false, error: 'No usable lines in that manifest.' });
  if (totalLines > MAX_LINES) return send(res, 400, { ok: false, error: 'That manifest is too large to import in one go.' });

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    // A PO is one manifest scope or the other. Importing per-label lines onto an order
    // declared as a single whole-order list would double-count it at reconciliation.
    if (po.manifest_scope === 'po')
      return send(res, 409, { ok: false, error: 'This PO uses a whole-order manifest — import per-label lines only on an order that declares them per label.' });

    const counts = await poBoxLineCounts(poId);
    const uidNum = Number(user.uid);
    const enteredBy = Number.isInteger(uidNum) ? uidNum : null;   // env admin has a non-numeric uid

    const applied = [];
    const skipped = [];
    for (const b of clean) {
      const box = await getPoBox(b.poBoxId);
      if (!box) { skipped.push({ poBoxId: b.poBoxId, reason: 'Label not found.' }); continue; }
      if (Number(box.po_id) !== poId) { skipped.push({ poBoxId: b.poBoxId, reason: 'That label belongs to another order.' }); continue; }
      if ((counts.get(Number(b.poBoxId)) || 0) > 0) {
        skipped.push({ poBoxId: b.poBoxId, reason: 'Already has a manifest — left untouched.' });
        continue;
      }
      const blocked = manifestEditBlock({ po, box, onBehalf: true });
      if (blocked) { skipped.push({ poBoxId: b.poBoxId, reason: blocked.error }); continue; }
      if (po.manifest_scope === 'po' && !isReplacementBox(box)) {
        skipped.push({ poBoxId: b.poBoxId, reason: 'Whole-order manifest — not a per-label order.' });
        continue;
      }

      let units = 0;
      for (const l of b.lines) {
        await addPoScan({
          poId, poBoxId: b.poBoxId, sku: l.sku, size: l.size, qty: l.qty, name: l.name,
          enteredBy, enteredOnBehalf: true,
        });
        units += l.qty;
      }
      applied.push({ poBoxId: b.poBoxId, boxNumber: box.box_number, lines: b.lines.length, units });
    }

    return send(res, 200, { ok: true, applied, skipped });
  } catch (e) {
    console.error('[po/manifest-import]', e.message);
    return send(res, 500, { ok: false, error: 'Could not import that manifest.' });
  }
}
