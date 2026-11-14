// "Fix the Product Model" (2026-11-14, owner approved): live SHEIN shoes that went out with another shoe's Product
// Model (a Setup default — "ACG Air Max", "Nike Air", "Dunk Low"). One strip on Shoes on SHEIN, shown only when
// there are any: the count + "Preview the fix" → a DRY RUN (op 'model') whose sheet shows every before → after; an
// admin / Connect-integrations holder confirms it there. Reads GET /api/shein/listings?modelFix=1 (DB only).
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { fmt } from './SheinListingsBits.jsx';
import { plain } from '../lib/sheinWords.js';

const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;

export function ModelFixStrip({ active, busy, onDryRun, onSignOut }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useLive(['shein_listing_job_items', 'shein_listing_products'], () => setTick((t) => t + 1), { mount: false });
  useEffect(() => {
    let live = true;
    api.sheinModelFix().then((r) => { if (live) { setD(r); setErr(''); } }).catch((e) => { if (!live) return; if (e.unauthorized) onSignOut?.(); else setErr(plain(e.message)); });
    return () => { live = false; };
  }, [tick]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (err || !d) return null;
  const todo = d.candidates || [];
  const sent = (d.rows || []).filter((r) => r.fixStatus);
  const typeIt = (d.rows || []).filter((r) => !r.should && !r.fixStatus);
  if (!todo.length && !typeIt.length) return null;
  const sample = todo.slice(0, 3).map((r) => `“${r.sent}” → “${r.should}”`).join(' · ');
  return (
    <div className="notice sm shl-modelfix" data-modelfix="" role="status">
      <span>
        <b>{plural(todo.length, 'shoe')} on SHEIN show{todo.length === 1 ? 's' : ''} another shoe’s Product Model</b> — the old Setup default went out with {todo.length === 1 ? 'it' : 'them'}.
        {sample ? <span className="muted xs shl-block">e.g. {sample}{todo.length > 3 ? ' …' : ''}</span> : null}
        {typeIt.length > 0 && <span className="muted xs shl-block" data-modelfix-type="">{plural(typeIt.length, 'more shoe')}: we can’t read the model from the title — type it in each shoe’s Details → SHEIN details first.</span>}
        {sent.length > 0 && <span className="muted xs shl-block" data-modelfix-sent="">{plural(sent.length, 'fix')} already sent to SHEIN (in review or done).</span>}
      </span>
      {todo.length > 0 && (
        <button type="button" className="btn sm" data-dry="model" disabled={!!busy || !!active}
          title={active ? 'A job is already running' : `Preview the fix for ${plural(todo.length, 'shoe')}: what SHEIN has now → the shoe’s own model. Nothing is sent.`}
          onClick={() => onDryRun(todo.map((r) => r.productId), ['model'])}>{busy === 'preview' ? 'Starting…' : `Preview the fix (${fmt(todo.length)})`}</button>
      )}
    </div>
  );
}
