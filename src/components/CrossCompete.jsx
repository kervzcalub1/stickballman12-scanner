// Alias Cross-Listing → ⚔ Compete (docs/context/alias-cross-listing.md → "Price compete").
// The same switches as Pre-sell Listings → ⚔ Compete (owner, 2026-11-20), over cross-listed
// pairs: master switch · 🔒 lock · "All shoes" · per shoe · per size — and under each size one
// line per SKU, because every SKU has its own market on Alias. Engine: api/_lib/cross-compete.js.
import React, { useEffect, useState } from 'react';
import { ShoeThumb } from './common.jsx';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { PH_DATETIME } from '../lib/format.js';
import { COMP_MODES, compFloor } from '../lib/presellCompete.js';

const ACTION_WORD = { down: '↓ lowered', up: '↑ raised', floor: '⛔ at the $5 floor', hold: 'held', none: 'no market', drift: '⚠ changed outside the app', error: '⚠ error', skip: 'skipped',
  restore: '🔒 put back (changed outside the app)', rebase: '↻ re-based to the market (under the floor 2 h+)' };
const c2d = (c) => (c == null ? '—' : `$${(Number(c) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const when = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : `${PH_DATETIME.format(d)} EST`; };

function Seg({ value, options, onChange, label }) {
  return (
    <div className="seg sm" role="group" aria-label={label}>
      {options.map(([k, text]) => (
        <button key={k} type="button" className={`seg-btn${value === k ? ' on' : ''}`} aria-pressed={value === k} onClick={() => onChange(k)}>{text}</button>
      ))}
    </div>
  );
}

export function CrossCompete({ canSettings }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [showLog, setShowLog] = useState(false);
  async function load() {
    try { setD(await api.crossCompete()); setError(''); }
    catch (err) { if (err?.unauthorized) return; setError(err.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['cross_groups', 'cross_pool', 'cross_listings', 'cross_comp_log', 'app_settings'], load, { mount: false, minGap: 3000 });
  async function set(body) {
    setBusy(true); setError('');
    try { setD(await api.crossCompeteSet(body)); }
    catch (err) { if (err?.unauthorized) return; setError(err.message); }
    finally { setBusy(false); }
  }
  if (!d) return <div className="card">{error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}</div>;
  const toggle = (id) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const competing = d.groups.reduce((n, g) => n + g.sizes.filter((z) => z.mode).length, 0);
  return (
    <>
      <div className="card ap-comp">
        <label className="ap-comp-master">
          <input type="checkbox" checked={d.master} disabled={busy} onChange={(e) => set({ action: 'master', on: e.target.checked })} />
          <span><b>⚔ Price compete is {d.master ? 'ON' : 'OFF'}</b>
            <span className="muted xs"> · {competing} size{competing === 1 ? '' : 's'} {d.master ? 'taking part' : 'set to take part (paused)'} · checks every {d.everyMin} min{d.lastRun ? ` · last ${when(d.lastRun)}` : ''}{d.running ? ' · running now…' : ''}</span></span>
        </label>
        <label className="ap-comp-master">
          <input type="checkbox" checked={d.lock} disabled={busy} onChange={(e) => set({ action: 'lock', on: e.target.checked })} />
          <span><b>🔒 Lock cross-listing prices is {d.lock ? 'ON' : 'OFF'}</b>
            <span className="muted xs"> · a price changed outside this app (e.g. an Alias bulk reprice) is put back at the next check — every live size, competing or not. Change prices on the Listed tab instead.</span></span>
        </label>
        {!d.alertChat && <p className="error xs">No Telegram chat is set for cross-listing — price changes are logged below but not posted.{canSettings ? ' Set one under Settings.' : ''}</p>}
        <p className="muted xs ap-comp-rules">
          Every check, per size and <b>per SKU</b> — each SKU has its own market on Alias, so each one is priced against its own lowest ask.
          If someone is <b>under</b> us, we go to their price (<b>Match</b>) or $1 under it (<b>Undercut $1</b>) — but never more than
          <b> $5 under the price we set</b>. If the market goes <b>up</b>, we follow it up (no cap). If the lowest ask is already ours, we hold.
          If the market stays <b>under the floor for 2 hours</b>, the market becomes the new “price we set” and the mode carries on from there.
          Only <b>live</b> listings move. Changing a price on the Listed tab makes that the new “price we set”.
        </p>
        <div className="ap-comp-all">
          <label className="ap-activate">
            <input type="checkbox" checked={d.all.on} disabled={busy} onChange={(e) => set({ action: 'all', on: e.target.checked, mode: d.all.mode })} />
            <span><b>All shoes</b> <span className="muted xs">— every shoe not set on its own below</span></span>
          </label>
          <Seg label="Default mode" value={d.all.mode} onChange={(m) => set({ action: 'all', on: d.all.on, mode: m })} options={Object.entries(COMP_MODES)} />
        </div>
        <div className="oo-actions">
          <button type="button" className="btn sm" disabled={busy || !(d.master || d.lock) || d.running || !d.here} onClick={() => set({ action: 'run' })}
            title={d.here ? 'Check every competing size now' : 'Only the live server moves prices'}>▶ Run now</button>
          {!d.here && <span className="muted xs">This server doesn’t move prices — only the live one does (PRESELL_WATCH).</span>}
        </div>
        {error && <div className="error mt">{error}</div>}
      </div>

      <div className="card">
        {!d.groups.length ? <p className="muted">Nothing cross-listed yet.</p> : (
          <div className="ap-groups">
            {d.groups.map((g) => {
              const own = g.setting;
              const choice = !own ? 'all' : own.enabled ? 'on' : 'off';
              const mode = own?.mode || d.all.mode;
              const on = g.sizes.filter((z) => z.mode).length;
              const isOpen = open.has(g.id);
              return (
                <div key={g.id} className={`ap-group${isOpen ? ' open' : ''}`}>
                  <button type="button" className="ap-group-head" aria-expanded={isOpen} onClick={() => toggle(g.id)}>
                    <ShoeThumb url={g.image} size={44} />
                    <span className="ap-group-main">
                      <span className="ap-group-title"><b>{g.name}</b></span>
                      <span className="muted xs ap-group-name">{g.skus.join(' · ')}</span>
                      <span className="xs">{on ? <span className="ap-comp-on">⚔ {on} of {g.sizes.length} size{g.sizes.length === 1 ? '' : 's'}</span> : <span className="muted">not competing</span>}</span>
                    </span>
                    <span className="ap-caret">{isOpen ? '▾' : '▸'}</span>
                  </button>
                  <div className="ap-group-bar ap-comp-bar">
                    <Seg label={`${g.name} competition`} value={choice} onChange={(v) => set(v === 'all' ? { action: 'group', groupId: g.id, clear: true } : { action: 'group', groupId: g.id, enabled: v === 'on', mode })}
                      options={[['all', `Follow all (${d.all.on ? 'on' : 'off'})`], ['on', 'On'], ['off', 'Off']]} />
                    {choice !== 'off' && <Seg label={`${g.name} mode`} value={mode} onChange={(m) => set({ action: 'group', groupId: g.id, enabled: choice === 'all' ? d.all.on : true, mode: m })} options={Object.entries(COMP_MODES)} />}
                    {d.here && d.master && on > 0 && <button type="button" className="btn sm ghost" disabled={busy || d.running} onClick={() => set({ action: 'run', groupId: g.id })}>▶ Run this shoe</button>}
                  </div>
                  {isOpen && (
                    <div className="ap-group-pairs">
                      {g.sizes.map((z) => (
                        <div key={z.poolId} className="ap-comp-size">
                          <div className="ap-comp-size-head">
                            <b>Size {z.size}</b>
                            <span className={z.mode ? 'ap-comp-on xs' : 'muted xs'}>{z.mode ? COMP_MODES[z.mode] : 'off'}</span>
                            <Seg label={`Size ${z.size}`} value={z.comp_override || 'shoe'} onChange={(v) => set({ action: 'size', poolId: z.poolId, override: v === 'shoe' ? null : v })}
                              options={[['shoe', 'Shoe'], ['on', 'On'], ['off', 'Off']]} />
                          </div>
                          {z.skus.map((k) => {
                            const st = k.state && k.state.at ? k.state : null;
                            if (!k.live) return <div key={k.groupSkuId} className="muted xs"><b>{k.sku}</b>: nothing live{k.off ? ` (${k.off} switched off)` : ''}</div>;
                            return (
                              <div key={k.groupSkuId} className="xs ap-comp-plat">
                                <b>{k.sku}</b> {k.live} live at <b>{c2d(st?.price ?? k.price)}</b>
                                {st?.market != null && <> · market {c2d(st.market)}</>}
                                {k.lock_cents != null && <> · 🔒 {c2d(k.lock_cents)}</>}
                                {k.base_cents != null && <> · set {c2d(k.base_cents)} → floor <b>{c2d(compFloor(k.base_cents))}</b></>}
                                {st?.far_since && <span className="error"> · market under the floor since {when(st.far_since)} (re-bases after 2 h)</span>}
                                {st && <span className="muted"> · {ACTION_WORD[st.action] || st.action} {when(st.at)}</span>}
                                {k.base_cents != null && <>{' · '}<button type="button" className="linklike xs" disabled={busy} title="Use the live price as the new “price we set” at the next check"
                                  onClick={() => set({ action: 'base', poolId: z.poolId, groupSkuId: k.groupSkuId })}>reset floor</button></>}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <button type="button" className="btn sm ghost" onClick={() => setShowLog((v) => !v)}>{showLog ? '▾' : '▸'} Price changes ({d.log.length})</button>
        {showLog && (!d.log.length ? <p className="muted">No changes yet.</p> : (
          <div className="ap-comp-log">
            {d.log.map((g) => (
              <div key={g.id} className={`ap-comp-logrow ${g.action}`}>
                <span className="muted xs">{when(g.created_at)}</span>
                <span><b>{g.sku || '—'}</b> {g.size}{g.group_name ? <span className="muted"> · {g.group_name}</span> : null}</span>
                <span>{ACTION_WORD[g.action] || g.action}{g.from_cents != null && g.to_cents != null ? ` ${c2d(g.from_cents)} → ${c2d(g.to_cents)}` : ''}
                  {g.market_cents != null ? <span className="muted"> · market {c2d(g.market_cents)}</span> : null}
                  {g.changed || g.failed ? <span className="muted"> · {g.changed} moved{g.failed ? `, ${g.failed} failed` : ''}</span> : null}</span>
                {g.note && <span className="muted xs">{g.note}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
