// eBay Listings (PH) — a READ-ONLY view of everything live on eBay, next to what we hold
// (docs/context/ebay-listings.md). Phase 1 of the listings hub (docs/listings-hub-plan.md):
// connect the account once, pull, look. Nothing on this page changes eBay.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TopBar, Modal } from '../components/common.jsx';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estDate, PH_DATETIME } from '../lib/format.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const when = (iso) => (iso ? `${PH_DATETIME.format(new Date(iso))} EST` : '—');
const SHOW = 100;   // listings shown before "Show all"

// One listing (the eBay item) with its sizes under it. Price shown as a range when sizes
// differ; quantities summed.
// Why a listing is not in Shopify (api/_lib/ebay-orphans.js) — the short words for a card.
const VERDICT = {
  deleted: ['Product deleted in Shopify', 'bad'],
  size_removed: ['Size removed in Shopify', 'bad'],
  recreated_on_ebay: ['Re-created in Shopify — new one is on eBay too (duplicate)', 'warn'],
  recreated_not_synced: ['Re-created in Shopify — new one NOT on eBay yet', 'warn'],
  no_style: ['Not in Shopify (no style code in the title)', 'muted'],
};

function groupListings(rows) {
  const by = new Map();
  for (const r of rows) {
    let g = by.get(r.item_id);
    if (!g) {
      g = { item_id: r.item_id, title: r.title, style: r.style, item_sku: r.item_sku, image_url: r.image_url, view_url: r.view_url,
        watch_count: r.watch_count, listing_type: r.listing_type, start_time: r.start_time, sizes: [], available: 0, sold: 0, min: null, max: null };
      by.set(r.item_id, g);
    }
    g.sizes.push(r);
    g.available += Number(r.qty_available || 0);
    g.sold += Number(r.qty_sold || 0);
    const p = r.price == null ? null : Number(r.price);
    if (p != null) { g.min = g.min == null ? p : Math.min(g.min, p); g.max = g.max == null ? p : Math.max(g.max, p); }
  }
  return [...by.values()];
}
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const priceRange = (g) => (g.min == null ? '—' : g.min === g.max ? money(g.min) : `${money(g.min)}–${money(g.max)}`);

function Thumb({ src, alt }) {
  const [bad, setBad] = useState(false);
  return src && !bad
    ? <img className="ebl-thumb" src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)} />
    : <span className="ebl-thumb ebl-thumb-empty" aria-hidden="true" />;
}

export function EbayListings({ user, onHome, onSignOut }) {
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
  const [st, setSt] = useState(null);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [q, setQ] = useQueryParam('q', '');
  const [view, setView] = useQueryParam('view', 'all');   // all | out | nostyle
  const [tab, setTab] = useQueryParam('tab', 'all');      // all | orphans | ended
  const [more, setMore] = useState(false);

  async function load() {
    try {
      const [s, l] = await Promise.all([api.ebayStatus(), api.ebayListings()]);
      setSt(s); setRows(l.rows || []);
    } catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['ebay_listings', 'app_settings'], load, { mount: false });

  // Back from eBay's approval page: say how it went, then drop it from the URL.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('ebay') === 'connected') setNotice(`eBay connected${p.get('ebay_user') ? ` as ${p.get('ebay_user')}` : ''}. Press Pull listings to read what’s live.`);
    if (p.get('ebay_error')) setErr(p.get('ebay_error'));
    if (p.get('ebay') || p.get('ebay_error')) {
      ['ebay', 'ebay_user', 'ebay_error'].forEach((k) => p.delete(k));
      window.history.replaceState(null, '', `${window.location.pathname}${p.toString() ? `?${p}` : ''}`);
    }
  }, []);

  async function connect() {
    setBusy('connect'); setErr('');
    try { const r = await api.ebayConnect(); window.location.href = r.url; }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); setBusy(''); }
  }
  async function disconnectNow() {
    if (!window.confirm('Forget the eBay connection? Pulling stops until someone connects again. Nothing on eBay changes.')) return;
    setBusy('disconnect'); setErr('');
    try { await api.ebayDisconnect(); await load(); setNotice('eBay disconnected.'); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setBusy(''); }
  }
  async function pull() {
    setBusy('pull'); setErr(''); setNotice('');
    try { await api.ebayPull(); await load(); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setBusy(''); }
  }

  const listings = useMemo(() => groupListings(rows || []), [rows]);
  // Listings EVERY size of which is gone from Shopify — the ones that can be ended whole.
  const orphanListings = useMemo(() => listings.filter((g) => g.sizes.every((s) => s.in_shopify === false)), [listings]);
  const counts = useMemo(() => ({
    all: listings.length,
    out: listings.filter((g) => g.available === 0).length,
    nostyle: listings.filter((g) => !g.style).length,
  }), [listings]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return listings.filter((g) => (view === 'all' || (view === 'out' && g.available === 0) || (view === 'nostyle' && !g.style))
      && (!needle || [g.title, g.style, g.item_sku, g.item_id, ...g.sizes.flatMap((s) => [s.sku, s.size])]
        .some((v) => String(v || '').toLowerCase().includes(needle))));
  }, [listings, q, view]);
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const pullState = st?.pull;
  const running = pullState?.state === 'running';

  return (
    <div className="app">
      <TopBar title="eBay Listings" onHome={onHome} onSignOut={onSignOut} />
      {err && <div className="error mt">{err}</div>}
      {notice && <div className="notice mt">{notice}</div>}

      <div className="card">
        <h3 className="er-step-title">eBay account</h3>
        <p className="muted sm">Pulls what’s live on eBay — photos, sizes, Custom labels, prices and quantities — and checks each Custom label against Shopify. It never changes a price or quantity (DPL, Shopify → eBay, still does); the one thing it can do is end listings that are no longer in Shopify.</p>
        {!st ? <p className="muted">Loading…</p> : !st.configured ? (
          <p className="sm">eBay isn’t set up on this server yet{isAdmin && st.missing?.length ? <> — missing <b>{st.missing.join(', ')}</b> on Railway</> : ''}.</p>
        ) : st.connected ? (
          <div className="ebl-account">
            <span className="ebl-ok">● Connected{st.user ? <> as <b>{st.user}</b></> : ''}{st.sandbox ? ' (sandbox)' : ''}</span>
            <span className="muted sm">Approved {st.connectedAt ? estDate(st.connectedAt) : ''}{st.connectedBy ? ` by ${st.connectedBy}` : ''} · access good until {st.refreshExpiresAt ? estDate(st.refreshExpiresAt) : '—'}</span>
            {isAdmin && <button type="button" className="btn ghost sm" disabled={!!busy} onClick={disconnectNow}>Disconnect</button>}
          </div>
        ) : isAdmin ? (
          <div className="ebl-account">
            <button type="button" className="btn primary" disabled={!!busy || !st.secrets} onClick={connect}>{busy === 'connect' ? 'Opening eBay…' : 'Connect eBay'}</button>
            <span className="muted sm">Opens eBay’s sign-in. Sign in as the <b>seller account</b> and press Agree — you come back here.</span>
            {!st.secrets && <span className="error xs">BUY_GC_KEY isn’t set — the eBay token is stored encrypted or not at all.</span>}
          </div>
        ) : <p className="sm">Not connected yet — an admin connects the eBay account once.</p>}
      </div>

      {st?.connected && (
        <div className="card">
          <div className="ebl-pullbar">
            <button type="button" className="btn primary" disabled={!!busy || running} onClick={pull}>
              {running ? (pullState.page === 'shopify' ? 'Checking against Shopify…' : `Pulling… page ${pullState.page || 0}${pullState.pages ? ` of ${pullState.pages}` : ''}`) : busy === 'pull' ? 'Starting…' : '↻ Pull listings from eBay'}</button>
            {pullState?.state === 'done' && (
              <span className="muted sm">Last pulled {when(pullState.finishedAt)}{pullState.by ? ` by ${pullState.by}` : ''} — {fmt(pullState.listings)} listings, {fmt(pullState.rows)} sizes{pullState.removed ? `, ${fmt(pullState.removed)} ended since the pull before` : ''}.{pullState.orphans != null ? ` Shopify check: ${fmt(pullState.orphans)} size${pullState.orphans === 1 ? '' : 's'} not in Shopify.` : pullState.shopifyError ? ` Shopify check skipped: ${pullState.shopifyError}` : ''}</span>
            )}
            {pullState?.state === 'failed' && <span className="error xs">Last pull failed {when(pullState.finishedAt)}: {pullState.error}</span>}
          </div>
          {pullState?.state === 'done' && pullState.inventoryItems == null && pullState.inventoryError && (
            <p className="muted xs">Listing model: couldn’t tell — eBay answered {pullState.inventoryError}.</p>
          )}
          {pullState?.state === 'done' && pullState.inventoryItems != null && (
            <p className="muted xs">
              {pullState.inventoryItems === 0
                ? 'Listing model: classic (Trading API) — no Inventory-API items on the account. Price/quantity changes later go through the Trading API.'
                : `Listing model: ${fmt(pullState.inventoryItems)} Inventory-API item${pullState.inventoryItems === 1 ? '' : 's'} on the account — some or all listings use eBay’s newer model.`}
            </p>
          )}
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="ebl-tabs seg">
          <button type="button" className={`seg-btn${tab === 'all' ? ' on' : ''}`} onClick={() => setTab('all')}>All listings <span className="seg-n">{fmt(listings.length)}</span></button>
          <button type="button" className={`seg-btn${tab === 'orphans' ? ' on' : ''}`} onClick={() => setTab('orphans')}>Not in Shopify — end <span className="seg-n">{fmt(orphanListings.length)}</span></button>
          <button type="button" className={`seg-btn${tab === 'ended' ? ' on' : ''}`} onClick={() => setTab('ended')}>Ended</button>
        </div>
      )}
      {tab === 'orphans' && rows && <OrphansTab orphans={orphanListings} checked={rows.some((r) => r.in_shopify != null)} isAdmin={isAdmin}
        onSignOut={onSignOut} onEnded={load} onConnect={connect} />}
      {tab === 'ended' && <EndedTab onSignOut={onSignOut} />}
      {tab === 'all' && rows && rows.length > 0 && (
        <div className="card">
          <div className="ebl-filters">
            <input type="search" className="input" value={q} onChange={(e) => { setQ(e.target.value); setMore(false); }}
              placeholder="Search title, style, Custom label (SKU), item #, size…" aria-label="Search eBay listings" />
            <div className="seg sm">
              {[['all', 'All'], ['out', 'Out of stock on eBay'], ['nostyle', 'No style code']].map(([k, label]) => (
                <button key={k} type="button" className={`seg-btn${view === k ? ' on' : ''}`} aria-pressed={view === k}
                  onClick={() => { setView(k); setMore(false); }}>{label} <span className="seg-n" aria-hidden="true">{fmt(counts[k])}</span></button>
              ))}
            </div>
          </div>
          <p className="muted xs">{fmt(listings.length)} listings · {fmt(rows.length)} sizes · as eBay reported them at the last pull. Tap a listing for its sizes.</p>
          <div className="ap-tablewrap">
            <table className="table ebl-table">
              <thead><tr><th aria-label="Photo" /><th>Listing</th><th>Style</th><th>Custom label (SKU)</th><th>Price</th><th className="num">Avail.</th><th className="num">Sold</th><th className="num" title="Watchers">👁</th></tr></thead>
              <tbody>
                {shown.slice(0, more ? shown.length : SHOW).map((g) => {
                  const isOpen = open.has(g.item_id);
                  const multi = g.sizes.length > 1 || g.sizes[0]?.size;
                  return (
                    <React.Fragment key={g.item_id}>
                      <tr className={`ebl-row${isOpen ? ' open' : ''}${multi ? ' clickable' : ''}`} onClick={() => multi && toggle(g.item_id)}>
                        <td className="ebl-thumb-cell"><Thumb src={g.image_url} alt={g.title} /></td>
                        <td>
                          <div className="ebl-title">{g.title}</div>
                          <div className="muted xs ebl-meta">
                            {multi && <span className="ebl-caret">{isOpen ? '▾' : '▸'} {g.sizes.length} size{g.sizes.length === 1 ? '' : 's'}</span>}
                            {g.view_url
                              ? <a className="ebl-link" href={g.view_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>#{g.item_id} ↗</a>
                              : <span>#{g.item_id}</span>}
                            {g.start_time && <span>listed {estDate(g.start_time)}</span>}
                          </div>
                        </td>
                        <td className="ebl-nowrap">{g.style || <span className="muted">—</span>}</td>
                        <td className="ebl-sku">{g.item_sku || (g.sizes.length === 1 ? g.sizes[0].sku : null) || <span className="muted">—</span>}</td>
                        <td className="ebl-nowrap">{priceRange(g)}</td>
                        <td className={`num${g.available === 0 ? ' ebl-zero' : ''}`}>{fmt(g.available)}</td>
                        <td className="num">{fmt(g.sold)}</td>
                        <td className="num">{g.watch_count ?? <span className="muted">—</span>}</td>
                      </tr>
                      {isOpen && g.sizes.map((s) => (
                        <tr key={`${g.item_id}|${s.variation_key}`} className="ebl-size">
                          <td />
                          <td className="ebl-size-name">Size <b>{s.size || '—'}</b></td>
                          <td />
                          <td className="ebl-sku">{s.sku || <span className="muted">—</span>}</td>
                          <td className="ebl-nowrap">{money(s.price)}</td>
                          <td className={`num${Number(s.qty_available) === 0 ? ' ebl-zero' : ''}`}>{s.qty_available ?? '—'}</td>
                          <td className="num">{s.qty_sold ?? 0}</td>
                          <td />
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!more && shown.length > SHOW && <button type="button" className="btn ghost sm mt" onClick={() => setMore(true)}>Show all {fmt(shown.length)}</button>}
          {!shown.length && <p className="muted">Nothing matches.</p>}
        </div>
      )}
      {rows && !rows.length && st?.connected && pullState?.state !== 'running' && <p className="muted mt">No listings yet — press Pull listings from eBay.</p>}
    </div>
  );
}

// ── Not in Shopify — end ────────────────────────────────────────────────────────────────
// Listings whose every size's Custom label is gone from Shopify (checked on each pull). A
// sale there deducts nothing anywhere, so they're ended here — one at a time, each re-checked
// in Shopify live by the server first (api/ebay/end.js). Phone-first cards.
function OrphansTab({ orphans, checked, isAdmin, onSignOut, onEnded, onConnect }) {
  const [sel, setSel] = useState(() => new Set());
  const [confirm, setConfirm] = useState(false);
  const [run, setRun] = useState(null);   // { done, total, ended, skipped:[], failed:[], running, reconnect }
  const stop = useRef(false);
  const sorted = useMemo(() => [...orphans].sort((a, b) => b.available - a.available || String(a.title).localeCompare(String(b.title))), [orphans]);
  const units = (list) => list.reduce((n, g) => n + g.available, 0);
  const picked = sorted.filter((g) => sel.has(g.item_id));
  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function go() {
    setConfirm(false);
    stop.current = false;
    const st = { done: 0, total: picked.length, ended: 0, skipped: [], failed: [], running: true, reconnect: false };
    setRun({ ...st });
    for (const g of picked) {
      if (stop.current) break;
      try {
        const r = await api.ebayEnd([g.item_id]);
        const x = (r.results || [])[0] || {};
        if (x.ok) st.ended++;
        else if (x.skipped) st.skipped.push(`${g.title}: ${x.error}`);
        else st.failed.push(`${g.title}: ${x.error}`);
        if (r.needsReconnect) { st.reconnect = true; st.done++; break; }
      } catch (e) {
        if (e.unauthorized) return onSignOut();
        st.failed.push(`${g.title}: ${e.message}`);
      }
      st.done++;
      setRun({ ...st });
    }
    setRun({ ...st, running: false });
    setSel(new Set());
    onEnded();
  }
  if (!checked) return <div className="card"><p className="sm">Not checked against Shopify yet — press <b>Pull listings from eBay</b>; every pull now checks each Custom label against Shopify.</p></div>;
  return (
    <div className="card">
      <p className="sm">These eBay listings’ Custom labels (SKUs) are <b>no longer in Shopify</b>, so a sale on eBay deducts nothing — <b>{fmt(units(sorted))} pairs</b> are still offered across {fmt(sorted.length)} listings. Ending one ends every size of it on eBay. Each is re-checked in Shopify right before it’s ended.</p>
      {sorted.length > 0 && (
        <div className="ebl-endbar">
          <label className="ebl-check"><input type="checkbox" checked={picked.length === sorted.length && sorted.length > 0}
            onChange={(e) => setSel(e.target.checked ? new Set(sorted.map((g) => g.item_id)) : new Set())} /> Select all</label>
          {run?.running
            ? <button type="button" className="btn" onClick={() => { stop.current = true; }}>Stop · {run.done}/{run.total}</button>
            : <button type="button" className="btn danger" disabled={!picked.length} onClick={() => setConfirm(true)}>End {picked.length || ''} on eBay</button>}
        </div>
      )}
      {run && !run.running && (
        <div className={run.failed.length || run.reconnect ? 'error mt' : 'notice mt'}>
          Ended {run.ended} of {run.total}{run.skipped.length ? ` · ${run.skipped.length} skipped` : ''}{run.failed.length ? ` · ${run.failed.length} failed` : ''}.
          {run.reconnect && <> eBay refused to end listings with the current approval — {isAdmin ? <button type="button" className="btn sm" onClick={onConnect}>Connect eBay again</button> : 'an admin presses Connect eBay again'} (it now asks for permission to end listings), then retry.</>}
          {[...run.skipped, ...run.failed].slice(0, 8).map((m) => <div key={m} className="xs">{m}</div>)}
        </div>
      )}
      {!sorted.length ? <p className="muted mt">Nothing to end — every eBay listing’s SKU is in Shopify.</p> : (
        <div className="ebl-orphans">
          {sorted.map((g) => {
            const verdicts = [...new Set(g.sizes.map((s) => s.shopify_verdict))];
            const newSkus = [...new Set(g.sizes.map((s) => s.shopify_new_sku).filter(Boolean))];
            return (
              <label key={g.item_id} className={`ebl-orphan${sel.has(g.item_id) ? ' on' : ''}`}>
                <input type="checkbox" checked={sel.has(g.item_id)} disabled={!!run?.running} onChange={() => toggle(g.item_id)} aria-label={`End ${g.title}`} />
                <Thumb src={g.image_url} alt={g.title} />
                <span className="ebl-orphan-main">
                  <span className="ebl-title">{g.title}</span>
                  <span className="muted xs">#{g.view_url ? <a className="ebl-link" href={g.view_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{g.item_id} ↗</a> : g.item_id}
                    {' · '}{g.sizes.length} size{g.sizes.length === 1 ? '' : 's'} · SKU {g.sizes.map((s) => s.sku).filter(Boolean).join(', ') || '—'}</span>
                  {verdicts.map((v) => <span key={v} className={`ebl-note ${VERDICT[v]?.[1] || 'muted'}`}>{VERDICT[v]?.[0] || 'Not in Shopify'}</span>)}
                  {newSkus.length > 0 && <span className="muted xs">New Shopify SKU: {newSkus.join(', ')}</span>}
                </span>
                <span className="ebl-orphan-units"><b>{g.available}</b><span className="muted xs">on eBay</span></span>
              </label>
            );
          })}
        </div>
      )}
      {confirm && (
        <Modal type="warn" title={`End ${picked.length} listing${picked.length === 1 ? '' : 's'} on eBay?`}
          message={`${fmt(units(picked))} pair${units(picked) === 1 ? '' : 's'} stop being offered. Every size of each listing ends. Each one's SKUs are re-checked in Shopify first — any that came back are skipped. This can't be undone from here (relist from Shopify / DPL).`}
          onClose={() => setConfirm(false)}>
          <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
          <button type="button" className="btn danger" onClick={go}>End {picked.length} on eBay</button>
        </Modal>
      )}
    </div>
  );
}

function EndedTab({ onSignOut }) {
  const [ends, setEnds] = useState(null);
  useEffect(() => { api.ebayEnds().then((r) => setEnds(r.ends || [])).catch((e) => { if (e.unauthorized) onSignOut(); else setEnds([]); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="card">
      {!ends ? <p className="muted">Loading…</p> : !ends.length ? <p className="muted">Nothing ended from here yet.</p> : (
        <div className="ebl-orphans">
          {ends.map((e) => (
            <div key={e.id} className="ebl-orphan">
              <span className={`ebl-note ${e.ok ? 'ok' : 'bad'}`}>{e.ok ? 'Ended' : 'Failed'}</span>
              <span className="ebl-orphan-main">
                <span className="ebl-title">{e.title || `#${e.item_id}`}</span>
                <span className="muted xs">#{e.item_id} · {when(e.ended_at)}{e.ended_by ? ` · ${e.ended_by}` : ''}</span>
                <span className="muted xs">{e.reason}{e.skus ? ` · SKU ${e.skus}` : ''}</span>
                {e.error && <span className="error xs">{e.error}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
