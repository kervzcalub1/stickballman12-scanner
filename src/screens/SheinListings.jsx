// SHEIN Listings (PH /ph/shein-listings, admin /shein-listings) — every Shopify shoe, what's on
// SHEIN, what isn't and why (docs/context/shein-listings.md, docs/shein-listings-plan.md
// Appendix C). Phase 0 + 1: our database (a size spelling, "Don't list on SHEIN") and the jobs
// that READ. Phase 2: select → Preview (a server job, reads only) → the review sheet
// (src/components/SheinDryRunSheet.jsx) → "Add sizes to N products" (admin / Connect
// integrations) → the same sheet follows the send. Every other SHEIN write is still drawn
// disabled ("Coming in the next phase"). Phase 4: products not on SHEIN → "Publish new products"
// (checklist in the drawer, the Setup tab for what is set once, a store-gate banner when SHEIN
// refuses new listings).
//
// URL (refresh-proof, src/lib/urlstate.js): tab · status · q · brand · blocker · shop (active|inactive on Shopify) · p · product ·
// job · sz · pt (Setup). Never in the URL: ticked products, the custom-size draft, the preview sheet.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ProgressBar, FormModal } from '../components/common.jsx';
import { HowItWorks, useSheinNav } from '../components/SheinNav.jsx';
import { JOB_KIND_WORDS, TERMS, plain } from '../lib/sheinWords.js';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { useQueryParam } from '../lib/urlstate.js';
import { STATUSES, STATUS_CODES } from '../lib/sheinListings.js';
import { fmt, when, TONE, NEEDS_PRIV } from '../components/SheinListingsBits.jsx';
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

export function SheinListings({ onSignOut, visible = true }) {
  const go = useSheinNav();
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
  const [advParam, setAdv] = useQueryParam('adv', '');   // the Advanced area stays open across a refresh
  // A hand-edited ?status= that isn't a code falls back to All instead of a 400.
  const status = STATUS_CODES.includes(statusRaw) || statusRaw === 'all' ? statusRaw : '';
  const shop = ['active', 'inactive'].includes(shopRaw) ? shopRaw : '';
  const page = Math.max(1, Number(pRaw) || 1);
  const tabKey = ['sizes', 'jobs', 'setup'].includes(tab) ? tab : 'products';
  const advOpen = advParam === '1' || tabKey === 'jobs' || tabKey === 'setup';

  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [loadedAt, setLoadedAt] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [sheet, setSheet] = useState(null);   // the preview sheet's job id — in memory only
  const seq = useRef(0);
  const gates = useStoreGates(onSignOut);   // Phase 4: what SHEIN last said about new listings
  const cut = useCutover(onSignOut);         // Phase 5: the 4seller switch-over + go-live checklists

  async function load() {
    const mine = ++seq.current;
    try {
      const r = await api.sheinListings({ status, q, brand, blocker, shopify: shop, page, pageSize: PAGE_SIZE });
      if (mine !== seq.current) return;
      setD(r); setErr(''); setLoadedAt(new Date().toISOString());
    } catch (e) {
      if (e.unauthorized) onSignOut();
      else if (mine === seq.current) setErr(plain(e.message));
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
      else setErr(plain(e.message));
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
  const snapshot = () => act('snapshot', {}, 'Refresh started on the server — it keeps going if you close this tab.');
  // A preview of these products (PH ok, reads only) → the sheet follows it.
  // ops: undefined = add missing sizes (Phase 2); ['price','edit'] = update prices & sizes (Phase 3).
  async function dryRun(productIds, ops) {
    const r = await act('preview', ops ? { productIds, ops } : { productIds }, 'Preview started on the server — nothing is sent to SHEIN.');
    if (r?.job?.id) { setProduct(''); setSheet(r.job.id); }
    return r;
  }
  const isListingJob = (j) => ['preview', 'run'].includes(j?.kind);
  const snapTitle = !connected ? 'Connect SHEIN first (Automatic sync section)' : active ? 'A job is already running' : 'Reads Shopify and SHEIN. Changes nothing.';

  const tiles = useMemo(() => {
    if (!s) return [];
    return TILE_ORDER.filter((c) => ALWAYS_TILES.has(c) || (s.byStatus[c]?.products || 0) > 0)
      .map((c) => ({ code: c, n: s.byStatus[c]?.products || 0, sizes: s.byStatus[c]?.sizes || 0 }));
  }, [s]);

  return (
    <div className="shl-page">
      {/* connection strip */}
      <div className="card shl-strip-card">
        {!d && !err && <div className="shl-skel shl-skel-line" aria-label="Loading" />}
        {d && (
          <div className="shl-strip">
            {connected ? <span className="ebl-ok">● SHEIN connected</span>
              : <span className="shl-bad-text">● SHEIN not connected</span>}
            <span className="muted sm">
              {lastRead ? <>Last refreshed <span className={stale ? 'shl-stale' : ''} title={stale ? 'Older than 30 minutes. Refresh for the latest.' : undefined}>{when(lastRead)}</span></> : 'Never refreshed'}
            </span>
            <CutoverStripLine cut={cut} onOpen={() => { setAdv('1'); setTab('setup'); }} />
            <span className="shl-grow" />
            <button type="button" className="btn ghost sm" disabled={!!busy || !connected || !!active} title={snapTitle} onClick={snapshot}>
              {busy === 'snapshot' ? 'Starting…' : `↻ ${TERMS.refresh}`}</button>
          </div>
        )}
        {d && (
          <HowItWorks>
            <p className="muted xs shl-strip-note">Stock is kept in step by <button type="button" className="shl-linkbtn" onClick={() => go('live')}>Automatic sync</button>. This section is about <b>what is listed</b>: sizes, SKUs, prices. It changes SHEIN in two ways, <b>adding missing sizes</b> and <b>updating prices &amp; sizes</b> (a SHEIN price, a size turned off, a wrong SKU), and only after a preview you check.</p>
            {s?.lastSnapshot?.counts?.products != null && <p className="muted xs">{fmt(s.all)} products · {fmt(s.lastSnapshot.counts.shopify_products)} on Shopify · {fmt(s.lastSnapshot.counts.shein_products)} on SHEIN</p>}
          </HowItWorks>
        )}
        {d && !d.configured && !connected && <p className="notice mt">SHEIN’s connection isn’t set up on this server, so nothing can be read from SHEIN here.</p>}
        {d && !connected && (
          <p className="notice mt">SHEIN isn’t connected. {canWrite ? <>Connect it in <button type="button" className="shl-linkbtn" onClick={() => go('live')}>Automatic sync</button>, then come back and refresh.</> : 'An admin connects it in Automatic sync.'} What was read before still shows below.</p>
        )}
        {err && d && <p className="notice mt" role="status">Couldn’t refresh: {err} — showing what was loaded {when(loadedAt)}.</p>}
        {msg && <p className="ebl-ok sm mt">{msg}</p>}
      </div>

      {!d && err && (
        <div className="card shl-state">
          <h3>Couldn’t load your shoes</h3>
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
          <span className="muted sm">{plain(active.phase) || JOB_KIND_WORDS[active.kind]}{active.total ? ` · ${fmt(active.done)} of ${fmt(active.total)}` : ''}{active.current ? ` · now ${active.current}` : ''} · started {when(active.started_at || active.created_at)}{active.started_by ? ` by ${active.started_by}` : ''}</span>
          <div className="shl-banner-bar"><ProgressBar value={active.total ? active.done / active.total : 0} indeterminate={!active.total} /></div>
          <span className="shl-banner-actions">
            <button type="button" className="btn ghost sm" disabled={!!busy || active.stop_requested} onClick={() => act('stop', { jobId: active.id })}>{active.stop_requested ? 'Stopping after this product…' : 'Stop'}</button>
            <button type="button" className="btn ghost sm" onClick={() => { if (isListingJob(active)) setSheet(active.id); else { setTab('jobs'); setJob(String(active.id)); } }}>View job →</button>
          </span>
        </div>
      )}
      {interrupted && (
        <div className="shl-banner warn" role="status">
          <b>Refresh #{interrupted.id} was interrupted</b>
          <span className="muted sm">The server restarted at {fmt(interrupted.done)} of {fmt(interrupted.total)} SHEIN products. Resume carries on from the first unfinished product.</span>
          <span className="shl-banner-actions">
            <button type="button" className="btn sm" disabled={!!busy || !connected} onClick={() => act('resume', { jobId: interrupted.id }, 'Resumed on the server.')}>{busy === 'resume' ? 'Resuming…' : 'Resume'}</button>
          </span>
        </div>
      )}

      {d && <StoreGateBanner gates={gates.gates} readAt={gates.readAt} />}

      {/* status tiles = filters */}
      {s && !neverRead && tabKey === 'products' && (
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
        <div className="ebl-tabs seg shl-tabs">
          <span className="shein-tabgroup" role="tablist" aria-label="Shoes on SHEIN">
            {[['products', 'Shoes', neverRead ? '' : fmt(s.all), ''], ['sizes', 'Sizes', toMap ? `${fmt(toMap)} to map` : '', toMap ? ' warnn' : '']].map(([k, l, n, cls]) => (
              <button key={k} type="button" role="tab" className={`seg-btn${tabKey === k ? ' on' : ''}`} aria-selected={tabKey === k} onClick={() => setTab(k === 'products' ? '' : k)}>
                {l}{n && <span className={`seg-n${cls}`}>{n}</span>}
              </button>
            ))}
          </span>
          <button type="button" className={`seg-btn${advOpen ? ' on' : ''}`} aria-expanded={advOpen} data-adv-toggle=""
            onClick={() => { if (advOpen) { setAdv(''); if (tabKey === 'jobs' || tabKey === 'setup') setTab(''); } else setAdv('1'); }}>{TERMS.advanced} {advOpen ? '▴' : '▾'}{active && !advOpen ? <span className="seg-n">1 running</span> : null}</button>
        </div>
      )}
      {d && advOpen && (
        <div className="card shein-advcard" data-adv-open="">
          <div className="ebl-tabs seg shein-subtabs" role="tablist" aria-label="Advanced">
            {[['jobs', 'Jobs', active ? '1 running' : ''], ['setup', 'Setup', '']].map(([k, l, n]) => (
              <button key={k} type="button" role="tab" className={`seg-btn${tabKey === k ? ' on' : ''}`} aria-selected={tabKey === k} onClick={() => setTab(tabKey === k ? '' : k)}>{l}{n && <span className="seg-n">{n}</span>}</button>
            ))}
          </div>
          <p className="muted sm shein-adv-line">Shopify product updates: {s?.hooks?.on ? <>on <span className="muted">(since {when(s.hooks.at)})</span></> : 'not connected yet'}{' '}
            {/* Stays on the page once registered: Shopify deletes a subscription after repeated failures, and this creates only what's missing. */}
            <button type="button" className="btn ghost sm" disabled={!canWrite || !!busy}
              title={canWrite ? (s?.hooks?.on ? 'Puts back any Shopify update Shopify has removed. Safe to press again.' : 'Shopify tells us when a product’s price, size or SKU changes') : NEEDS_PRIV}
              onClick={() => act('webhooks', {}, s?.hooks?.on ? 'Shopify product updates checked.' : 'Shopify product updates connected.')}>
              {busy === 'webhooks' ? 'Connecting…' : (s?.hooks?.on ? 'Reconnect Shopify updates' : 'Connect Shopify updates')}</button></p>
          <AutoPrice ap={s?.autoPrice} canWrite={canWrite} busy={busy} onAct={act} />
        </div>
      )}

      {d && neverRead && tabKey === 'products' && (
        <div className="card shl-state shl-hero">
          <h3>Nothing read yet</h3>
          <p className="muted">This fills in after the first refresh. It takes a few minutes, changes nothing on SHEIN, and keeps going if you close the tab.</p>
          <button type="button" className="btn primary" disabled={!!busy || !connected || !!active} title={snapTitle} onClick={snapshot}>{busy === 'snapshot' ? 'Starting…' : TERMS.refresh}</button>
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

      {/* Portalled, so a hidden section has to take them off the screen itself. Their state is in the URL / in `sheet`. */}
      {product && visible && <SheinProductDrawer id={product} isAdmin={!!d?.isAdmin} onClose={() => setProduct('')} onAct={act} busy={busy} onSignOut={onSignOut}
        active={active} connected={connected} onDryRun={dryRun} onOpenJob={(id) => { setProduct(''); setSheet(id); }} />}
      {sheet && visible && <DryRunSheet jobId={sheet} canWrite={canWrite} isAdmin={!!d?.isAdmin} onClose={() => setSheet(null)} onSignOut={onSignOut} />}
    </div>
  );
}

// D8 — "Automatic price update" (docs/context/shein-listings.md → Phase 3). OFF by default. Admin /
// Connect integrations turn it on (a confirm says what it does); everyone else sees its state.
function AutoPrice({ ap, canWrite, busy, onAct }) {
  const [ask, setAsk] = useState(false);
  const on = !!ap?.on;
  const who = ap?.by ? <> · turned {on ? 'on' : 'off'} by {ap.by}{ap.at ? ` ${when(ap.at)}` : ''}</> : on ? null : ' · never turned on';
  return (
    <div className="shl-auto" data-auto={on ? 'on' : 'off'}>
      <span className="sm">Automatic price update: <span className={`ebo-chip ${on ? 'ok' : ''}`.trim()}>{on ? 'On' : 'Off'}</span></span>
      <span className="muted xs">{on ? 'Once a day (EST) SHEIN prices that are wrong are previewed, then sent' : 'Prices only change on SHEIN when a person confirms a preview'}{who}</span>
      {canWrite
        ? (on
          ? <button type="button" className="btn ghost xs" disabled={!!busy} onClick={() => onAct('auto_price', { on: false }, 'Automatic price update is off. Prices change only when a person confirms a preview.')}>{busy === 'auto_price' ? 'Saving…' : 'Turn off'}</button>
          : <button type="button" className="btn ghost xs" disabled={!!busy} onClick={() => setAsk(true)}>Turn on…</button>)
        : <span className="muted xs">An admin (or the Connect integrations privilege) can change this.</span>}
      {ask && createPortal(
        <FormModal title="Turn on automatic price update?" submitLabel="Turn on automatic price update" onClose={() => setAsk(false)}
          message={<>Once a day (EST) the server starts a <b>preview</b> of every product whose SHEIN price is off — market + 15 %, rounded up, else the Shopify price — and sends that preview on its next check, with the same checks a person’s send has. A price going <b>up</b> may go to SHEIN’s price review (In review). Sizes, SKUs and titles are never sent by this — those still need a person. You can turn it off any time.</>}
          onSubmit={async () => {
            const r = await onAct('auto_price', { on: true }, 'Automatic price update is on — the first preview starts at the next daily check (EST).');
            if (!r) throw new Error('Not turned on — see the message on the page.');
            setAsk(false);
          }} />,
        document.body,
      )}
    </div>
  );
}
