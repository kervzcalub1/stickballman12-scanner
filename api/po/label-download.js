// GET /api/po/label-download?poId=[&poBoxId=|&fileId=]   (supplier — own order only — / warehouse / ph_team)
// The courier's label(s) for an order: every label on it (one PDF — the uploaded file as-is
// when there's one, every file merged oldest-first when labels came in parts), ONE uploaded
// file (fileId), or ONE label's pages (poBoxId) out of whichever file it lives in.
//
// Proxied deliberately. These carry the ship-to address and a live courier barcode, so
// unlike listing photos the bucket must never serve them by URL: every download is a
// request we authorise first, and the R2 signature never leaves this process.
//
// A per-box download extracts that label's page from the stored original rather than us
// keeping N split files — one object per upload, and a page mapping that can be corrected
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
  const fileId = params.get('fileId') ? Number(params.get('fileId')) : null;
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });
  if (poBoxId != null && !Number.isInteger(poBoxId)) return send(res, 400, { ok: false, error: 'Invalid poBoxId.' });
  if (fileId != null && !Number.isInteger(fileId)) return send(res, 400, { ok: false, error: 'Invalid fileId.' });

  try {
    const found = await getPoLabelFile(poId, { poBoxId, fileId });
    if (!found) return send(res, 404, { ok: false, error: 'No labels file has been uploaded for this order.' });
    const { po, box } = found;
    // A supplier only ever reaches their OWN order's labels.
    if (user.role === 'supplier' && !isPrivileged(user.role) && Number(po.supplier_user_id) !== Number(user.uid)) {
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    }
    if (box && !found.file) {
      return send(res, 404, {
        ok: false,
        error: 'This label has no page in the uploaded files — its tracking number did not match any page.',
      });
    }

    let bytes;
    let filename;
    if (box) {
      // Copy the label's pages from the file it lives in into a fresh document: the page
      // keeps its vectors, so the barcode prints exactly as the courier made it.
      const pdf = await getObject(found.file.key);
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
    } else if (found.file) {
      // One uploaded file, exactly as it was uploaded.
      bytes = await getObject(found.file.key);
      filename = found.file.name || `${po.po_code}-labels.pdf`;
    } else if (found.files.length === 1) {
      bytes = await getObject(found.files[0].key);
      filename = found.files[0].name || `${po.po_code}-labels.pdf`;
    } else {
      // Several files (labels bought in parts): ONE PDF, oldest upload first, so the
      // warehouse prints every label on the order in one go. Every file or nothing — a
      // merged sheet silently missing a part is a box that never gets its label.
      const { PDFDocument } = await import('pdf-lib');
      const out = await PDFDocument.create();
      for (const f of found.files) {
        const src = await PDFDocument.load(await getObject(f.key));
        for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
      }
      bytes = Buffer.from(await out.save());
      filename = `${po.po_code}-all-labels.pdf`;
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
