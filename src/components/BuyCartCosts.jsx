// The request's cost stack — what a pair on it actually costs the company.
//
// Every "Lands at" on the request is this stack applied to a shelf price, so when it is
// empty the screen quietly stops saying anything: each pair lands at exactly its
// sticker, no payout clears a threshold, and the Call column is blank on every line. And
// empty is the NORMAL state for a new buyer — the stack is snapshotted from the buyer's
// payout preset when the request is opened, and buyers do not manage their own presets.
//
// So the desk that is being asked to release the money can state it. Approvers and
// auditors only: the buyer says what the sticker says, the company says what the sticker
// costs it. Saving re-prices every line against the new rates using the market prices
// already captured on them, and writes the before-and-after into the request's history.
import React, { useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { NumField } from './common.jsx';
import { calcCostBreakdown } from '../lib/payout.js';

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const pct = (n) => `${Number(n) || 0}%`;

// The seven fields, in the order they hit the register: the three compounding discounts,
// then the flat coupon's neighbours, then what is added on top. Same order and the same
// labels as the Payout Calculator, because they are the same numbers.
export const COST_FIELDS = [
  { key: 'storePct', label: 'Store discount', unit: '%' },
  { key: 'promoPct', label: 'Promo / birthday', unit: '%' },
  { key: 'giftPct', label: 'Gift card', unit: '%' },
  { key: 'cashbackPct', label: 'Cashback', unit: '%' },
  { key: 'taxPct', label: 'Sales tax', unit: '%' },
  { key: 'tipAmt', label: 'Tip', unit: '$' },
  { key: 'shippingAmt', label: 'Shipping', unit: '$' },
];

const val = (stack, key) => {
  const n = Number(stack?.[key]);
  return Number.isFinite(n) ? n : 0;
};
const isEmpty = (stack) => !stack || COST_FIELDS.every((f) => val(stack, f.key) === 0);

export function BuyCartCosts({ cart, canEdit, onChanged, onSignOut }) {
  const stack = cart.cost_stack || null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  // One chip being typed into, in place. Correcting a single rate is what actually
  // happens — somebody reads the receipt and the tax is 6% not 8.25% — and opening a
  // seven-box form to change one number is a form you have to re-read before you can
  // trust that you only changed the one.
  const [chip, setChip] = useState(null);          // { key, value } or null
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const chipInput = useRef(null);

  // Focus follows a TAP, which is the case iOS allows — the rule this app keeps
  // breaking is auto-focusing on mount, where the DOM takes focus and the keyboard
  // never appears. Nothing depends on it either way: the input is under the finger
  // that just opened it.
  useLayoutEffect(() => { if (chip) chipInput.current?.focus(); }, [chip?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // The last time anybody wrote it, off the trail rather than off a column: the events
  // are already the record, and a second copy on the row is a second thing to keep true.
  const lastEdit = (cart.events || []).find((e) => e.kind === 'costs_edited');

  function open() {
    setDraft(Object.fromEntries(COST_FIELDS.map((f) => {
      const n = val(stack, f.key);
      return [f.key, n ? String(n) : ''];
    })));
    setErr(''); setEditing(true);
  }

  // What is on screen right now, including a chip mid-type — so the landed total below
  // moves as you type a rate rather than after you commit it.
  const live = editing ? draft
    : chip ? { ...(stack || {}), [chip.key]: Number(chip.value) || 0 }
      : (stack || {});
  // What the edit actually does to this request, in the only terms that matter: the
  // pairs on it. Shown live while typing, so a rate is never saved on faith.
  const shelfTotal = (cart.lines || [])
    .filter((l) => l.status !== 'rejected')
    .reduce((n, l) => n + (Number(l.shelf_price) || 0) * (Number(l.qty) || 0), 0);
  const landedTotal = (cart.lines || [])
    .filter((l) => l.status !== 'rejected')
    .reduce((n, l) => {
      const shelf = Number(l.shelf_price) || 0;
      if (!(shelf > 0)) return n;
      return n + calcCostBreakdown({ ...live, shelfPrice: shelf }).finalCost * (Number(l.qty) || 0);
    }, 0);

  // One writer for both editors. The endpoint takes the WHOLE stack every time — a
  // stack is stated as a whole, and a partial write would leave "what did this cost"
  // answerable only by replaying the trail.
  async function commit(next) {
    setBusy(true); setErr('');
    try {
      await api.cartSetCosts(cart.id, next);
      onChanged();
      return true;
    } catch (e) {
      if (e.unauthorized) { onSignOut(); return false; }
      setErr(e.message); return false;
    } finally { setBusy(false); }
  }

  async function save() {
    const ok = await commit(Object.fromEntries(
      COST_FIELDS.map((f) => [f.key, Number(draft[f.key]) || 0])));
    if (ok) setEditing(false);
  }

  // Committing a chip has to survive being asked twice. Enter fires it, and the input
  // then goes `disabled` while it saves — which BLURS a focused element, firing onBlur
  // straight into a second identical write. A ref, not `busy`: the blur arrives during
  // React's commit, before any re-rendered handler could see the new state.
  const inFlight = useRef(false);
  function saveChip() {
    if (!chip || inFlight.current) return;
    const { key, value } = chip;
    const next = Object.fromEntries(COST_FIELDS.map((f) => [f.key, val(stack, f.key)]));
    const was = next[key];
    next[key] = Number(value) || 0;
    // Nothing typed, or typed back to what it was: close without a write, so the
    // history doesn't fill with edits that changed nothing.
    if (next[key] === was) { setChip(null); return; }
    inFlight.current = true;
    commit(next)
      // Only close the chip that was saved. Tapping straight from one rate to the next
      // blurs the first and opens the second, and this landing later must not shut it.
      .then(() => setChip((c) => (c && c.key === key ? null : c)))
      .finally(() => { inFlight.current = false; });
  }

  return (
    <section className="card bc-costs">
      <h3 className="bc-h">
        What a pair costs us{' '}
        <span className="muted sm">
          {stack?.presetName ? `${stack.presetName}’s stack` : isEmpty(stack) ? 'not set' : 'set by hand'}
        </span>
      </h3>

      {isEmpty(stack) && !editing && (
        <p className="bc-costs-none">
          No costs are on this request, so every pair “lands at” its shelf price and no buy
          call can be made. {canEdit ? 'Enter what the store actually charges — discounts, tax, shipping — and every line re-prices.'
            : 'Somebody who can approve or audit this request needs to enter them.'}
        </p>
      )}

      {!editing && !isEmpty(stack) && (
        <>
          <div className="bc-costs-strip">
            {COST_FIELDS.map((f) => {
              const n = val(stack, f.key);
              const shown = f.unit === '%' ? pct(n) : money(n);
              // Being typed into: the chip keeps its label and swaps its value for an
              // input, so nothing moves under the finger that opened it.
              if (chip?.key === f.key) {
                return (
                  <span key={f.key} className="bc-cost-chip on">
                    {f.label}{' '}
                    {f.unit === '$' && <span aria-hidden="true">$</span>}
                    <input ref={chipInput} className="bc-cost-input" type="number" min="0" step="0.01"
                      inputMode="decimal" disabled={busy} value={chip.value}
                      aria-label={f.label}
                      onChange={(e) => setChip({ key: f.key, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); saveChip(); }
                        if (e.key === 'Escape') { e.preventDefault(); setChip(null); }
                      }}
                      // Leaving the box commits it. A rate typed and then clicked away
                      // from is a rate somebody meant to change, and losing it silently
                      // is worse than one extra line in the history.
                      onBlur={saveChip} />
                    {f.unit === '%' && <span aria-hidden="true">%</span>}
                  </span>
                );
              }
              if (!canEdit) {
                return (
                  <span key={f.key} className={`bc-cost-chip${n === 0 ? ' zero' : ''}`}>
                    {f.label} <b>{shown}</b>
                  </span>
                );
              }
              return (
                <button key={f.key} type="button" disabled={busy}
                  className={`bc-cost-chip editable${n === 0 ? ' zero' : ''}`}
                  title={`Change the ${f.label.toLowerCase()}`}
                  onClick={() => { setErr(''); setChip({ key: f.key, value: n ? String(n) : '' }); }}>
                  {f.label} <b>{shown}</b>
                </button>
              );
            })}
          </div>
          {canEdit && (
            <p className="muted xs bc-costs-hint">
              {chip
                ? 'Enter to save · Esc to leave it as it was. Every line re-prices, and the change is recorded against your name.'
                : 'Tap a rate to change it.'}
            </p>
          )}
        </>
      )}

      {editing && (
        <>
          <div className="pc-grid three">
            {COST_FIELDS.map((f) => (
              <NumField key={f.key} label={f.label} disabled={busy}
                prefix={f.unit === '$' ? '$' : undefined}
                suffix={f.unit === '%' ? '%' : undefined}
                placeholder={f.unit === '$' ? '0.00' : '0'}
                value={draft[f.key] ?? ''}
                onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} />
            ))}
          </div>
          <p className="muted sm">
            The three percentages compound — each comes off what’s left, not off the shelf
            price — then tax, tip and shipping go on top. A blank box is zero. Saving
            re-prices every line against the market prices already on it; it never
            re-checks the market, so the call still answers at the prices the buyer saw.
          </p>
        </>
      )}

      <div className="bc-costs-foot">
        <span className="bc-costs-effect">
          {shelfTotal > 0
            ? <>{money(shelfTotal)} on the shelf lands at <b>{money(landedTotal)}</b>{editing ? ' with these rates' : ''}</>
            : 'Nothing on the request to cost yet.'}
        </span>
        <span className="bc-costs-spacer" />
        {!editing && lastEdit && (
          <span className="muted xs">Last set by {lastEdit.actor_name || 'system'}</span>
        )}
        {!editing && canEdit && (
          <button type="button" className={`btn sm ${isEmpty(stack) ? 'primary' : 'ghost'}`}
            disabled={busy} onClick={open}>
            {isEmpty(stack) ? 'Enter the costs' : 'Edit all seven'}
          </button>
        )}
        {editing && (
          <>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="btn sm primary" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Save costs'}
            </button>
          </>
        )}
      </div>
      {err && <div className="error mt">{err}</div>}
    </section>
  );
}
