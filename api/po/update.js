// POST /api/po/update  (ph_team / admin)
//   { poId, supplierName?, tagCode?, dateOfPurchase?, notes?, expectedBoxes?, orderKind? }
// Corrects the order's own details after it's been raised — the supplier it was placed
// with, its tag/code, the purchase date, the notes, and how many boxes it expects.
// Only the fields actually sent are written, so two people editing different parts of
// the same order don't blank each other's work.
//
// A reconciled/closed order is frozen: its count has been settled with the supplier and
// the record has to keep saying what was settled. See docs/context/purchase-orders.md.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPoFull, updatePo, addPoComment, syncExpectedBoxes, PO_FROZEN, dbConfigured } from '../_lib/db.js';
import { ORDER_KINDS } from '../_lib/po-manifest.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });

  try {
    const data = await getPoFull(poId);
    if (!data) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (PO_FROZEN.includes(data.po.status)) {
      return send(res, 409, { ok: false, error: `${data.po.po_code} is ${data.po.status} — its details are settled and can't be edited.` });
    }

    const patch = {};
    const changed = [];
    if (body.supplierName !== undefined) {
      const v = String(body.supplierName ?? '').trim().slice(0, 120);
      if (!v) return send(res, 400, { ok: false, error: 'Supplier name cannot be blank.' });
      if (v !== data.po.supplier_name) { patch.supplierName = v; changed.push(`supplier → ${v}`); }
    }
    if (body.tagCode !== undefined) {
      const v = String(body.tagCode ?? '').trim().slice(0, 120) || null;
      if (v !== (data.po.tag_code || null)) { patch.tagCode = v; changed.push(`tag → ${v || '—'}`); }
    }
    if (body.dateOfPurchase !== undefined) {
      const raw = String(body.dateOfPurchase ?? '').trim();
      if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return send(res, 400, { ok: false, error: 'Date of purchase must be YYYY-MM-DD.' });
      const v = raw || null;
      const cur = data.po.date_of_purchase ? String(data.po.date_of_purchase).slice(0, 10) : null;
      if (v !== cur) { patch.dateOfPurchase = v; changed.push(`date of purchase → ${v || '—'}`); }
    }
    if (body.notes !== undefined) {
      const v = String(body.notes ?? '').trim().slice(0, 2000) || null;
      if (v !== (data.po.notes || null)) { patch.notes = v; changed.push('notes edited'); }
    }
    // Shoes or empty shoe boxes. Changeable after the fact on purpose: an order for
    // boxes is routinely raised on the shoes form before anyone says which it is, and the
    // supplier can't declare a thing until the order says what it's for. The lines are
    // NOT rewritten — a shoe line's size and a box line's dimensions are different facts,
    // so anything already declared under the old kind shows blank in the new one and has
    // to be re-stated. That's why the change is announced on the thread.
    if (body.orderKind !== undefined) {
      const v = String(body.orderKind ?? '').trim();
      if (!ORDER_KINDS.includes(v))
        return send(res, 400, { ok: false, error: 'An order is either for shoes or for empty shoe boxes.' });
      if (v !== (data.po.order_kind || 'shoes')) {
        patch.orderKind = v;
        changed.push(`order kind → ${v === 'boxes' ? 'empty shoe boxes' : 'shoes'}`
          + ((data.lines || []).length ? ` (${data.lines.length} declared line(s) kept — re-state them for the new kind)` : ''));
      }
    }
    if (body.expectedBoxes !== undefined) {
      const raw = body.expectedBoxes;
      const v = raw === '' || raw == null ? null : Number(raw);
      if (v != null && (!Number.isInteger(v) || v < 1 || v > 500))
        return send(res, 400, { ok: false, error: 'Boxes expected must be a whole number from 1 to 500.' });
      // It can be set HIGHER than the labels entered so far — an order often knows six
      // boxes are coming before the last tracking numbers exist — but never lower than
      // the labels it already holds, which would make the order contradict itself.
      const labels = (data.boxes || []).filter((b) => b.kind !== 'replacement').length;
      if (v != null && v < labels)
        return send(res, 400, { ok: false, error: `This order already has ${labels} label(s) — it can't expect fewer boxes than that. Remove a label first.` });
      if (v !== (data.po.expected_boxes ?? null)) { patch.expectedBoxes = v; changed.push(`boxes expected → ${v ?? '—'}`); }
    }
    if (!Object.keys(patch).length) return send(res, 200, { ok: true, po: data.po, changed: [] });

    const po = await updatePo(poId, patch);
    if (patch.expectedBoxes === undefined) await syncExpectedBoxes(poId);
    // The thread is this order's audit trail — there's no separate history table, so a
    // silent edit would be an edit nobody can account for later.
    await addPoComment({
      poId, kind: 'system', body: `Order details edited — ${changed.join(', ')}.`,
      author: { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role },
    }).catch((e) => console.warn('[po/update] system comment:', e.message));
    return send(res, 200, { ok: true, po, changed });
  } catch (e) {
    console.error('[po/update]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the purchase order.' });
  }
}
