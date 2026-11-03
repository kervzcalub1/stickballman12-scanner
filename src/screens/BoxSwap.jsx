// /no-box/box-swap — pairs received with no box and set aside (status `box_swap`) until
// their box is ready (docs/context/no-box.md "Box swap", Brent 2026-11-03). The warehouse
// sets them aside at inbound; when the boxes are ready they do what inbound does —
// scan the shoe, then the VIN sticker going on it:
//   1. scan the box UPC (or type a SKU to narrow the list, or tap a row)
//   2. scan the VIN sticker → the pair takes that number, is boxed, goes to Needs Shelf
//      (and only now reaches the PH team).
// No sticker to hand: "Print its VIN" keeps the system VIN and prints it.
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { TopBar, LabelSheet } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useLive, useMediaQuery } from '../hooks.js';
import { isVinCode, upcDigits, sizeLabel, compareSizes } from '../lib/codes.js';
import { estDate } from '../lib/format.js';
import { beepOk, beepErr } from '../lib/beep.js';
import { loadPrefs } from '../prefs.js';

const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));
const skuKey = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');

// One row per shoe + size: pairs of one size are interchangeable, so the list is a
// count to work down, not a VIN per line (the system VINs mean nothing on the floor).
function groupRows(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const k = `${skuKey(r.sku)}|${String(r.size || '').trim()}`;
    if (!m.has(k)) m.set(k, { key: k, sku: r.sku, size: r.size, name: r.name, gender: r.gender, upc: r.upc, colorway: r.colorway, units: [], pos: new Set() });
    const g = m.get(k);
    g.units.push(r);
    if (!g.upc && r.upc) g.upc = r.upc;
    if (r.po_code) g.pos.add(r.po_code);
  }
  return [...m.values()].sort((a, b) => String(a.name || a.sku).localeCompare(String(b.name || b.sku)) || compareSizes(a.size, b.size));
}

export function BoxSwap({ user, onBack, onSignOut }) {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState('');      // a typed SKU narrows the list
  const [target, setTarget] = useState(null);    // the group whose next pair gets the sticker
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);      // { kind: 'ok'|'err', text }
  const [labels, setLabels] = useState(null);    // { items, mode }
  const [showCam, setShowCam] = useState(false);
  const inputRef = useRef(null);

  async function load() {
    try { const { rows: r } = await api.boxSwapList(); setRows(r || []); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['items'], async () => {
    const { rows: r } = await api.boxSwapList();
    setRows((cur) => (JSON.stringify(cur) === JSON.stringify(r) ? cur : r));
  }, { mount: false, paused: rows == null || busy || !!labels });

  const groups = useMemo(() => groupRows(rows), [rows]);
  const shown = filter ? groups.filter((g) => skuKey(g.sku).includes(skuKey(filter)) || upcDigits(g.upc) === upcDigits(filter)) : groups;
  // The target follows the list: once its last pair is swapped it's gone.
  const liveTarget = target ? groups.find((g) => g.key === target.key) || null : null;
  useEffect(() => { if (target && rows && !liveTarget) setTarget(null); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // A tone with every answer (muted by the 🔊 toggle) — staff watch the box, not the screen.
  const say = (kind, text) => {
    setFlash({ kind, text });
    if (loadPrefs().scanSound !== false) (kind === 'ok' ? beepOk : beepErr)();
  };
  const refocus = () => { if (!isMobile) setTimeout(() => inputRef.current?.focus(), 0); };

  // ONE field, routed by what was scanned — the same rule as intake.
  async function routeScan(raw) {
    const code = String(raw || '').trim();
    setInput(''); setError('');
    if (!code) return;
    if (isVinCode(code)) {
      if (!liveTarget) {
        say('err', `Scan the shoe first (its box UPC, or tap it below) — then ${code.toUpperCase()}.`);
        api.scanFailure({ code, reason: 'box_swap_sticker_first', screen: 'box-swap' });
        return refocus();
      }
      return swap(liveTarget, code);
    }
    const digits = /^\d{8,14}$/.test(code) ? code : null;
    if (digits) {
      const hit = groups.find((g) => upcDigits(g.upc) === digits);
      if (!hit) {
        say('err', `Nothing waiting for a box swap has UPC ${digits}. Check the size on the box, or find the shoe by SKU below.`);
        api.scanFailure({ code, reason: 'box_swap_no_match', screen: 'box-swap' });
        return refocus();
      }
      setTarget(hit); setFilter('');
      say('ok', `${hit.name || hit.sku} · size ${hit.size} — now scan the VIN sticker going on it.`);
      return refocus();
    }
    // Anything else is a SKU (or part of one): narrow the list, and pick it when it's one size.
    setFilter(code);
    const hits = groups.filter((g) => skuKey(g.sku).includes(skuKey(code)));
    if (hits.length === 1) { setTarget(hits[0]); say('ok', `${hits[0].name || hits[0].sku} · size ${hits[0].size} — now scan the VIN sticker.`); }
    else if (!hits.length) say('err', `Nothing waiting for a box swap matches ${code}.`);
    else setFlash(null);
    refocus();
  }

  async function swap(g, vin) {
    setBusy(true); setError('');
    try {
      const unit = g.units[0];   // oldest first — pairs of one size are interchangeable
      const { item, from } = await api.boxSwap({ itemId: unit.id, vin: vin || undefined });
      setRows((rs) => (rs || []).filter((r) => r.id !== unit.id));
      if (vin) say('ok', `✓ ${g.name || g.sku} · size ${g.size} → ${item.vin} · boxed, now Needs Shelf.${g.units.length > 1 ? ` ${g.units.length - 1} more of this size waiting.` : ''}`);
      else {
        say('ok', `✓ ${g.name || g.sku} · size ${g.size} boxed under ${from} — print its VIN label and stick it on.`);
        setLabels({ mode: 'vin', items: [{ ...unit, ...item }] });
      }
      if (g.units.length <= 1) setTarget(null);
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      say('err', e.message);
    } finally { setBusy(false); refocus(); }
  }

  async function noBoxComing(g) {
    const unit = g.units[0];
    if (!window.confirm(`No box is coming for ${g.name || g.sku} size ${g.size}? One pair moves to the No Box queue (Print box labels), and its VIN label prints so the shoe has its sticker.`)) return;
    setBusy(true);
    try {
      await api.itemEvent(unit.vin, 'status_change', { status: 'no_box', from: 'box_swap', note: 'No box coming — moved from Box swap' });
      setRows((rs) => (rs || []).filter((r) => r.id !== unit.id));
      // A no-box pair always carries its VIN sticker — this one never got one at inbound.
      say('ok', `${g.name || g.sku} · size ${g.size} moved to No Box — print its VIN label and stick it on the shoe.`);
      setLabels({ mode: 'vin', items: [unit] });
      if (g.units.length <= 1) setTarget(null);
    } catch (e) { if (e.unauthorized) return onSignOut(); say('err', e.message); }
    finally { setBusy(false); }
  }

  const boxLabelItems = (g, n = 1) => Array.from({ length: n }, (_, i) => ({ ...g.units[i % g.units.length], upc: g.upc || g.units[0].upc }));
  const total = rows ? rows.length : 0;

  return (
    <div className="app">
      <TopBar title="Box swap" onHome={onBack} onSignOut={onSignOut} />
      <div className="card">
        <p className="muted sm">
          Pairs received <b>without a box</b> and set aside until the box is ready. They’re on their order (so it can be checked)
          but not listed and <b>not with the PH team</b>. When the box is ready: <b>scan the shoe’s UPC</b> (or tap it below),
          then <b>scan the VIN sticker</b> you put on it — it goes to Needs Shelf.
        </p>
        {flash && (
          <div className={`scan-flash ${flash.kind === 'ok' ? 'added' : 'warn'}`} role="status" aria-live="assertive">{flash.text}</div>
        )}
        {liveTarget && (
          <div className="boxswap-target">
            <div>
              <span className="muted sm">Next sticker goes on</span>
              <div><b>{liveTarget.name || liveTarget.sku}</b> · US {sizeLabel(liveTarget.size, liveTarget.gender, liveTarget.name)} <span className="muted">· {liveTarget.sku}</span></div>
              <div className="muted sm">{liveTarget.units.length} waiting in this size</div>
            </div>
            <div className="boxswap-target-actions">
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setLabels({ mode: 'upc', items: boxLabelItems(liveTarget) })}>
                <Icon name="print" /> Box label
              </button>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => swap(liveTarget, null)}
                title="No roll sticker to hand — keep the pair's own VIN and print it">
                <Icon name="print" /> No sticker? Print its VIN
              </button>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => noBoxComing(liveTarget)}>No box coming</button>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setTarget(null)}>Cancel</button>
            </div>
          </div>
        )}
        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); routeScan(input); }}>
          <input ref={inputRef} autoFocus={!isMobile} autoCapitalize="characters" autoCorrect="off" autoComplete="off"
            aria-label="Scan the shoe's UPC, a SKU, or the VIN sticker"
            placeholder={liveTarget ? 'Now scan the VIN sticker (SBM-…)' : 'Scan the box UPC — or type a SKU'}
            value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
          <button className="btn primary" disabled={busy}>{liveTarget ? 'Put on' : 'Find'}</button>
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)}>
            <Icon name="camera" /> {showCam ? 'Close camera' : 'Camera'}
          </button>
        </form>
        {showCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner continuous mode="rescale" onDetected={routeScan} onClose={() => setShowCam(false)} />
          </Suspense>
        )}
        {error && <div className="error mt">{error}</div>}
      </div>

      <div className="card">
        <div className="boxswap-head">
          <h3 className="bc-h">Waiting for a box <span className="muted sm">{total} pair{total === 1 ? '' : 's'}{filter ? ` · matching ${filter}` : ''}</span></h3>
          {filter && <button type="button" className="btn sm ghost" onClick={() => setFilter('')}>Show all</button>}
        </div>
        {!rows ? <p className="muted">Loading…</p>
          : !shown.length ? <p className="ok">{filter ? `Nothing waiting matches ${filter}.` : 'All clear — nothing waiting for a box swap.'}</p>
          : (
            <ul className="boxswap-list">
              {shown.map((g) => (
                <li key={g.key} className={liveTarget?.key === g.key ? 'on' : ''}>
                  <button type="button" className="boxswap-pick" onClick={() => { setTarget(g); setFlash(null); refocus(); }}
                    aria-label={`Swap ${g.sku} size ${g.size}`}>
                    <span className="boxswap-name"><b>{g.name || g.sku}</b><span className="muted sm"> · {g.sku}</span></span>
                    <span className="boxswap-meta">
                      <span>US {sizeLabel(g.size, g.gender, g.name)}</span>
                      <span className="boxswap-n">×{g.units.length}</span>
                    </span>
                    <span className="muted xs">
                      {g.upc ? `UPC ${g.upc}` : 'no UPC on file'}
                      {g.pos.size ? ` · ${[...g.pos].join(', ')}` : ''}
                      {` · in since ${estDate(g.units[0].created_at)}`}
                    </span>
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => setLabels({ mode: 'upc', items: boxLabelItems(g, g.units.length) })}
                    title={`Box labels for all ${g.units.length}`}><Icon name="print" /> {g.units.length > 1 ? `${g.units.length} box labels` : 'Box label'}</button>
                </li>
              ))}
            </ul>
          )}
      </div>
      {labels && <LabelSheet items={labels.items} mode={labels.mode} onClose={() => setLabels(null)} />}
    </div>
  );
}
