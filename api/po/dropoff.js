// The supplier's drop-off receipt: proof a box was handed to the courier.
//
// POST /api/po/dropoff  { poId, action:'sign', contentType }                     -> { uploadUrl, key }
//                       { poId, action:'attach', key, name, contentType, sizeBytes } -> { receipt, dropoffReceipts }
//                       { poId, action:'delete', id }                             -> { dropoffReceipts }
// GET  /api/po/dropoff?id=…[&download=1]                                          -> the bytes
//
// The supplier uploads it, or our team does for them. Same presigned shape as a buying request's
// files, and the bytes are checked on attach. Files are proxied, never a bucket URL. A supplier
// reaches only their own orders, and can remove only what they uploaded themselves.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import {
  getPo, listPoDropoffReceipts, getPoDropoffReceipt, addPoDropoffReceipt, removePoDropoffReceipt, dbConfigured,
} from '../_lib/db.js';
import { presignPutUrl, getObject, deleteObject, r2Configured } from '../_lib/r2.js';
import { sniffImageFormat } from '../_lib/imgformat.js';
import { alertDropoffReceiptUploaded } from '../_lib/alerts.js';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };
const TYPE = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };

const isSupplier = (user) => user.role === 'supplier' && !isPrivileged(user.role);
const refused = (user, po) => isSupplier(user) && Number(po.supplier_user_id) !== Number(user.uid);

// What's wrong with a receipt, by its bytes rather than the type the browser claimed, or null.
export function dropoffFileProblem(buf) {
  if (buf && buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return null;
  const format = sniffImageFormat(buf);
  if (format === 'heic') return 'This photo is in HEIC format, which can’t be opened here. Take it with the camera here, or save it as a JPEG.';
  if (!['jpeg', 'png', 'webp'].includes(format)) return 'That file isn’t a photo or a PDF. Try again.';
  return null;
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    if (req.method === 'GET') {
      const params = new URL(req.url, 'http://x').searchParams;
      const r = await getPoDropoffReceipt(Number(params.get('id')));
      if (!r) return send(res, 404, { ok: false, error: 'That receipt is not on file.' });
      const po = await getPo(r.po_id);
      if (!po || refused(user, po)) return send(res, 403, { ok: false, error: 'You do not have access to this receipt.' });
      if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured.' });
      const bytes = await getObject(r.r2_key);
      const ext = String(r.r2_key).split('.').pop().toLowerCase();
      res.statusCode = 200;
      res.setHeader('Content-Type', r.content_type || TYPE[ext] || 'application/octet-stream');
      res.setHeader('Content-Length', String(bytes.length));
      const name = (r.name || `${po.po_code}-dropoff.${ext}`).replace(/[^A-Za-z0-9._-]/g, '_');
      res.setHeader('Content-Disposition', `${params.get('download') ? 'attachment' : 'inline'}; filename="${name}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.end(bytes);
    }

    const body = await getJsonBody(req);
    const poId = Number(body.poId);
    if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (refused(user, po)) return send(res, 403, { ok: false, error: 'You do not have access to this order.' });

    if (body.action === 'delete') {
      const r = await getPoDropoffReceipt(Number(body.id));
      if (!r || Number(r.po_id) !== poId) return send(res, 404, { ok: false, error: 'That receipt is not on this order.' });
      if (isSupplier(user) && !(r.uploaded_role === 'supplier' && Number(r.uploaded_by_id) === Number(user.uid)))
        return send(res, 403, { ok: false, error: 'Only our team can remove a receipt they uploaded. Ask them to.' });
      const gone = await removePoDropoffReceipt(r.id);
      if (gone && r2Configured()) await deleteObject(gone.r2_key).catch((e) => console.warn('[po/dropoff] object left behind:', e.message));
      return send(res, 200, { ok: true, dropoffReceipts: await listPoDropoffReceipts(poId) });
    }

    if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured.' });

    if (body.action === 'sign') {
      const ext = EXT[body.contentType];
      if (!ext) return send(res, 400, { ok: false, error: 'Upload a photo or a PDF of the receipt.' });
      const key = `po-dropoff/${po.po_code}/${Date.now()}.${ext}`;
      return send(res, 200, { ok: true, uploadUrl: presignPutUrl({ key, expiresIn: 300 }), key });
    }

    if (body.action === 'attach') {
      // Only a key this server minted, under this order's own prefix.
      const key = String(body.key ?? '').trim();
      const prefix = `po-dropoff/${po.po_code}/`;
      if (!key.startsWith(prefix) || !/^\d+\.(jpg|png|webp|heic|pdf)$/.test(key.slice(prefix.length)))
        return send(res, 400, { ok: false, error: 'That upload is not valid for this order.' });
      let problem;
      try { problem = dropoffFileProblem(await getObject(key)); }
      catch { problem = 'The file did not reach storage. Try again.'; }
      if (problem) {
        await deleteObject(key).catch(() => {});
        return send(res, 400, { ok: false, error: problem });
      }
      const receipt = await addPoDropoffReceipt({
        poId, key,
        name: String(body.name ?? '').trim().slice(0, 200) || null,
        contentType: EXT[body.contentType] ? body.contentType : null,
        sizeBytes: Number.isInteger(Number(body.sizeBytes)) ? Number(body.sizeBytes) : null,
        actor: user,
      });
      // The team asked for it, so tell them it came. Our own upload needs no announcing.
      if (isSupplier(user)) alertDropoffReceiptUploaded(po, user);
      return send(res, 200, { ok: true, receipt, dropoffReceipts: await listPoDropoffReceipts(poId) });
    }

    return send(res, 400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    console.error('[po/dropoff]', e.message);
    return send(res, 500, { ok: false, error: 'Could not handle that receipt.' });
  }
}
