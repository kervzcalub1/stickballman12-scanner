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
const SHOW = 300;

// What each row says about our stock vs eBay's quantity.
function stockNote(r) {
  if (!r.style) return { key: 'nostyle', label: 'No style code in the title', tone: 'muted' };
  if (r.on_hand == null) return r.qty_available > 0 ? { key: 'none', label: 'Listed — we hold none', tone: 'bad' } : { key: 'ok', label: '' };
  if (r.qty_available > r.on_hand) return { key: 'over', label: `eBay shows ${r.qty_available}, we hold ${r.on_hand}`, tone: 'bad' };
  if (r.qty_available === 0 && r.on_hand > 0) return { key: 'idle', label: `We hold ${r.on_hand}, eBay shows 0`, tone: 'warn' };
  return { key: 'ok', label: '' };
}

export function EbayListings({ user, onHome, onSignOut }) {
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
  const [st, setSt] = useState(null);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [q, setQ] = useQueryParam('q', '');
  const [view, setView] = useQueryParam('view', 'all');   // all | over | none | idle | nostyle
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

  const annotated = useMemo(() => (rows || []).map((r) => ({ ...r, note: stockNote(r) })), [rows]);
  const counts = useMemo(() => {
    const c = { all: annotated.length, over: 0, none: 0, idle: 0, nostyle: 0 };
    for (const r of annotated) if (r.note.key in c) c[r.note.key]++;
    return c;
  }, [annotated]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return annotated.filter((r) => (view === 'all' || r.note.key === view)
      && (!needle || [r.title, r.style, r.sku, r.item_id, r.size].some((v) => String(v || '').toLowerCase().includes(needle))));
  }, [annotated, q, view]);
  const listings = useMemo(() => new Set((rows || []).map((r) => r.item_id)).size, [rows]);

  const pullState = st?.pull;
  const running = pullState?.state === 'running';

  return (
    <div className="app">
      <TopBar title="eBay Listings" onHome={onHome} onSignOut={onSignOut} />
      {err && <div className="error mt">{err}</div>}
      {notice && <div className="notice mt">{notice}</div>}

      <div className="card">
        <h3 className="er-step-title">eBay account</h3>
        <p className="muted sm">Read-only: this page pulls what’s live on eBay and shows it next to our stock. It never changes a price, quantity or listing — DPL (Shopify → eBay) still does that.</p>
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
              placeholder="Search title, style, SKU, item #, size…" aria-label="Search eBay listings" />
            <div className="seg sm">
              {[['all', 'All'], ['over', 'eBay > ours'], ['none', 'We hold none'], ['idle', 'Ours, not on eBay'], ['nostyle', 'No style']].map(([k, label]) => (
                <button key={k} type="button" className={`seg-btn${view === k ? ' on' : ''}`} aria-pressed={view === k}
                  onClick={() => { setView(k); setMore(false); }}>{label} <span className="seg-n" aria-hidden="true">{fmt(counts[k])}</span></button>
              ))}
            </div>
          </div>
          <p className="muted xs">{fmt(listings)} listings · {fmt(rows.length)} sizes · “ours” = pairs on hand (not sold, shipped, missing or issue) of that style + size.</p>
          <div className="ap-tablewrap">
            <table className="table ebl-table">
              <thead><tr><th>Listing</th><th>Style</th><th>Size</th><th>Price</th><th>eBay qty</th><th>Sold</th><th>Ours</th><th /></tr></thead>
              <tbody>
                {shown.slice(0, more ? shown.length : SHOW).map((r) => (
                  <tr key={`${r.item_id}|${r.variation_key}`}>
                    <td>
                      <div className="ebl-title">{r.title}</div>
                      <div className="muted xs">#{r.view_url ? <a href={r.view_url} target="_blank" rel="noreferrer">{r.item_id}</a> : r.item_id}{r.sku ? ` · SKU ${r.sku}` : ''}</div>
                    </td>
                    <td>{r.style || <span className="muted">—</span>}</td>
                    <td>{r.size || <span className="muted">—</span>}</td>
                    <td>{r.price != null ? `$${Number(r.price).toFixed(2)}` : '—'}</td>
                    <td>{r.qty_available ?? '—'}</td>
                    <td>{r.qty_sold ?? 0}</td>
                    <td>{r.on_hand ?? <span className="muted">0</span>}</td>
                    <td>{r.note.label && <span className={`ebl-note ${r.note.tone}`}>{r.note.label}</span>}</td>
                  </tr>
                ))}
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
