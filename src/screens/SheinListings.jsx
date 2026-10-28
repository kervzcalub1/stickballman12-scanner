// SHEIN Listings (PH /ph/shein-listings, admin /shein-listings) — every Shopify shoe, what's on
// SHEIN, what isn't and why (docs/context/shein-listings.md, docs/shein-listings-plan.md
// Appendix C). Phase 0 + 1: our database (a size spelling, "Don't list on SHEIN") and the jobs
// that READ. Phase 2: select → Dry run (a server job, reads only) → the review sheet
// (src/components/SheinDryRunSheet.jsx) → "Add sizes to N products" (admin / Connect
// integrations) → the same sheet follows the send. Every other SHEIN write is still drawn
// disabled ("Coming in the next phase"). Phase 4: products not on SHEIN → "Publish new products"
// (checklist in the drawer, the Setup tab for what is set once, a store-gate banner when SHEIN
// refuses new listings).
//
// URL (refresh-proof, src/lib/urlstate.js): tab · status · q · brand · blocker · shop (active|inactive on Shopify) · p · product ·
// job · sz · pt (Setup). Never in the URL: ticked products, the custom-size draft, the dry-run sheet.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TopBar, ProgressBar, FormModal } from '../components/common.jsx';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { STATUSES, STATUS_CODES } from '../lib/sheinListings.js';
import { fmt, when, TONE, NEEDS_PRIV, goPath, checkPath } from '../components/SheinListingsBits.jsx';
import { SheinListingsProducts } from './SheinListingsProducts.jsx';
import { SheinListingsSizes } from './SheinListingsSizes.jsx';
import { SheinListingsJobs, jobLabel } from './SheinListingsJobs.jsx';
import { SheinProductDrawer } from '../components/SheinProductDrawer.jsx';
import { DryRunSheet } from '../components/SheinDryRunSheet.jsx';
import { SheinListingsSetup } from './SheinListingsSetup.jsx';
import { useStoreGates, StoreGateBanner } from '../components/SheinPublishBits.jsx';
import { useCutover, CutoverStripLine } from '../components/SheinCutover.jsx';

export const LISTING_TABLES = ['shein_listing_products', 'shein_listing_variants', 'shein_listing_jobs', 'shein_listing_job_items', 'shein_size_map'];
const PAGE_SIZE = 25;
// The tiles, in the order the mockup reads them (All first, then healthy → stuck).
const TILE_ORDER = ['synced', 'not_on_shein', 'out_of_date', 'in_review', 'blocked', 'error', 'shein_only', 'unknown'];
const ALWAYS_TILES = new Set(['synced', 'not_on_shein', 'out_of_date', 'in_review', 'blocked', 'error']);
const STALE_MS = 30 * 60 * 1000;

export function SheinListings({ user, onHome, onSignOut }) {
  const [tab, setTab] = useQueryParam('tab', 'products');
  const [statusRaw, setStatus] = useQueryParam('status', '');
  const [q, setQ] = useQueryParam('q', '');
  const [brand, setBrand] = useQueryParam('brand', '');
  const [blocker, setBlocker] = useQueryParam('blocker', '');
  const [shopRaw, setShop] = useQueryParam('shop', '');   // Shopify: '' all · active (in stock) · inactive (or no stock)
  const [pRaw, setP] = useQueryParam('p', '');
  const [product, setProduct] = useQueryParam('product', '');
  const [job, setJob] = useQueryParam('job', '');
  const [sz, setSz] = useQueryParam('sz', '');
  // A hand-edited ?status= that isn't a code falls back to All instead of a 400.
  const status = STATUS_CODES.includes(statusRaw) || statusRaw === 'all' ? statusRaw : '';
  const shop = ['active', 'inactive'].includes(shopRaw) ? shopRaw : '';
  const page = Math.max(1, Number(pRaw) || 1);
  const tabKey = ['sizes', 'jobs', 'setup'].includes(tab) ? tab : 'products';

  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [loadedAt, setLoadedAt] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [sheet, setSheet] = useState(null);   // the dry-run sheet's job id — in memory only
  const seq = useRef(0);
  const gates = useStoreGates(onSignOut);   // Phase 4: what SHEIN last said about new listings
  const cut = useCutover(onSignOut);         // Phase 5: the 4seller cut-over + go-live checklists

  async function load() {
    const mine = ++seq.current;
    try {
      const r = await api.sheinListings({ status, q, brand, blocker, shopify: shop, page, pageSize: PAGE_SIZE });
      if (mine !== seq.current) return;
      setD(r); setErr(''); setLoadedAt(new Date().toISOString());
    } catch (e) {
      if (e.unauthorized) onSignOut();
      else if (mine === seq.current) setErr(e.message);
    }
  }
  useEffect(() => { load(); }, [status, q, brand, blocker, shop, page]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = d?.summary?.activeJob || null;
  useLive(LISTING_TABLES, load, { mount: false, every: active ? 5_000 : 60_000 });

  async function act(action, extra = {}, done = null) {
    setBusy(action); setErr(''); setMsg('');
    try {
      const r = await api.sheinListingAction({ action, ...extra });
      if (done) setMsg(typeof done === 'function' ? done(r) : done);
      await load();
      return r;
    } catch (e) {
      if (e.unauthorized) onSignOut();
      else setErr(e.message);
      return null;
    } finally { setBusy(''); }
  }

  const s = d?.summary;
  const canWrite = !!d?.canWrite;
  const connected = !!d?.connected;
  const neverRead = !!s && !s.lastSnapshot && s.all === 0;
  const lastRead = s?.lastSnapshot?.finished_at || null;
  const stale = lastRead && Date.now() - new Date(lastRead).getTime() > STALE_MS;
  const interrupted = !active && s?.latestSnapshot?.status === 'interrupted' ? s.latestSnapshot : null;
  const toMap = (s?.topBlockers || []).find((b) => b.code === 'size_needs_map')?.sizes || 0;
  const pickStatus = (code) => { setStatus(status === code ? '' : code); setP(''); if (tabKey !== 'products') setTab(''); };
  const snapshot = () => act('snapshot', {}, 'Re-read started on the server — it keeps going if you close this tab.');
  // A dry run of these products (PH ok, reads only) → the sheet follows it.
  // ops: undefined = add missing sizes (Phase 2); ['price','edit'] = update prices & sizes (Phase 3).
  async function dryRun(productIds, ops) {
    const r = await act('preview', ops ? { productIds, ops } : { productIds }, 'Dry run started on the server — nothing is sent to SHEIN.');
    if (r?.job?.id) { setProduct(''); setSheet(r.job.id); }
    return r;
  }
  const isListingJob = (j) => ['preview', 'run'].includes(j?.kind);
  const snapTitle = !connected ? 'Connect SHEIN first (SHEIN ↔ Shopify check page)' : active ? 'A job is already running' : 'Reads Shopify and SHEIN — writes nothing';

  const tiles = useMemo(() => {
    if (!s) return [];
    return TILE_ORDER.filter((c) => ALWAYS_TILES.has(c) || (s.byStatus[c]?.products || 0) > 0)
      .map((c) => ({ code: c, n: s.byStatus[c]?.products || 0, sizes: s.byStatus[c]?.sizes || 0 }));
  }, [s]);

  return (
    <div className="app shl-page">
      <TopBar title="SHEIN Listings" onHome={onHome} onSignOut={onSignOut} />

      {/* connection strip */}
      <div className="card shl-strip-card">
        {!d && !err && <div className="shl-skel shl-skel-line" aria-label="Loading" />}
        {d && (
          <div className="shl-strip">
            {connected ? <span className="ebl-ok">● SHEIN connected</span>
              : <span className="shl-bad-text">● SHEIN not connected</span>}
            <span className="muted sm">
              {lastRead ? <>Last read <span className={stale ? 'shl-stale' : ''} title={stale ? 'Older than 30 minutes — re-read for the latest' : undefined}>{when(lastRead)}</span></> : 'Never read'}
              {s?.lastSnapshot?.counts?.products != null && <> · {fmt(s.all)} products · {fmt(s.lastSnapshot.counts.shopify_products)} on Shopify · {fmt(s.lastSnapshot.counts.shein_products)} on SHEIN</>}
            </span>
            <span className="muted sm">Shopify product updates: {s?.hooks?.on ? <>on <span className="muted">(since {when(s.hooks.at)})</span></> : 'not registered yet'}</span>
            <CutoverStripLine cut={cut} onOpen={() => setTab('setup')} />
            <span className="shl-grow" />
            <button type="button" className="btn ghost sm" disabled={!!busy || !connected || !!active} title={snapTitle} onClick={snapshot}>
              {busy === 'snapshot' ? 'Starting…' : '↻ Re-read Shopify + SHEIN'}</button>
            {!s?.hooks?.on && (
              <button type="button" className="btn ghost sm" disabled={!canWrite || !!busy} title={canWrite ? 'Shopify tells us when a product’s price, size or SKU changes' : NEEDS_PRIV}
                onClick={() => act('webhooks', {}, 'Shopify product webhooks registered.')}>{busy === 'webhooks' ? 'Registering…' : 'Register Shopify webhooks'}</button>
            )}
          </div>
        )}
        {d && <p className="muted xs shl-strip-note">Stock is kept in step by the live sync (<button type="button" className="shl-linkbtn" onClick={() => goPath(checkPath())}>SHEIN ↔ Shopify check</button>). This page is about <b>what is listed</b>: sizes, seller SKUs, prices. It writes to SHEIN in two ways — <b>add missing sizes</b>, and <b>update prices &amp; sizes</b> (SHEIN price, a size turned off, a wrong SKU) — always after a dry run you check.</p>}
        {d && <AutoPrice ap={s?.autoPrice} canWrite={canWrite} busy={busy} onAct={act} />}
        {d && !d.configured && !connected && <p className="notice mt">SHEIN’s developer app isn’t set up on this server, so nothing can be read from SHEIN here.</p>}
        {d && !connected && (
          <p className="notice mt">SHEIN isn’t connected. {canWrite ? <>Connect it on the <button type="button" className="shl-linkbtn" onClick={() => goPath(checkPath())}>SHEIN ↔ Shopify check</button> page, then come back and re-read.</> : 'An admin connects it on the SHEIN ↔ Shopify check page.'} What was read before still shows below.</p>
        )}
        {err && d && <p className="notice mt" role="status">Couldn’t refresh: {err} — showing what was loaded {when(loadedAt)}.</p>}
        {msg && <p className="ebl-ok sm mt">{msg}</p>}
      </div>

      {!d && err && (
        <div className="card shl-state">
          <h3>Couldn’t load SHEIN Listings</h3>
          <p className="muted">{err}</p>
          <button type="button" className="btn primary" onClick={load}>Try again</button>
        </div>
      )}
      {!d && !err && (
        <div className="card" aria-busy="true">
          <div className="shl-skel-tiles">{Array.from({ length: 6 }, (_, i) => <span key={i} className="shl-skel shl-skel-tile" />)}</div>
          {Array.from({ length: 4 }, (_, i) => <div key={i} className="shl-skel shl-skel-row" />)}
        </div>
      )}

      {/* running job */}
      {active && (
        <div className="shl-banner" role="status">
          <b>Job #{active.id} · {jobLabel(active)}</b>
          <span className="muted sm">{active.phase || active.status}{active.total ? ` · ${fmt(active.done)} of ${fmt(active.total)}` : ''}{active.current ? ` · now ${active.current}` : ''} · started {when(active.started_at || active.created_at)}{active.started_by ? ` by ${active.started_by}` : ''}</span>
          <div className="shl-banner-bar"><ProgressBar value={active.total ? active.done / active.total : 0} indeterminate={!active.total} /></div>
          <span className="shl-banner-actions">
            <button type="button" className="btn ghost sm" disabled={!!busy || active.stop_requested} onClick={() => act('stop', { jobId: active.id })}>{active.stop_requested ? 'Stopping after this product…' : 'Stop'}</button>
            <button type="button" className="btn ghost sm" onClick={() => { if (isListingJob(active)) setSheet(active.id); else { setTab('jobs'); setJob(String(active.id)); } }}>View job →</button>
          </span>
        </div>
      )}
      {interrupted && (
        <div className="shl-banner warn" role="status">
          <b>Re-read #{interrupted.id} was interrupted</b>
          <span className="muted sm">The server restarted at {fmt(interrupted.done)} of {fmt(interrupted.total)} SHEIN products. Resume carries on from the first unfinished product.</span>
          <span className="shl-banner-actions">
            <button type="button" className="btn sm" disabled={!!busy || !connected} onClick={() => act('resume', { jobId: interrupted.id }, 'Resumed on the server.')}>{busy === 'resume' ? 'Resuming…' : 'Resume'}</button>
          </span>
        </div>
      )}

      {d && <StoreGateBanner gates={gates.gates} readAt={gates.readAt} />}

      {/* status tiles = filters */}
      {s && !neverRead && (
        <div className="card">
          <div className="shc-tiles shl-tiles" role="group" aria-label="Filter by status">
            <button type="button" className={`shc-tile${!status ? ' on' : ''}`} aria-pressed={!status} onClick={() => pickStatus('')}>
              <b>{fmt(s.all)}</b><span>All products</span>
            </button>
            {tiles.map((t) => (
              <button key={t.code} type="button" className={`shc-tile ${TONE[t.code]}${status === t.code ? ' on' : ''}`} aria-pressed={status === t.code}
                data-status={t.code} title={STATUSES[t.code].meaning} onClick={() => pickStatus(t.code)}>
                <b>{fmt(t.n)}</b>
                <span><i className={`shl-dot ${TONE[t.code]}`} />{STATUSES[t.code].label}{t.sizes ? ` · ${fmt(t.sizes)} size${t.sizes === 1 ? '' : 's'}` : ''}</span>
              </button>
            ))}
          </div>
          {s.off > 0 && (
            <p className="muted xs shl-off-line">
              <button type="button" className={`shl-linkbtn${status === 'excluded' ? ' on' : ''}`} aria-pressed={status === 'excluded'} onClick={() => pickStatus('excluded')}>Not listing ({fmt(s.off)})</button>
              {' '}— Shopify drafts, or marked “Don’t list on SHEIN”. Not in the counts above.
            </p>
          )}
        </div>
      )}

      {d && (
        <div className="ebl-tabs seg shl-tabs" role="tablist">
          {[['products', 'Products', neverRead ? '' : fmt(s.all), ''], ['sizes', 'Sizes', toMap ? `${fmt(toMap)} to map` : '', toMap ? ' warnn' : ''], ['jobs', 'Jobs', active ? '1 running' : '', ''], ['setup', 'Setup', '', '']].map(([k, l, n, cls]) => (
            <button key={k} type="button" role="tab" className={`seg-btn${tabKey === k ? ' on' : ''}`} aria-selected={tabKey === k} onClick={() => setTab(k === 'products' ? '' : k)}>
              {l}{n && <span className={`seg-n${cls}`}>{n}</span>}
            </button>
          ))}
        </div>
      )}

      {d && neverRead && tabKey === 'products' && (
        <div className="card shl-state shl-hero">
          <h3>Nothing read yet</h3>
          <p className="muted">This page lists every Shopify shoe with its SHEIN status, size by size. It fills in after the first read of Shopify and SHEIN — a server job of a few minutes that only <b>reads</b> (nothing on SHEIN changes) and keeps going if you close the tab.</p>
          <button type="button" className="btn primary" disabled={!!busy || !connected || !!active} title={snapTitle} onClick={snapshot}>{busy === 'snapshot' ? 'Starting…' : 'Check all listings'}</button>
          {!connected && <p className="muted xs mt">SHEIN has to be connected first.</p>}
        </div>
      )}

      {d && !neverRead && tabKey === 'products' && (
        <SheinListingsProducts setStatusAll={() => pickStatus('')} d={d} status={status} q={q} setQ={(v) => { setQ(v); setP(''); }} brand={brand} setBrand={(v) => { setBrand(v); setP(''); }}
          blocker={blocker} setBlocker={(v) => { setBlocker(v); setP(''); }} shop={shop} setShop={(v) => { setShop(v); setP(''); }} page={page} setPage={(n) => setP(n > 1 ? String(n) : '')} pageSize={PAGE_SIZE}
          onOpen={(id) => setProduct(id)} onAct={act} busy={busy} onSignOut={onSignOut} active={active} onDryRun={dryRun} />
      )}
      {d && tabKey === 'sizes' && (
        <SheinListingsSizes sz={sz} setSz={setSz} canWrite={canWrite} connected={connected} active={active} onAct={act} busy={busy}
          goBlocker={(code) => { setBlocker(code); setStatus(''); setP(''); setTab(''); }} onSignOut={onSignOut} />
      )}
      {d && tabKey === 'setup' && <SheinListingsSetup canWrite={canWrite} gates={gates} cut={cut} onSignOut={onSignOut}
        onOpenProduct={(id) => setProduct(id)} onOpenJob={(id) => { setTab('jobs'); setJob(String(id)); }} />}
      {d && tabKey === 'jobs' && (
        <SheinListingsJobs job={job} setJob={setJob} active={active} canWrite={canWrite} isAdmin={!!d?.isAdmin} connected={connected} onAct={act} busy={busy} onSignOut={onSignOut} />
      )}

      {d && !neverRead && (
        <details className="card shl-legend">
          <summary>What do the statuses mean?</summary>
          <div className="shl-legend-grid">
            {[...TILE_ORDER.filter((c) => c !== 'unknown'), 'excluded'].map((c) => (
              <div key={c}><span className={STATUSES[c].chip}>{STATUSES[c].label}</span> <span className="muted">{STATUSES[c].meaning}</span></div>
            ))}
          </div>
        </details>
      )}

      {product && <SheinProductDrawer id={product} isAdmin={!!d?.isAdmin} onClose={() => setProduct('')} onAct={act} busy={busy} onSignOut={onSignOut}
        active={active} connected={connected} onDryRun={dryRun} onOpenJob={(id) => { setProduct(''); setSheet(id); }} />}
      {sheet && <DryRunSheet jobId={sheet} canWrite={canWrite} isAdmin={!!d?.isAdmin} onClose={() => setSheet(null)} onSignOut={onSignOut} />}
    </div>
  );
}

// D8 — "Auto re-sync price" (docs/context/shein-listings.md → Phase 3). OFF by default. Admin /
// Connect integrations turn it on (a confirm says what it does); everyone else sees its state.
function AutoPrice({ ap, canWrite, busy, onAct }) {
  const [ask, setAsk] = useState(false);
  const on = !!ap?.on;
  const who = ap?.by ? <> · turned {on ? 'on' : 'off'} by {ap.by}{ap.at ? ` ${when(ap.at)}` : ''}</> : on ? null : ' · never turned on';
  return (
    <div className="shl-auto" data-auto={on ? 'on' : 'off'}>
      <span className="sm">Auto re-sync price: <span className={`ebo-chip ${on ? 'ok' : ''}`.trim()}>{on ? 'On' : 'Off'}</span></span>
      <span className="muted xs">{on ? 'Once a day (EST) SHEIN prices that are off are dry-run, then sent' : 'Prices only change on SHEIN when a person confirms a dry run'}{who}</span>
      {canWrite
        ? (on
          ? <button type="button" className="btn ghost xs" disabled={!!busy} onClick={() => onAct('auto_price', { on: false }, 'Auto re-sync price is off. Prices change only when a person confirms a dry run.')}>{busy === 'auto_price' ? 'Saving…' : 'Turn off'}</button>
          : <button type="button" className="btn ghost xs" disabled={!!busy} onClick={() => setAsk(true)}>Turn on…</button>)
        : <span className="muted xs">An admin (or the Connect integrations privilege) can change this.</span>}
      {ask && createPortal(
        <FormModal title="Turn on auto re-sync price?" submitLabel="Turn on auto re-sync" onClose={() => setAsk(false)}
          message={<>Once a day (EST) the server starts a <b>dry run</b> of every product whose SHEIN price is off — market + 15 %, rounded up, else the Shopify price — and sends that dry run on its next check, with the same checks a person’s send has. A price going <b>up</b> may go to SHEIN’s price review (In review). Sizes, SKUs and titles are never sent by this — those still need a person. You can turn it off any time.</>}
          onSubmit={async () => {
            const r = await onAct('auto_price', { on: true }, 'Auto re-sync price is on — the first dry run starts at the next daily check (EST).');
            if (!r) throw new Error('Not turned on — see the message on the page.');
            setAsk(false);
          }} />,
        document.body,
      )}
    </div>
  );
}
