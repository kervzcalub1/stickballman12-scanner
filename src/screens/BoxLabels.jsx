// Box Labels — replacement box labels for pairs with no original box. Three jobs
// behind ONE scan field, routed by what the code looks like (lib/codes.js):
//   · a VIN            → the pair is already in the system: reprint its box label
//                        (and its VIN sticker, if that one is gone too);
//   · a UPC / a SKU    → old stock that ISN'T in the system yet: mint a real unit
//                        (kind='existing', so it never reaches the PH team) and
//                        print both labels; or
//   · the same lookup, "just the label" → a plain box label, nothing recorded.
//
// The label PDFs are the same ones the No Box queue prints (lib/labelPdf.js) — a
// box label needs a UPC to be scannable, so when the record has none we ask for it
// (staff read it off the tongue label inside the shoe) with a skip that falls back
// to a text-only label.
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { loadPrefs, savePrefs } from '../prefs.js';
import { TopBar, Modal, LabelSheet, StatusPill, CopyText } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { useMediaQuery } from '../hooks.js';
import { isUpcCode, isVinCode, upcDigits, compareSizes, sizeLabel } from '../lib/codes.js';

const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

export function BoxLabels({ navBack, onHome, onSignOut }) {
  const [input, setInput] = useState('');
  const [found, setFound] = useState(null);   // { kind:'item'|'product', … }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showCam, setShowCam] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [labels, setLabels] = useState(null); // { items, mode } for the LabelSheet
  const [upcPrompt, setUpcPrompt] = useState(null); // { target } awaiting a UPC
  const [upcInput, setUpcInput] = useState('');
  const [noUpcFound, setNoUpcFound] = useState(false);
  const [flash, setFlash] = useState(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const setCameraZoom = (z) => setPrefs((p) => { const n = { ...p, cameraZoom: z }; savePrefs(n); return n; });
  const inputRef = useRef(null);
  const flashTimer = useRef(null);
  const isMobile = useMediaQuery('(max-width: 768px)');

  // Loud per-scan feedback, same as Shelve / Existing Stock — staff are looking at
  // the shoe, not the screen.
  function pulse(kind, text) {
    setFlash({ kind, text });
    try { navigator.vibrate?.(kind === 'err' ? [30, 40, 30] : 30); } catch { /* unsupported */ }
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1600);
  }
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  // Keep the field hot for a HID scanner gun. Never while the camera is open (iOS
  // keyboard trap) and never on mobile, where a forced focus suppresses the keyboard.
  useEffect(() => {
    if (showCam || isMobile) return undefined;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [showCam, isMobile, found]);

  useEffect(() => {
    if (!navBack) return undefined;
    navBack.current = () => {
      if (showCam) { setShowCam(false); return true; }
      if (found) { setFound(null); return true; }
      return false;
    };
    return () => { if (navBack) navBack.current = null; };
  }, [navBack, showCam, found]);

  function reset() { setFound(null); setInput(''); setError(''); }

  // A VIN goes straight to the unit. Any other code is checked against OUR OWN
  // stock first (api/items/find) and only then against the third-party catalogue:
  // a pair we've already handled is the authoritative record, and it's exactly the
  // kind the catalogue tends not to know — old stock, in-store buys, hand-entered
  // SKUs. A local hit also lists the real units, so staff jump to an existing VIN
  // instead of minting a duplicate.
  async function routeScan(raw) {
    const code = String(raw || '').trim();
    if (!code) return;
    setInput(''); setError('');
    setBusy(true);
    try {
      if (isVinCode(code)) {
        const { item } = await api.itemLookup(code.toUpperCase());
        setFound({ kind: 'item', item });
        pulse('vin', `${item.name || item.sku || item.vin}${item.size ? ` · US ${sizeLabel(item.size, item.gender, item.name)}` : ''}`);
        return;
      }

      const upc = isUpcCode(code);
      const local = await api.itemsFind(code).catch(() => null);
      if (local?.product) {
        const p = local.product;
        setFound({
          kind: 'product', from: 'inventory', name: p.name || code, sku: p.sku || (upc ? '' : code),
          upc: p.upc || (upc ? code : ''), colorway: p.colorway || '', gender: p.gender || '', image: '',
          // One size in stock → it's almost certainly the pair in hand; preselect it.
          size: p.sizes?.length === 1 ? p.sizes[0] : '',
          sizeOptions: (p.sizes || []).slice().sort(compareSizes),
          units: local.units || [],
        });
        pulse('vin', `${p.name || p.sku} — ${local.units.length} in your inventory.`);
        return;
      }

      // Not ours → the catalogue. UPC first, since only the UPC proxy hands back
      // the exact scanned size.
      const { product: p } = upc ? await api.searchUpc(code) : await api.searchSku(code);
      setFound({
        kind: 'product', from: 'catalogue', name: p.name || code, sku: p.sku || (upc ? '' : code),
        upc: upc ? code : '', colorway: p.colorway || '', gender: p.gender || '', image: p.image || '',
        size: p.scannedSize || '', sizeOptions: (p.sizes || []).slice().sort(compareSizes),
        units: [],
      });
      pulse(p.scannedSize ? 'vin' : 'dup', p.scannedSize
        ? `${p.name || p.sku} · US ${sizeLabel(p.scannedSize, p.gender, p.name)}`
        : `${p.name || p.sku} — pick the size below.`);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      // The catalogue's own 404 reads as a dead end; say what to try instead.
      const msg = /No product found/i.test(err.message || '')
        ? `${err.message} It isn’t in your inventory either — scan the pair’s VIN sticker, or try the ${isUpcCode(code) ? 'SKU' : 'box UPC'} instead.`
        : err.message;
      setError(msg); pulse('err', 'Not found.');
    } finally { setBusy(false); }
  }

  // Jump from a matching unit into the VIN flow (workflow 2) without re-scanning.
  async function useUnit(vin) {
    setBusy(true); setError('');
    try {
      const { item } = await api.itemLookup(vin);
      setFound({ kind: 'item', item });
      pulse('vin', `${vin} — print its box label.`);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(false); }
  }

  // ---- printing -------------------------------------------------------------
  // A box label without a UPC has no barcode, which defeats the point — so when the
  // record has none, ask for it before printing (skippable).
  function printBox(target) {
    if (upcDigits(target.upc)) { setLabels({ items: [target], mode: 'upc' }); return; }
    setUpcPrompt(target); setUpcInput(''); setNoUpcFound(false); setError('');
  }
  async function confirmUpc() {
    const t = upcPrompt;
    const digits = upcDigits(upcInput);
    if (!noUpcFound && ![8, 12, 13].includes(digits.length)) {
      setError('Enter a valid 8-, 12-, or 13-digit UPC — or tick “No UPC found”.'); return;
    }
    setBusy(true); setError('');
    try {
      if (noUpcFound) {
        setLabels({ items: [t], mode: 'upc' }); // text-only fallback label
      } else {
        // On a real unit the UPC is worth keeping — next reprint won't ask again.
        if (t.vin) await api.setItemUpc(t.vin, digits);
        const updated = { ...t, upc: digits };
        setFound((f) => (f?.kind === 'item'
          ? { ...f, item: { ...f.item, upc: digits } }
          : { ...f, upc: digits }));
        setLabels({ items: [updated], mode: 'upc' });
      }
      setUpcPrompt(null);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(false); }
  }

  // ---- mint a unit ----------------------------------------------------------
  // Old stock that isn't in the system: one 'existing' unit, so it bypasses the PH
  // team exactly like a counted shelf does. It goes in With Box (the replacement box
  // label IS its box) and lands in the normal needs-shelf queue to be put away.
  async function createUnit() {
    const p = found;
    setShowConfirm(false); setBusy(true); setError('');
    try {
      const item = {
        name: p.name, sku: p.sku, size: p.size, upc: upcDigits(p.upc) || '',
        image: p.image, colorway: p.colorway, gender: p.gender || null,
        withBox: true, source: 'manual',
      };
      const res = await api.batchCommit({
        kind: 'existing', noShelf: true,
        batch: { origin: 'Box label — no box' },
        items: [item],
      });
      const vin = res.vins[0];
      setFound({ kind: 'item', justCreated: true, item: { ...item, vin, status: 'needs_shelf' } });
      pulse('vin', `${vin} created — print both labels.`);
      setLabels({ items: [{ ...item, vin }], mode: 'upc' }); // box label first
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(false); }
  }

  const it = found?.kind === 'item' ? found.item : null;
  const p = found?.kind === 'product' ? found : null;
  const needSize = p && !String(p.size || '').trim();

  return (
    <div className="app">
      <TopBar title="Box Labels" onHome={onHome} onSignOut={onSignOut} />

      <div className="card">
        {flash && (
          <div className={`scan-flash scan-flash--${flash.kind}`} role="status" aria-live="assertive">
            <span className="scan-flash-ic">{flash.kind === 'err' ? '!' : '✓'}</span>
            <span>{flash.text}</span>
          </div>
        )}
        <p className="muted sm">
          Replacement labels for a pair with <b>no box</b>. Scan its <b>VIN</b> to reprint the box label for a pair
          already in the system, or scan the <b>old box UPC</b> / type a <b>SKU</b> for old stock that isn’t —
          then either print the label on its own or give the pair a VIN first.
        </p>

        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); routeScan(input); }}>
          <input ref={inputRef} autoCapitalize="characters" autoCorrect="off" autoComplete="off"
            placeholder="Scan a VIN or box UPC — or type a SKU"
            value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
          <button className="btn primary" disabled={busy || !input.trim()}>{busy ? '…' : 'Find'}</button>
          <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} onClick={() => setShowCam((v) => !v)} title="Scan with camera">
            <Icon name="camera" /> {showCam ? 'Close camera' : 'Scan with camera'}
          </button>
        </form>

        {showCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner mode="rescale" onDetected={(c) => { setShowCam(false); routeScan(c); }}
              onClose={() => setShowCam(false)} zoom={prefs.cameraZoom} onZoomChange={setCameraZoom} />
          </Suspense>
        )}
        {error && <div className="error mt">{error}</div>}
      </div>

      {/* Already a real unit — scanned VIN, or one we just minted. */}
      {it && (
        <div className="card">
          <div className="dcard-top">
            <CopyText text={it.vin} className="vin">{it.vin}</CopyText>
            {it.status && <StatusPill status={it.status} />}
          </div>
          <CopyText text={it.name} className="dcard-name">{it.name || '—'}</CopyText>
          <div className="dcard-line">
            <span>Size {it.size ? `US ${sizeLabel(it.size, it.gender, it.name)}` : '—'}</span>
            <CopyText text={it.sku} className="muted">{it.sku || '—'}</CopyText>
          </div>
          <div className="muted sm">
            {upcDigits(it.upc)
              ? <CopyText text={upcDigits(it.upc)}>UPC {upcDigits(it.upc)}</CopyText>
              : 'No UPC on file — we’ll ask for it before printing.'}
            {it.location_label ? ` · ${it.location_label}` : ''}
          </div>
          {found.justCreated && (
            <p className="ok sm mt">
              VIN created. Print <b>both</b> labels — the box label goes on the replacement box, the VIN sticker
              on the shoe. It’s now waiting in <b>Shelve / Put-away</b>.
            </p>
          )}
          <div className="nobox-actions mt">
            <button className="btn primary" disabled={busy} onClick={() => printBox(it)}>
              <Icon name="print" /> Print box label
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setLabels({ items: [it], mode: 'vin' })}>
              <Icon name="print" /> {found.justCreated ? 'Print VIN label' : 'Reprint VIN label'}
            </button>
            <button className="btn ghost" onClick={reset}>Next shoe</button>
          </div>
        </div>
      )}

      {/* A catalogue hit with no unit behind it — label only, or mint a VIN too. */}
      {p && (
        <div className="card">
          <div className="dcard-top">
            <CopyText text={p.name} className="dcard-name">{p.name}</CopyText>
            <span className="muted sm">{p.from === 'inventory' ? 'From your inventory' : 'From the catalogue'}</span>
          </div>
          <div className="muted sm"><CopyText text={p.sku}>{p.sku || '—'}</CopyText>{p.colorway ? ` · ${p.colorway}` : ''}</div>
          <div className="muted sm">{upcDigits(p.upc)
            ? <CopyText text={upcDigits(p.upc)}>UPC {upcDigits(p.upc)}</CopyText>
            : 'No UPC — we’ll ask for it before printing.'}</div>

          {/* Already in stock: pick the actual pair rather than minting a duplicate. */}
          {p.units?.length > 0 && (
            <div className="boxlbl-units">
              <div className="muted sm mt"><b>{p.units.length}</b> already in inventory — pick the pair in your hand to reprint its labels:</div>
              {p.units.map((u) => (
                <div className="boxlbl-unit" key={u.vin}>
                  <span className="vin">{u.vin}</span>
                  <span>{u.size ? `US ${sizeLabel(u.size, p.gender, p.name)}` : '—'}</span>
                  <StatusPill status={u.status} />
                  <span className="muted sm">{u.locationCode || 'unshelved'}</span>
                  <button className="btn sm ghost" disabled={busy} onClick={() => useUnit(u.vin)}>Use this VIN</button>
                </div>
              ))}
            </div>
          )}
          <div className="dcard-line mt">
            <label className="sm">Size&nbsp;
              {p.sizeOptions?.length ? (
                <select value={p.size} onChange={(e) => setFound((f) => ({ ...f, size: e.target.value }))}>
                  <option value="">— pick —</option>
                  {p.sizeOptions.map((s) => <option key={s} value={s}>US {sizeLabel(s, p.gender, p.name)}</option>)}
                </select>
              ) : (
                <input className="sz-input" value={p.size} placeholder="US"
                  onChange={(e) => setFound((f) => ({ ...f, size: e.target.value }))} />
              )}
            </label>
          </div>
          {needSize && <p className="muted sm">Pick the size — a box label without one can’t be shelved or sold from.</p>}
          <div className="nobox-actions mt">
            <button className="btn primary" disabled={busy || needSize} onClick={() => printBox(p)}>
              <Icon name="print" /> Print box label only
            </button>
            <button className={`btn ${p.units?.length ? 'ghost' : ''}`} disabled={busy || needSize} onClick={() => setShowConfirm(true)}>
              <Icon name="box" /> Give it a VIN + print both
            </button>
            <button className="btn ghost" onClick={reset}>Next shoe</button>
          </div>
          <p className="muted sm mt">
            <b>Label only</b> just prints — nothing is recorded. <b>Give it a VIN</b> counts the pair into inventory as
            existing stock (never seen by the PH team) so it can be shelved, located and sold
            {p.units?.length ? ' — only for a pair that isn’t already in the list above.' : '.'}
          </p>
        </div>
      )}

      {showConfirm && p && (
        <Modal type="warn" title={`Count ${p.name} · US ${sizeLabel(p.size, p.gender, p.name)} into inventory?`}
          message={'This creates ONE new unit with its own VIN, recorded as existing stock already listed on II and the stores — the PH team never sees it. Only do this if the pair isn’t in the system yet: if it already has a VIN sticker, scan that instead.'
            + (p.units?.length ? ` Heads up: ${p.units.length} pair${p.units.length === 1 ? '' : 's'} with this code ${p.units.length === 1 ? 'is' : 'are'} already in inventory — creating another will double-count it.` : '')}
          onClose={() => setShowConfirm(false)}>
          <button className="btn primary" disabled={busy} onClick={createUnit}>Confirm — create the VIN</button>
          <button className="btn ghost" onClick={() => setShowConfirm(false)}>Cancel</button>
        </Modal>
      )}

      {upcPrompt && (
        <div className="modal-overlay" onClick={() => !busy && setUpcPrompt(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Box label — UPC needed</h3>
            <p className="modal-msg">
              <b>{upcPrompt.name || upcPrompt.sku || upcPrompt.vin}</b>{upcPrompt.size ? ` · US ${sizeLabel(upcPrompt.size, upcPrompt.gender, upcPrompt.name)}` : ''} has no UPC on file.
              Read it off the <b>tongue label inside the shoe</b> (or the old box) so the new label scans normally.
              {upcPrompt.vin ? ' It’s saved to this pair for next time.' : ''}
            </p>
            <input className="nobox-upc-input" autoFocus={!isMobile} inputMode="numeric" autoComplete="off"
              placeholder="Scan or type the UPC (12–13 digits)" value={upcInput} disabled={noUpcFound || busy}
              onChange={(e) => setUpcInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmUpc(); }} />
            <label className="nobox-noupc-check">
              <input type="checkbox" checked={noUpcFound} disabled={busy} onChange={(e) => setNoUpcFound(e.target.checked)} />
              No UPC found — print a label without a barcode
            </label>
            {error && <div className="error sm mt">{error}</div>}
            <div className="modal-actions">
              <button className="btn ghost" disabled={busy} onClick={() => setUpcPrompt(null)}>Cancel</button>
              <button className="btn primary" disabled={busy || (!noUpcFound && !upcDigits(upcInput))} onClick={confirmUpc}>
                {busy ? '…' : (noUpcFound ? 'Print without UPC' : 'Save & print')}
              </button>
            </div>
          </div>
        </div>
      )}

      {labels && <LabelSheet items={labels.items} mode={labels.mode} onClose={() => setLabels(null)} />}
    </div>
  );
}
