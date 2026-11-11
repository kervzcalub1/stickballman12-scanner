// SHEIN (PH /ph/shein, admin /shein): every SHEIN screen on one page, in sections kept in `?section=`.
// A section mounts on its first visit and then stays mounted, hidden, so an uploaded export, a reprice
// in progress and prices being fetched in the browser all survive moving between sections. A hidden
// section does nothing on its own: every useLive inside it is paused (LivePausedContext) and catches up
// when shown. Each section owns its own URL params (src/lib/sheinPage.js for who sees what, and where the
// old pages' URLs land; docs/context/shein-listings.md → "The one page").
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from '../components/common.jsx';
import { SheinNavContext } from '../components/SheinNav.jsx';
import { api } from '../api.js';
import { LivePausedContext } from '../hooks.js';
import { hasPriv } from '../lib/constants.js';
import { PH_DATETIME } from '../lib/format.js';
import { canonicalSheinUrl, sheinSectionsFor, isSheinPath } from '../lib/sheinPage.js';
import { CARD_WORDS, SECTION_WORDS, SECTION_LEADS, plain } from '../lib/sheinWords.js';
import { readParam, syncQueryParams } from '../lib/urlstate.js';
import { SheinToday } from './SheinToday.jsx';
import { SheinListings } from './SheinListings.jsx';
import { SheinCheck } from './SheinCheck.jsx';
import { SheinReprice } from './SheinReprice.jsx';
import { SheinLivePanel } from './SheinLivePanel.jsx';
import { SheinOrders } from './SheinOrders.jsx';

// Runs before any section's first render, so each one seeds its URL state from the tidy address.
// Idempotent. replaceState, so Back skips the old address.
function tidyUrl(base) {
  const next = canonicalSheinUrl(window.location.pathname, window.location.search, base);
  if (next) window.history.replaceState(null, '', next + window.location.hash);
}

export function Shein({ user, base, onHome, onSignOut }) {
  const allowed = useMemo(() => sheinSectionsFor(user), [user]);
  const [raw, setRaw] = useState(() => { tidyUrl(base); return readParam('section'); });
  const section = allowed.includes(raw) ? raw : allowed[0];
  const seen = useRef(new Set());
  seen.current.add(section);
  const canConnect = hasPriv(user, 'connect_integrations');

  // A link to a section this account can't see lands on its first one; the URL shouldn't claim otherwise.
  useEffect(() => {
    if (raw && raw !== section) { const u = new URL(window.location.href); u.searchParams.set('section', section); window.history.replaceState(null, '', u.pathname + u.search + u.hash); setRaw(section); }
  }, [raw, section]);

  // Back / Forward (or an old address pushed by stale code) lands here. Leaving the page isn't our business.
  useEffect(() => {
    const onPop = () => { if (!isSheinPath(window.location.pathname)) return; tidyUrl(base); setRaw(readParam('section')); syncQueryParams(); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [base]);

  // Each section keeps its own place on the page.
  const scrolls = useRef({});
  const current = useRef(section);
  useLayoutEffect(() => {
    if (current.current === section) return;
    current.current = section;
    window.scrollTo(0, scrolls.current[section] || 0);
  }, [section]);

  const go = useCallback((key, params = {}) => {
    scrolls.current[current.current] = window.scrollY;
    const u = new URL(window.location.href);
    u.searchParams.set('section', key);
    for (const [k, v] of Object.entries(params)) { if (v === '' || v == null) u.searchParams.delete(k); else u.searchParams.set(k, String(v)); }
    window.history.replaceState(null, '', u.pathname + u.search + u.hash);
    setRaw(key);
    if (Object.keys(params).length) syncQueryParams();
  }, []);

  // The connection: read once, when Automatic sync or Fix problems is first opened.
  const needsStatus = seen.current.has('live') || seen.current.has('check');
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState(null);
  const loadStatus = useCallback(async () => {
    setStatusErr(null);
    try { setStatus(await api.sheinStatus()); }
    catch (e) { if (e.unauthorized) onSignOut(); else setStatusErr({ code: e.status, message: e.message }); }
  }, [onSignOut]);
  useEffect(() => { if (needsStatus) loadStatus(); }, [needsStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = (k) => {
    if (k === 'today') return <SheinToday onSignOut={onSignOut} />;
    if (k === 'listings') return <SheinListings user={user} visible={section === 'listings'} onSignOut={onSignOut} />;
    if (k === 'orders') return <SheinOrders onSignOut={onSignOut} />;
    if (k === 'check') return <SheinCheck sheinApi={status} onSignOut={onSignOut} />;
    if (k === 'reprice') return <SheinReprice onSignOut={onSignOut} />;
    return <SheinLiveSection status={status} statusErr={statusErr} canConnect={canConnect} onRetry={loadStatus} onSignOut={onSignOut} />;
  };

  return (
    <div className="app shein-page">
      <TopBar title={CARD_WORDS.title} onHome={onHome} onSignOut={onSignOut} />
      <div className="shein-sections" role="tablist" aria-label="SHEIN sections">
        {allowed.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={section === k} data-section-tab={k}
            className={`seg-btn${section === k ? ' on' : ''}`} onClick={() => go(k)}>{SECTION_WORDS[k]}</button>
        ))}
      </div>
      <SheinNavContext.Provider value={go}>
        {allowed.filter((k) => seen.current.has(k)).map((k) => (
          <div key={k} role="tabpanel" hidden={k !== section} data-section={k}>
            <LivePausedContext.Provider value={k !== section}>{SECTION_LEADS[k] && <p className="shein-lead">{SECTION_LEADS[k]}</p>}{body(k)}</LivePausedContext.Provider>
          </div>
        ))}
      </SheinNavContext.Provider>
    </div>
  );
}

// The connection, then the sync itself.
function SheinLiveSection({ status, statusErr, canConnect, onRetry, onSignOut }) {
  const [result, setResult] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return { ok: p.get('shein') === 'connected', error: p.get('shein_error') || '' };
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Say how it went once, then drop only those two params: the rest of the URL belongs to other sections.
  useEffect(() => {
    const u = new URL(window.location.href);
    if (!u.searchParams.has('shein') && !u.searchParams.has('shein_error')) return;
    u.searchParams.delete('shein'); u.searchParams.delete('shein_error');
    window.history.replaceState(null, '', u.pathname + u.search + u.hash);
  }, []);
  async function connect() {
    setErr(''); setBusy(true); setResult({ ok: false, error: '' });
    try { const r = await api.sheinConnect(); window.location.href = r.url; }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(plain(e.message)); setBusy(false); }
  }
  const refused = statusErr?.code === 403;
  return (
    <>
      <div className="card shl-strip-card" data-connect="">
        {!status && !statusErr && <div className="shl-skel shl-skel-line" aria-label="Loading" />}
        {refused && (
          <p className="notice sm" data-connect-state="refused">Your account can’t open this screen’s information: it answers only to the PH team and admins. Ask an admin to check SHEIN’s connection or to change a sync switch.</p>
        )}
        {statusErr && !refused && (
          <div data-connect-state="error">
            <p className="error sm">Couldn’t read the SHEIN connection: {plain(statusErr.message)}</p>
            <button type="button" className="btn ghost sm" onClick={onRetry}>Try again</button>
          </div>
        )}
        {status && (
          <div className="shl-strip" data-connect-state={status.connected ? 'connected' : status.configured ? 'not_connected' : 'not_set_up'}>
            {status.connected
              ? <><span className="ebl-ok">● SHEIN connected</span>{status.connectedAt && <span className="muted sm">Since {PH_DATETIME.format(new Date(status.connectedAt))} EST{status.connectedBy ? ` by ${status.connectedBy}` : ''}</span>}</>
              : !status.configured ? <span className="muted sm">SHEIN isn’t set up on this server yet. Until it is, fixes go through SHEIN’s upload files.</span>
                : canConnect ? <><span className="shl-bad-text">● SHEIN not connected</span><span className="shl-grow" /><button type="button" className="btn primary" disabled={busy} onClick={connect}>{busy ? 'Opening SHEIN…' : 'Connect SHEIN'}</button></>
                  : <span className="muted sm">SHEIN isn’t connected yet. An admin connects it.</span>}
          </div>
        )}
        {result.ok && <p className="ebl-ok sm mt" role="status">SHEIN connected.</p>}
        {result.error && <div className="error mt" role="alert">SHEIN didn’t connect: {result.error}</div>}
        {err && <div className="error mt" role="alert">{err}</div>}
      </div>
      {status?.connected && <SheinLivePanel isAdmin={canConnect} onSignOut={onSignOut} />}
    </>
  );
}
