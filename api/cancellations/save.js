// POST /api/cancellations/save  { id?, platform, order_number, sku?, size?, product?, reason?, note? } -> { ok, row }
//   no id → one typed in by hand (warehouse, PH, admin) — for a picture that never made it
//           to Telegram, or someone not connected to the bot.
//   id    → a fix to a recorded row (anyone who sees the page): type the number the photo
//           couldn't give, put a misread one right, add a missing SKU / size / name.
// No review step (2026-11-12): a save is simply the record. When the number is one of OUR
// orders (eBay / SHEIN / pre-sell), whatever detail was left blank is filled from it, then
// from our catalogue by SKU — the same lookup the bot uses (fillDetails). Flags are
// recomputed from the fields (flagsFor), kept for the record only.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured, getCancellation, createCancellation, updateCancellationFields } from '../_lib/db.js';
import { fillDetails } from '../_lib/cancellations.js';
import { cleanOrderNo, cleanSku, orderKey, flagsFor, isPlatform } from '../../src/lib/cancellations.js';
import { VIEW_ROLES, actorOf, idOf, text } from './_shared.js';

const dupMsg = (d) => `That order number is already logged as #${d?.id}${d?.sent_by ? ` (sent by ${d.sent_by})` : ''}.`;
const DETAIL = ['product', 'sku', 'size'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, VIEW_ROLES);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const platform = b.platform ? String(b.platform) : null;
  if (platform && !isPlatform(platform)) return send(res, 400, { ok: false, error: 'Unknown platform.' });
  const order_number = cleanOrderNo(b.order_number) || null;
  const f = {
    platform, order_number, order_key: orderKey(order_number),
    sku: cleanSku(b.sku), size: text(b.size, 20), product: text(b.product, 200),
    reason: text(b.reason, 300), note: text(b.note, 500),
  };
  try {
    const id = b.id == null ? null : idOf(b.id);
    if (b.id != null && !id) return send(res, 400, { ok: false, error: 'Which cancellation?' });
    const cur = id ? await getCancellation(id) : null;
    if (id && (!cur || cur.status === 'rejected')) return send(res, 404, { ok: false, error: 'That cancellation does not exist.' });
    if (!id && !f.order_key) return send(res, 400, { ok: false, error: 'Type the order number.' });
    const numberChanged = !cur || cur.order_key !== f.order_key;
    const typedDetail = DETAIL.some((k) => String(f[k] ?? '') !== String(cur?.[k] ?? ''));
    f.details_from = cur ? (typedDetail ? 'edited' : cur.details_from) : (DETAIL.some((k) => f[k]) ? 'typed' : null);
    f.order_match = cur && !numberChanged ? cur.order_match : null;
    // Blank details + a number → our orders, then the catalogue (the bot's own lookup).
    if (f.order_key && (numberChanged || DETAIL.some((k) => !f[k]))) {
      const [o] = await fillDetails([{ order_number: f.order_number, platform: f.platform, sku: f.sku, size: f.size, product: f.product }], f.platform, { typed: true });
      for (const k of DETAIL) if (!f[k] && o[k]) f[k] = o[k];
      if (o.order_match) { f.order_match = o.order_match; f.platform = f.platform || o.platform; }
      const from = String(o.details_from || '').split(',').filter((x) => x && x !== 'typed');
      if (from.length) f.details_from = [...new Set([...(f.details_from ? f.details_from.split(',') : []), ...from])].join(',');
    }
    f.flags = flagsFor(f);
    if (!id) {
      const out = await createCancellation({ ...f, source: 'app', sent_by_user_id: Number(user.uid) || null, sent_by: actorOf(user) });
      if (out.duplicate) return send(res, 409, { ok: false, error: dupMsg(out.duplicate) });
      return send(res, 200, { ok: true, row: out.row });
    }
    const changed = ['platform', 'order_number', 'sku', 'size', 'product', 'reason', 'note']
      .filter((k) => String(cur[k] ?? '') !== String(f[k] ?? ''))
      .map((k) => `${k}: ${cur[k] ?? '—'} → ${f[k] ?? '—'}`).join('; ');
    const out = await updateCancellationFields(id, { ...f, changed: changed || null }, actorOf(user));
    if (out.duplicate) return send(res, 409, { ok: false, error: dupMsg(out.duplicate) });
    return send(res, 200, { ok: true, row: out.row });
  } catch (e) {
    console.error('[cancellations/save]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save that.' });
  }
}
