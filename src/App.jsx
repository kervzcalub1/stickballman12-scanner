// App shell + top-level router. Each page lives in src/screens/*; shared UI in
// src/components/*; pure helpers in src/lib/*. Top-level pages are reflected in
// the URL path (so refresh restores the page); sub-state (open item, wizard step)
// stays in memory. A page may claim the device Back button via `navBack` (close a
// modal / step back) before the app navigates away.
import React, { useEffect, useRef, useState } from 'react';
import { getUser, clearAuth, api } from './api.js';
import { isUnsavedDirty } from './hooks.js';
import { pathForView, viewForPath } from './lib/constants.js';
import { clearQuery, writeParam } from './lib/urlstate.js';
import { setMarkupPct } from './lib/config.js';
import { Auth, ForcedPasswordChange } from './screens/Auth.jsx';
import { Home } from './screens/Home.jsx';
import { CheckAccess } from './screens/CheckAccess.jsx';
import { Settings } from './screens/Settings.jsx';
import { MergeTools } from './screens/MergeTools.jsx';
import { Receiving } from './screens/Receiving.jsx';
import { BatchPage } from './screens/BatchPage.jsx';
import { Inventory } from './screens/Inventory.jsx';
import { PHTeamApp, PHGrid } from './screens/PHTeam.jsx';
import { NoBoxReport } from './screens/NoBoxReport.jsx';
import { ItemCosts } from './screens/ItemCosts.jsx';
import { BoxLabels } from './screens/BoxLabels.jsx';
import { BoxStock } from './screens/BoxStock.jsx';
import { StatusScanPage } from './screens/StatusScanPage.jsx';
import { RescaleRequestsReport } from './screens/RescaleRequests.jsx';
import { ShelvePage } from './screens/ShelvePage.jsx';
import { Locations } from './screens/Locations.jsx';
import { InstoreListing } from './screens/InstoreListing.jsx';
import { PayoutCalculator } from './screens/PayoutCalculator.jsx';
import { Advisor } from './components/Advisor.jsx';
import { ExistingStock } from './screens/ExistingStock.jsx';
import { SupplierApp } from './screens/SupplierApp.jsx';
import { Reconciliation } from './screens/Reconciliation.jsx';
import { Sop } from './screens/Sop.jsx';
import { DeletedItems } from './screens/DeletedItems.jsx';
import { VinStock } from './screens/VinStock.jsx';

// The supplier scan-out portal is served on the `supplier.` subdomain. This is a
// UX/branding branch only — the real boundary is server-side (every /api/po/*
// endpoint scopes a supplier to their own POs). Never trust the hostname for authz.
const SUPPLIER_HOST = typeof window !== 'undefined' && /^supplier\./i.test(window.location.hostname);
const isPrivilegedRole = (r) => r === 'admin' || r === 'superadmin';

export default function App() {
  const [user, setUserState] = useState(getUser);
  // Initial page comes from the URL (so refreshing /inventory stays on Inventory).
  const [view, setView] = useState(() => viewForPath(window.location.pathname));
  // Superadmin only: when true we render the PH-team workspace (PHTeamApp, which
  // owns the /ph/* routes). ph_team is always in it; superadmin toggles in/out.
  const [phMode, setPhMode] = useState(() => window.location.pathname.startsWith('/ph'));
  const [openVin, setOpenVin] = useState(null); // VIN to open in Inventory detail (cross-nav)
  // Multi-box: when set, Receiving runs in "add a box to this open batch" mode.
  const [batchContext, setBatchContext] = useState(null);
  const [batchReturnId, setBatchReturnId] = useState(null); // reopen this batch on return to Batches
  const navBack = useRef(null);              // current page sets its internal back handler here
  const appRef = useRef({ view, user });
  appRef.current = { view, user };

  function onAuthed(u) {
    setUserState(u);
    // PH users (and superadmin deep-linking into /ph/*) route under /ph/* inside
    // PHTeamApp, which reads the URL itself — don't rewrite it or we'd clobber the link.
    if (u.role === 'ph_team' || u.role === 'supplier') return;
    if (u.role === 'superadmin' && window.location.pathname.startsWith('/ph')) { setPhMode(true); return; }
    // Honor a deep link the user landed on before signing in (e.g. /inventory).
    const v = viewForPath(window.location.pathname);
    setView(v);
    window.history.replaceState(null, '', pathForView(v));
  }
  function signOut() { clearAuth(); setUserState(null); setView('home'); window.history.replaceState(null, '', '/'); }

  // Load app-wide settings (price margin) once signed in, so "GI + N%" labels and
  // Final-price math use the real configured value. Bump state to re-render after.
  const [, setCfgTick] = useState(0);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api.getSettings()
      .then((r) => { if (!cancelled && r?.priceMarkupPct != null) { setMarkupPct(r.priceMarkupPct); setCfgTick((t) => t + 1); } })
      .catch(() => { /* keep default 20% */ });
    return () => { cancelled = true; };
  }, [user]);

  // Keep the URL in sync with the page so refresh restores it and the browser
  // Back/Forward buttons move between pages. A modal or wizard step still
  // consumes Back first (via navBack) so Back closes it instead of leaving.
  useEffect(() => {
    if (!user) return undefined;
    const onPop = () => {
      // Let the page handle Back internally first (close a modal, step back a
      // wizard) — that keeps you on the page, so no "lose changes" prompt.
      // Re-pushing the current path must PRESERVE the query string — screens keep
      // their restorable state there (?sku=…), and dropping it would blank the page
      // the moment Back is cancelled.
      const here = () => pathForView(appRef.current.view) + window.location.search;
      const back = navBack.current;
      if (back && back()) {
        window.history.pushState(null, '', here());
        return;
      }
      // Back would now leave the page — if there's unsaved data, confirm first.
      if (isUnsavedDirty() && !window.confirm('You have unsaved changes. Leave this page and lose them?')) {
        window.history.pushState(null, '', here());
        return;
      }
      // Keep superadmin's PH-workspace flag in sync with the URL (PHTeamApp handles
      // its own /ph/* subpages; here we only toggle in/out of the workspace).
      setPhMode(window.location.pathname.startsWith('/ph'));
      setView(viewForPath(window.location.pathname));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [user]);

  if (!user) return <Auth onAuthed={onAuthed} />;
  // Signed in with an admin-issued temp password → force a change before anything else
  // (the server also rejects role-gated calls with 428 until this is done).
  if (user.mustChange) return <ForcedPasswordChange user={user} onChanged={onAuthed} onSignOut={signOut} />;

  // The advisor rides along on every staff screen, attached here rather than in each of
  // the twenty-five screens below — and, since 2026-08-26, on the supplier portal too,
  // where it is a much narrower thing: three tools, its own prompt, and results
  // projected down to counts (see api/advisor/ask.js). Still absent from the two
  // returns above it — Auth and the forced password change are pre-auth.
  const withAdvisor = (screen) => (<>{screen}<Advisor user={user} /></>);

  const enterPh = () => { setPhMode(true); if (window.location.pathname !== '/ph') window.history.pushState(null, '', '/ph'); };
  const exitPh = () => { setPhMode(false); window.history.pushState(null, '', pathForView('home')); setView('home'); };

  // PH Team users get their own home (New Inventory / Rescale Stock reports, etc.).
  // Superadmin reuses the same workspace when they've entered PH mode; exitPh takes
  // them back to the main admin home.
  // Suppliers only ever see the scan-out portal (any host).
  if (user.role === 'supplier') return withAdvisor(<SupplierApp user={user} onSignOut={signOut} />);
  // On the supplier subdomain, staff don't belong — admins pass through for oversight,
  // everyone else is pointed at the main site.
  if (SUPPLIER_HOST) {
    if (isPrivilegedRole(user.role)) return withAdvisor(<SupplierApp user={user} onSignOut={signOut} />);
    return (
      <div className="app"><div className="wrap-narrow"><div className="card empty-state">
        This portal is for suppliers. Staff — please use <a href="https://stickballman12.com">stickballman12.com</a>.
        <div style={{ marginTop: 12 }}><button className="btn ghost" onClick={signOut}>Sign out</button></div>
      </div></div></div>
    );
  }

  if (user.role === 'ph_team') return withAdvisor(<PHTeamApp user={user} onSignOut={signOut} />);
  if (user.role === 'superadmin' && phMode) return withAdvisor(<PHTeamApp user={user} onSignOut={signOut} onExit={exitPh} />);

  const go = (v) => {
    setView(v);
    // Changing page drops the old page's query — another screen's ?sku= is meaningless
    // and would read as state that failed to load.
    if (window.location.pathname !== pathForView(v)) window.history.pushState(null, '', pathForView(v));
    else clearQuery();
  };
  const openItem = (vin) => { setOpenVin(vin); go('inventory'); };
  // Jump straight from "batch saved, but this PO is 2 short" into that PO's report.
  // go() lands on /reconcile and clears the query, so the ?po= is written after.
  const openReconcile = (poId) => { setBatchContext(null); go('reconcile'); writeParam('po', poId); };
  if (view === 'receiving') return withAdvisor(<Receiving user={user} navBack={navBack} batchContext={batchContext} onBatchDone={() => { setBatchContext(null); go('batches'); }} onOpenItem={openItem} onOpenReconcile={openReconcile} onHome={() => { setBatchContext(null); go('home'); }} onSignOut={signOut} />);
  if (view === 'rescale') return withAdvisor(<Receiving mode="rescale" user={user} navBack={navBack} onOpenItem={openItem} onHome={() => go('home')} onSignOut={signOut} />);
  // In-store buying: admin/warehouse only. ph_team never reaches here (they short-
  // circuit to PHTeamApp above), so the normal Home/router already gates it.
  if (view === 'instore') return withAdvisor(<Receiving mode="instore" user={user} navBack={navBack} onOpenItem={openItem} onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'instore-listing') return withAdvisor(<InstoreListing onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'payout') return withAdvisor(<PayoutCalculator user={user} onHome={() => go('home')} onSignOut={signOut} />);
  // Existing (old) stock: same admin/warehouse gate as in-store — ph_team short-
  // circuits to PHTeamApp above and never reaches this router.
  if (view === 'existing-stock') return withAdvisor(<ExistingStock navBack={navBack} onHome={() => go('home')} onSignOut={signOut} />);
  // `box` is set when continuing an EXISTING pending box; absent = add a new one.
  if (view === 'batches') return withAdvisor(<BatchPage initialBatchId={batchReturnId} onAddBox={(batch, box = null) => { setBatchContext({ ...batch, box }); setBatchReturnId(batch.id); go('receiving'); }} onOpenItem={openItem} onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'inventory') return withAdvisor(<Inventory navBack={navBack} openVin={openVin} onConsumedVin={() => setOpenVin(null)} onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'report') return withAdvisor(<PHGrid user={user} onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'deleted') return withAdvisor(<DeletedItems onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'vin-stock') return withAdvisor(<VinStock onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'access') return withAdvisor(<CheckAccess user={user} onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'settings') return withAdvisor(<Settings onHome={() => go('home')} onSignOut={signOut} />);
  // Superadmin only, and gated HERE as well as on the server: an admin who types /merge
  // gets the home page, not a tool whose buttons would 403 halfway through.
  if (view === 'merge') return withAdvisor(user.role === 'superadmin'
    ? <MergeTools onHome={() => go('home')} onSignOut={signOut} />
    : <Home user={user} onPick={go} onSignOut={signOut} />);
  if (view === 'nobox') return withAdvisor(<NoBoxReport user={user} onHome={() => go('home')} onSignOut={signOut} />);
  // Replacement box labels — admin/warehouse (ph_team short-circuits to PHTeamApp above).
  if (view === 'costs') return withAdvisor(<ItemCosts onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'box-labels') return withAdvisor(<BoxLabels navBack={navBack} onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'box-stock') return withAdvisor(<BoxStock onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'sold') return withAdvisor(<StatusScanPage target="sold" navBack={navBack} onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'shipped') return withAdvisor(<StatusScanPage target="shipped" navBack={navBack} onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'rescalereq') return withAdvisor(<RescaleRequestsReport canAudit showPricing={user.role !== 'warehouse'} onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'shelve') return withAdvisor(<ShelvePage navBack={navBack} onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'locations') return withAdvisor(<Locations onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'reconcile') return withAdvisor(<Reconciliation canReconcile={user.role === 'warehouse' || isPrivilegedRole(user.role)} onHome={() => go('home')} onSignOut={signOut} />);
  if (view === 'sop') return withAdvisor(<Sop user={user} navBack={navBack} onHome={() => go('home')} onSignOut={signOut} />);
  return withAdvisor(<Home user={user} onPick={(v) => { setBatchContext(null); if (v === 'ph') return enterPh(); go(v); }} onSignOut={signOut} />);
}
