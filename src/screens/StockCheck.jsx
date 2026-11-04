// Stock Check (/stock-check, docs/context/inventory.md "Stock Check").
//
// Alex's ask, 2026-11-04: "scan the shoe and it'll say you scanned a size 10, we have three
// in inventory — or if the VIN is on it, the VIN will say yes this is or is not in
// inventory", then audit by scanning every pair to see if the number is right.
//
// So: scan ANYTHING (box UPC, VIN sticker, or type a SKU) → one big answer. Then
// "Count this size": every scan of the same shoe + size adds one, and Finish compares the
// count with Shopify's number, read live again at that moment.
//
// THE SERVER OWNS THE COUNT. Every scan is recorded under the person (My Scans reads them),
// and whether a scan counted is decided by api/items/stock-check.js — this screen only
// shows what it was told, so a count can't be nudged from the browser. A count survives a
// refresh (GET /api/items/stock-count resumes it).
//
// The number is Shopify's for-sale quantity (lib/stockCheck.js says why, and why NOT
// Shopify's "committed"). A pair sold today but not yet shipped is still on the shelf but
// no longer in that number — so the screen says: count after the day's orders ship.
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { loadPrefs, savePrefs } from '../prefs.js';
import { TopBar } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { PH_DATE, PH_DATETIME } from '../lib/format.js';
import { beepOk, beepErr } from '../lib/beep.js';
import { stickerState } from '../lib/stickerState.js';
import { pairVerdict, shopifyForSize, shopifySizes, countResult, entryVia } from '../lib/stockCheck.js';

const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));
const VERDICT_ICON = { in: '✅', out: '❌', warn: '⚠️' };

export function StockCheck({ onHome, onSignOut, onMyScans }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState(null);   // the last check's response (+ chosen size)
  const [count, setCount] = useState(null);     // { ...stock_counts row, tally, scans } — the server's
  const [result, setResult] = useState(null);   // the finished count
  const [vinOnly, setVinOnly] = useState(false);
  const [flash, setFlash] = useState(null);     // { kind: 'ok'|'err', text } — the count's per-scan banner
  const [showCam, setShowCam] = useState(false);
  const [prefs, setPrefs] = useState(loadPrefs);
  const setCameraZoom = (z) => setPrefs((p) => { const n = { ...p, cameraZoom: z }; savePrefs(n); return n; });
  const inputRef = useRef(null);
  const flashTimer = useRef(null);
  const countRef = useRef(null);
  countRef.current = count;
  const queue = useRef(Promise.resolve());
  // How the code in the box got there: a gun types a whole code in a burst, a person
  // doesn't. Only a hint, recorded beside each scan so a count's typed entries show.
  const keys = useRef({ first: 0, last: 0, pasted: false });

  // A count left open (refresh, closed tab, dead battery) carries on where it stopped.
  useEffect(() => {
    api.stockCountOpen().then((r) => { if (r.count) setCount({ ...r.count, tally: r.tally, scans: r.scans }); })
      .catch((e) => { if (e.unauthorized) onSignOut(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!showCam) { const t = setTimeout(() => inputRef.current?.focus(), 50); return () => clearTimeout(t); } }, [showCam, answer, count]);

  function pulse(kind, text) {
    setFlash({ kind, text });
    if (prefs.scanSound !== false) { if (kind === 'ok') beepOk(); else beepErr(); }
    try { navigator.vibrate?.(kind === 'ok' ? 30 : [30, 40, 30]); } catch { /* unsupported */ }
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1800);
  }
  function onType(e) {
    const v = e.target.value;
    const now = performance.now();
    if (!input || v.length <= 1) keys.current = { first: now, last: now, pasted: false };
    else keys.current.last = now;
    setInput(v);
  }

  // Scans are handled one at a time, in order — a gun can fire faster than a check answers.
  function scan(raw, via) {
    const code = String(raw || '').trim();
    setInput('');
    if (!code) return;
    const how = via || entryVia(code.length, keys.current.last - keys.current.first, keys.current.pasted);
    keys.current = { first: 0, last: 0, pasted: false };
    queue.current = queue.current.then(() => (countRef.current ? countScan(code, how) : check(code, how))).catch(() => {});
  }

  async function check(code, via, { size = '', recheck = false } = {}) {
    setBusy(true); setError(''); setResult(null);
    try {
      const r = await api.stockCheck(code, { size, via, recheck });
      setAnswer(r);
      if (!recheck) { if (r.unknown) beepErr(); else beepOk(); }
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message); beepErr();
    } finally { setBusy(false); }
  }

  async function countScan(code, via) {
    const c = countRef.current;
    try {
      const r = await api.stockCheck(code, { countId: c.id, via });
      setCount((cur) => (cur && cur.id === c.id ? { ...cur, tally: r.tally, scans: [{ ...r.scan, code, vin: r.pair?.vin || null }, ...cur.scans] } : cur));
      if (r.scan.counted) pulse(r.scan.note ? 'err' : 'ok', r.scan.note ? `+1 · but ${r.scan.note}` : `+1 · ${c.size}`);
      else pulse('err', `Not counted — ${r.scan.note}`);
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      pulse('err', `Not counted — ${e.message}`);
      // The count was closed elsewhere (another tab finished it): stop showing it as open.
      if (e.status === 409 || e.status === 404) setCount(null);
    }
  }

  async function countAction(action, body) {
    setBusy(true); setError('');
    try { return await api.stockCount(action, body); }
    catch (e) { if (e.unauthorized) onSignOut(); else setError(e.message); return null; }
    finally { setBusy(false); }
  }
  // Start counting the size on screen. A scanned box/VIN is in hand, so the server files it as #1.
  // Runs IN the scan queue: a box scanned the instant after tapping waits for the count to
  // exist, instead of being taken as a plain check (and the next one bouncing off a busy box).
  function startCount() {
    queue.current = queue.current.then(startCountNow).catch(() => {});
  }
  async function startCountNow() {
    const a = answer;
    const r = await countAction('start', a.scan?.id != null && a.kind !== 'sku'
      ? { scanId: a.scan.id, vinOnly } : { sku: a.shoe.sku, size: a.shoe.size, name: a.shoe.name, vinOnly });
    if (!r) return;
    setResult(null);
    const c = { ...r.count, tally: r.tally, scans: r.scans };
    countRef.current = c;   // now, not at the next render — the queued scans read it
    setCount(c);
  }
  // Undo and Finish also wait their turn behind scans still being answered.
  const undoLast = () => { queue.current = queue.current.then(undoLastNow).catch(() => {}); };
  const finish = () => { queue.current = queue.current.then(finishNow).catch(() => {}); };
  async function undoLastNow() {
    const r = await countAction('undo', { id: countRef.current.id });
    if (r) setCount({ ...r.count, tally: r.tally, scans: r.scans });
  }
  async function finishNow() {
    const r = await countAction('finish', { id: countRef.current.id });
    if (!r) return;
    const c = r.count;
    setResult({ ...c, tally: r.tally, checkedAt: r.checkedAt, readErr: r.shopifyError, ...countResult(c.counted, c.expected_end) });
    countRef.current = null;
    setCount(null);
  }
  async function cancelCount() {
    if (count.tally?.counted && !window.confirm('Stop this count? It is kept in My Scans as cancelled.')) return;
    const r = await countAction('cancel', { id: count.id });
    if (r) { countRef.current = null; setCount(null); }
  }

  const t = count?.tally || {};
  const expected = count?.expected_start;

  return (
    <div className="app">
      <TopBar title="Stock Check" onHome={onHome} onSignOut={onSignOut}
        right={onMyScans ? <button type="button" className="btn ghost sm" onClick={onMyScans}>My scans</button> : null} />
      <div className="wrap-narrow stkchk">
        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); scan(input); }}>
          <input ref={inputRef} autoFocus autoCapitalize="characters" autoCorrect="off" aria-label="Scan or type a code"
            placeholder={count ? `Scan every ${count.size} you find…` : 'Scan a box or a VIN — or type a SKU'}
            value={input} onChange={onType} onPaste={() => { keys.current.pasted = true; }} />
          <button className="btn primary">{count ? 'Add' : 'Check'}</button>
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera">
            <Icon name="camera" /> {showCam ? 'Close camera' : 'Camera'}
          </button>
        </form>
        {showCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner continuous mode="rescale" refireAfterGapMs={count ? 1500 : 0} onDetected={(c) => scan(c, 'camera')}
              onClose={() => setShowCam(false)} zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
          </Suspense>
        )}
        {error && <div className="error mt">{error}</div>}

        {count && (
          <section className="card stkchk-count" aria-label="Counting">
            <div className="stkchk-count-head">
              <div>
                <div className="muted sm">Counting{count.vin_only ? ' · VINs only' : ''}</div>
                <div className="stkchk-count-shoe">{count.name || count.sku}</div>
                <div className="muted sm">{count.sku} · size <b>{count.size}</b></div>
              </div>
              <div className="stkchk-tally" aria-label={`Counted ${t.counted || 0}`}>
                <span className="stkchk-tally-num">{t.counted || 0}</span>
                <span className="muted sm">{expected == null ? 'Shopify: couldn’t read' : `of ${expected} on Shopify`}</span>
              </div>
            </div>
            {flash && <div className={`stkchk-flash ${flash.kind}`} role="status">{flash.text}</div>}
            <p className="muted sm">
              {count.vin_only
                ? <>Scan the <b>VIN sticker</b> on every pair of this size. Each pair counts once — a box barcode is not counted.</>
                : <>Scan every pair of this size you can find, <b>once each — its box barcode or its VIN sticker, not both</b>. A different shoe or size is not counted.</>}
            </p>
            {(t.by_barcode > 0 || t.typed > 0 || t.flagged > 0) && (
              <p className="stkchk-mix muted sm">
                {t.by_vin || 0} by VIN · {t.by_barcode || 0} by box barcode
                {t.typed ? ` · ${t.typed} typed by hand` : ''}{t.flagged ? ` · ${t.flagged} our record says gone` : ''}
              </p>
            )}
            <div className="stkchk-actions">
              <button type="button" className="btn ghost" onClick={undoLast} disabled={busy || !t.counted}>↶ Undo last</button>
              <button type="button" className="btn ghost" onClick={cancelCount} disabled={busy}>Cancel</button>
              <button type="button" className="btn ok" onClick={finish} disabled={busy}>{busy ? 'Working…' : 'Finish count'}</button>
            </div>
            {count.scans?.length > 0 && (
              <ol className="stkchk-log">
                {count.scans.slice(0, 30).map((l) => (
                  <li key={l.id} className={l.counted && !l.undone ? 'ok' : 'bad'}>
                    <span className="mono">{l.vin || l.code}</span>
                    <span className="muted sm">{l.undone ? 'undone' : l.counted ? 'counted' : 'not counted'}{l.note ? ` — ${l.note}` : ''}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

        {result && !count && (
          <section className={`card stkchk-result ${result.tone}`} aria-label="Count result">
            <div className="stkchk-verdict"><span aria-hidden="true">{VERDICT_ICON[result.tone]}</span> <span>{result.text}</span></div>
            <div className="muted sm">{result.name || result.sku} · {result.sku} · size {result.size}</div>
            {result.tally && (
              <p className="muted sm">
                {result.tally.by_vin} by VIN · {result.tally.by_barcode} by box barcode
                {result.tally.typed ? ` · ${result.tally.typed} typed by hand` : ''}
                {result.tally.flagged ? ` · ${result.tally.flagged} our record says gone` : ''}
                {result.tally.refused ? ` · ${result.tally.refused} not counted` : ''}
              </p>
            )}
            {result.readErr && <p className="shopchk-err">Couldn’t read Shopify again ({result.readErr}) — compared with the number read when the count started.</p>}
            {result.checkedAt && <p className="muted sm">Shopify read at {PH_DATETIME.format(new Date(result.checkedAt))} EST.</p>}
            {result.tone !== 'in' && result.expected_end != null && (
              <p className="muted sm">Before calling a pair missing: was anything of this size sold today and not shipped yet? It is still on the shelf but no longer in Shopify’s number.</p>
            )}
            <div className="stkchk-actions">
              <button type="button" className="btn ghost" onClick={() => setResult(null)}>Done</button>
              {onMyScans && <button type="button" className="btn ghost" onClick={onMyScans}>My scans</button>}
            </div>
          </section>
        )}

        {!count && answer && <Answer a={answer} busy={busy} vinOnly={vinOnly} onVinOnly={setVinOnly}
          onPickSize={(size) => setAnswer((cur) => ({ ...cur, shoe: { ...cur.shoe, size } }))}
          onRecheck={() => check(answer.kind === 'sku' ? answer.shoe.sku : answer.code, null, { size: answer.kind === 'sku' ? answer.shoe.size || '' : '', recheck: true })}
          onCount={startCount} />}

        {!answer && !count && !result && (
          <div className="card empty-state stkchk-help">
            <p><b>Scan a box</b> — see its size and how many Shopify has.</p>
            <p><b>Scan a VIN sticker</b> — see whether that pair is still in inventory.</p>
            <p><b>Count a size</b> — after a scan, tap <b>Count this size</b> and scan every pair of it you find.</p>
          </div>
        )}
        <p className="muted sm mt">
          The number is what Shopify has for sale right now. A pair sold today but not shipped yet is
          still on the shelf but no longer counted — <b>count after the day’s orders have shipped</b>.
        </p>
      </div>
    </div>
  );
}

function Answer({ a, busy, vinOnly, onVinOnly, onPickSize, onRecheck, onCount }) {
  const { shoe, pair, sticker, shopify } = a;
  const verdict = pair ? pairVerdict(pair, pair.events) : null;
  const st = !pair && sticker ? stickerState(sticker) : null;
  const sh = shoe?.size && shopify && !shopify.error ? shopifyForSize(shopify.products, shoe.size) : null;
  const sizes = shopify && !shopify.error ? shopifySizes(shopify.products) : [];

  if (a.unknown || (!shoe && !pair && !sticker)) {
    return (
      <section className="card stkchk-answer out" aria-label="Answer">
        <div className="stkchk-verdict"><span aria-hidden="true">❌</span> <span>Couldn’t tell which shoe {a.code} is</span></div>
        <p className="muted sm">The barcode isn’t in the catalogue or in our stock. Type the SKU off the box label instead.</p>
      </section>
    );
  }
  return (
    <section className={`card stkchk-answer ${verdict?.tone || (st ? 'out' : '')}`} aria-label="Answer">
      {verdict && (
        <div className="stkchk-pair">
          <div className="stkchk-verdict"><span aria-hidden="true">{VERDICT_ICON[verdict.tone]}</span> <span>{verdict.headline}</span></div>
          <div className="muted sm">
            <span className="mono">{pair.vin}</span> · {verdict.detail}
            {verdict.when ? ` · ${PH_DATE.format(new Date(verdict.when))} EST` : ''}
            {verdict.shelf ? ` · shelf ${verdict.shelf}` : ''}
          </div>
        </div>
      )}
      {st && (
        <div className="stkchk-pair">
          <div className="stkchk-verdict"><span aria-hidden="true">❌</span> <span>Not in inventory — {st.label.toLowerCase()}</span></div>
          <div className="muted sm"><span className="mono">{a.code}</span> · {st.body}</div>
        </div>
      )}

      {shoe && (
        <>
          <div className="stkchk-shoe">
            {shoe.image && <img src={shoe.image} alt="" className="stkchk-img" />}
            <div>
              <div className="stkchk-name">{shoe.name || shoe.sku}</div>
              <div className="muted sm mono">{shoe.sku}{shoe.ambiguous ? ' · the catalogue wasn’t sure — check the box label' : ''}</div>
            </div>
          </div>

          {shopify?.error && <p className="shopchk-err">Couldn’t read Shopify: {shopify.error}. This is not a zero — try again.</p>}

          {shoe.size && sh && (
            <div className="stkchk-big">
              <div className="stkchk-size">Size {shoe.size}</div>
              <div className="stkchk-qty"><span className="stkchk-qty-num">{sh.qty}</span> for sale on Shopify</div>
              {!sh.listed && sizes.length > 0 && <div className="muted sm">No live Shopify listing has this size.</div>}
              {sh.inactive > 0 && <div className="muted sm">{sh.inactive} more on an archived / draft listing (not for sale).</div>}
            </div>
          )}

          {sizes.length > 0 && (
            <div className="stkchk-sizes">
              <div className="muted sm">{shoe.size ? 'Other sizes on Shopify' : 'Pick a size'}</div>
              <div className="stkchk-size-grid">
                {sizes.map((z) => (
                  <button key={z.size} type="button" onClick={() => onPickSize(z.size)}
                    className={`stkchk-chip${shoe.size && z.size === shoe.size ? ' on' : ''}${z.qty > 0 ? '' : ' zero'}`}>
                    {z.size} <b>×{z.qty}</b>
                  </button>
                ))}
              </div>
            </div>
          )}
          {shopify && !shopify.error && !sizes.length && <p className="muted">Shopify has no live listing for {shoe.sku}.</p>}
          {shopify?.checkedAt && !shopify.error && <p className="muted sm">Live from Shopify at {PH_DATETIME.format(new Date(shopify.checkedAt))} EST.</p>}

          <div className="stkchk-actions">
            <button type="button" className="btn ghost" onClick={onRecheck} disabled={busy}>{busy ? 'Checking…' : 'Check again'}</button>
            {shoe.size && <button type="button" className="btn primary" onClick={onCount} disabled={busy}>Count this size</button>}
          </div>
          {shoe.size && (
            <label className="stkchk-vinonly muted sm">
              <input type="checkbox" checked={vinOnly} onChange={(e) => onVinOnly(e.target.checked)} />
              {' '}Count by VIN sticker only — every pair counted exactly once (box barcodes can’t tell two boxes apart)
            </label>
          )}
        </>
      )}
    </section>
  );
}
