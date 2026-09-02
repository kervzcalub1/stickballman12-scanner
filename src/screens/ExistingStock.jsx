// Existing Stock — count old stock (stock that predates this system) into the
// inventory, shelf by shelf.
//
// The flow is deliberately NOT the receiving wizard: these pairs have no shipment,
// no supplier, no tracking and no cost to capture, and there can be thousands of
// them. So it's a continuous loop — scan the shelf once, then scan pair after pair
// onto it — closer to Shelve/Put-away than to intake.
//
// Two things make this kind different (see docs/context/existing-stock.md):
//  · the pairs are ALREADY on the shelf, so the shelf is part of the count and the
//    commit shelves them in the same request (no needs_shelf round-trip); and
//  · they were ALREADY listed to II and the stores years ago, so they bypass the PH
//    team entirely (batches.kind='existing' ∈ PH_EXCLUDED_KINDS) and are recorded
//    as already-synced.
// They have no VIN labels yet, so a commit ends by opening the label print dialog.
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { loadPrefs, savePrefs } from '../prefs.js';
import { TopBar, Modal, LabelSheet } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useUnsavedGuard } from '../hooks.js';
import { isUpcCode, isLocationCode, isRollVin, isVinCode, compareSizes } from '../lib/codes.js';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { ShelfPicker } from '../components/ShelfPicker.jsx';

const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

let rowKey = 1;

export function ExistingStock({ navBack, onHome, onSignOut }) {
  const [location, setLocation] = useState(null);  // the shelf being counted
  const [rows, setRows] = useState([]);            // { key, name, sku, upc, image, size, qty, withBox }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showCam, setShowCam] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [done, setDone] = useState(null);          // commit result
  const [labels, setLabels] = useState(null);      // VIN labels to print after a commit
  const [prefs, setPrefs] = useState(loadPrefs);
  const setCameraZoom = (z) => setPrefs((p) => { const n = { ...p, cameraZoom: z }; savePrefs(n); return n; });
  // Raw 1ID mode (per person, set on the Receiving screen's Preferences). Counting old
  // stock happens deep in the racks — the furthest anyone gets from a working printer —
  // so this is the flow that benefits most from a stack of pre-printed stickers.
  const rawVins = !!prefs.rawVins;
  const inputRef = useRef(null);
  const recentRef = useRef({});
  // Bumped after EVERY scan, whatever it did. The re-focus effect used to key on
  // `rows.length`, which is not the same thing: re-scanning a shoe already on the shelf
  // bumps a qty, and binding a 1ID sticker fills in a `vins` array — neither changes the
  // count, so the field went cold in exactly the two moves this screen is made of.
  const [scanSeq, setScanSeq] = useState(0);
  // Gun by default, keyboard on request. On iOS a programmatic focus() gives DOM focus
  // but no software keyboard, so a field we keep hot for a HID gun is a field that looks
  // typable and isn't. `inputMode="none"` makes that honest — no keyboard is promised —
  // and "Type" is the way in when a barcode won't read. Same pattern as the 1ID bar in
  // Receiving. See the iOS keyboard-trap note in hooks.js.
  const [typing, setTyping] = useState(false);
  const [flash, setFlash] = useState(null);
  const flashTimer = useRef(null);
  const [listRef] = useAutoAnimate();
  useUnsavedGuard(rows.length > 0);

  // Same loud per-scan feedback as Shelve/Put-away: a colour banner (iOS has no
  // Vibration API) plus a best-effort haptic. Warehouse staff are looking at the
  // shoe, not the screen.
  function pulse(kind, text) {
    setFlash({ kind, text });
    try { navigator.vibrate?.(kind === 'dup' || kind === 'err' ? [30, 40, 30] : 30); } catch { /* unsupported */ }
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1600);
  }
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  // Keep the field hot for a HID scanner gun between scans. Deliberately NOT
  // focused while the camera is open (see the iOS keyboard-trap note in hooks).
  useEffect(() => {
    if (showCam) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [showCam, scanSeq, location]);

  useEffect(() => {
    if (!navBack) return undefined;
    navBack.current = () => { if (showCam) { setShowCam(false); return true; } return false; };
    return () => { if (navBack) navBack.current = null; };
  }, [navBack, showCam]);

  const total = rows.reduce((n, r) => n + r.qty, 0);

  async function setShelf(code) {
    setError('');
    if (location && location.code === code) return;
    if (rows.length) { setError('Save or clear this shelf before switching to another one.'); pulse('err', 'Save this shelf first.'); return; }
    setBusy(true);
    try {
      const { location: loc } = await api.locationLookup(code);
      setLocation({ code: loc.code, label: loc.label, warehouse: loc.warehouse, area: loc.area, active: loc.active });
      pulse('shelf', `Counting onto ${loc.label || loc.code}. Now scan the pairs on it.`);
      if (loc.active === false) setError(`Heads up: “${loc.code}” is marked inactive — the count will be refused.`);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message); pulse('err', err.message);
    } finally { setBusy(false); }
  }

  // Scan a box UPC (or type a SKU) → resolve the shoe, then add/bump its size.
  // Old boxes often scan to a size-specific UPC, in which case the catalogue hands
  // back `scannedSize` and this is a pure one-scan-per-pair loop; when it doesn't,
  // the row lands with no size and is flagged so it can be filled in by hand.
  async function addProduct(code) {
    setError('');
    if (!location) { setError('Scan the shelf first.'); pulse('err', 'Scan the shelf first.'); return; }
    setBusy(true);
    try {
      const isUpc = isUpcCode(code);
      const { product: p } = isUpc ? await api.searchUpc(code) : await api.searchSku(code);
      const sku = p.sku || (isUpc ? '' : code);
      const size = p.scannedSize || '';
      setRows((rs) => {
        // Same SKU + same size → bump the qty rather than stacking duplicate rows.
        const at = rs.findIndex((r) => r.sku && sku && r.sku.toUpperCase() === sku.toUpperCase() && r.size === size);
        if (at >= 0 && size) {
          const next = rs.slice();
          next[at] = { ...next[at], qty: next[at].qty + 1 };
          return next;
        }
        return [{
          key: rowKey++, name: p.name || sku || code, sku, upc: (isUpc ? code : '') || p.upc || '',
          image: p.image || '', size, qty: 1, withBox: true,
          sizeOptions: (p.sizes || []).slice().sort(compareSizes),
        }, ...rs];
      });
      if (size) pulse('vin', `+1 · ${p.name || sku} · US ${size}`);
      else pulse('dup', `${p.name || sku || code} — no size from the catalogue. Set it below.`);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message); pulse('err', err.message);
    } finally { setBusy(false); }
  }

  // A shelf barcode switches the target; anything else is treated as a product
  // code. (Cooldown dedupes gun/camera re-reads of the same barcode.)
  function routeScan(raw) {
    const c = String(raw).trim().toUpperCase();
    if (!c) return;
    const now = Date.now();
    if (recentRef.current[c] && now - recentRef.current[c] < 1200) return;
    recentRef.current[c] = now;
    setInput('');
    setScanSeq((n) => n + 1);   // whatever this scan turns out to be, the field goes hot again
    // Raw 1ID mode, second beat: this scan is a STICKER for the pair just counted.
    if (rawVins && isRollVin(c)) return bindSticker(c);
    // ANYTHING ELSE that looks like one of our own numbers is not a product code, and
    // must never reach the catalogue. This is where "No product found for that SKU" on a
    // perfectly good sticker came from: a half-read 1ID matches neither the roll pattern
    // nor a shelf code, so it fell through to a SKU lookup and came back as a catalogue
    // problem that doesn't exist. Checked BEFORE isLocationCode, which also happily
    // swallows a stump like "SBM-R" (three letters, a dash, and something).
    if (/^SBM-/i.test(c)) {
      const whole = isVinCode(c);
      setError(!whole
        ? `That 1ID came through as “${c}” — only part of it read. Scan the sticker again.`
        : !rawVins
          ? `${c} is a 1ID sticker, and this count isn’t in 1ID mode. Turn on raw 1ID stickers in Receiving → Preferences, or scan the shoe’s box instead.`
          : `${c} is a printed VIN, not a pre-printed 1ID sticker. Scan the SBM-R- sticker on the shoe.`);
      pulse('err', whole ? 'Not a 1ID sticker.' : 'Half-read 1ID — scan it again.');
      return undefined;
    }
    if (isLocationCode(c)) return setShelf(c);
    return addProduct(c);
  }

  const patchRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key) => setRows((rs) => rs.filter((r) => r.key !== key));
  const clearShelf = () => { setRows([]); setLocation(null); setError(''); };

  const missingSize = rows.filter((r) => !String(r.size || '').trim()).length;
  // In raw mode every counted pair needs a sticker scanned onto it before it can be
  // saved — same rule as a missing size, and blocked the same way.
  const missingStickers = rawVins
    ? rows.reduce((n, r) => n + Math.max(0, (Number(r.qty) || 0) - (r.vins || []).length), 0)
    : 0;
  const awaitingSticker = rawVins
    ? rows.find((r) => (Number(r.qty) || 0) > (r.vins || []).length) || null
    : null;

  // Bind a scanned pre-printed sticker to the pair waiting for one. The server check is
  // advisory — see the same call in Receiving: flaky Wi-Fi must never stop a count, and
  // `items.vin` being UNIQUE means a secretly-used sticker is still caught at commit.
  async function bindSticker(code) {
    const vin = String(code).trim().toUpperCase();
    if (rows.some((r) => (r.vins || []).includes(vin))) {
      setError(`1ID ${vin} is already on a pair in this count.`);
      return;
    }
    const target = rows.find((r) => (Number(r.qty) || 0) > (r.vins || []).length);
    if (!target) { setError(`Scan the shoe first, then its 1ID — ${vin} has nothing to go on.`); return; }
    try {
      const r = await api.checkVin(vin);
      if (r.state === 'assigned') { setError(`1ID ${vin} is already used — grab another sticker.`); return; }
      if (r.state === 'void') { setError(`1ID ${vin} was voided — grab another sticker.`); return; }
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      /* couldn't check — bind anyway, commit is the authority */
    }
    setError('');
    patchRow(target.key, { vins: [...(target.vins || []), vin] });
  }

  async function save() {
    if (!location || !rows.length) return;
    setShowConfirm(false);
    setBusy(true); setError('');
    try {
      // One item per unit — the server assigns a VIN to each, exactly as receiving
      // does, so labels/locate/sold-shipped all behave normally afterwards.
      const items = rows.flatMap((r) => Array.from({ length: r.qty }, (_, i) => ({
        name: r.name, sku: r.sku, size: r.size, upc: r.upc, image: r.image,
        withBox: r.withBox, source: 'manual',
        // Raw mode: the pair's number comes off the sticker already on the shoe.
        vin: rawVins ? (r.vins || [])[i] || null : null,
      })));
      const res = await api.batchCommit({
        kind: 'existing',
        locationCode: location.code,
        batch: { origin: location.label || location.code },
        items,
      });
      // Keep the label items ON `done` — the success modal's "Print again" button
      // needs them after the sheet has been closed (closing sets `labels` to null,
      // so a button reading from `labels` would be permanently dead).
      const labelItems = items.map((it, i) => ({ ...it, vin: res.vins[i] }));
      setDone({
        count: res.count,
        batchCode: res.batchCode,
        shelved: res.shelved,
        label: location.label || location.code,
        labelItems,
      });
      // The pairs have no VIN stickers yet — that's the one part of this that can't
      // fix itself later, so go straight to the print dialog. UNLESS raw 1ID mode is
      // on: then the sticker is already on the shoe and was scanned to get here, so
      // opening a print dialog would just be a dialog to dismiss (and printing those
      // labels would put a SECOND number on the same pair).
      if (!rawVins) setLabels(labelItems);
      setRows([]);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="app">
      <TopBar title="Existing Stock" onHome={onHome} onSignOut={onSignOut} />

      <div className="card">
        {flash && (
          <div className={`scan-flash scan-flash--${flash.kind}`} role="status" aria-live="assertive">
            <span className="scan-flash-ic">{flash.kind === 'dup' || flash.kind === 'err' ? '!' : '✓'}</span>
            <span>{flash.text}</span>
          </div>
        )}
        {location ? (
          <div className={`shelve-target${flash?.kind === 'shelf' ? ' flash-ok' : ''}`}>
            <span className="muted sm">Counting onto</span>
            <span className="shelve-loc"><Icon name="pin" /> {location.warehouse}{location.area ? ` · ${location.area}` : ''} · <b>{location.label || location.code}</b></span>
            <button type="button" className="btn ghost sm" onClick={clearShelf}>Change shelf</button>
          </div>
        ) : (
          <p className="muted">Scan the <b>shelf barcode</b> you're standing at, then scan the box of every pair already on it.</p>
        )}

        {rawVins && location && (
          <div className={`rawvin-beat ${awaitingSticker ? 'awaiting' : ''}`} role="status" aria-live="polite">
            {awaitingSticker
              ? <><b>2 · Scan the 1ID</b> sticker onto {awaitingSticker.name || awaitingSticker.sku || 'that pair'}, then stick it on</>
              : <><b>1 · Scan the shoe</b> — then scan its pre-printed 1ID sticker</>}
          </div>
        )}
        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); routeScan(input); }}>
          {/* NEVER disabled. A disabled input is blurred by the browser, and a HID gun
              fires 20 characters in a few hundred milliseconds — so disabling this while
              a lookup was in flight dropped the middle of the next barcode on the floor
              and submitted the stump, which is where "No product found for that SKU" on a
              perfectly good 1ID came from. The 1.2s per-code cooldown in routeScan is
              what stops a double-read; the field's job is just to catch every keystroke. */}
          <input ref={inputRef} autoCapitalize="characters" autoCorrect="off" autoComplete="off"
            inputMode={typing ? 'text' : 'none'}
            placeholder={!location ? 'Scan a shelf barcode (e.g. MNH-WH-A2-04)'
              : rawVins ? (awaitingSticker ? 'Now scan the 1ID sticker' : 'Scan a box UPC — or type a SKU')
              : 'Scan a box UPC — or type a SKU'}
            value={input} onChange={(e) => setInput(e.target.value)} />
          <button className="btn primary" disabled={busy}>Add</button>
          {/* Focus from INSIDE the tap: on iOS a focus() outside a real gesture sets
              focus and suppresses the keyboard, which is the "keyboard won't come up"
              everyone hits. */}
          <button type="button" className={`btn ${typing ? 'primary' : 'ghost'}`} title="Type instead of scanning"
            onClick={() => {
              const on = !typing;
              setTyping(on);
              if (on) setTimeout(() => inputRef.current?.focus(), 0);
              else inputRef.current?.blur();
            }}>Type</button>
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera">
            <Icon name="camera" /> {showCam ? 'Close camera' : 'Scan with camera'}
          </button>
          {!location && <button type="button" className="btn ghost" onClick={() => setPickerOpen(true)}><Icon name="pin" /> Pick shelf</button>}
        </form>

        {showCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner continuous mode="rescale" onDetected={routeScan} onClose={() => setShowCam(false)}
              zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
          </Suspense>
        )}
        {error && <div className="error mt">{error}</div>}
        <p className="muted sm mt">
          These pairs are already listed on II and the stores, so they <b>never reach the PH team</b> and no price is fetched.
          Each one gets a VIN — print and stick the labels before moving to the next shelf.
        </p>
      </div>

      <div className="batch-bar">
        <button className="btn ghost" onClick={onHome}>← Home</button>
        <div className="batch-totals">
          <b>{total}</b> pair{total === 1 ? '' : 's'} on this shelf
          {missingSize ? ` · ${missingSize} need a size` : ''}
          {missingStickers ? ` · ${missingStickers} need a 1ID sticker` : ''}
        </div>
        <button className="btn primary" disabled={busy || !location || !rows.length || missingSize > 0 || missingStickers > 0}
          onClick={() => setShowConfirm(true)}>{busy ? 'Saving…' : 'Save shelf'}</button>
      </div>

      {rows.length > 0 && (
        <div className="card">
          <div className="dcards" ref={listRef}>
            {rows.map((r) => (
              <div className="dcard" key={r.key}>
                <div className="dcard-top">
                  <span className="dcard-name">{r.name}</span>
                  {rawVins && (
                    (Number(r.qty) || 0) > (r.vins || []).length
                      ? <span className="vin need">1ID?</span>
                      : <span className="vin">{(r.vins || []).join(' ')}</span>
                  )}
                  <button type="button" className="btn icon ghost remove" title="Remove" onClick={() => removeRow(r.key)}>×</button>
                </div>
                <div className="muted sm">{r.sku || '—'}{r.upc ? ` · ${r.upc}` : ''}</div>
                <div className="dcard-line">
                  <label className="sm">Size&nbsp;
                    {r.sizeOptions?.length ? (
                      <select value={r.size} onChange={(e) => patchRow(r.key, { size: e.target.value })}>
                        <option value="">— pick —</option>
                        {r.sizeOptions.map((s) => <option key={s} value={s}>US {s}</option>)}
                      </select>
                    ) : (
                      <input className="sz-input" value={r.size} placeholder="US"
                        onChange={(e) => patchRow(r.key, { size: e.target.value })} />
                    )}
                  </label>
                  <span className="qty-ctl">
                    <button type="button" className="btn icon ghost" disabled={r.qty <= 1}
                      onClick={() => patchRow(r.key, { qty: r.qty - 1 })}>−</button>
                    <b>{r.qty}</b>
                    <button type="button" className="btn icon ghost" onClick={() => patchRow(r.key, { qty: r.qty + 1 })}>＋</button>
                  </span>
                </div>
                <label className="check-pill">
                  <input type="checkbox" checked={r.withBox} onChange={(e) => patchRow(r.key, { withBox: e.target.checked })} /> With box
                </label>
                {!r.withBox && <div className="muted sm">No box — can’t be shelved; it’ll go to the No Box queue.</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {pickerOpen && <ShelfPicker onPick={(c) => { setPickerOpen(false); setShelf(String(c).trim().toUpperCase()); }} onClose={() => setPickerOpen(false)} />}

      {showConfirm && location && (
        <Modal type="warn" title={`Count ${total} pair${total === 1 ? '' : 's'} onto ${location.label || location.code}?`}
          message={`These are recorded as already listed on II, Alias, StockX and Shopify, and will NOT appear for the PH team. Confirm the shelf is ${location.warehouse}${location.area ? ` · ${location.area}` : ''} · ${location.label || location.code}.`}
          onClose={() => setShowConfirm(false)}>
          <div className="confirm-list">
            {rows.slice(0, 5).map((r) => (
              <div key={r.key} className="confirm-line">
                <span className="muted sm">{r.name}{r.size ? ` · US ${r.size}` : ''} · ×{r.qty}</span>
              </div>
            ))}
            {rows.length > 5 && <div className="muted sm">+ {rows.length - 5} more</div>}
          </div>
          <button className="btn primary" onClick={save}>Confirm — count onto this shelf</button>
          <button className="btn ghost" onClick={() => setShowConfirm(false)}>Cancel</button>
        </Modal>
      )}

      {/* The print dialog opens first, so hold the summary back until it's closed
          rather than stacking two modals. */}
      {done && !labels && (
        <Modal type="success" title={`${done.count} pair${done.count === 1 ? '' : 's'} counted in`}
          message={`Batch ${done.batchCode} · ${done.shelved?.updated ?? 0} shelved at ${done.label}`
            + (done.shelved?.noBoxBlocked ? ` · ${done.shelved.noBoxBlocked} had no box and went to the No Box queue instead.` : '.')}
          onClose={() => setDone(null)}>
          <button className="btn primary" onClick={() => setLabels(done.labelItems)}>Print VIN labels again</button>
          <button className="btn ghost" onClick={() => { setDone(null); clearShelf(); }}>Next shelf</button>
          <button className="btn ghost" onClick={onHome}>← Home</button>
        </Modal>
      )}

      {labels && <LabelSheet items={labels} onClose={() => setLabels(null)} />}
    </div>
  );
}
