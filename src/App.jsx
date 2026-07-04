// App shell + top-level router. Each page lives in src/screens/*; shared UI in
// src/components/*; pure helpers in src/lib/*. Top-level pages are reflected in
// the URL path (so refresh restores the page); sub-state (open item, wizard step)
// stays in memory. A page may claim the device Back button via `navBack` (close a
// modal / step back) before the app navigates away.
import React, { useEffect, useRef, useState } from 'react';
import { getUser, clearAuth } from './api.js';
import { isUnsavedDirty } from './hooks.js';
import { pathForView, viewForPath } from './lib/constants.js';
import { Auth } from './screens/Auth.jsx';
import { Home } from './screens/Home.jsx';
import { CheckAccess } from './screens/CheckAccess.jsx';
import { Receiving } from './screens/Receiving.jsx';
import { BatchPage } from './screens/BatchPage.jsx';
import { Inventory } from './screens/Inventory.jsx';
import { PHTeamApp, PHGrid } from './screens/PHTeam.jsx';
import { NoBoxReport } from './screens/NoBoxReport.jsx';
import { StatusScanPage } from './screens/StatusScanPage.jsx';
import { RescaleRequestsReport } from './screens/RescaleRequests.jsx';
import { ShelvePage } from './screens/ShelvePage.jsx';
import { Locations } from './screens/Locations.jsx';
import { InstoreListing } from './screens/InstoreListing.jsx';

export default function App() {
  const [user, setUserState] = useState(getUser);
  // Initial page comes from the URL (so refreshing /inventory stays on Inventory).
  const [view, setView] = useState(() => viewForPath(window.location.pathname));
  const [openVin, setOpenVin] = useState(null); // VIN to open in Inventory detail (cross-nav)
  // Multi-box: when set, Receiving runs in "add a box to this open batch" mode.
  const [batchContext, setBatchContext] = useState(null);
  const [batchReturnId, setBatchReturnId] = useState(null); // reopen this batch on return to Batches
  const navBack = useRef(null);              // current page sets its internal back handler here
  const appRef = useRef({ view, user });
  appRef.current = { view, user };

  function onAuthed(u) {
    setUserState(u);
    // PH users route under /ph/* inside PHTeamApp, which reads the URL itself —
    // don't rewrite it here or we'd clobber a /ph/... deep link.
    if (u.role === 'ph_team') return;
    // Honor a deep link the user landed on before signing in (e.g. /inventory).
    const v = viewForPath(window.location.pathname);
    setView(v);
    window.history.replaceState(null, '', pathForView(v));
  }
  function signOut() { clearAuth(); setUserState(null); setView('home'); window.history.replaceState(null, '', '/'); }

  // Keep the URL in sync with the page so refresh restores it and the browser
  // Back/Forward buttons move between pages. A modal or wizard step still
  // consumes Back first (via navBack) so Back closes it instead of leaving.
  useEffect(() => {
    if (!user) return undefined;
    const onPop = () => {
      // Let the page handle Back internally first (close a modal, step back a
      // wizard) — that keeps you on the page, so no "lose changes" prompt.
      const back = navBack.current;
      if (back && back()) {
        window.history.pushState(null, '', pathForView(appRef.current.view));
        return;
      }
      // Back would now leave the page — if there's unsaved data, confirm first.
      if (isUnsavedDirty() && !window.confirm('You have unsaved changes. Leave this page and lose them?')) {
        window.history.pushState(null, '', pathForView(appRef.current.view));
        return;
      }
      setView(viewForPath(window.location.pathname));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [user]);

  if (!user) return <Auth onAuthed={onAuthed} />;

  // PH Team users get their own home: choose the New Inventory report or the
  // Rescale Stock report (same listing/sync job, split by workflow).
  if (user.role === 'ph_team') return <PHTeamApp user={user} onSignOut={signOut} />;

  const go = (v) => {
    setView(v);
    if (window.location.pathname !== pathForView(v)) window.history.pushState(null, '', pathForView(v));
  };
  const openItem = (vin) => { setOpenVin(vin); go('inventory'); };
  if (view === 'receiving') return <Receiving user={user} navBack={navBack} batchContext={batchContext} onBatchDone={() => { setBatchContext(null); go('batches'); }} onOpenItem={openItem} onHome={() => { setBatchContext(null); go('home'); }} onSignOut={signOut} />;
  if (view === 'rescale') return <Receiving mode="rescale" user={user} navBack={navBack} onOpenItem={openItem} onHome={() => go('home')} onSignOut={signOut} />;
  // In-store buying: admin/warehouse only. ph_team never reaches here (they short-
  // circuit to PHTeamApp above), so the normal Home/router already gates it.
  if (view === 'instore') return <Receiving mode="instore" user={user} navBack={navBack} onOpenItem={openItem} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'instore-listing') return <InstoreListing onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'batches') return <BatchPage initialBatchId={batchReturnId} onAddBox={(batch) => { setBatchContext(batch); setBatchReturnId(batch.id); go('receiving'); }} onOpenItem={openItem} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'inventory') return <Inventory navBack={navBack} openVin={openVin} onConsumedVin={() => setOpenVin(null)} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'report') return <PHGrid user={user} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'access') return <CheckAccess user={user} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'nobox') return <NoBoxReport user={user} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'sold') return <StatusScanPage target="sold" navBack={navBack} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'shipped') return <StatusScanPage target="shipped" navBack={navBack} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'rescalereq') return <RescaleRequestsReport canAudit showPricing={user.role !== 'warehouse'} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'shelve') return <ShelvePage navBack={navBack} onHome={() => go('home')} onSignOut={signOut} />;
  if (view === 'locations') return <Locations onHome={() => go('home')} onSignOut={signOut} />;
  return <Home user={user} onPick={(v) => { setBatchContext(null); go(v); }} onSignOut={signOut} />;
}
