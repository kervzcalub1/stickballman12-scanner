// Open cases — the exception path, and the custody facts that feed it.
//
// Everything else on this screen is the happy road. What actually costs money is the
// other one: a wrong pair bought, a box that never turned up, a refund promised and
// never posted. Those used to live in a chat message, which is to say nowhere.
//
// Every case carries the same four things — an OWNER, a NEXT ACTION, a DUE DATE and, at
// the end, what actually happened. A return case is the same row with the facts a return
// needs, including the retailer's own final return date, which is the deadline that
// actually bites. And it closes on a rule of its own: **returned is not refunded.**
import React, { useState } from 'react';
import { api } from '../api.js';
import { FormModal } from './common.jsx';
import { estToday } from '../lib/format.js';

const money = (n) => (n == null ? '—' : `$${(Number(n) || 0).toFixed(2)}`);

const KIND = {
  return: { label: 'Return', cls: 'danger' },
  shortage: { label: 'Shortage', cls: 'warn' },
  followup: { label: 'Follow-up', cls: 'muted' },
};

// A due date only means something against today's EST day — the buyer may be reading
// this from Manila, where the calendar is already tomorrow.
const overdue = (d) => Boolean(d) && d < estToday();

export function BuyCartTasks({ cart, canManage, onChanged, onSignOut }) {
  const [open, setOpen] = useState(null);   // 'return' | 'followup'
  const [closing, setClosing] = useState(null);
  const [chasing, setChasing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const tasks = cart.tasks || [];
  const live = tasks.filter((t) => t.status === 'open');
  const past = tasks.filter((t) => t.status !== 'open');

  async function run(fn) {
    setBusy(true); setErr('');
    try { await fn(); await onChanged(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); throw e; }
    finally { setBusy(false); }
  }

  return (
    <section className="card bc-tasks">
      <h3 className="bc-h">
        Open cases
        <span className={live.length ? 'bc-short sm' : 'muted sm'}>
          {live.length ? `${live.length} outstanding` : 'none'}
        </span>
      </h3>

      {/* Custody. Between the till and the courier these are company shoes sitting in
          somebody's flat, and nothing recorded whose. The ship-by is what turns "he
          still hasn't sent it" from a memory into a date somebody can be asked about. */}
      <div className="bc-custody">
        <span>
          Held by <b>{cart.holder || '—'}</b>
          {cart.holder_location ? <span className="muted sm"> · {cart.holder_location}</span> : null}
        </span>
        <span className={overdue(cart.ship_by) && cart.po?.status !== 'shipped' ? 'bc-short' : ''}>
          Ship by <b>{cart.ship_by || '—'}</b>
          {overdue(cart.ship_by) && <span className="muted sm"> — overdue</span>}
        </span>
        <span>
          Funded by <b>{cart.funding_method === 'company_card' ? 'company card' : 'gift cards'}</b>
          {cart.funding_method === 'company_card' && cart.card_reference
            ? <span className="muted sm"> · ref {cart.card_reference} · {money(cart.card_authorized)} authorised</span>
            : null}
        </span>
        {canManage && (
          <span className="bc-custody-actions">
            <button type="button" className="btn sm ghost" onClick={() => setOpen('custody')}>Custody…</button>
            <button type="button" className="btn sm ghost" onClick={() => setOpen('funding')}>Funding…</button>
          </span>
        )}
      </div>

      {!tasks.length && (
        <p className="muted sm">
          Nothing outstanding. A wrong pair, a missing box or an unposted refund goes here —
          with an owner and a date, so following it up isn’t a memory test.
        </p>
      )}

      {[...live, ...past].map((t) => {
        const k = KIND[t.kind] || KIND.followup;
        return (
          <div key={t.id} className={`bc-task ${t.status}`}>
            <div className="bc-task-head">
              <span className={`po-chip ${k.cls}`}>{k.label}</span>
              <b>{t.title}</b>
              {t.status === 'open'
                ? <span className={overdue(t.due_date) ? 'bc-short sm' : 'muted sm'}>
                    due {t.due_date}{overdue(t.due_date) ? ' — overdue' : ''}
                  </span>
                : <span className={`po-chip ${t.status === 'resolved' ? 'ok' : 'muted'}`}>
                    {t.status === 'resolved' ? 'Resolved' : 'Written off'}
                  </span>}
            </div>
            <div className="muted sm">
              Owner {t.owner_name || '—'}
              {t.sku ? ` · ${t.sku}${t.size ? ` ${t.size}` : ''}${t.qty ? ` ×${t.qty}` : ''}` : ''}
              {t.cost_at_risk != null ? ` · ${money(t.cost_at_risk)} at risk` : ''}
              {/* The RETAILER'S cutoff, kept apart from our own due date: ours can be
                  moved, theirs cannot, and it is the one that decides whether this is
                  recoverable at all. */}
              {t.return_by ? ` · retailer cutoff ${t.return_by}` : ''}
            </div>
            {t.next_action && <p className="bc-task-next">{t.next_action}</p>}
            {t.return_tracking && <p className="muted xs">Return tracking {t.return_tracking}</p>}
            {t.refund_verified_at
              ? <p className="bc-covered sm">Refund of {money(t.refund_amount)} verified by {t.refund_verified_by}</p>
              : t.kind === 'return' && t.status === 'open'
                ? <p className="muted xs">Returned is not refunded — this closes when the credit has posted.</p>
                : null}
            {t.resolution && <p className="muted sm">{t.resolution}</p>}
            {canManage && t.status === 'open' && (
              <div className="bc-task-actions">
                <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setChasing(t)}>Update</button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => setClosing(t)}>Close it out</button>
              </div>
            )}
          </div>
        );
      })}

      {canManage && (
        <div className="bc-task-add">
          <button type="button" className="btn sm" disabled={busy} onClick={() => setOpen('followup')}>Open a follow-up</button>
          <button type="button" className="btn sm danger" disabled={busy} onClick={() => setOpen('return')}>Open a return case</button>
        </div>
      )}

      {(open === 'followup' || open === 'return') && (
        <FormModal
          title={open === 'return' ? 'Open a return case' : 'Open a follow-up'}
          message={open === 'return'
            ? 'Wrong shoes are frozen cash. The case stays open until the refund has actually posted — not when the parcel goes back.'
            : 'Anything still outstanding on this request. It needs an owner and a date, or it is a hope rather than a task.'}
          submitLabel="Open it"
          onClose={() => setOpen(null)}
          onSubmit={async (v) => {
            await run(() => api.cartTask(cart.id, {
              kind: open,
              title: v.title.trim(),
              nextAction: v.nextAction?.trim() || null,
              ownerName: v.ownerName.trim(),
              dueDate: v.dueDate,
              sku: v.sku?.trim() || null,
              size: v.size?.trim() || null,
              qty: v.qty ? Number(v.qty) : null,
              costAtRisk: v.costAtRisk === '' || v.costAtRisk == null ? null : Number(v.costAtRisk),
              returnBy: v.returnBy || null,
              holder: v.holder?.trim() || null,
            }));
            setOpen(null);
          }}
          fields={[
            { name: 'title', label: 'What is the case?', required: true, maxLength: 200,
              placeholder: open === 'return' ? 'e.g. 2 × 10W bought in the wrong colourway' : 'e.g. Box 2 never scanned out' },
            { name: 'ownerName', label: 'Who owns it?', required: true, maxLength: 120 },
            { name: 'dueDate', label: 'Next action due (EST)', type: 'date', required: true, value: estToday() },
            { name: 'nextAction', label: 'What happens next?', type: 'textarea', maxLength: 400 },
            ...(open === 'return' ? [
              { name: 'sku', label: 'SKU', maxLength: 60 },
              { name: 'size', label: 'Size', maxLength: 20 },
              { name: 'qty', label: 'Pairs', type: 'number', min: 1, max: 999 },
              { name: 'costAtRisk', label: 'Cost at risk', type: 'number', step: '0.01', min: 0,
                hint: 'What the company is out until this is refunded.' },
              { name: 'holder', label: 'Who has them now?', maxLength: 120 },
              { name: 'returnBy', label: 'Retailer’s final return date', type: 'date',
                hint: 'Their cutoff, not ours. It is the date that decides whether this is recoverable.' },
            ] : []),
          ]} />
      )}

      {chasing && (
        <FormModal
          title={`Update — ${chasing.title}`}
          message="Anything left blank stays as it was."
          submitLabel="Save"
          onClose={() => setChasing(null)}
          onSubmit={async (v) => {
            await run(() => api.cartTaskPatch(cart.id, chasing.id, {
              nextAction: v.nextAction?.trim() || null,
              ownerName: v.ownerName?.trim() || null,
              dueDate: v.dueDate || null,
              returnTracking: v.returnTracking?.trim() || null,
              refundAmount: v.refundAmount === '' || v.refundAmount == null ? null : Number(v.refundAmount),
            }));
            setChasing(null);
          }}
          fields={[
            { name: 'nextAction', label: 'What happens next?', type: 'textarea', maxLength: 400, value: chasing.next_action || '' },
            { name: 'ownerName', label: 'Owner', maxLength: 120, value: chasing.owner_name || '' },
            { name: 'dueDate', label: 'Next action due (EST)', type: 'date', value: chasing.due_date || '' },
            ...(chasing.kind === 'return' ? [
              { name: 'returnTracking', label: 'Return tracking', maxLength: 80, value: chasing.return_tracking || '' },
              { name: 'refundAmount', label: 'Refund expected', type: 'number', step: '0.01', min: 0,
                value: chasing.refund_amount == null ? '' : String(chasing.refund_amount) },
            ] : []),
          ]} />
      )}

      {closing && (
        <FormModal
          title={`Close out — ${closing.title}`}
          message={closing.kind === 'return'
            ? 'Resolved means the credit has POSTED. If it never will, write it off — that is a different outcome and it should read like one.'
            : 'Say how it ended. A case closed with no resolution records that somebody ticked a box.'}
          submitLabel="Close the case"
          onClose={() => setClosing(null)}
          onSubmit={async (v) => {
            await run(() => api.cartTaskClose(cart.id, closing.id, {
              status: v.outcome === 'written_off' ? 'written_off' : 'resolved',
              resolution: v.resolution.trim(),
              refundAmount: v.refundAmount === '' || v.refundAmount == null ? null : Number(v.refundAmount),
            }));
            setClosing(null);
          }}
          fields={[
            { name: 'outcome', label: 'How did it end?', type: 'select', value: 'resolved',
              options: [
                { value: 'resolved', label: closing.kind === 'return' ? 'Refund verified — money is back' : 'Resolved' },
                { value: 'written_off', label: 'Not recoverable — write it off' },
              ] },
            ...(closing.kind === 'return' ? [{
              name: 'refundAmount', label: 'Amount refunded', type: 'number', step: '0.01', min: 0,
              value: closing.refund_amount == null ? '' : String(closing.refund_amount),
            }] : []),
            { name: 'resolution', label: 'What happened?', type: 'textarea', required: true, maxLength: 500,
              placeholder: 'e.g. Credit of $184.98 posted to the card on 12 Sep' },
          ]} />
      )}

      {(open === 'custody' || open === 'funding') && (
        <FormModal
          title={open === 'custody' ? 'Who is holding the shoes?' : 'How is this funded?'}
          message={open === 'custody'
            ? 'Company inventory should not sit with a buyer without a name against it and a date it must ship by.'
            : 'Gift cards and a company card are reconciled against different evidence, so the closing conditions change with this.'}
          submitLabel="Save"
          onClose={() => setOpen(null)}
          onSubmit={async (v) => {
            await run(() => (open === 'custody'
              ? api.cartCustody(cart.id, {
                holder: v.holder?.trim() || null,
                holderLocation: v.holderLocation?.trim() || null,
                shipBy: v.shipBy || null,
              })
              : api.cartFunding(cart.id, {
                method: v.method,
                cardReference: v.cardReference?.trim() || null,
                cardAuthorized: v.cardAuthorized === '' || v.cardAuthorized == null ? null : Number(v.cardAuthorized),
              })));
            setOpen(null);
          }}
          fields={open === 'custody' ? [
            { name: 'holder', label: 'Who has them?', maxLength: 120, value: cart.holder || '' },
            { name: 'holderLocation', label: 'Where?', maxLength: 200, value: cart.holder_location || '' },
            { name: 'shipBy', label: 'Ship by (EST)', type: 'date', value: cart.ship_by || '' },
          ] : [
            { name: 'method', label: 'Funding route', type: 'select', value: cart.funding_method || 'gift_card',
              options: [
                { value: 'gift_card', label: 'Company-funded gift cards' },
                { value: 'company_card', label: 'Company credit card' },
              ] },
            { name: 'cardReference', label: 'Payment reference', maxLength: 80, value: cart.card_reference || '',
              hint: 'Something that traces back to a line on the statement.' },
            { name: 'cardAuthorized', label: 'Authorised amount', type: 'number', step: '0.01', min: 0,
              value: cart.card_authorized == null ? '' : String(cart.card_authorized) },
          ]} />
      )}

      {err && <div className="error mt">{err}</div>}
    </section>
  );
}
