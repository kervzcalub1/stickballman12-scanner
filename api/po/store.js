// POST /api/po/store  (supplier on their own order / ph_team / admin)
//   { poId, action, ... } -> { ok, ...order }
//
// Everything about a store order's stores and its list except adding lines
// (that's po/store-list). docs/store-orders-plan.md §4.2–4.3.
//
//   rename          { storeId, name }      supplier (until confirmed) / staff
//   remove          { storeId }            supplier (until confirmed) / staff — refused with boxes,
//                                          charges or receipts, or once the list is confirmed
//   confirm         {}                     the supplier's "this is what the stores told me" —
//                                          locks the list for them (staff may confirm for them)
//   unlock          { note }               staff: reopen the list for the supplier to fix
//   invoice_checked { checked }            staff: the optional "we checked the totals" mark
//   assign_lines    { storeName }          staff: put a store-less whole-order list under a store
//                                          (converts an order entered before it was by store)
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import {
  getPo, getPoFull, getPoStore, listPoStores, listPoStoreLines, renamePoStore, removePoStore,
  setPoListConfirmed, setPoInvoiceChecked, assignOrderLinesToStore, writePoStoreList, poHasBoxLines,
  addPoComment, dbConfigured,
} from '../_lib/db.js';
import { orderListEditBlock, isBoxesOrder } from '../_lib/po-manifest.js';
import { supplierPoView } from '../_lib/po-supplier-view.js';
import { normStoreName } from '../../src/lib/storePaste.js';
import { hasOrderedList } from '../../src/lib/postatus.js';

const STAFF_ONLY = new Set(['unlock', 'invoice_checked', 'assign_lines']);
const ACTIONS = new Set(['rename', 'remove', 'confirm', 'unlock', 'invoice_checked', 'assign_lines']);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const action = String(body.action || '');
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid order is required.' });
  if (!ACTIONS.has(action)) return send(res, 400, { ok: false, error: 'Unknown action.' });
  const bySupplier = user.role === 'supplier' && !isPrivileged(user.role);
  if (bySupplier && STAFF_ONLY.has(action)) return send(res, 403, { ok: false, error: 'You do not have access to this feature.' });
  const who = user.name || user.username || '';
  const uidNum = Number(user.uid);
  const author = { id: Number.isInteger(uidNum) ? uidNum : null, name: who, role: user.role };
  const note = (b) => addPoComment({ poId, kind: 'system', body: b, author })
    .catch((e) => console.warn('[po/store] system comment:', e.message));
  const reply = async () => {
    const data = await getPoFull(poId);
    return send(res, 200, { ok: true, ...(bySupplier ? supplierPoView(data) : data) });
  };

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (bySupplier && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });

    if (action === 'assign_lines') {
      const name = normStoreName(body.storeName);
      if (!name) return send(res, 400, { ok: false, error: 'Which store do these lines belong to?' });
      if (isBoxesOrder(po) || hasOrderedList(po))
        return send(res, 409, { ok: false, error: 'This order can’t be split by store.' });
      const blocked = orderListEditBlock({ po, onBehalf: true });
      if (blocked) return send(res, blocked.code, { ok: false, error: blocked.error });
      if (await poHasBoxLines(poId))
        return send(res, 409, { ok: false, error: 'This order lists what is in each box — it can’t be split by store.' });
      // Make sure the store exists (an empty store list write creates it), then move the lines.
      await writePoStoreList({ poId, stores: [{ name, lines: [] }] });
      const store = (await listPoStores(poId)).find((s) => s.name.toLowerCase() === name.toLowerCase());
      const r = await assignOrderLinesToStore(poId, store.id);
      if (r.error) return send(res, 409, { ok: false, error: r.error });
      await note(`${who} put ${r.moved} line(s) of the order’s list under ${store.name}.`);
      return reply();
    }

    if (!po.by_store) return send(res, 409, { ok: false, error: 'This order isn’t split by store.' });

    if (action === 'rename' || action === 'remove') {
      const store = await getPoStore(Number(body.storeId));
      if (!store || Number(store.po_id) !== poId) return send(res, 404, { ok: false, error: 'That store isn’t on this order.' });
      const blocked = orderListEditBlock({ po, onBehalf: !bySupplier });
      if (blocked) return send(res, blocked.code, { ok: false, error: blocked.error });
      if (action === 'rename') {
        const name = normStoreName(body.name);
        if (!name) return send(res, 400, { ok: false, error: 'A store needs a name.' });
        if (name === store.name) return reply();
        try { await renamePoStore(store.id, name); } catch (e) {
          if (e?.code === '23505') return send(res, 409, { ok: false, error: `${name} is already a store on this order.` });
          throw e;
        }
        await note(`${who} renamed store “${store.name}” to “${name}”.`);
        return reply();
      }
      if (po.list_confirmed_at)
        return send(res, 409, { ok: false, error: 'The list is confirmed — unlock it before removing a store.' });
      const r = await removePoStore(store.id);
      if (r.error) return send(res, 409, { ok: false, error: r.error });
      await note(`${who} removed store “${store.name}” (${r.linesRemoved} line(s)).`);
      return reply();
    }

    if (action === 'confirm') {
      if (po.list_confirmed_at) return reply();
      const blocked = orderListEditBlock({ po, onBehalf: !bySupplier });
      if (blocked) return send(res, blocked.code, { ok: false, error: blocked.error });
      const stores = await listPoStores(poId);
      if (!stores.length) return send(res, 400, { ok: false, error: 'Add the stores and what each is sending first.' });
      const empty = stores.filter((s) => !s.declared_units);
      if (empty.length) return send(res, 400, { ok: false, error: `${empty.map((s) => s.name).join(', ')}: no shoes listed — add them or remove the store.` });
      const unpriced = (await listPoStoreLines(poId)).filter((l) => l.unit_cost == null);
      if (unpriced.length) return send(res, 400, { ok: false, error: `${unpriced.length} line(s) have no price — every line needs its price each before the list can be confirmed.` });
      await setPoListConfirmed(poId, who);
      const pairs = stores.reduce((n, s) => n + s.declared_units, 0);
      const total = stores.reduce((n, s) => n + Number(s.declared_total || 0), 0);
      await note(`${who} confirmed the store list — ${stores.length} store(s), ${pairs} pair(s), $${total.toFixed(2)}.${bySupplier ? '' : ' (confirmed by staff)'}`);
      return reply();
    }

    if (action === 'unlock') {
      if (!po.list_confirmed_at) return reply();
      if (po.audited_at) return send(res, 409, { ok: false, error: 'This order has been audited — reopen the audit first.' });
      const why = String(body.note || '').trim().slice(0, 500);
      if (!why) return send(res, 400, { ok: false, error: 'Say why the list is being reopened — it goes on the order’s history.' });
      await setPoListConfirmed(poId, null);
      await note(`${who} reopened the confirmed store list: ${why}`);
      return reply();
    }

    if (action === 'invoice_checked') {
      const checked = body.checked !== false;
      await setPoInvoiceChecked(poId, checked ? who : null);
      await note(checked ? `${who} checked the store list totals (invoice checked).` : `${who} cleared “invoice checked”.`);
      return reply();
    }
    return send(res, 400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    console.error('[po/store]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the store.' });
  }
}
