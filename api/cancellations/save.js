// POST /api/cancellations/save  { id?, platform, order_number, sku?, size?, product?, reason?, note? } -> { ok, row }
//   no id → a new one typed in by hand (warehouse, PH, admin) — for a picture that never
//           made it to Telegram, or someone not connected to the bot.
//   id    → a reviewer's correction (PH / admin), only while it is still to review.
// The flags are recomputed from the fields as they now stand (flagsFor); a person's edit
// drops the reader's own doubts, because the edit IS the look at the photo.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured, getCancellation, createCancellation, updateCancellationFields } from '../_lib/db.js';
import { cleanOrderNo, cleanSku, orderKey, flagsFor, isPlatform } from '../../src/lib/cancellations.js';
import { VIEW_ROLES, canReview, actorOf, idOf, text } from './_shared.js';

const dupMsg = (d) => `That order number is already logged as #${d?.id}${d?.sent_by ? ` (sent by ${d.sent_by})` : ''}.`;

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
  f.flags = flagsFor(f);
  try {
    const id = b.id == null ? null : idOf(b.id);
    if (b.id != null && !id) return send(res, 400, { ok: false, error: 'Which cancellation?' });
    if (!id) {
      if (!f.order_key) return send(res, 400, { ok: false, error: 'Type the order number.' });
      const out = await createCancellation({ ...f, source: 'app', sent_by_user_id: Number(user.uid) || null, sent_by: actorOf(user) });
      if (out.duplicate) return send(res, 409, { ok: false, error: dupMsg(out.duplicate) });
      return send(res, 200, { ok: true, row: out.row });
    }
    if (!canReview(user)) return send(res, 403, { ok: false, error: 'Only PH and admin correct cancellations.' });
    const cur = await getCancellation(id);
    if (!cur) return send(res, 404, { ok: false, error: 'That cancellation does not exist.' });
    if (cur.status !== 'to_review') return send(res, 409, { ok: false, error: 'Only a row still to review can be edited — reopen it first.' });
    // Keep a photo-failure flag only while there's still no number; "submit failed" stays
    // until someone acts on it.
    if ((cur.flags || []).includes('submit_failed')) f.flags.push('submit_failed');
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
