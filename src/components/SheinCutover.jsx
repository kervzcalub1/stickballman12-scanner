// SHEIN Listings Phase 5 — the Setup tab's Go-live checklist and 4seller cut-over cards, and the one
// line on the connection strip once the cut-over has started (docs/context/shein-listings.md →
// "Phase 5"). Every ✓ / ✕ comes from the SERVER (api/shein/listing-cutover.js → src/lib/sheinCutover.js);
// this file only draws it. Ticks need an admin or the “Connect integrations” privilege; everyone sees
// the cards. Nothing here calls SHEIN or Shopify.
import React, { useRef, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { estToday } from '../lib/format.js';
import { TICKS, WINDOW_DAYS, SETTLE_DAYS } from '../lib/sheinCutover.js';
import { fmt, when, NEEDS_PRIV } from './SheinListingsBits.jsx';

// One fetch for the strip line and both cards (the page shell owns it).
export function useCutover(onSignOut) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  async function load() {
    const mine = ++seq.current;
    try { const r = await api.sheinCutover(); if (mine === seq.current) { setD(r); setErr(''); } } catch (e) { if (e.unauthorized) onSignOut(); else if (mine === seq.current) setErr(e.message); }
  }
  useLive(['app_settings', 'shein_listing_jobs', 'shein_listing_products'], load);
  async function act(body) {
    const r = await api.sheinCutoverAction(body);   // throws with the server's message
    seq.current += 1; setD(r); setErr('');
    return r;
  }
  return { d, err, load, act };
}

const ICON = { true: ['shl-yes', '✓', 'Passes'], false: ['shl-no', '✕', 'Not yet'], null: ['shl-wait', '…', 'On track — still counting'] };
const okAttr = (ok) => (ok === true ? 'yes' : ok === false ? 'no' : 'counting');

// A person's tick: done → who / when / the date they gave (+ Untick); not done → the date (and note) + Tick.
function TickRow({ k, tick, canWrite, onAct, blockedWhy = '', compact = false }) {
  const def = TICKS[k];
  const [date, setDate] = useState(estToday());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go(body, ask) {
    if (ask && !window.confirm(ask)) return;
    setBusy(true); setErr('');
    try { await onAct(body); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  if (tick) {
    return (
      <div className="shl-co-tick" data-tick={k} data-ticked="yes">
        <span className="sm"><span className="shl-yes">✓</span> <b>{compact ? 'Ticked' : def.label}</b>{tick.date ? <> — {def.date}: <b>{tick.date}</b></> : null}{tick.note ? <> · {tick.note}</> : null}</span>
        <span className="muted xs">Ticked by {tick.by || '—'} {when(tick.at)}</span>
        <button type="button" className="btn ghost xs" disabled={!canWrite || busy} title={canWrite ? 'Take this tick back' : NEEDS_PRIV}
          onClick={() => go({ action: 'untick', key: k }, k === 'paused_4seller' ? 'Untick “4seller paused”? The 30 days end, and the “last action” tick goes too. Only do this if 4seller is running again.' : `Untick “${def.label}”?`)}>{busy ? 'Saving…' : 'Untick'}</button>
        {err && <p className="error sm shl-block">{err}</p>}
      </div>
    );
  }
  const why = !canWrite ? NEEDS_PRIV : blockedWhy;
  return (
    <div className="shl-co-tick" data-tick={k} data-ticked="no">
      <span className="sm"><span className="shl-wait">○</span> <b>{compact ? 'Not ticked yet' : def.label}</b></span>
      <span className="shl-co-form">
        {def.date && <label className="xs shl-co-field"><span className="muted">{def.date} (EST)</span>
          <input type="date" className="shl-co-in" value={date} max={estToday()} onChange={(e) => setDate(e.target.value)} disabled={!!why || busy} aria-label={`${def.label}: ${def.date}`} /></label>}
        {def.note && <label className="xs shl-co-field"><span className="muted">{def.note}</span>
          <input type="text" className="shl-co-in" value={note} maxLength={200} placeholder="e.g. Dunk Low Panda" onChange={(e) => setNote(e.target.value)} disabled={!!why || busy} aria-label={`${def.label}: ${def.note}`} /></label>}
        <button type="button" className="btn sm shl-fix" disabled={!!why || busy || (def.date && !date)} title={why || 'Records your name and the time'}
          onClick={() => go({ action: 'tick', key: k, date: def.date ? date : undefined, note: def.note ? note : undefined })}>{busy ? 'Saving…' : 'Tick'}</button>
      </span>
      {why && why !== NEEDS_PRIV && <span className="muted xs shl-block">{why}</span>}
      {err && <p className="error sm shl-block">{err}</p>}
    </div>
  );
}

function Line({ it, children }) {
  const icon = ICON[String(it.ok)] || ICON.null;
  return (
    <div className="shl-req shl-co-line" data-line={it.key} data-ok={okAttr(it.ok)}>
      <span className={icon[0]} aria-label={icon[2]} title={icon[2]}>{icon[1]}</span>
      <span className="shl-co-body">
        <span className="shl-pub-label">{it.title}</span>
        {it.detail && <span className={`xs shl-block ${it.ok === false ? 'shl-was' : 'muted'}`} data-detail="">{it.detail}</span>}
        {(it.by || it.at) && it.ok && <span className="muted xs shl-block">{it.by ? `${it.by} · ` : ''}{when(it.at)}</span>}
        {children}
        <span className="muted xs shl-block shl-co-how">How it’s checked: {it.how}</span>
      </span>
    </div>
  );
}

/* ------------------------------- go-live ------------------------------- */
export function GoLiveCard({ cut, canWrite }) {
  const { d, err, act } = cut;
  const g = d?.golive;
  return (
    <div className="card" data-setup="golive">
      <h3 className="er-step-title">Go-live checklist</h3>
      <p className="muted sm">What has to be true before the first real send, and the three pilots after it. ✓ is read live where we can check it; the rest a person ticks (your name and the time are kept).</p>
      {err && !d && <p className="error sm">Couldn’t load the checklist: {err}</p>}
      {!d && !err && <div className="shl-skel shl-skel-row" />}
      {g && (
        <>
          <div className="shl-chiprow"><span className={`ebo-chip ${g.ready ? 'ok' : ''}`.trim()} data-golive-sum="">{fmt(g.passing)} of {fmt(g.total)} done</span></div>
          {g.items.map((it) => (
            <Line key={it.key} it={it}>
              {it.topics && <span className="xs shl-block shl-co-topics">{it.topics.map((t) => <code key={t}>{t}</code>)}</span>}
              {it.tick && <TickRow k={it.tick} tick={d.ticks[it.tick]} canWrite={canWrite} onAct={act} compact />}
            </Line>
          ))}
        </>
      )}
    </div>
  );
}

/* ------------------------------- cut-over ------------------------------- */
export function CutoverCard({ cut, canWrite, onOpenProduct, onOpenJob }) {
  const { d, err, act } = cut;
  const c = d?.cutover;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function restart() {
    if (!window.confirm(`Start the ${WINDOW_DAYS} days again from now? Use this after a miss is fixed. The 4seller-paused date stays as it is.`)) return;
    setBusy(true); setMsg('');
    try { await act({ action: 'restart' }); setMsg(`The ${WINDOW_DAYS} days start again from now.`); } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  const failedWindow = c?.items.some((i) => ['b', 'c'].includes(i.key) && i.ok === false && c.started);
  return (
    <div className="card" data-setup="cutover">
      <h3 className="er-step-title">4seller cut-over</h3>
      <p className="muted sm">Turning 4seller off for good. Once 4seller’s SHEIN sync is paused, {WINDOW_DAYS} days start; when every line below passes, 4seller can be cancelled.</p>
      {err && !d && <p className="error sm">Couldn’t load the checklist: {err}</p>}
      {!d && !err && <div className="shl-skel shl-skel-row" />}
      {c && (
        <>
          <div className="shl-chiprow" data-cutover-sum="">
            {!c.started ? <span className="ebo-chip">Not started</span>
              : <span className="ebo-chip info">Day {fmt(c.dayN)} of {WINDOW_DAYS}</span>}
            {c.started && <span className="ebo-chip">{c.complete ? `${WINDOW_DAYS} days done` : `${fmt(c.daysLeft)} day${c.daysLeft === 1 ? '' : 's'} left`}</span>}
            <span className={`ebo-chip ${c.ready ? 'ok' : ''}`.trim()}>{fmt(c.passing)} of {fmt(c.total)} pass</span>
          </div>
          {c.started && <p className="muted xs">The {WINDOW_DAYS} days started {when(c.windowStart)} (when “4seller paused” was ticked{d.ticks.paused_4seller?.restarts ? `; restarted by ${d.ticks.paused_4seller.restartedBy}` : ''}).</p>}
          {c.ready && <p className="shl-co-ready" role="status" data-ready=""><b>Ready to cancel 4seller.</b> Every line passes — the 4seller subscription can be cancelled.</p>}
          {c.items.map((it) => (
            <Line key={it.key} it={it}>
              {it.ticks && it.ticks.map((k) => <TickRow key={k} k={k} tick={d.ticks[k]} canWrite={canWrite} onAct={act}
                blockedWhy={k === 'last_action_4seller' && !d.ticks.paused_4seller ? 'Tick “4seller paused” first.' : ''} />)}
              {it.shoes?.length > 0 && (
                <ul className="shl-co-list xs">
                  {it.shoes.slice(0, 12).map((s) => (
                    <li key={s.id} data-shoe={s.id}>
                      <button type="button" className="shl-linkbtn" onClick={() => onOpenProduct?.(s.id)}>{s.title || s.id}</button>
                      {s.style && !String(s.title || '').includes(s.style) ? <span className="muted"> · {s.style}</span> : null}
                      <span className={s.state === 'waiting' ? 'muted' : 'shl-was'}> — {s.state === 'waiting' ? `new ${when(s.firstSeen)}, ${SETTLE_LEFT(s)}` : s.state === 'late' ? `answered after ${fmt(s.days)} days` : `no answer for ${fmt(s.days)} days`}</span>
                    </li>
                  ))}
                  {it.shoes.length > 12 && <li className="muted">… and {fmt(it.shoes.length - 12)} more</li>}
                </ul>
              )}
              {it.jobs?.length > 0 && (
                <span className="xs shl-block">{it.jobs.map((j) => <button key={j.id} type="button" className="btn ghost xs shl-co-job" onClick={() => onOpenJob?.(j.id)}>Job #{j.id} · {JOB_KIND[j.kind] || j.kind} · {fmt(j.done)} of {fmt(j.total)} →</button>)}</span>
              )}
              {it.numbers && it.numbers.byCode.length > 0 && (
                <span className="muted xs shl-block">Blocked by SHEIN: {it.numbers.byCode.map((b) => `${b.code.replace(/_/g, ' ')} ${fmt(b.sizes)}`).join(' · ')}</span>
              )}
            </Line>
          ))}
          {failedWindow && (
            <div className="er-actions">
              <span className="muted xs shl-grow">A miss means the {WINDOW_DAYS} days weren’t clean. Fix what it names, then start them again.</span>
              <button type="button" className="btn ghost sm" disabled={!canWrite || busy} title={canWrite ? 'The paused date is kept' : NEEDS_PRIV} onClick={restart}>{busy ? 'Saving…' : `Start the ${WINDOW_DAYS} days again`}</button>
            </div>
          )}
          {msg && <p className="muted sm">{msg}</p>}
          {!canWrite && <p className="muted xs mt">An admin, or someone with the Connect integrations privilege, ticks these lines. Everyone can see them.</p>}
        </>
      )}
    </div>
  );
}
const JOB_KIND = { snapshot: 'Re-read', probe: 'Ask SHEIN', preview: 'Dry run', run: 'Send', recheck: 'Re-check' };
const SETTLE_LEFT = (s) => `still inside its ${SETTLE_DAYS} days (status: ${String(s.status || '').replace(/_/g, ' ')})`;

// The connection strip's one line, once the cut-over has started.
export function CutoverStripLine({ cut, onOpen }) {
  const c = cut.d?.cutover;
  if (!c?.started) return null;
  return (
    <span className="sm" data-cutover-line="">
      4seller cut-over:{' '}
      <button type="button" className="shl-linkbtn" onClick={onOpen}>
        {c.ready ? <b className="ebl-ok">Ready to cancel 4seller</b> : <>day {fmt(c.dayN)} of {WINDOW_DAYS} · {fmt(c.passing)} of {fmt(c.total)} pass</>}
      </button>
    </span>
  );
}
