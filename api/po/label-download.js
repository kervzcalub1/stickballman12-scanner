// GET /api/po/label-download?poId=[&poBoxId=]   (supplier — own order only — / warehouse / ph_team)
// The courier's label(s) for an order: the whole uploaded PDF, or ONE label's page.
//
// Proxied deliberately. These carry the ship-to address and a live courier barcode, so
// unlike listing photos the bucket must never serve them by URL: every download is a
// request we authorise first, and the R2 signature never leaves this process.
//
// A per-box download extracts that label's page from the stored original rather than us
// keeping N split files — one object per order, and a page mapping that can be corrected
// later without re-uploading anything.
import { send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPoLabelFile, dbConfigured } from '../_lib/db.js';
import { getObject, r2Configured } from '../_lib/r2.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured.' });

  const params = new URL(req.url, 'http://x').searchParams;
  const poId = Number(params.get('poId'));
  const poBoxId = params.get('poBoxId') ? Number(params.get('poBoxId')) : null;
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });
  if (poBoxId != null && !Number.isInteger(poBoxId)) return send(res, 400, { ok: false, error: 'Invalid poBoxId.' });

  try {
    const found = await getPoLabelFile(poId, poBoxId);
    if (!found) return send(res, 404, { ok: false, error: 'No labels file has been uploaded for this order.' });
    const { po, box } = found;
    // A supplier only ever reaches their OWN order's labels.
    if (user.role === 'supplier' && !isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid)) {
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    }
    if (box && !box.label_page) {
      return send(res, 404, {
        ok: false,
        error: 'This label has no page in the uploaded file — its tracking number did not match any page.',
      });
    }

    const pdf = await getObject(po.labels_key);
    let bytes = pdf;
    let filename = po.labels_name || `${po.po_code}-labels.pdf`;

    if (box) {
      // Copy the one page into a fresh document: the page keeps its vectors, so the
      // barcode prints exactly as the courier made it.
      const { PDFDocument } = await import('pdf-lib');
      const src = await PDFDocument.load(pdf);
      const count = src.getPageCount();
      const from = box.label_page - 1;
      // The label plus anything between it and the next label — the packing slip that
      // belongs in this box. Clamped to the file: a stale mapping must not 500.
      const to = Math.min(Math.max(Number(box.label_page_end) || box.label_page, box.label_page) - 1, count - 1);
      if (from < 0 || from >= count) {
        return send(res, 409, { ok: false, error: 'That label points at a page the file does not have — re-upload the labels PDF.' });
      }
      const out = await PDFDocument.create();
      const idxs = [];
      for (let i = from; i <= to; i++) idxs.push(i);
      for (const page of await out.copyPages(src, idxs)) out.addPage(page);
      bytes = Buffer.from(await out.save());
      filename = `${po.po_code}-label-${box.box_number}.pdf`;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    // Addresses and a usable barcode — never let a shared cache hold on to one.
    res.setHeader('Cache-Control', 'private, no-store');
    return res.end(bytes);
  } catch (e) {
    console.error('[po/label-download]', e.message);
    return send(res, 500, { ok: false, error: 'Could not fetch the label.' });
  }
}
