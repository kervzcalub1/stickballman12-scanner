// eBay Listings (PH) — a READ-ONLY view of everything live on eBay, next to what we hold
// (docs/context/ebay-listings.md). Phase 1 of the listings hub (docs/listings-hub-plan.md):
// connect the account once, pull, look. Nothing on this page changes eBay.
import React, { useEffect, useMemo, useState } from 'react';
import { TopBar } from '../components/common.jsx';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { estDate, PH_DATETIME } from '../lib/format.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const when = (iso) => (iso ? `${PH_DATETIME.format(new Date(iso))} EST` : '—');
const SHOW = 100;   // listings shown before "Show all"

// One listing (the eBay item) with its sizes under it. Price shown as a range when sizes
// differ; quantities summed.
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
        <p className="muted sm">Read-only: this page pulls what’s live on eBay — photos, sizes, Custom labels, prices and quantities. It never changes a price, quantity or listing — DPL (Shopify → eBay) still does that.</p>
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
              {running ? `Pulling… page ${pullState.page || 0}${pullState.pages ? ` of ${pullState.pages}` : ''}` : busy === 'pull' ? 'Starting…' : '↻ Pull listings from eBay'}</button>
            {pullState?.state === 'done' && (
              <span className="muted sm">Last pulled {when(pullState.finishedAt)}{pullState.by ? ` by ${pullState.by}` : ''} — {fmt(pullState.listings)} listings, {fmt(pullState.rows)} sizes{pullState.removed ? `, ${fmt(pullState.removed)} ended since the pull before` : ''}.</span>
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
