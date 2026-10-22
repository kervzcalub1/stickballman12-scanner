// POST /api/po/store-list  (supplier on their own order / ph_team / admin)
//   { poId, stores: [{ name, shoes: [{ sku, name?, colorway?, gender?, unitCost, tip?, sizes: [{ size, qty }] }] }] }
//   -> { ok, pairs, ...order }
//
// The store-by-store list of a store order (docs/store-orders-plan.md §4.2) — what each store
// told the supplier it is sending, at what price. It is the invoice we build (the stores never
// send one), so:
//   · every shoe needs its price;
//   · the same shoe + size already on that store at a DIFFERENT price is refused, never
//     re-priced (a re-paste at a new price used to silently re-price the whole quantity);
//   · it is written in ONE transaction — all of it lands or none of it does.
// Re-pasting a line ADDS to its quantity, like every other paste.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getPo, getPoFull, listPoStoreLines, writePoStoreList, poHasBoxLines, countPoOrderLines, addPoComment, dbConfigured } from '../_lib/db.js';
import { orderListEditBlock, money, isBoxesOrder } from '../_lib/po-manifest.js';
import { supplierPoView } from '../_lib/po-supplier-view.js';
import { normStoreName } from '../../src/lib/storePaste.js';
import { hasOrderedList } from '../../src/lib/postatus.js';

const MAX_STORES = 30;
const MAX_ENTRIES = 150;   // store × SKU
const MAX_LINES = 1000;    // store × SKU × size
const str = (v, n) => String(v ?? '').trim().slice(0, n) || null;
const fmt = (n) => `$${Number(n).toFixed(2)}`;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid order is required.' });

  // The list, checked whole before anything is written.
  const rawStores = Array.isArray(body.stores) ? body.stores : [];
  if (!rawStores.length) return send(res, 400, { ok: false, error: 'Nothing to add — paste at least one "Store:" line with its shoes.' });
  if (rawStores.length > MAX_STORES) return send(res, 400, { ok: false, error: `At most ${MAX_STORES} stores in one paste.` });
  const stores = [];       // [{ name, lines: [...] }]
  const byKey = new Map(); // "store|SKU|size" -> line (the same line twice in one paste adds up)
  let entries = 0;
  let lineCount = 0;
  for (const st of rawStores) {
    const name = normStoreName(st?.name);
    if (!name) return send(res, 400, { ok: false, error: 'Every store needs a name.' });
    let store = stores.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!store) { store = { name, lines: [] }; stores.push(store); }
    for (const sh of Array.isArray(st.shoes) ? st.shoes : []) {
      entries += 1;
      const sku = str(sh?.sku, 60)?.toUpperCase();
      if (!sku) return send(res, 400, { ok: false, error: `${name}: every shoe needs a SKU.` });
      const unitCost = money(sh.unitCost);
      if (unitCost == null) return send(res, 400, { ok: false, error: `${name}: ${sku} has no price. The list is the invoice — add the price each (e.g. "${sku} $110").` });
      const sizes = Array.isArray(sh.sizes) ? sh.sizes : [];
      if (!sizes.length) return send(res, 400, { ok: false, error: `${name}: ${sku} has no sizes.` });
      for (const z of sizes) {
        const size = str(z?.size, 20);
        const qty = parseInt(z?.qty, 10);
        if (!size) return send(res, 400, { ok: false, error: `${name}: ${sku} has a blank size.` });
        if (!(qty >= 1 && qty <= 999)) return send(res, 400, { ok: false, error: `${name}: ${sku} size ${size} — quantity must be 1–999.` });
        const key = `${name.toLowerCase()}|${sku}|${size}`;
        const had = byKey.get(key);
        if (had) {
          if (had.unitCost !== unitCost)
            return send(res, 400, { ok: false, error: `${name}: ${sku} size ${size} is in this paste twice at ${fmt(had.unitCost)} and ${fmt(unitCost)}. One price per shoe and size.` });
          had.qty = Math.min(999, had.qty + qty);
          continue;
        }
        const line = { sku, size, qty, unitCost, tip: money(sh.tip), name: str(sh.name, 200), colorway: str(sh.colorway, 120), gender: str(sh.gender, 20) };
        byKey.set(key, line);
        store.lines.push(line);
        lineCount += 1;
      }
    }
    if (!store.lines.length) return send(res, 400, { ok: false, error: `${name}: no shoes under this store.` });
  }
  if (entries > MAX_ENTRIES) return send(res, 400, { ok: false, error: `At most ${MAX_ENTRIES} shoes (store × SKU) in one paste.` });
  if (lineCount > MAX_LINES) return send(res, 400, { ok: false, error: `At most ${MAX_LINES} sizes in one paste.` });

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    const bySupplier = user.role === 'supplier' && !isPrivileged(user.role);
    if (bySupplier && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    if (isBoxesOrder(po))
      return send(res, 409, { ok: false, error: 'This order is for empty shoe boxes — it can’t be split by store.' });
    if (hasOrderedList(po))
      return send(res, 409, { ok: false, error: 'This order was raised from a buying request — its list is the receipt, not a store list.' });
    const blocked = orderListEditBlock({ po, onBehalf: !bySupplier });
    if (blocked) return send(res, blocked.code, { ok: false, error: blocked.error });
    if (!po.by_store) {
      // Turning an existing order into a store order: only while it has no other list.
      if (await poHasBoxLines(po.id))
        return send(res, 409, { ok: false, error: 'This order already lists what is in each box — it can’t also be split by store.' });
    }
    // On an order that isn't by store yet, every whole-order line is store-less.
    if (!po.by_store && await countPoOrderLines(po.id) > 0) {
      return send(res, 409, {
        ok: false,
        error: bySupplier
          ? 'This order already has a list that isn’t split by store. Message us and we’ll move it under a store first.'
          : 'This order already has a list that isn’t split by store — put those lines under a store first (Assign to a store).',
      });
    }
    const existing = await listPoStoreLines(po.id);
    // Same store + shoe + size already on the order at a different price: refused, never
    // re-priced. A person decides which price is right.
    for (const st of stores) {
      for (const l of st.lines) {
        const had = existing.find((e) => e.store_name.toLowerCase() === st.name.toLowerCase()
          && e.sku === l.sku && e.size === l.size && e.dimensions == null);
        if (had && had.unit_cost != null && Number(had.unit_cost) !== l.unitCost) {
          return send(res, 409, {
            ok: false,
            error: `${st.name}: ${l.sku} size ${l.size} is already on the list at ${fmt(had.unit_cost)} — this paste says ${fmt(l.unitCost)}. Fix the line on the list instead of pasting it again.`,
          });
        }
      }
    }

    const onBehalf = !bySupplier;
    const uidNum = Number(user.uid);
    await writePoStoreList({
      poId: po.id, stores,
      enteredBy: onBehalf && Number.isInteger(uidNum) ? uidNum : null,
      enteredOnBehalf: onBehalf,
    });
    const pairs = stores.reduce((n, st) => n + st.lines.reduce((k, l) => k + l.qty, 0), 0);
    const who = user.name || user.username || '';
    await addPoComment({
      poId: po.id, kind: 'system',
      body: `${po.list_confirmed_at ? 'After the list was confirmed, ' : ''}${who} added ${pairs} pair(s) to the store list — `
        + stores.map((st) => `${st.name}: ${st.lines.reduce((k, l) => k + l.qty, 0)}`).join(', ') + '.',
      author: { id: Number.isInteger(uidNum) ? uidNum : null, name: who, role: user.role },
    }).catch((e) => console.warn('[po/store-list] system comment:', e.message));
    const data = await getPoFull(po.id);
    return send(res, 200, { ok: true, pairs, ...(bySupplier ? supplierPoView(data) : data) });
  } catch (e) {
    // The same shoe and size from two stores, before the database update that allows it
    // has run (docs/store-orders-plan.md §6) — the old whole-order index refuses the second.
    if (e?.code === '23505')
      return send(res, 409, { ok: false, error: 'Two stores list the same shoe and size, and the update that allows that hasn’t finished rolling out yet. Nothing was added — try again in a few minutes.' });
    console.error('[po/store-list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not add the store list. Nothing was added — try again.' });
  }
}
