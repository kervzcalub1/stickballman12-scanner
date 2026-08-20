// Warehouse bulk scan-out: scan many VINs (VIN only — not UPC) and mark them all
// Sold or Shipped at once. Reuses the bulk-status endpoint (sold cascades the
// delist). Unsaved scans are guarded against accidental Back/refresh.
//
// Built for volume (150–300+ pairs a day), so the loop is scan → scan → scan →
// review → submit: the scanner never closes, nothing pops up mid-run, and every
// scan answers with a colour banner AND a tone (lib/beep.js) because staff are
// looking at the box, not the screen. Anything that DOESN'T go on the list —
// wrong barcode, unknown VIN, duplicate, already done — is logged to a persistent
// failure list with its reason instead of a transient error line that the next
// scan overwrites. Submitting is still one deliberate action on a list you can
// see, which is what makes an accidental scan recoverable.
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { estTime } from '../lib/format.js';
import { api } from '../api.js';
import { loadPrefs, savePrefs } from '../prefs.js';
import { TopBar, StatusPill, Modal } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useUnsavedGuard, useMediaQuery } from '../hooks.js';
import { isVinCode } from '../lib/codes.js';
import { beepOk, beepErr } from '../lib/beep.js';
import { useAutoAnimate } from '@formkit/auto-animate/react';

// Lazy-loaded so the barcode library only downloads when the camera is opened.
const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

export function StatusScanPage({ target, navBack, onHome, onSignOut }) {
  const label = target === 'sold' ? 'Sold' : 'Shipped';
  const [rows, setRows] = useState([]);   // { vin, name, sku, size, status, at }
  const [fails, setFails] = useState([]); // { key, code, reason, at } — persistent, unlike `error`
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { count, fails } end-of-session summary
  const [showCam, setShowCam] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [remaining, setRemaining] = useState(null); // sold-not-yet-shipped backlog
  const [flash, setFlash] = useState(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [listRef] = useAutoAnimate(); // rows slide in as each VIN is scanned
  const setCameraZoom = (z) => setPrefs((p) => { const n = { ...p, cameraZoom: z }; savePrefs(n); return n; });
  const toggleSound = () => setPrefs((p) => { const n = { ...p, scanSound: !p.scanSound }; savePrefs(n); return n; });
  const inputRef = useRef(null);
  const recentRef = useRef({});
  const flashTimer = useRef(null);
  const soundRef = useRef(prefs.scanSound);
  soundRef.current = prefs.scanSound;
  const isMobile = useMediaQuery('(max-width: 768px)');
  useUnsavedGuard(rows.length > 0);

  // Every scan answers twice — a colour banner to glance at and a tone to hear.
  // Staff are watching the box and the gun, so the tone is the primary signal.
  function pulse(kind, text) {
    setFlash({ kind, text });
    if (soundRef.current) { if (kind === 'ok') beepOk(); else beepErr(); }
    try { navigator.vibrate?.(kind === 'ok' ? 30 : [30, 40, 30]); } catch { /* unsupported */ }
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1600);
  }
  // A scan that didn't make the list. Kept (newest first) so a run of 300 can be
  // reviewed at the end instead of the reason vanishing on the next scan.
  // Deliberately does NOT set `error` — the banner says it now and the log keeps
  // it, so a third copy under the input was just noise. `error` stays for save
  // failures, which aren't tied to a single scan.
  function fail(code, reason) {
    setFails((f) => [{ key: `${code}-${Date.now()}-${f.length}`, code, reason, at: new Date() }, ...f]);
    pulse('err', reason);
  }
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  // "Remaining" = pairs marked Sold that haven't been scanned out yet — the only
  // real still-to-ship queue in the data (sold → shipped). Meaningless for Sold.
  async function loadRemaining() {
    if (target !== 'shipped') return;
    try { const { counts } = await api.pendingCounts(); setRemaining(counts?.awaiting_shipment ?? null); }
    catch { /* a missing count must never block scanning */ }
  }
  useEffect(() => { loadRemaining(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the box focused so a scanner gun types straight in.
  useEffect(() => { if (!showCam) { const t = setTimeout(() => inputRef.current?.focus(), 50); return () => clearTimeout(t); } }, [showCam, rows]);

  // Back closes the camera first; otherwise falls through to app navigation.
  useEffect(() => {
    if (!navBack) return undefined;
    navBack.current = () => { if (showCam) { setShowCam(false); return true; } return false; };
    return () => { if (navBack) navBack.current = null; };
  }, [navBack, showCam]);

  async function addVin(code) {
    const c = String(code).trim().toUpperCase();
    if (!c) return;
    const now = Date.now();
    if (recentRef.current[c] && now - recentRef.current[c] < 1200) return; // gun/camera re-read
    recentRef.current[c] = now;
    setInput(''); setError('');
    if (!isVinCode(c)) return fail(c, `“${c}” is not a VIN — scan the SBM-… label, not the UPC.`);
    if (rows.some((r) => r.vin === c)) return fail(c, `${c} is already in this list — scanned twice.`);
    setBusy(true);
    try {
      const { item } = await api.itemLookup(c);
      if (item.status === target) return fail(c, `${item.vin} is already ${label}.`);
      setRows((rs) => [{ vin: item.vin, name: item.name, sku: item.sku, size: item.size, status: item.status, at: new Date() }, ...rs]);
      pulse('ok', `${item.name || item.sku || item.vin}${item.size ? ` · US ${item.size}` : ''}`);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      fail(c, err.message);
    } finally { setBusy(false); }
  }
  const removeRow = (vin) => setRows((rs) => rs.filter((r) => r.vin !== vin));
  // Undo the last scan — the common case is one pair scanned in error, and hunting
  // for its row in a list of 200 is slower than the mistake was.
  function undoLast() {
    setRows((rs) => {
      if (!rs.length) return rs;
      const [last, ...rest] = rs;                       // newest is first
      delete recentRef.current[last.vin];               // let it be re-scanned straight away
      pulse('err', `Removed ${last.vin} from the list.`);
      return rest;
    });
  }

  async function save() {
    if (!rows.length) return;
    setShowConfirm(false);
    setBusy(true); setError('');
    try {
      await api.bulkStatus(rows.map((r) => r.vin), target);
      setResult({ count: rows.length, fails: fails.length });
      setRows([]); setFails([]); setFlash(null);
      recentRef.current = {};
      loadRemaining();
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="app">
      <TopBar title={`Mark ${label}`} onHome={onHome} onSignOut={onSignOut}
        right={(
          <button className="btn ghost sm" onClick={toggleSound} aria-pressed={prefs.scanSound}
            title={prefs.scanSound ? 'Scan sounds on — tap to mute' : 'Scan sounds off — tap to unmute'}>
            {prefs.scanSound ? '🔊' : '🔇'}
          </button>
        )} />
      <div className="card">
        {flash && (
          <div className={`scan-flash scan-flash--${flash.kind === 'ok' ? 'vin' : 'err'}`} role="status" aria-live="assertive">
            <span className="scan-flash-ic">{flash.kind === 'ok' ? '✓' : '!'}</span>
            <span>{flash.text}</span>
          </div>
        )}

        {/* The three numbers that matter mid-run, readable at arm's length. */}
        <div className="scanout-stats">
          <div className="scanout-stat"><span className="scanout-num">{rows.length}</span><span className="scanout-lbl">Scanned</span></div>
          {target === 'shipped' && (
            <div className="scanout-stat">
              <span className="scanout-num">{remaining == null ? '—' : Math.max(0, remaining - rows.length)}</span>
              <span className="scanout-lbl">Remaining</span>
            </div>
          )}
          <div className={`scanout-stat${fails.length ? ' bad' : ''}`}><span className="scanout-num">{fails.length}</span><span className="scanout-lbl">Errors</span></div>
          <div className="scanout-last">
            <span className="scanout-lbl">Last scanned</span>
            {rows[0]
              ? <span><span className="vin">{rows[0].vin}</span> <span className="muted sm">{rows[0].name || '—'}{rows[0].size ? ` · US ${rows[0].size}` : ''}</span></span>
              : <span className="muted">—</span>}
          </div>
        </div>

        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); addVin(input); }}>
          <input ref={inputRef} autoFocus autoCapitalize="characters" autoCorrect="off"
            placeholder="Scan a VIN (SBM-…)" value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
          <button className="btn primary" disabled={busy}>Add</button>
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera"><Icon name="camera" /> {showCam ? 'Close camera' : 'Scan with camera'}</button>
        </form>
        {showCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner continuous mode="vin" onDetected={addVin} onClose={() => setShowCam(false)}
              zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
          </Suspense>
        )}
        {error && <div className="error mt">{error}</div>}
        <p className="muted sm mt">Scan each box’s VIN to mark it <b>{label}</b> (VIN only — not the product UPC). The scanner stays open — keep scanning, then review the list and submit once.{target === 'sold' ? ' Marking sold also delists it from Intelligent Inventory and all stores.' : ''}</p>
      </div>

      <div className="batch-bar">
        <button className="btn ghost" onClick={onHome}>← Home</button>
        <div className="batch-totals"><b>{rows.length}</b> to mark {label}</div>
        <button className="btn ghost" disabled={busy || !rows.length} onClick={undoLast} title="Remove the most recent scan">↶ Undo last</button>
        <button className={`btn ${target === 'sold' ? 'ok' : 'primary'}`} disabled={busy || !rows.length} onClick={() => setShowConfirm(true)}>{busy ? 'Saving…' : `Save → ${label}`}</button>
      </div>

      {showConfirm && (
        <Modal type="warn" title={`Mark ${rows.length} item${rows.length === 1 ? '' : 's'} ${label}?`}
          message={target === 'sold'
            ? 'This delists them from Intelligent Inventory and all stores. This can’t be undone from here.'
            : 'Confirm these VINs are correct before marking them shipped.'}
          onClose={() => setShowConfirm(false)}>
          <div className="confirm-list">
            {rows.slice(0, 5).map((r) => <div key={r.vin} className="confirm-line"><span className="vin">{r.vin}</span> <span className="muted sm">{r.name || '—'}{r.size ? ` · US ${r.size}` : ''}</span></div>)}
            {rows.length > 5 && <div className="muted sm">+ {rows.length - 5} more</div>}
          </div>
          <button className={`btn ${target === 'sold' ? 'ok' : 'primary'}`} onClick={save}>Confirm — Mark {label}</button>
          <button className="btn ghost" onClick={() => setShowConfirm(false)}>Cancel</button>
        </Modal>
      )}

      {/* Scans that didn't make the list, with the reason. Persistent: on a 300-pair
          run the reason must survive the next scan, or nobody can act on it. Sits
          BELOW the sticky action bar — a card directly above it gets covered once
          the bar wraps to two rows on a phone. */}
      {fails.length > 0 && (
        <div className="card scanout-fails">
          <div className="scanout-fails-head">
            <b>{fails.length} failed scan{fails.length === 1 ? '' : 's'}</b>
            <button className="btn ghost sm" onClick={() => setFails([])}>Clear</button>
          </div>
          {fails.slice(0, 25).map((f) => (
            <div className="scanout-fail" key={f.key}>
              <span className="vin">{f.code}</span>
              <span className="muted sm">{f.reason}</span>
              <span className="muted sm scanout-fail-t">{estTime(f.at)}</span>
            </div>
          ))}
          {fails.length > 25 && <div className="muted sm">+ {fails.length - 25} older</div>}
        </div>
      )}

      {rows.length > 0 && (
        <div className="card">
          {isMobile ? (
            <div className="dcards" ref={listRef}>
              {rows.map((r) => (
                <div className="dcard" key={r.vin}>
                  <div className="dcard-top">
                    <span className="vin">{r.vin}</span>
                    <button type="button" className="btn icon ghost remove" title="Remove" onClick={() => removeRow(r.vin)}>×</button>
                  </div>
                  <div className="dcard-name">{r.name || '—'}</div>
                  <div className="dcard-line"><span>Size {r.size ? `US ${r.size}` : '—'}</span><StatusPill status={r.status} /></div>
                </div>
              ))}
            </div>
          ) : (
            <div className="inv-tablewrap">
              <table className="inv-table">
                <thead><tr><th className="inv-col-vin">VIN</th><th>Shoe</th><th className="inv-col-size">Size</th><th>Current status</th><th aria-label="remove" /></tr></thead>
                <tbody ref={listRef}>
                  {rows.map((r) => (
                    <tr key={r.vin}>
                      <td className="inv-col-vin"><span className="vin">{r.vin}</span></td>
                      <td className="inv-name" title={r.name}>{r.name || '—'}</td>
                      <td className="inv-col-size">{r.size ? `US ${r.size}` : '—'}</td>
                      <td><StatusPill status={r.status} /></td>
                      <td><button type="button" className="btn icon ghost remove" title="Remove" onClick={() => removeRow(r.vin)}>×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {result && (
        <Modal type="success" title={`Marked ${label}`}
          message={`${result.count} pair${result.count === 1 ? '' : 's'} scanned out successfully`
            + (result.fails ? `, ${result.fails} error${result.fails === 1 ? '' : 's'} during the session.` : ' — no errors.')
            + (target === 'shipped' && remaining != null ? ` ${remaining} still awaiting shipment.` : '')}
          onClose={() => setResult(null)}>
          <button className="btn primary" onClick={() => setResult(null)}>Scan more</button>
          <button className="btn ghost" onClick={onHome}>← Home</button>
        </Modal>
      )}
    </div>
  );
}
