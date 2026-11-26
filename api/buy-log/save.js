// POST /api/buy-log/save { id?, supplier_user_id?, store, order_number, ordered_on, tracking_numbers[], note,
//                          lines:[{ id?, sku, name?, size?, qty, unit_cost }] }  -> { ok, id }
// Create or change an order on the Buy Log (docs/context/buy-log.md). A supplier saves their
// own; PH / admin save for any supplier switched on for it (`supplier_user_id` on create).
// The size is optional: blank = "sizes not known", compared by SKU alone.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { dbConfigured, saveBuyLog, getBuyLogOwner, listBuyLogSuppliers } from '../_lib/db.js';
import { buyLogUser, isSupplier, canManage, ownsBuy, actorOf, idOf, realDate, MAX_MONEY } from './_shared.js';

const text = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await buyLogUser(req, res);
  if (!user) return;
  if (!isSupplier(user) && !canManage(user)) return send(res, 403, { ok: false, error: 'You can read the buy log, not change it.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  let b;
  try { b = await getJsonBody(req); } catch (e) { return send(res, e.status || 400, { ok: false, error: e.message || 'Bad request.' }); }

  const id = b.id == null || b.id === '' ? null : idOf(b.id);
  if (b.id != null && b.id !== '' && !id) return send(res, 400, { ok: false, error: 'Which order?' });
  const orderedOn = b.ordered_on ? realDate(b.ordered_on) : null;
  if (b.ordered_on && !orderedOn) return send(res, 400, { ok: false, error: 'That order date is not a real date.' });
  // Not on the form any more (2026-11-26: tracking comes from the linked POs' labels); kept for
  // an order that already has some, and left untouched when the field is not sent.
  const tracking = b.tracking_numbers == null ? null : [...new Set((Array.isArray(b.tracking_numbers) ? b.tracking_numbers : String(b.tracking_numbers || '').split(/[\s,;]+/))
    .map((t) => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).filter((t) => t.length >= 6 && t.length <= 40))].slice(0, 60);

  const raw = Array.isArray(b.lines) ? b.lines : [];
  if (!raw.length) return send(res, 400, { ok: false, error: 'Add at least one shoe: SKU, pairs and cost per pair.' });
  if (raw.length > 400) return send(res, 400, { ok: false, error: 'That is more than 400 lines — split it into two orders.' });
  const lines = [];
  for (const [i, l] of raw.entries()) {
    const sku = text(l.sku, 40).toUpperCase();
    const qty = Number(l.qty); const cost = Number(l.unit_cost);
    if (!sku || sku.replace(/[^A-Z0-9]/g, '').length < 3) return send(res, 400, { ok: false, error: `Line ${i + 1}: the SKU is missing.` });
    if (!Number.isInteger(qty) || qty <= 0 || qty > 5000) return send(res, 400, { ok: false, error: `Line ${i + 1} (${sku}): pairs must be a whole number from 1 to 5,000.` });
    if (l.unit_cost === '' || l.unit_cost == null || !Number.isFinite(cost) || cost < 0 || cost > MAX_MONEY) return send(res, 400, { ok: false, error: `Line ${i + 1} (${sku}): the cost per pair is missing.` });
    lines.push({ id: idOf(l.id), sku, name: text(l.name, 160) || null, size: text(l.size, 12) || null, qty, unit_cost: Math.round(cost * 100) / 100 });
  }

  try {
    let supplierUserId; let supplierName;
    if (id) {
      const own = await getBuyLogOwner(id);
      if (!ownsBuy(res, user, own)) return;
      supplierUserId = own.supplier_user_id; supplierName = own.supplier_name;
    } else if (isSupplier(user)) {
      supplierUserId = Number(user.uid); supplierName = actorOf(user);
    } else {
      // Staff open it FOR a supplier — one who is switched on for the buy log, so the order
      // shows up in that supplier's own portal.
      const sid = idOf(b.supplier_user_id);
      const who = sid ? (await listBuyLogSuppliers()).find((s) => Number(s.id) === sid) : null;
      if (!who) return send(res, 400, { ok: false, error: 'Pick whose order this is — a supplier with “Keep a buy log” switched on.' });
      supplierUserId = sid; supplierName = who.name;
    }
    const saved = await saveBuyLog({
      id, supplierUserId, supplierName, store: text(b.store, 120), orderNumber: text(b.order_number, 60),
      orderedOn, tracking, note: text(b.note, 600), lines,
    }, actorOf(user));
    if (!saved) return send(res, 404, { ok: false, error: 'That order no longer exists.' });
    return send(res, 200, { ok: true, id: saved });
  } catch (e) {
    console.error('[buy-log/save]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the order.' });
  }
}
