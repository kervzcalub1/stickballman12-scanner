// GET  /api/po/audit?poId=…   -> { ok, variance, charges, receipts, can }   (staff)
//                             -> { ok, receipts }                             (the supplier: their own)
// POST /api/po/audit { poId, action, … }  -> { ok, …same as GET }
//
// The audit of a STORE order (docs/store-orders-plan.md §4.5–4.7). Kevin compares, store by
// store, what the supplier declared (the list = the invoice) against what arrived (every
// box tied to its store, PR C) against what the card was charged — receipts when the store
// gave one. Actions:
//
//   charge_add      { storeId, amount, chargedOn?, cardLast4?, note? }   staff — negative = a credit
//   charge_remove   { chargeId }                                         staff
//   credit          { storeId, agreed, received, note }                  staff — per-store credit
//   receipt_amount  { receiptId, amount, lines?, readAgreed? }           staff, or the supplier on
//                                                                        a receipt they uploaded
//   receipt_remove  { receiptId }                                        same
//   receipt_email   { storeId, emailReceiptId }                          staff — an ingested email
//   landed          { note | null }                                      staff — "Call it landed"
//   mark_audited    { note? }                                            the `audit_po` privilege
//   unaudit         {}                                                   admin
//
// Everything that changes money evidence is refused once the order is audited; undo the
// audit first (admin). Each action leaves a system comment on the order.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import {
  getPo, getPoStore, getPoStoreVariance, listPoStoreCharges, addPoStoreCharge, getPoStoreCharge,
  removePoStoreCharge, listPoStoreReceipts, getPoStoreReceipt, setPoStoreReceiptRead, removePoStoreReceipt,
  addPoStoreReceipt, setPoStoreCredit, setPoLandedOverride, markPoAudited, unauditPo, addPoComment,
  storeOutcomeForIntake, getEmailReceipt, dbConfigured,
} from '../_lib/db.js';
import { hasPrivilege } from '../_lib/buycart.js';
import { alertPoDiscrepancy } from '../_lib/alerts.js';
import { deleteObject, r2Configured } from '../_lib/r2.js';

const ACTIONS = new Set(['charge_add', 'charge_remove', 'credit', 'receipt_amount', 'receipt_remove',
  'receipt_email', 'landed', 'mark_audited', 'unaudit']);
const SUPPLIER_OK = new Set(['receipt_amount', 'receipt_remove']);
const money = (n) => `$${Number(n).toFixed(2)}`;
// A money amount from the body: a finite number with at most 2 decimals' worth, or null.
const amountOf = (v, { allowNegative = false } = {}) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || Math.abs(n) > 1e7 || (!allowNegative && n < 0)) return NaN;
  return Math.round(n * 100) / 100;
};

// What a supplier may see of their receipts: the file and its total, not which of our
// mailboxes an email came from.
const supplierReceipt = ({ email_receipt_id, email_store, email_order, email_total, email_received_at, email_subject, uploaded_by_id, ...r }) => r;

async function view(poId, { staff, user }) {
  const receipts = await listPoStoreReceipts(poId);
  if (!staff) {
    return { receipts: receipts.filter((r) => Number(r.uploaded_by_id) === Number(user.uid)).map(supplierReceipt) };
  }
  const [variance, charges] = await Promise.all([getPoStoreVariance(poId), listPoStoreCharges(poId)]);
  return {
    variance, charges, receipts,
    can: { audit: await hasPrivilege(user, 'audit_po'), unaudit: isPrivileged(user.role) },
  };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 90 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = req.method === 'POST' ? await getJsonBody(req) : {};
  const poId = Number(req.method === 'GET' ? new URL(req.url, 'http://x').searchParams.get('poId') : body.poId);
  if (!Number.isInteger(poId) || poId < 1) return send(res, 400, { ok: false, error: 'A valid order is required.' });
  const staff = !(user.role === 'supplier' && !isPrivileged(user.role));
  const who = user.name || user.username || '';
  const uidNum = Number(user.uid);
  const author = { id: Number.isInteger(uidNum) ? uidNum : null, name: who, role: user.role };
  const note = (text) => addPoComment({ poId, kind: 'system', audience: 'internal', body: text, author })
    .catch((e) => console.warn('[po/audit] system comment:', e.message));

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (!staff && Number(po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    if (!po.by_store)
      return send(res, 409, { ok: false, error: `${po.po_code} is not an order bought from several stores — it reconciles the usual way.` });
    if (req.method === 'GET') return send(res, 200, { ok: true, ...(await view(poId, { staff, user })) });

    const action = String(body.action || '');
    if (!ACTIONS.has(action)) return send(res, 400, { ok: false, error: 'Unknown action.' });
    if (!staff && !SUPPLIER_OK.has(action)) return send(res, 403, { ok: false, error: 'You do not have access to this feature.' });
    const audited = !!po.audited_at;
    if (audited && action !== 'unaudit') {
      return send(res, 409, { ok: false, error: `${po.po_code} was audited by ${po.audited_by || 'staff'} — undo the audit first to change anything.` });
    }
    const storeOf = async (id) => {
      const st = await getPoStore(Number(id));
      return st && Number(st.po_id) === poId ? st : null;
    };
    const reply = async () => send(res, 200, { ok: true, ...(await view(poId, { staff, user })) });

    if (action === 'charge_add') {
      const st = await storeOf(body.storeId);
      if (!st) return send(res, 400, { ok: false, error: 'Pick the store this charge was for.' });
      const amount = amountOf(body.amount, { allowNegative: true });
      if (amount == null || Number.isNaN(amount) || amount === 0)
        return send(res, 400, { ok: false, error: 'Enter the amount off the card statement (negative for a credit back).' });
      const chargedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.chargedOn || '')) ? body.chargedOn : null;
      const last4 = String(body.cardLast4 ?? '').replace(/\D/g, '').slice(-4) || null;
      await addPoStoreCharge({
        storeId: Number(st.id), amount, chargedOn, cardLast4: last4,
        note: String(body.note ?? '').trim().slice(0, 300) || null, enteredBy: who,
      });
      await note(`${st.name}: card ${amount < 0 ? 'credit' : 'charge'} ${money(amount)}${chargedOn ? ` on ${chargedOn}` : ''} recorded.`);
      return reply();
    }
    if (action === 'charge_remove') {
      const c = await getPoStoreCharge(Number(body.chargeId));
      if (!c || Number(c.po_id) !== poId) return send(res, 404, { ok: false, error: 'That charge is not on this order.' });
      await removePoStoreCharge(Number(c.id));
      await note(`${c.store_name}: card charge ${money(c.amount)}${c.charged_on ? ` on ${c.charged_on}` : ''} removed.`);
      return reply();
    }
    if (action === 'credit') {
      const st = await storeOf(body.storeId);
      if (!st) return send(res, 400, { ok: false, error: 'Pick the store.' });
      const agreed = amountOf(body.agreed);
      const received = amountOf(body.received);
      if (Number.isNaN(agreed) || Number.isNaN(received)) return send(res, 400, { ok: false, error: 'Credits are amounts of $0 or more.' });
      await setPoStoreCredit(Number(st.id), { agreed, received, note: String(body.note ?? '').trim().slice(0, 300) || null });
      await note(`${st.name}: credit agreed ${agreed == null ? '—' : money(agreed)}, received ${received == null ? '—' : money(received)}.`);
      return reply();
    }
    if (action === 'receipt_amount' || action === 'receipt_remove') {
      const r = await getPoStoreReceipt(Number(body.receiptId));
      if (!r || Number(r.po_id) !== poId) return send(res, 404, { ok: false, error: 'That receipt is not on this order.' });
      if (!staff && Number(r.uploaded_by_id) !== uidNum) return send(res, 403, { ok: false, error: 'You can only change receipts you uploaded.' });
      if (action === 'receipt_remove') {
        await removePoStoreReceipt(Number(r.id));
        if (r.r2_key && r2Configured()) deleteObject(r.r2_key).catch((e) => console.warn('[po/audit] r2 delete:', e.message));
        await note(`${r.store_name}: receipt ${r.name || `#${r.id}`} removed.`);
        return reply();
      }
      const amount = amountOf(body.amount);
      if (Number.isNaN(amount)) return send(res, 400, { ok: false, error: 'Enter the receipt’s total.' });
      const lines = Array.isArray(body.lines) ? body.lines.slice(0, 300).map((l) => ({
        sku: String(l?.sku ?? '').slice(0, 40), size: l?.size == null ? null : String(l.size).slice(0, 20),
        qty: Math.min(Math.max(parseInt(l?.qty, 10) || 1, 1), 999),
        totalPrice: Number.isFinite(Number(l?.totalPrice)) ? Number(l.totalPrice) : null,
      })) : undefined;
      await setPoStoreReceiptRead(Number(r.id), {
        amount, lines, readAgreed: typeof body.readAgreed === 'boolean' ? body.readAgreed : undefined,
      });
      await note(`${r.store_name}: receipt total ${amount == null ? 'cleared' : money(amount)}.`);
      return reply();
    }
    if (action === 'receipt_email') {
      const st = await storeOf(body.storeId);
      if (!st) return send(res, 400, { ok: false, error: 'Pick the store.' });
      const emailId = Number(body.emailReceiptId);
      if (!Number.isInteger(emailId)) return send(res, 400, { ok: false, error: 'Pick the email receipt.' });
      const er = await getEmailReceipt(emailId);
      if (!er) return send(res, 404, { ok: false, error: 'That email receipt no longer exists.' });
      await addPoStoreReceipt({
        storeId: Number(st.id), emailReceiptId: emailId, amount: er.total == null ? null : Number(er.total),
        name: `Email receipt${er.order_number ? ` #${er.order_number}` : ''}`, uploadedBy: who,
        uploadedById: Number.isInteger(uidNum) ? uidNum : null,
      });
      await note(`${st.name}: email receipt${er.order_number ? ` #${er.order_number}` : ''} attached (${er.total == null ? 'no total' : money(er.total)}).`);
      return reply();
    }
    if (action === 'landed') {
      const text = body.note == null ? null : String(body.note).trim().slice(0, 500);
      if (body.note != null && !text) return send(res, 400, { ok: false, error: 'Say why it counts as landed (e.g. “box 7 lost — claim filed”).' });
      await setPoLandedOverride(poId, who, text);
      await note(text ? `Called it landed: “${text}”.` : 'Cleared “Call it landed”.');
      // Landing is when a store order's shortfall becomes news (plan §4.7).
      if (text) alertPoDiscrepancy(await storeOutcomeForIntake(poId), user);
      return reply();
    }
    if (action === 'mark_audited') {
      if (!(await hasPrivilege(user, 'audit_po')))
        return send(res, 403, { ok: false, error: 'You do not have the “Audit store orders” privilege.' });
      if (po.status !== 'receiving')
        return send(res, 409, { ok: false, error: `${po.po_code} is ${po.status} — only an order being received can be audited.` });
      const v = await getPoStoreVariance(poId);
      if (!v.landed.landed) {
        return send(res, 409, {
          ok: false,
          error: `Not landed yet — ${v.landed.labels_in} of ${v.landed.labels} boxes in${v.landed.open_batches ? `, ${v.landed.open_batches} batch still open` : ''}. `
            + 'Wait for the rest, or “Call it landed” with the reason.',
        });
      }
      if (v.untied_units > 0)
        return send(res, 409, { ok: false, error: `${v.untied_units} received pair(s) aren’t tied to a store yet — tie them first.` });
      const text = String(body.note ?? '').trim().slice(0, 1000) || null;
      await markPoAudited(poId, { who, note: text });
      const t = v.totals;
      await note(`Audited: ${t.received_units} of ${t.declared_units} pairs, ${t.short} short, ${t.over} over, ${money(t.owed || 0)} owed`
        + `${t.charged_total != null ? `, charged ${money(t.charged_total)} against ${money(t.declared_total || 0)} declared` : ''}.`
        + (text ? ` “${text}”` : ''));
      return reply();
    }
    if (action === 'unaudit') {
      if (!isPrivileged(user.role)) return send(res, 403, { ok: false, error: 'Only an admin can undo an audit.' });
      if (!audited) return send(res, 409, { ok: false, error: `${po.po_code} hasn’t been audited.` });
      await unauditPo(poId);
      await note(`Undid the audit by ${po.audited_by || 'staff'} — the order is back to receiving.`);
      return reply();
    }
    return send(res, 400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    console.error('[po/audit]', e.message);
    return send(res, 500, { ok: false, error: 'Could not do that.' });
  }
}
