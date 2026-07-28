// Discrepancy resolution: the checklist and the internal thread, both shown on the
// reconciliation report under the expected-vs-received table.
//
// The checklist is what happens AFTER an order comes up short — chase the supplier,
// agree a refund or a reship, wait for it to land. Four steps, and the middle two change
// shape depending on the outcome. Every tick is reversible: a refund that never arrives
// has to be re-openable.
//
// The thread is INTERNAL. Warehouse and PH talk freely here; the supplier reads the
// single note above it, written on purpose for them. Ticking a step drops a system line
// into the same timeline, so the thread doubles as the audit trail.
import React, { useState } from 'react';
import { Icon } from './NavIcons.jsx';

const OUTCOMES = [
  { key: 'refund', label: 'Refund' },
  { key: 'replacement', label: 'Replacement' },
  { key: 'writeoff', label: 'Write off' },
];

const STEP_LABEL = {
  contacted: 'Supplier contacted',
  outcome: 'Outcome agreed',
  reference: 'Reference logged',
  settled: 'Settled',
};

// The settled step reads differently per outcome — "Refund received" and "Replacement
// received" are the same row in the machine but not the same sentence to a person.
function settledLabel(outcome) {
  if (outcome === 'refund') return 'Refund received';
  if (outcome === 'replacement') return 'Replacement received';
  if (outcome === 'writeoff') return 'Written off';
  return 'Settled';
}
function referenceLabel(outcome) {
  return outcome === 'replacement' ? 'Replacement tracking logged' : 'Credit reference logged';
}

const money = (v) => (v == null ? null : Number(v).toFixed(2));
const stamp = (by, at) => [by, at ? String(at).slice(0, 10) : null].filter(Boolean).join(' · ');

export function PoResolution({ resolution, steps, comments, onStep, onComment, busy }) {
  const r = resolution || {};
  const outcome = r.outcome || null;
  const list = steps && steps.length ? steps : ['contacted', 'outcome', 'reference', 'settled'];

  // Draft state for the two steps that need a value typed before they can be ticked.
  const [refValue, setRefValue] = useState('');
  const [refAmount, setRefAmount] = useState('');
  const [gotAmount, setGotAmount] = useState('');
  const [draft, setDraft] = useState('');

  const done = (step) => {
    if (step === 'contacted') return !!r.contacted_at;
    if (step === 'outcome') return !!r.outcome_at && !!r.outcome;
    if (step === 'reference') return !!r.ref_at;
    if (step === 'settled') return !!r.settled_at;
    return false;
  };
  // A step only opens once the one before it is done — the order is the SOP, and an
  // out-of-order tick is nearly always a mis-tap.
  const reachable = (step) => {
    const i = list.indexOf(step);
    return i <= 0 || done(list[i - 1]);
  };

  const post = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    await onComment(body);
  };

  const row = (step) => {
    const isDone = done(step);
    const open = reachable(step);
    const label = step === 'settled' ? settledLabel(outcome)
      : step === 'reference' ? referenceLabel(outcome)
      : STEP_LABEL[step];

    return (
      <div className={`rsl-step${isDone ? ' done' : ''}${open ? '' : ' locked'}`} key={step}>
        <button
          className="rsl-tick"
          disabled={busy || !open || (!isDone && (step === 'outcome' || (step === 'reference' && outcome !== 'writeoff')))}
          title={isDone ? 'Un-tick this step' : 'Mark done'}
          onClick={() => onStep({ step, undo: isDone })}>
          {isDone ? '☑' : '☐'}
        </button>
        <div className="rsl-body">
          <div className="rsl-line">
            <span className="rsl-label">{label}</span>
            {isDone && (
              <span className="muted xs">
                {step === 'contacted' && stamp(r.contacted_by, r.contacted_at)}
                {step === 'outcome' && stamp(r.outcome_by, r.outcome_at)}
                {step === 'reference' && stamp(r.ref_by, r.ref_at)}
                {step === 'settled' && (r.settled_by ? stamp(r.settled_by, r.settled_at) : `automatic · ${String(r.settled_at).slice(0, 10)}`)}
              </span>
            )}
          </div>

          {/* Outcome — the branch. Picking one reshapes the two steps below. */}
          {step === 'outcome' && open && (
            <div className="rsl-choices">
              {OUTCOMES.map((o) => (
                <button key={o.key} disabled={busy}
                  className={`rsl-choice${outcome === o.key ? ' on' : ''}`}
                  onClick={() => onStep({ step: 'outcome', outcome: o.key })}>
                  {o.label}
                </button>
              ))}
              {outcome && (
                <button className="rsl-clear" disabled={busy} onClick={() => onStep({ step: 'outcome', undo: true })}>
                  Clear
                </button>
              )}
            </div>
          )}

          {/* Reference — a credit note + the agreed amount, or the reship's tracking. */}
          {step === 'reference' && open && !isDone && outcome && (
            <div className="rsl-form">
              <input className="rsl-input" value={refValue} disabled={busy}
                onChange={(e) => setRefValue(e.target.value)}
                placeholder={outcome === 'replacement' ? 'Tracking number' : 'Credit note / invoice ref'} />
              {outcome === 'refund' && (
                <input className="rsl-input rsl-amount" value={refAmount} disabled={busy}
                  inputMode="decimal" onChange={(e) => setRefAmount(e.target.value)}
                  placeholder="Amount agreed" />
              )}
              <button className="btn sm" disabled={busy || !refValue.trim()}
                onClick={() => onStep({ step: 'reference', value: refValue.trim(), amount: refAmount })}>
                Save
              </button>
            </div>
          )}
          {step === 'reference' && isDone && (
            <p className="rsl-detail">
              <b>{r.ref_value}</b>
              {r.ref_amount != null && <> · {money(r.ref_amount)} agreed</>}
              {outcome === 'replacement' && <> · added to this PO as a tracked label</>}
            </p>
          )}

          {/* Settled — for a refund, what actually landed. */}
          {step === 'settled' && open && !isDone && outcome === 'refund' && (
            <div className="rsl-form">
              <input className="rsl-input rsl-amount" value={gotAmount} disabled={busy}
                inputMode="decimal" onChange={(e) => setGotAmount(e.target.value)}
                placeholder="Amount received" />
              <button className="btn sm" disabled={busy || !gotAmount.trim()}
                onClick={() => onStep({ step: 'settled', amount: gotAmount })}>
                Save
              </button>
            </div>
          )}
          {step === 'settled' && isDone && r.settled_amount != null && (
            <p className="rsl-detail">
              {money(r.settled_amount)} received
              {r.shortfall > 0
                ? <span className="rsl-short"> · {money(r.shortfall)} short of what was agreed</span>
                : null}
            </p>
          )}
          {step === 'settled' && open && !isDone && outcome === 'replacement' && (
            <p className="muted xs">Ticks itself once the reship is scanned in and the order adds up.</p>
          )}
        </div>
      </div>
    );
  };

  const doneCount = list.filter(done).length;

  return (
    <>
      <div className="card">
        <div className="rsl-head">
          <h4 className="rows-title">Resolution</h4>
          <span className={`po-flag ${doneCount === list.length ? 'ok' : ''}`}>
            {doneCount} of {list.length}
          </span>
        </div>
        {r.shortfall > 0 && (
          <p className="rsl-alert">
            The refund came in <b>{money(r.shortfall)}</b> under the {money(r.ref_amount)} agreed.
          </p>
        )}
        <div className="rsl-steps">{list.map(row)}</div>
      </div>

      <div className="card">
        <div className="rsl-head">
          <h4 className="rows-title">Internal notes</h4>
          <span className="muted xs">Warehouse &amp; PH only — the supplier can’t see these</span>
        </div>
        <div className="rsl-thread">
          {(comments || []).length === 0
            ? <p className="muted sm">Nothing yet. Anything you write here stays between the two teams.</p>
            : comments.map((c) => (
              c.kind === 'system' ? (
                <div className="rsl-sys" key={c.id}>
                  <Icon name="reconcile" /> {c.body}
                  <span className="muted xs"> · {String(c.created_at).slice(0, 10)}</span>
                </div>
              ) : (
                <div className="rsl-msg" key={c.id}>
                  <div className="rsl-msg-head">
                    {c.author_name || 'Someone'} · {String(c.created_at).slice(0, 16).replace('T', ' ')}
                  </div>
                  <div className="rsl-msg-body">{c.body}</div>
                </div>
              )
            ))}
        </div>
        <div className="rsl-compose">
          <textarea className="rsl-input" rows={2} maxLength={2000} value={draft} disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What's happening with this one?" />
          <button className="btn sm" disabled={busy || !draft.trim()} onClick={post}>Post</button>
        </div>
      </div>
    </>
  );
}
