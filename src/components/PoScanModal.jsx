// Shared PO manifest-entry UI, used by BOTH the supplier portal (SupplierApp) and the
// PH "Purchase Orders" overview (PoOverview, entering a supplier's manifest on their
// behalf). Both post to /api/po/scan and /api/po/line — the server decides on-behalf
// attribution from the caller's role, so this UI is identical for either side.
// See docs/context/purchase-orders.md.
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';
import { isUpcCode, usSizeChart, compareSizes, isCameraReread } from '../lib/codes.js';
import { DimensionsFields, dimsComplete, dimsToText, emptyDims } from './PoDimensions.jsx';
import { parsePoPaste, listValue, skuOf } from '../lib/poPaste.js';
import { readPoFile, PO_FILE_ACCEPT } from '../lib/poCsv.js';
import { AliasCodeCheck, aliasOnlyCode } from './AliasCodeCheck.jsx';
import { beepOk, beepErr } from '../lib/beep.js';

const CameraScanner = lazy(() => import('./CameraScanner.jsx'));

// One editable scanned line on a still-filling label: rename-free, but the size can be
// corrected and the qty nudged (or the line removed at ×0). Size commits on blur/Enter;
// qty posts on each ± tap. The parent reloads the PO after each save. `attribution` is an
// optional trailing note (e.g. "entered by …") shown under the product name.
export function PoLineRow({ line, disabled, onSave, attribution, boxesOrder = false }) {
  const [size, setSize] = useState(String(line.size ?? ''));
  useEffect(() => { setSize(String(line.size ?? '')); }, [line.size]);
  const commitSize = () => {
    const v = size.trim();
    if (!v || v === String(line.size)) { setSize(String(line.size ?? '')); return; }
    onSave({ size: v });
  };
  // On an empty-box order the DIMENSIONS take the size's place — same cell, same commit
  // on blur, same merge if two lines of one SKU land on the same value. One text box
  // rather than three number fields: this is the correcting-one-row case, and three
  // inputs in a table cell is unreadable. Anything with three numbers in it parses
  // (`normalizeDimensions`), and the server writes back the canonical `L x W x H unit`.
  const [dims, setDims] = useState(String(line.dimensions ?? ''));
  useEffect(() => { setDims(String(line.dimensions ?? '')); }, [line.dimensions]);
  const commitDims = () => {
    const v = dims.trim();
    if (!v || v === String(line.dimensions ?? '')) { setDims(String(line.dimensions ?? '')); return; }
    onSave({ dimensions: v });
  };
  // Cost and tip per pair, corrected after the fact. Blank is a real value here — it
  // clears the field back to "not declared", which is not the same as $0.
  const moneyStr = (v) => (v == null || v === '' ? '' : String(Number(v)));
  const [cost, setCost] = useState(moneyStr(line.unit_cost));
  const [tip, setTip] = useState(moneyStr(line.tip));
  useEffect(() => { setCost(moneyStr(line.unit_cost)); }, [line.unit_cost]);
  useEffect(() => { setTip(moneyStr(line.tip)); }, [line.tip]);
  // One committer for both: `field` is what the API expects, `stored` what's on the row.
  const commitMoney = (field, typed, stored, reset) => {
    const v = typed.trim();
    if (v === moneyStr(stored)) return;
    if (v === '') { onSave({ [field]: null }); return; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) { reset(moneyStr(stored)); return; }
    onSave({ [field]: n });
  };
  return (
    <li className={`po-line-edit${boxesOrder ? ' boxes' : ''}`}>
      <div className="po-line-head">
        <span className="po-line-name">{line.name || line.sku}</span>
        <span className="po-line-meta">{line.sku}</span>
      </div>
      {attribution && <div className="po-line-attribution muted xs">{attribution}</div>}
      <div className="po-line-controls">
        <label className="po-line-size">
          <span className="muted xs">Size</span>
          <input className="sz" value={size} disabled={disabled} inputMode="decimal"
            onChange={(e) => setSize(e.target.value)} onBlur={commitSize}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
        </label>
        {/* A box carries BOTH: the size it was made for, and how big the carton is. */}
        {boxesOrder && (
          <label className="po-line-size po-line-dims">
            <span className="muted xs">Dimensions</span>
            <input className={`sz dims ${line.dimensions ? '' : 'need'}`} value={dims} disabled={disabled}
              placeholder="13 x 9 x 5 in" onChange={(e) => setDims(e.target.value)} onBlur={commitDims}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
          </label>
        )}
        {/* Every control is a labelled cell of the same shape, so the rows line up as
            columns on a wide screen (where the labels give way to one header row) and
            stack legibly on a phone. */}
        <div className="po-line-qty">
          <span className="muted xs">Qty</span>
          <div className="qty-stepper">
            <button type="button" className="btn icon ghost step" disabled={disabled || line.qty_expected <= 1}
              onClick={() => onSave({ qty: line.qty_expected - 1 })}>−</button>
            <span className="qty-val">×{line.qty_expected}</span>
            <button type="button" className="btn icon ghost step" disabled={disabled}
              onClick={() => onSave({ qty: line.qty_expected + 1 })}>+</button>
          </div>
        </div>
        <label className="po-line-cost">
          <span className="muted xs">{boxesOrder ? 'Cost ea' : 'Shelf price ea'}</span>
          <span className="po-money-input">
            <span className="po-money-sym">$</span>
            <input className="cost" value={cost} disabled={disabled} inputMode="decimal" placeholder="—"
              onChange={(e) => setCost(e.target.value)}
              onBlur={() => commitMoney('unitCost', cost, line.unit_cost, setCost)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
          </span>
        </label>
        <label className="po-line-cost">
          <span className="muted xs">Tip ea</span>
          <span className="po-money-input">
            <span className="po-money-sym">$</span>
            <input className="cost" value={tip} disabled={disabled} inputMode="decimal" placeholder="—"
              onChange={(e) => setTip(e.target.value)}
              onBlur={() => commitMoney('tip', tip, line.tip, setTip)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
          </span>
        </label>
        <button type="button" className="btn icon ghost remove" title="Remove this item from the manifest"
          aria-label="Remove this item from the manifest" disabled={disabled}
          onClick={() => onSave({ qty: 0 })}>×</button>
      </div>
    </li>
  );
}

// Column headings for a list of `PoLineRow`s. Only shown on a wide screen — that's where
// the per-cell labels are hidden and the rows read as a table; on a phone each cell keeps
// its own label and this collapses away.
export function PoLineHeader({ boxesOrder = false }) {
  return (
    <li className={`po-line-headings${boxesOrder ? ' boxes' : ''}`} aria-hidden="true">
      <span>Item</span><span>Size</span>{boxesOrder && <span>Dimensions</span>}
      <span>Qty</span><span>{boxesOrder ? 'Cost ea' : 'Shelf price ea'}</span><span>Tip ea</span><span />
    </li>
  );
}

// The whole-order list (Path C) as editable rows, grouped by SKU: a SKU with more than one
// size gets a "Shelf price ea — all sizes" row above its sizes (`po/line-price`, one
// request, the same gate as one row's price). Each size keeps its own price field, so one
// size can still differ. Used by the supplier's order card and staff's PO detail.
export function PoOrderLineRows({ poId, lines, boxesOrder = false, isBusy, onSave, attributionOf, onApplied, onSignOut }) {
  const groups = [];
  const byKey = new Map();
  for (const l of lines) {
    const k = String(l.sku || '').toUpperCase();
    if (!byKey.has(k)) { const g = { key: k, sku: l.sku, name: l.name, lines: [] }; byKey.set(k, g); groups.push(g); }
    byKey.get(k).lines.push(l);
  }
  return groups.flatMap((g) => [
    g.lines.length > 1
      ? <PoSkuPriceRow key={`sku:${g.key}`} poId={poId} sku={g.sku} name={g.name} lines={g.lines} boxesOrder={boxesOrder}
          disabled={g.lines.some((l) => isBusy(l))} onApplied={onApplied} onSignOut={onSignOut} />
      : null,
    ...g.lines.map((l) => (
      <PoLineRow key={l.id} line={l} disabled={isBusy(l)} boxesOrder={boxesOrder}
        onSave={(patch) => onSave(l, patch)} attribution={attributionOf(l)} />
    )),
  ]).filter(Boolean);
}

// One SKU's price state (one price / mixed / n unpriced) and the box that sets it on every
// size. Applied on Enter or the button, never on blur: it rewrites several rows at once.
// Blank + apply = clear every size back to "no price" (never $0).
function PoSkuPriceRow({ poId, sku, name, lines, boxesOrder, disabled, onApplied, onSignOut }) {
  const priceOf = (l) => (l.unit_cost == null || l.unit_cost === '' ? null : Number(l.unit_cost));
  const prices = lines.map(priceOf);
  const distinct = [...new Set(prices.filter((p) => p != null))].sort((a, b) => a - b);
  const unpriced = prices.filter((p) => p == null).length;
  const one = distinct.length === 1 && !unpriced ? distinct[0] : null;
  const $ = (n) => `$${n.toFixed(2)}`;
  const state = !distinct.length ? `${unpriced} unpriced`
    : one != null ? `one price · ${$(one)}`
    : [distinct.length > 1 ? `mixed prices · ${$(distinct[0])}–${$(distinct[distinct.length - 1])}` : `${$(distinct[0])} on ${lines.length - unpriced}`,
      unpriced ? `${unpriced} unpriced` : ''].filter(Boolean).join(' · ');
  const [val, setVal] = useState(one != null ? one.toFixed(2) : '');
  useEffect(() => { setVal(one != null ? one.toFixed(2) : ''); }, [one]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const v = val.trim().replace(/^\$\s*/, '');
  const n = v === '' ? null : Number(v);
  const valid = v === '' || (/^\d+(\.\d{1,2})?$/.test(v) && Number.isFinite(n) && n <= 1e7);
  const noChange = n == null ? !distinct.length : one != null && Math.abs(one - n) < 0.005;
  const apply = async () => {
    if (!valid) { setErr(`“${v}” isn’t a price — type it like 41.60, or leave it blank to clear.`); return; }
    if (noChange || busy) return;
    setBusy(true); setErr('');
    try { await api.poLinePrice(Number(poId), sku, n); onApplied(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(false); }
    return undefined;
  };
  const label = boxesOrder ? 'Cost ea — all sizes' : 'Shelf price ea — all sizes';
  return (
    <li className="po-sku-price" data-testid="po-sku-price">
      <div className="po-sku-price-head">
        <b>{sku}</b>
        {name && <span className="muted xs">{name}</span>}
        <span className={`po-sku-price-state xs${unpriced ? ' warn' : ''}`}>{lines.length} sizes · {state}</span>
      </div>
      <div className="po-sku-price-set">
        <label className="po-size-money">
          <span className="muted xs">{label}</span>
          <span className="po-money-input">
            <span className="po-money-sym">$</span>
            <input inputMode="decimal" placeholder="—" aria-label={`${label} for ${sku}`} value={val} disabled={disabled || busy}
              onChange={(e) => { setVal(e.target.value); setErr(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }} />
          </span>
        </label>
        <button type="button" className="btn sm" disabled={disabled || busy || noChange} onClick={apply}>
          {busy ? 'Saving…' : n == null && v === '' ? `Clear all ${lines.length} sizes` : `Set all ${lines.length} sizes`}
        </button>
      </div>
      {err && <div className="error sm">{err}</div>}
    </li>
  );
}

// RAPID SCAN (the supplier's whole-order list): a scan that can't go straight in — the
// barcode gave the shoe but no size, the code wasn't found, a SKU was typed, or only Alias
// knew the barcode — waits here while the gun carries on. The supplier finishes it: the SKU
// (scan or type it; the catalogue name fills in when known, never required), the size
// (chips, or typed: 5C, 3Y, 10.5…), the quantity, an optional shelf price ea → Add.
function PoFinishCard({ entry, busy, onChange, onAdd, onDismiss, onLookUp, onSignOut, onCodeConfirm, onCodeFix }) {
  const [skuText, setSkuText] = useState(entry.sku || '');
  const [err, setErr] = useState('');
  const [finding, setFinding] = useState(false);
  const known = !!entry.sku;
  const chips = (() => {
    const opts = (entry.sizeOptions || []).map(String);
    const kind = opts.some((x) => /y$/i.test(x)) ? 'y' : opts.some((x) => /w$/i.test(x)) ? 'w' : '';
    return opts.length > 1 ? opts : [...new Set([...opts, ...usSizeChart(kind)])];
  })();
  // The SKU the supplier scanned or typed for a code the catalogue didn't know. Named from
  // the catalogue when it's there; a style code it doesn't carry still goes in by its code
  // (as in a paste) — anything else is asked again rather than guessed.
  const findSku = async () => {
    const v = skuText.trim();
    if (!v) return;
    setErr('');
    if (isUpcCode(v)) { setErr('That’s a barcode — type the style code printed on the box label (e.g. DZ5485-201).'); return; }
    setFinding(true);
    try {
      const p = await onLookUp(v);
      const sku = p?.sku || skuOf(v);
      if (!sku) { setErr('That doesn’t look like a style code (e.g. DZ5485-201).'); return; }
      onChange({ sku, name: p?.name || '', colorway: p?.colorway || '', gender: p?.gender || null, sizeOptions: p?.sizes || [], image: p?.image || '' });
      setSkuText(sku);
    } catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); } finally { setFinding(false); }
  };
  const size = String(entry.size || '').trim();
  const ready = known && !entry.codeCheck && !!size && entry.qty >= 1;
  const why = entry.why === 'notfound' ? <>Not found: <code>{entry.code}</code> — scan or type the SKU from the box label</>
    : entry.codeCheck ? 'Check the style code on this box first'
    : entry.why === 'typed' ? 'Pick the size and how many'
    : <>No size from the barcode <code>{entry.code}</code> — pick it</>;
  return (
    <li className="po-finish" data-testid="po-finish">
      <div className="po-finish-head">
        <div className="po-finish-what">
          <b>{known ? entry.sku : 'Unknown barcode'}</b>
          {known && (
            <span className={`muted xs${entry.name ? '' : ' po-paste-warn'}`}>{entry.name || 'not in the catalogue — added by its SKU'}</span>
          )}
          <span className="muted xs po-finish-why">{why}</span>
        </div>
        <button type="button" className="btn icon ghost" title="Leave this one out" aria-label="Leave this one out" onClick={onDismiss}>×</button>
      </div>
      {!known && (
        <form className="po-finish-sku" onSubmit={(e) => { e.preventDefault(); findSku(); }}>
          <input autoCapitalize="characters" autoCorrect="off" aria-label="SKU for this shoe" placeholder="Scan or type the SKU"
            value={skuText} onChange={(e) => setSkuText(e.target.value)} />
          <button type="submit" className="btn sm" disabled={finding}>{finding ? 'Looking…' : 'Look up'}</button>
        </form>
      )}
      {err && <div className="error sm">{err}</div>}
      {entry.codeCheck && (
        <AliasCodeCheck key={entry.codeCheck} code={entry.codeCheck} current={entry.sku} onSignOut={onSignOut}
          onConfirm={onCodeConfirm} onFix={onCodeFix} />
      )}
      {known && !entry.codeCheck && (<>
        <div className="size-chips" role="group" aria-label={`Size for ${entry.sku}`}>
          {chips.map((z) => (
            <button type="button" key={z} className={`size-chip${size === z ? ' on' : ''}`} aria-pressed={size === z}
              onClick={() => onChange({ size: z })}>{z}</button>
          ))}
        </div>
        <div className="po-finish-fields">
          <label className="po-size-money">
            <span className="muted xs">Size</span>
            <input className="sz" placeholder="5C, 3Y, 10.5…" aria-label={`Typed size for ${entry.sku}`} value={entry.size}
              onChange={(e) => onChange({ size: e.target.value })} />
          </label>
          <div className="po-size-money">
            <span className="muted xs">Qty</span>
            <span className="qty-stepper">
              <button type="button" className="btn icon ghost step" aria-label="One less" onClick={() => onChange({ qty: Math.max(1, entry.qty - 1) })}>−</button>
              <input className="qty" type="number" inputMode="numeric" min="1" aria-label={`Quantity for ${entry.sku}`} value={entry.qty}
                onChange={(e) => onChange({ qty: Math.min(999, Math.max(1, parseInt(e.target.value, 10) || 1)) })} />
              <button type="button" className="btn icon ghost step" aria-label="One more" onClick={() => onChange({ qty: Math.min(999, entry.qty + 1) })}>+</button>
            </span>
          </div>
          <label className="po-size-money">
            <span className="muted xs">Shelf price ea</span>
            <span className="po-money-input">
              <span className="po-money-sym">$</span>
              <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" aria-label={`Shelf price ea for ${entry.sku}`}
                value={entry.cost ?? ''} onChange={(e) => onChange({ cost: e.target.value })} />
            </span>
          </label>
        </div>
      </>)}
      <div className="po-finish-actions">
        <button type="button" className="btn primary" disabled={busy || !ready} onClick={onAdd}>
          {ready ? `Add ${entry.qty} pair${entry.qty === 1 ? '' : 's'} · size ${size}` : known ? (entry.codeCheck ? 'Check the code first' : 'Pick a size') : 'Find the SKU first'}
        </button>
      </div>
    </li>
  );
}

// Scan / type a UPC or SKU → resolve the product → tap size chips (tap again for
// +1) → add the whole shoe (every size) to the label at once, like the warehouse
// Add-Item flow. Each size posts one po_line via /api/po/scan.
let rowKey = 0;
const sameSku = (a, b) => String(a || '').toUpperCase().replace(/[\s-]/g, '') === String(b || '').toUpperCase().replace(/[\s-]/g, '');

// `box` = add to a specific shipping label (per-box manifest). `po` (with no box) = add to
// the whole order (Path C — one list for the whole purchase, no per-box breakdown). Exactly
// one of the two is passed; everything else is identical.
// `startPaste` = the window opens on "Paste a list" (the scanner is one tap away).
// `instant` = RAPID SCAN for the supplier's whole-order list (shoes only): a barcode that
// gives the shoe AND its size is one pair on the order at once — no draft, no dialog — and
// anything that can't go straight in waits in "Finish these" while the gun carries on.
export function PoScanModal({ box, po, boxesOrder = false, startPaste = false, instant = false, onClose, onAdded, onSignOut }) {
  const orderMode = !box;
  const rapid = instant && orderMode && !boxesOrder;
  // Name the target the way the rest of the app does — a reship is "the replacement
  // shipment" everywhere else, so "Label 3" here would read as a fourth original box.
  const targetLabel = orderMode ? 'the whole order'
    : box.kind === 'replacement' ? 'the replacement shipment' : `Label ${box.box_number}`;
  const targetTitle = orderMode ? 'Whole order'
    : box.kind === 'replacement' ? 'Replacement shipment' : `Label ${box.box_number}`;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(null); // { type, text } — matches the warehouse scan flash
  // draft = { name, sku, upc, colorway, gender, image, sizeOptions, rows:[{key,size,qty}] }
  const [draft, setDraft] = useState(null);
  const [mCam, setMCam] = useState(false);            // inline live camera toggle (like warehouse)
  const [camZoom, setCamZoom] = useState(1);          // 1× / 2× camera zoom (like warehouse)
  const [recent, setRecent] = useState([]);           // running "added to this label" tally (session)
  const [pendingSwitch, setPendingSwitch] = useState(null); // a different shoe scanned mid-draft
  // A barcode only Alias knew is checked against the box before it goes on the manifest
  // (src/components/AliasCodeCheck.jsx) — the warehouse receives a PO line by its UPC
  // without looking it up again, so a wrong code declared here is never questioned
  // downstream. Answers are kept per barcode for the session: { fix: null | product }.
  const codeDecisionsRef = useRef(new Map());
  // EMPTY-BOX ORDERS. The carton size is what identifies a line here, the way a shoe's
  // size does on a normal order — so it takes the size chips' place rather than sitting
  // beside them. It's also the one field a supplier types the SAME value into thirty
  // times in a row, so the last one declared carries into the next shoe automatically
  // (and the manifest list has a bulk apply for fixing a run of them afterwards).
  const [defaultDims, setDefaultDimsState] = useState(emptyDims);
  // Read through a ref too: "add & switch" seeds the NEXT shoe's row in the same tick it
  // records the carton just declared, and a state read there would still be the old one.
  const defaultDimsRef = useRef(emptyDims());
  const setDefaultDims = (d) => { defaultDimsRef.current = d; setDefaultDimsState(d); };
  const draftRef = useRef(null); draftRef.current = draft; // so the camera callback sees the live draft
  // Set the draft AND its ref in one go: the next scan in the queue can run before React
  // re-renders, and it must see the shoe this one just opened (or cleared).
  const openDraft = (d) => { draftRef.current = d; setDraft(d); };
  const recentRef = useRef({});                       // code -> last-seen ms (camera re-reads only)
  const inputRef = useRef(null);
  // RAPID SCAN. A scan gun fires the next code while the last lookup is still out, so
  // scans queue up and run one at a time, in order — the field is never disabled (a
  // disabled field drops focus, and every scan after the first went nowhere).
  const queueRef = useRef(Promise.resolve());
  const [looking, setLooking] = useState(0);          // lookups queued or in flight
  // Scans that didn't land. Kept on screen until dismissed — with scans queued, a flash
  // or an error line is overwritten by the next one before anybody reads it.
  const [failed, setFailed] = useState([]);           // [{ code, why }]
  const enqueue = (fn) => { queueRef.current = queueRef.current.then(fn).catch(() => {}); return queueRef.current; };
  // Keep the gun aimed at the scan field — but only with a mouse/trackpad: on a phone a
  // focus() pops the keyboard over the list (same rule as warehouse receiving).
  const hasFinePointer = () => { try { return window.matchMedia('(pointer: fine)').matches; } catch { return true; } };
  const refocusScan = () => { if (hasFinePointer()) inputRef.current?.focus({ preventScroll: true }); };
  // "Paste a list" — a supplier's "SKU / size x qty" message, many shoes at once
  // (src/lib/poPaste.js). Shoes only: an empty box needs its dimensions on every line.
  // `file` = an uploaded CSV / TSV / .xlsx read into the same result (src/lib/poCsv.js); while
  // one is loaded it IS the list, and the text box steps aside.
  const [paste, setPaste] = useState(startPaste ? { text: '', prices: {} } : null); // null = closed; { text, prices: {sku: '120'}, file? }
  const [lookups, setLookups] = useState({});         // sku -> { state: 'loading'|'ok'|'none', name, colorway, gender }
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const parsed = !paste ? null : paste.file ? paste.file : parsePoPaste(paste.text);
  const loadFile = async (f) => {
    if (!f) return;
    setError('');
    try {
      const r = await readPoFile(f);
      // A .txt that's just the message goes into the paste box like a paste.
      if (r.text != null) setPaste((p) => ({ ...(p || {}), text: r.text, prices: {}, file: null }));
      else setPaste((p) => ({ ...(p || {}), prices: {}, file: r }));
    } catch (e) { setError(`Could not read ${f.name}: ${e.message}`); }
  };
  // A "Total $1,050" in the message / file is never used as a price — it's the check.
  const statedTotals = (parsed?.totals || []).filter((t) => t.amount != null);
  const priced = statedTotals.length ? listValue(parsed.shoes, paste?.prices) : null;
  // Name each pasted SKU from the catalogue — a convenience, never a gate: a SKU the
  // catalogue doesn't carry is still added, by its code.
  const pastedSkus = (parsed?.shoes || []).map((x) => x.sku).join('|');
  useEffect(() => {
    if (!paste) return undefined;
    // sku-search allows 40 a minute: a long list (a real one had 77 shoes) is named in
    // batches a minute apart instead of the rest hitting the limit and reading "not in the
    // catalogue". Names are a convenience — Add works before they're all in.
    const todo = (parsed?.shoes || []).filter((x) => !lookups[x.sku]).slice(0, 35);
    if (!todo.length) return undefined;
    const t = setTimeout(() => {
      setLookups((m) => ({ ...m, ...Object.fromEntries(todo.map((x) => [x.sku, { state: 'loading' }])) }));
      for (const x of todo) {
        api.searchSku(x.sku)
          .then(({ product: p }) => setLookups((m) => ({ ...m, [x.sku]: p?.name
            ? { state: 'ok', name: p.name, colorway: p.colorway || '', gender: p.gender || null }
            : { state: 'none' } })))
          .catch((e) => { if (e.unauthorized) onSignOut(); setLookups((m) => ({ ...m, [x.sku]: { state: 'none' } })); });
      }
    }, Object.keys(lookups).length ? 61_000 : 500);
    return () => clearTimeout(t);
  }, [pastedSkus, Object.keys(lookups).length]); // eslint-disable-line react-hooks/exhaustive-deps

  const addPasted = async () => {
    const shoes = (parsed?.shoes || []).map((x) => {
      const l = lookups[x.sku] || {};
      const typed = paste.prices?.[x.sku];
      const cost = typed !== undefined ? moneyOf(typed) : x.unitCost;
      return { sku: x.sku, name: x.name || l.name || null, colorway: l.colorway || null, gender: l.gender || null,
        unitCost: cost ?? null,
        // A size's own price ("9 x 2 $110", a CSV row's price) goes with that size.
        sizes: x.sizes.map((z) => (z.unitCost != null ? { size: z.size, qty: z.qty, unitCost: z.unitCost } : { size: z.size, qty: z.qty })) };
    });
    if (!shoes.length) return;
    setBusy(true); setError('');
    try {
      const out = await api.poScanBulk(orderMode ? { poId: Number(po.id), shoes } : { poBoxId: Number(box.id), shoes });
      for (const line of out.lines || []) recordScan(line);
      setFlash({ type: 'added', text: `Added ${out.pairs} pair${out.pairs === 1 ? '' : 's'} · ${shoes.length} SKU${shoes.length === 1 ? '' : 's'} to ${targetLabel}` });
      setPaste(startPaste ? { text: '', prices: {} } : null); onAdded();
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message); onAdded();
    } finally { setBusy(false); }
  };

  // Merge a server-returned po_line into the running tally (its live incremented qty).
  const recordScan = (line, fallbackName) => setRecent((rs) => {
    if (!line) return rs;
    // A box line is identified by its dimensions, a shoe line by its size.
    const what = rapid ? `${line.sku} · ${line.size}`
      : [line.size ? `size ${line.size}` : '', line.dimensions || ''].filter(Boolean).join(' · ');
    const key = `${line.sku}|#|${what}`;
    const price = rapid && line.unit_cost != null && line.unit_cost !== '' ? Number(line.unit_cost) : null;
    return [{ key, name: line.name || fallbackName || line.sku, what, qty: line.qty_expected ?? 1, price },
      ...rs.filter((r) => r.key !== key)];
  });

  // Scan/type a code → resolve → build/accumulate the draft, exactly like the
  // warehouse Add-Item flow: the catalog size auto-fills, re-scanning the same shoe
  // bumps that size, and a *different* shoe prompts to finish the current one first.
  // A live camera re-reading the same barcode within 1.2s is ignored. A gun or typed
  // scan never is: six boxes of one size scanned back to back are six pairs.
  const resolve = (raw, { fromCamera = false } = {}) => {
    const c = String(raw).trim();
    if (!c) return;
    if (fromCamera) {
      const now = Date.now();
      if (isCameraReread(recentRef.current, c, now)) return;
      recentRef.current[c] = now;
    }
    setCode(''); setError('');
    setLooking((n) => n + 1);
    enqueue(() => (rapid ? resolveRapid(c) : resolveOne(c)).finally(() => setLooking((n) => n - 1)));
  };
  const resolveOne = async (c) => {
    try {
      const isUpc = isUpcCode(c);
      const { product: p0 } = isUpc ? await api.searchUpc(c) : await api.searchSku(c);
      const alias = aliasOnlyCode(p0, isUpc ? c : '');
      const told = alias ? codeDecisionsRef.current.get(c) : null;
      const p = told?.fix ? { ...p0, ...told.fix } : p0;
      const incoming = {
        codeCheck: alias && !told ? alias : '', codeCheckUpcs: alias && !told ? [c] : [],
        name: p.name || '', sku: p.sku || (isUpc ? '' : c), image: p.image || '',
        upc: (isUpc ? c : '') || p.upc || '', colorway: p.colorway || '', gender: p.gender || null,
        scannedSize: p.scannedSize ? String(p.scannedSize) : null, sizeOptions: p.sizes || [],
      };
      const d = draftRef.current;
      if (!d) {
        openDraft({ ...incoming, rows: firstRows(incoming) });
        setFlash(startFlash(incoming, c));
      } else if (!sameSku(d.sku, incoming.sku)) {
        // A different shoe. When the current one is complete, add it and carry on —
        // a popup per SKU stops the gun. Only a shoe that can't be added yet (a size
        // or carton missing, a style code to check) still asks.
        if (!draftIsReady(d)) { setPendingSwitch(incoming); return; }
        const prev = d.name || d.sku;
        if (await addToLabel()) {
          openDraft({ ...incoming, rows: firstRows(incoming) });
          const f = startFlash(incoming, c);
          setFlash({ ...f, text: `Added ${prev} · now ${f.text.replace(/^✓ /, '')}` });
        }
      } else if (incoming.codeCheck && !(d.codeCheckUpcs || []).includes(c)) {
        // Same code, but a box nobody has read yet: ask about it before it counts.
        setDraft((x) => ({ ...x, codeCheck: incoming.codeCheck, codeCheckUpcs: [...(x.codeCheckUpcs || []), c] }));
        setFlash({ type: 'warn', text: 'Check the style code on this box, then tap the size below.' });
      } else if (incoming.scannedSize) {
        addSize(incoming.scannedSize);
        setFlash({ type: 'added', text: `+1 · size ${incoming.scannedSize}` });
      } else {
        setFlash({ type: 'warn', text: 'Scanned, but no size from the catalog. Tap the size below.' });
      }
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      // On a BOXES order the catalogue is a convenience, not the source of truth: what
      // identifies the line is the SKU printed on the carton and the carton's size, both
      // of which the person is holding. A SKU the catalogue doesn't carry — or a lookup
      // that times out — must not stop them declaring it, so the draft opens anyway with
      // the code they typed and an empty name to fill in. (A shoes order still needs the
      // lookup: that's where the size list comes from.)
      if (boxesOrder && !draftRef.current && !isUpcCode(c)) {
        openDraft({ name: '', sku: c, image: '', upc: '', colorway: '', gender: null, scannedSize: null, sizeOptions: [], rows: [] });
        setFlash({ type: 'warn', text: `Couldn’t look up ${c} — declaring it anyway. Type the shoe’s name, then tap the size.` });
        setError('');
      } else {
        setFailed((f) => [{ code: c, why: e.message || (e.timeout ? 'catalogue timed out — scan it again' : 'not found') }, ...f].slice(0, 20));
        // "Not found" on a timeout is a lie that costs somebody a search.
        setFlash({ type: 'dup', text: e.timeout ? `Catalogue timed out — scan ${c} again` : `Not found · ${c}` });
      }
    }
  };

  // ---- RAPID SCAN (`instant`: the supplier's whole-order list) ----
  // No draft: a barcode that names the shoe AND its size is one pair on the order the
  // moment it's read (a tone, the running list, the field stays live). Correctness is
  // checked at Review — the order manifest card, where every line can be fixed or removed
  // while the order is a draft. Anything that can't go straight in waits in `toFinish`.
  const [toFinish, setToFinish] = useState([]);       // [{ key, why, code, sku, name, …, size, qty, cost, upc }]
  const [finishBusy, setFinishBusy] = useState(null);  // key of the one being added
  // STICKY "Shelf price ea" for the next scans: typed once, carried by every pair added after
  // it (instant hits AND Finish cards, which prefill from it but stay editable) until it's
  // changed or cleared. Blank = no price, never $0. Read through a ref: scans run from the
  // queue, in closures made a few renders ago.
  const [sticky, setStickyState] = useState(null);    // number | null
  const [stickyText, setStickyText] = useState('');
  const [stickyErr, setStickyErr] = useState('');
  const stickyRef = useRef(null);
  const stickyStr = (n) => (n == null ? '' : n.toFixed(2));
  const setSticky = (n) => {
    stickyRef.current = n; setStickyState(n); setStickyText(stickyStr(n)); setStickyErr('');
    // A card whose price nobody has typed follows the sticky price; one they typed keeps theirs.
    setToFinish((list) => list.map((x) => (x.costTouched ? x : { ...x, cost: stickyStr(n) })));
  };
  // Commit what's in the price box. A gun fired while the price box had focus types a
  // barcode / SKU into it — that's a scan, not a price: it goes to the scanner and the
  // price box goes back to what it was.
  const commitSticky = ({ enter = false } = {}) => {
    const v = stickyText.trim().replace(/^\$\s*/, '');
    if (v === '') { setSticky(null); return; }
    if (isUpcCode(v) || /[a-z]/i.test(v)) {
      setStickyText(stickyStr(stickyRef.current));
      if (enter) resolve(v);
      return;
    }
    const n = Number(v);
    if (!/^\d+(\.\d{1,2})?$/.test(v) || !Number.isFinite(n) || n > 1e7) {
      setStickyText(stickyStr(stickyRef.current));
      setStickyErr(`“${v}” isn’t a price — type it like 41.60, or leave it blank for no price.`);
      return;
    }
    setSticky(Math.round(n * 100) / 100);
  };
  // A pair that went onto a line already carrying a DIFFERENT price: the server kept the
  // line's price (po/scan-order never overwrites one), and this says so — the gun isn't
  // stopped, and the price is changed on the list, deliberately.
  const [priceNotes, setPriceNotes] = useState([]);   // [{ key, text }]
  const notePriceKept = (sku, size, kept) => {
    if (!kept) return;
    const key = `${String(sku).toUpperCase()}|${String(size).toUpperCase()}`;
    const text = `${sku} · ${size} already at $${Number(kept.price).toFixed(2)} — kept; change it on the list`;
    setPriceNotes((ns) => [{ key, text }, ...ns.filter((x) => x.key !== key)].slice(0, 20));
  };
  // A gun fires the same box code again and again; the catalogue allows 40 lookups a
  // minute. A code already answered this session isn't asked again.
  const lookupCacheRef = useRef(new Map());           // code -> product
  // Pairs read but not yet written, by SKU + size. A scan that lands while its line is
  // still waiting in the queue folds into it (qty +1) instead of posting again.
  const writesRef = useRef(new Map());
  const addedTimer = useRef(null);
  // The order card re-reads after a write; under a gun that's once the scans settle.
  const addedSoon = () => { clearTimeout(addedTimer.current); addedTimer.current = setTimeout(() => onAdded(), 700); };
  useEffect(() => () => clearTimeout(addedTimer.current), []);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lookUp = async (c, { sku = false } = {}) => {
    const ck = `${sku ? 's' : 'c'}:${c.toUpperCase()}`;
    if (lookupCacheRef.current.has(ck)) return lookupCacheRef.current.get(ck);
    for (let attempt = 0; ; attempt++) {
      try {
        const { product } = !sku && isUpcCode(c) ? await api.searchUpc(c) : await api.searchSku(c);
        lookupCacheRef.current.set(ck, product);
        return product;
      } catch (e) {
        // Rate-limited: wait it out and carry on — the scans behind this one are kept, in order.
        if (e.status === 429 && attempt < 3) {
          setFlash({ type: 'warn', text: 'The catalogue asked us to slow down — your scans are kept and go in by themselves in a moment.' });
          await sleep(20_000);
          continue;
        }
        throw e;
      }
    }
  };
  const lookUpSku = async (v) => {
    try { return await lookUp(v, { sku: true }); } catch (e) {
      if (e.status === 404) return null; // not in the catalogue — still allowed by its code
      throw e;
    }
  };
  const writeLine = async (key) => {
    const w = writesRef.current.get(key);
    if (!w) return;
    writesRef.current.delete(key);
    try {
      const { line, priceKept } = await api.poScanOrder({ poId: Number(po.id), sku: w.sku, size: w.size, qty: w.qty,
        name: w.name || '', upc: w.upc || '', colorway: w.colorway || '', gender: w.gender || null,
        ...(w.unitCost != null ? { unitCost: w.unitCost } : {}) });
      recordScan(line, w.name);
      notePriceKept(w.sku, w.size, priceKept);
      addedSoon();
    } catch (e) {
      if (e.unauthorized) { onSignOut(); return; }
      beepErr();
      setFailed((f) => [{ code: `${w.sku} · ${w.size} ×${w.qty}`, why: e.message || 'not added' }, ...f].slice(0, 20));
      setFlash({ type: 'dup', text: `Not added · ${w.sku} · ${w.size}` });
    }
  };
  // One pair (or a finished entry's qty) onto the order. Its write runs in the scan queue,
  // so the order on screen is the order scanned.
  // The price is part of the key: a pair scanned after the sticky price changed is its own
  // write, so the server can say the line kept the earlier price instead of it being folded in.
  const addPairs = (l, qty = 1) => {
    const key = `${String(l.sku).toUpperCase()}|${String(l.size).toUpperCase()}|${l.unitCost ?? ''}`;
    const w = writesRef.current.get(key);
    if (w) { w.qty += qty; return; }
    writesRef.current.set(key, { ...l, qty });
    enqueue(() => writeLine(key));
  };
  const finishKey = useRef(0);
  const queueFinish = (entry) => {
    beepErr();
    setToFinish((list) => {
      // The same barcode again is another box of it: one more pair on the entry already waiting.
      const same = list.find((x) => x.code && x.code === entry.code && x.why === entry.why);
      if (same) return list.map((x) => (x === same ? { ...x, qty: Math.min(999, x.qty + 1) } : x));
      return [...list, { size: '', qty: 1, cost: stickyStr(stickyRef.current), ...entry, key: ++finishKey.current }];
    });
    setFlash({ type: 'warn', text: entry.why === 'notfound' ? `Not found · ${entry.code} — finish it below, keep scanning`
      : entry.why === 'check' ? `Check the style code on ${entry.sku} below — keep scanning`
      : `${entry.sku} — pick its size below, keep scanning` });
  };
  const resolveRapid = async (c) => {
    const isUpc = isUpcCode(c);
    let p;
    try { p = await lookUp(c); } catch (e) {
      if (e.unauthorized) return onSignOut();
      if (e.status === 404 || /not found|no product/i.test(e.message || '')) {
        // A typed style code the catalogue doesn't carry still goes in by its code.
        const typed = !isUpc && skuOf(c);
        if (typed) return queueFinish({ why: 'typed', code: c, sku: typed, name: '' });
        return queueFinish({ why: 'notfound', code: c, sku: '' });
      }
      beepErr();
      setFailed((f) => [{ code: c, why: e.message || (e.timeout ? 'catalogue timed out — scan it again' : 'not looked up') }, ...f].slice(0, 20));
      setFlash({ type: 'dup', text: e.timeout ? `Catalogue timed out — scan ${c} again` : `Not looked up · ${c}` });
      return undefined;
    }
    // Only Alias knew this barcode: the box's printed code is checked once per barcode
    // before it counts (src/components/AliasCodeCheck.jsx), then it goes straight in.
    const alias = aliasOnlyCode(p, isUpc ? c : '');
    const told = alias ? codeDecisionsRef.current.get(c) : null;
    const q = told?.fix ? { ...p, ...told.fix } : p;
    const base = { code: c, sku: q.sku || (isUpc ? '' : c), name: q.name || '', colorway: q.colorway || '', gender: q.gender || null,
      image: q.image || '', sizeOptions: q.sizes || [] };
    const size = isUpc && q.scannedSize ? String(q.scannedSize) : '';
    if (!base.sku) return queueFinish({ ...base, why: 'notfound', sku: '' });
    if (alias && !told) return queueFinish({ ...base, why: 'check', codeCheck: alias, size, upc: size ? c : '', upcSize: size });
    if (size) {
      // A UPC is ONE size's box: it goes on the line for the size it named, and no other.
      beepOk();
      setFlash({ type: 'added', text: `+1 · ${base.sku} · ${size}` });
      addPairs({ ...base, size, upc: c, unitCost: stickyRef.current });
      return undefined;
    }
    return queueFinish({ ...base, why: isUpc ? 'size' : 'typed' });
  };
  const patchFinish = (key, patch) => setToFinish((list) => list.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const dropFinish = (key) => setToFinish((list) => list.filter((x) => x.key !== key));
  const addFinished = async (entry) => {
    const size = String(entry.size || '').trim();
    if (!entry.sku || !size) return;
    setFinishBusy(entry.key);
    try {
      // The barcode's own UPC only on the size that barcode named — a size picked by hand
      // for a code that didn't say one isn't that code's ([[upc-is-per-size]]).
      const upc = entry.upc && entry.upcSize && entry.upcSize === size ? entry.upc : '';
      const { line, priceKept } = await api.poScanOrder({ poId: Number(po.id), sku: entry.sku, size, qty: entry.qty,
        name: entry.name || '', upc, colorway: entry.colorway || '', gender: entry.gender || null,
        ...(moneyOf(entry.cost) != null ? { unitCost: moneyOf(entry.cost) } : {}) });
      beepOk();
      recordScan(line, entry.name);
      notePriceKept(entry.sku, size, priceKept);
      setFlash({ type: 'added', text: `Added ${entry.qty} · ${entry.sku} · ${size}` });
      dropFinish(entry.key);
      onAdded();
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      beepErr();
      setError(e.message);
    } finally { setFinishBusy(null); refocusScan(); }
    return undefined;
  };

  // What a freshly-resolved shoe starts with. Identical on both kinds — a box is bought
  // FOR a size, so the size row is the row either way. The difference is that a boxes row
  // also carries the carton, pre-filled with the last one declared: a run of sizes in one
  // size of box is the normal shape of these orders, so it's typed once.
  const firstRows = (incoming) => (incoming.scannedSize
    ? [{ key: rowKey++, size: incoming.scannedSize, qty: 1, cost: '', tip: '', dims: { ...defaultDimsRef.current } }]
    : []);
  const startFlash = (incoming, c) => (incoming.scannedSize
    ? { type: 'added', text: `✓ ${incoming.name || c} · size ${incoming.scannedSize}` }
    : { type: 'warn', text: `Scanned ${incoming.name || c} — no size from the catalog. Tap the size below.` });

  // Size helpers — mirror the warehouse Add-Item behavior.
  const sizePool = () => {
    const apiSizes = draft?.sizeOptions || [];
    const tokens = [...apiSizes, ...(draft?.rows || []).map((r) => r.size)].map((s) => String(s || ''));
    const kind = tokens.some((s) => /y$/i.test(s)) ? 'y' : tokens.some((s) => /w$/i.test(s)) ? 'w' : '';
    const pool = apiSizes.length > 1 ? apiSizes : [...new Set([...apiSizes, ...usSizeChart(kind)])];
    return pool.filter((s) => !(draft?.rows || []).some((r) => String(r.size) === String(s)));
  };
  // Money is PER SIZE — the same shoe can cost (and be tipped) differently in a 9 than in
  // an 11 — so cost and tip live on the size row. A new row inherits what was typed on the
  // last one, because the common case is still a run of sizes bought at one price: type it
  // once, change only the size that differs.
  const lastMoney = (rows) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].cost !== '' || rows[i].tip !== '') return { cost: rows[i].cost, tip: rows[i].tip };
    }
    return { cost: '', tip: '' };
  };
  // A new size row inherits the last money typed AND, on a boxes order, the last carton
  // declared — the two things that are usually the same down a run of sizes.
  const lastDims = (rows) => {
    for (let i = rows.length - 1; i >= 0; i--) if (dimsComplete(rows[i].dims)) return rows[i].dims;
    return defaultDimsRef.current;
  };
  const newRow = (rows, size) => ({ key: rowKey++, size: String(size), qty: 1, ...lastMoney(rows), dims: { ...lastDims(rows) } });
  const addSize = (s) => setDraft((d) => {
    const i = d.rows.findIndex((r) => String(r.size) === String(s));
    if (i >= 0) { const rows = d.rows.slice(); rows[i] = { ...rows[i], qty: rows[i].qty + 1 }; return { ...d, rows }; }
    return { ...d, rows: [...d.rows, newRow(d.rows, s)] };
  });
  const addCustom = () => setDraft((d) => ({ ...d, rows: [...d.rows, newRow(d.rows, '')] }));
  const setRow = (key, patch) => setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const bump = (key, by) => setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, qty: Math.max(1, r.qty + by) } : r)) }));
  const removeRow = (key) => setDraft((d) => ({ ...d, rows: d.rows.filter((r) => r.key !== key) }));

  // A typed money field → a number to send, or null for "not declared" (blank or junk).
  const moneyOf = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  // Commit the whole draft (every size) to the label. Returns true on success.
  // Reads the draft through its ref: it also runs from the scan queue, inside a closure
  // made a few renders ago.
  const addToLabel = async () => {
    const draft = draftRef.current;
    const rows = (draft?.rows || [])
      .map((r) => ({
        size: String(r.size).trim(),
        dimensions: boxesOrder ? dimsToText(r.dims) : null,
        dims: r.dims,
        qty: Math.max(1, parseInt(r.qty, 10) || 1),
        unitCost: moneyOf(r.cost), tip: moneyOf(r.tip),
      }))
      // A box has to say BOTH which size it's for and how big it is; half a declaration
      // is a line the warehouse can't match to anything.
      .filter((r) => r.size && (!boxesOrder || r.dimensions));
    if (!draft?.sku) { setError('A SKU is required.'); return false; }
    if (draft.codeCheck) { setError('Check the style code printed on the box first.'); return false; }
    if (rows.length === 0) {
      setError(boxesOrder
        ? 'Every box needs a size AND its length, width and height.'
        : 'Tap at least one size.');
      return false;
    }
    setBusy(true); setError('');
    try {
      for (const r of rows) {
        const common = { sku: draft.sku, size: r.size, qty: r.qty,
          ...(boxesOrder ? { dimensions: r.dimensions } : {}),
          name: draft.name, upc: draft.upc, colorway: draft.colorway, gender: draft.gender,
          unitCost: r.unitCost, tip: r.tip };
        const { line, priceKept } = orderMode
          ? await api.poScanOrder({ poId: Number(po.id), ...common })
          : await api.poScan({ poBoxId: Number(box.id), ...common });
        recordScan(line, draft.name);
        notePriceKept(draft.sku, r.size, priceKept); // po/scan-order keeps a line's own price
      }
      // Carry the last carton declared into the next shoe — a boxes order is normally a
      // run of SKUs in one box, so this is the difference between typing it once and
      // typing it thirty times.
      if (boxesOrder) setDefaultDims({ ...rows[rows.length - 1].dims });
      const total = rows.reduce((n, r) => n + r.qty, 0);
      setFlash({ type: 'added', text: `Added ${draft.name || draft.sku} · ${total} ${boxesOrder ? (total === 1 ? 'box' : 'boxes') : `unit${total === 1 ? '' : 's'}`} to ${targetLabel}` });
      openDraft(null); onAdded();
      return true;
    } catch (e) {
      if (e.unauthorized) { onSignOut(); return false; }
      setError(e.message); onAdded(); return false; // reflect whatever landed before the failure
    } finally { setBusy(false); }
  };

  function draftIsReady(d) {
    const rows = d?.rows || [];
    return !!d && !d.codeCheck && rows.length > 0 && rows.every((r) => String(r.size).trim())
      && (!boxesOrder || rows.every((r) => dimsComplete(r.dims)));
  }

  // "Different shoe" prompt: commit the current shoe, then open the new one.
  const confirmSwitch = async () => {
    const next = pendingSwitch;
    const ok = await addToLabel();
    setPendingSwitch(null);
    if (ok && next) {
      openDraft({ ...next, rows: firstRows(next) });
      setFlash(startFlash(next, next.sku));
    }
  };

  const totalUnits = (draft?.rows || []).reduce((n, r) => n + (parseInt(r.qty, 10) || 0), 0);
  // A box that doesn't say which size it's for, or how big it is, isn't a declaration —
  // it's a line nobody can match to a shoe. Every row has to be complete, not just one:
  // a half-filled row would be silently dropped on submit.
  const draftRows = draft?.rows || [];
  const draftReady = draftIsReady(draft);
  const draftMissing = draft?.codeCheck ? 'Check the style code printed on the box first.'
    : !draftReady && draftRows.length > 0
    ? (draftRows.some((r) => !String(r.size).trim()) ? 'Every row needs a size.' : 'Every box needs its length, width and height.')
    : '';
  // What this draft adds up to, per size: qty × cost and qty × tip.
  const draftTotal = (draft?.rows || []).reduce((t, r) => {
    const q = parseInt(r.qty, 10) || 0;
    const c = moneyOf(r.cost); const tp = moneyOf(r.tip);
    return { cost: t.cost + (c || 0) * q, tip: t.tip + (tp || 0) * q, any: t.any || c != null || tp != null };
  }, { cost: 0, tip: 0, any: false });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal additem" role="dialog" aria-modal="true"
        onClick={(e) => {
          e.stopPropagation();
          // Keep the scan gun aimed at the SKU field by refocusing it when the user taps
          // empty modal space — but NEVER when they tapped another control (the size box,
          // qty, product name, a chip/button). That refocus was bouncing every click back
          // to SKU, so the size field was impossible to type letters into (5C, 3Y, …).
          if (mCam || paste || pendingSwitch) return;
          // A tap on a finish card (its labels, its SKU / size fields) keeps the focus it gave;
          // its BUTTONS hand it back to the scan field below, like every other button here.
          if (!e.target.closest('button') && e.target.closest('.po-finish')) return;
          // After a BUTTON (a size chip, +/−) the scan field takes focus back, or the gun's
          // Enter would press that button again and add a pair nobody scanned. "+ Custom"
          // is the exception: its new size box takes the focus.
          if (e.target.closest('button')) { if (!e.target.closest('.size-chip.custom')) refocusScan(); return; }
          if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
          inputRef.current?.focus({ preventScroll: true });
        }}>
        <div className="modal-head">
          <h3 className="modal-title">Add {boxesOrder ? 'boxes' : 'items'} · {targetTitle}</h3>
          <button type="button" className="btn icon ghost" onClick={onClose}>×</button>
        </div>

        {!boxesOrder && !draft && (
          <div className="po-paste-toggle">
            <button type="button" className={`btn sm ${paste ? 'primary' : 'ghost'}`} disabled={busy}
              onClick={() => { setError(''); setPaste((p) => (p ? null : { text: '', prices: {} })); }}>
              {paste ? '← Scan instead' : '📋 Paste a list'}
            </button>
            {!paste && <span className="muted xs">SKU, then “size x qty” lines — or upload a CSV — many shoes at once</span>}
          </div>
        )}
        {paste ? (
          <div className={`po-paste${dragOver ? ' po-paste-drop' : ''}`}
            onDragOver={(e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); setDragOver(true); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!busy) loadFile(e.dataTransfer?.files?.[0]); }}>
            <div className="po-paste-file-row">
              <input ref={fileRef} type="file" accept={PO_FILE_ACCEPT} hidden aria-label="Upload a CSV file"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; loadFile(f); }} />
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => fileRef.current?.click()}>📄 Upload a CSV</button>
              <span className="muted xs">.csv · .tsv · .xlsx — or drop the file here</span>
            </div>
            {paste.file ? (
              <div className="po-paste-file">
                <div className="po-paste-file-head">
                  <b>📄 {paste.file.name}</b>
                  <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setPaste((p) => ({ ...p, file: null, prices: {} }))}>✕ Use a paste instead</button>
                </div>
                {paste.file.error
                  ? <div className="error sm" role="alert">{paste.file.error}</div>
                  : (
                    <p className="muted xs">
                      Read as {paste.file.layout === 'text' ? 'a pasted list (no header row: each row is a line of the message)'
                        : paste.file.layout === 'matrix' ? 'one row per SKU, sizes across the top' : paste.file.layout === 'per-pair' ? 'one row per pair (no qty column)' : 'one row per SKU + size'}
                      {(paste.file.columns || []).length > 0 && ` · ${paste.file.columns.map((c) => `${c.role} = “${c.header}”`).join(' · ')}`}
                    </p>
                  )}
              </div>
            ) : (<>
              <textarea className="input" rows={8} value={paste.text} autoFocus disabled={busy}
                aria-label="Paste the list"
                placeholder={'DZ5485-201\n8.5 x 2\n9 x 3 $110\n9.5 x 4\n\nIB4025-100 $120\n10 x 1'}
                onChange={(e) => setPaste((p) => ({ ...p, text: e.target.value }))} />
              <p className="muted xs">One shoe per block: the SKU (optionally with its shelf price ea — <code>$120</code>, <code>@120</code>, <code>120 ea</code>, <code>price 120</code>), then one <code>size x qty</code> per line (a price after it, e.g. <code>9 x 2 $110</code>, is that size’s own). A number with no <code>$</code> or word beside it is never read as a price. Paste as many shoes as you like; the same SKU twice is added together. Sizes already on {targetLabel} go up by the pasted quantity.</p>
            </>)}
            {parsed?.shoes.length > 0 && (
              <ul className="po-paste-list">
                {parsed.shoes.map((x) => {
                  const l = lookups[x.sku];
                  const n = x.sizes.reduce((k, z) => k + z.qty, 0);
                  const ownPrice = x.sizes.filter((z) => z.unitCost != null).length;
                  const fromTotal = x.priceFrom === 'total' || x.sizes.some((z) => z.priceFrom === 'total');
                  return (
                    <li key={x.sku}>
                      <div className="po-paste-head">
                        <b>{x.sku}</b>
                        <span className={`muted xs${l?.state === 'none' ? ' po-paste-warn' : ''}`}>
                          {x.name || (l?.state === 'ok' ? l.name : l?.state === 'none' ? 'not in the catalogue — added by its SKU' : 'looking up…')}
                        </span>
                        <span className="po-paste-n">{n} pair{n === 1 ? '' : 's'}</span>
                      </div>
                      <div className="po-paste-sizes">
                        {[...x.sizes].sort((a, b) => compareSizes(a.size, b.size)).map((z) => (
                          <span key={z.size} className="size-chip static">
                            {z.size} ×{z.qty}{z.unitCost != null && <span className="po-paste-size-price"> · ${z.unitCost.toFixed(2)}</span>}
                          </span>
                        ))}
                        {ownPrice < x.sizes.length && (
                          <label className="po-size-money po-paste-price">
                            <span className="muted xs">{ownPrice ? 'Shelf price ea (other sizes)' : 'Shelf price ea'}</span>
                            <span className="po-money-input">
                              <span className="po-money-sym">$</span>
                              <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00"
                                value={paste.prices?.[x.sku] ?? (x.unitCost ?? '')}
                                onChange={(e) => setPaste((p) => ({ ...p, prices: { ...p.prices, [x.sku]: e.target.value } }))} />
                            </span>
                          </label>
                        )}
                      </div>
                      {(ownPrice > 0 || fromTotal) && (
                        <p className="muted xs po-paste-note">
                          {ownPrice > 0 && 'A size showing its own price keeps it. '}
                          {fromTotal && 'Price ea worked out from the line total ÷ its pairs — check it.'}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {priced && parsed.shoes.length > 0 && (
              <p className="muted xs po-paste-total" role="note">
                {paste.file ? 'The file’s total' : 'The message says'}: {statedTotals.map((t) => `$${t.amount.toFixed(2)}`).join(' · ')}
                {' — this list comes to '}<b>${priced.total.toFixed(2)}</b>
                {priced.unpriced > 0 && ` (+ ${priced.unpriced} pair${priced.unpriced === 1 ? '' : 's'} with no price)`}
                {statedTotals.some((t) => Math.abs(t.amount - priced.total) < 0.005) ? ' ✓' : ' — check the prices'}
              </p>
            )}
            {error && <div className="error sm" role="alert">{error}</div>}
            {parsed?.skipped.length > 0 && (
              <div className="po-paste-skipped" role="alert">
                <b>Not added — fix these {paste.file ? 'rows' : 'lines'} if they matter:</b>
                <ul>{parsed.skipped.map((k, i) => <li key={i}><code>{k.line}</code> — {k.why}</li>)}</ul>
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn ghost" disabled={busy} onClick={() => (startPaste ? onClose() : setPaste(null))}>{startPaste ? 'Close' : 'Cancel'}</button>
              <button type="button" className="btn primary wide" disabled={busy || !parsed?.pairs} onClick={addPasted}>
                {busy ? 'Adding…' : parsed?.pairs ? `Add ${parsed.pairs} pair${parsed.pairs === 1 ? '' : 's'} (${parsed.shoes.length} SKU${parsed.shoes.length === 1 ? '' : 's'}) to ${orderMode ? 'order' : 'label'}` : 'Paste a list to add'}
              </button>
            </div>
          </div>
        ) : (<>
        {/* The sticky price: typed once, on every pair scanned after it. Never takes the
            focus by itself and never disables anything — Enter here hands the focus back
            to the scan field. */}
        {rapid && (
          <div className="po-sticky-price">
            <label className="po-size-money">
              <span className="muted xs">Shelf price ea for next scans</span>
              <span className="po-money-input">
                <span className="po-money-sym">$</span>
                <input inputMode="decimal" placeholder="—" aria-label="Shelf price ea for next scans" value={stickyText}
                  onChange={(e) => { setStickyText(e.target.value); setStickyErr(''); }}
                  onBlur={() => commitSticky()}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    commitSticky({ enter: true });
                    // Blur first so the blur's commit sees the box already settled.
                    setTimeout(() => { e.target.blur?.(); refocusScan(); }, 0);
                  }} />
              </span>
            </label>
            <span className="po-sticky-state" data-testid="po-sticky-state">
              {sticky != null
                ? <>Price for next scans: <b>${sticky.toFixed(2)}</b> · <button type="button" className="linklike" onClick={() => setSticky(null)}>clear</button></>
                : 'Next scans: no price'}
            </span>
            {stickyErr && <div className="error sm po-sticky-err">{stickyErr}</div>}
          </div>
        )}
        {/* Never disabled: a disabled field (or a disabled submit button, which blocks the
            gun's Enter) is what made rapid scanning impossible. Scans queue instead. */}
        <form className="searchrow" onSubmit={(e) => { e.preventDefault(); resolve(code); }}>
          <input ref={inputRef} autoFocus autoCapitalize="characters" autoCorrect="off"
            placeholder="Scan or type UPC / SKU" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="btn primary">Add</button>
          <button type="button" className={`btn ${mCam ? 'primary' : 'ghost'}`} onClick={() => setMCam((v) => !v)} title="Scan with camera"><Icon name="camera" /></button>
        </form>
        {mCam && (
          <Suspense fallback={<p className="muted">Loading camera…</p>}>
            <CameraScanner continuous mode="product" onDetected={(c) => resolve(c, { fromCamera: true })} onClose={() => setMCam(false)}
              zoom={camZoom} onZoomChange={setCamZoom} />
          </Suspense>
        )}

        </>)}

        <div className="scan-flash-live" role="status" aria-live="polite">
          {flash && <div className={`scan-flash ${flash.type}`}>{flash.text}</div>}
        </div>
        {looking > 0 && <p className="muted xs po-scan-looking" role="status">Looking up {looking} scan{looking === 1 ? '' : 's'}…</p>}
        {failed.length > 0 && (
          <div className="po-scan-failed error sm mt" role="alert">
            <div className="po-scan-failed-head">
              <b>Not added — scan {failed.length === 1 ? 'this' : 'these'} again or type the SKU:</b>
              <button type="button" className="btn sm ghost" onClick={() => setFailed([])}>Clear</button>
            </div>
            <ul>{failed.map((f, i) => <li key={i}><code>{f.code}</code> — {f.why}</li>)}</ul>
          </div>
        )}
        {priceNotes.length > 0 && (
          <div className="po-price-kept sm mt" role="status" data-testid="po-price-kept">
            <div className="po-scan-failed-head">
              <b>Added — at the price already on the list:</b>
              <button type="button" className="btn sm ghost" onClick={() => setPriceNotes([])}>Clear</button>
            </div>
            <ul>{priceNotes.map((n) => <li key={n.key}>{n.text}</li>)}</ul>
          </div>
        )}
        {error && !paste && <div className="error sm mt">{error}</div>}
        {!draft && !busy && !looking && !paste && !(rapid && (toFinish.length || recent.length)) && (
          <p className="muted sm mt">{boxesOrder
            ? 'Scan or type the SKU printed on the empty box — the shoe’s name fills in, and a scanned UPC fills the size too. Then tap the size each box is for and give its dimensions; a new row starts at the last carton you typed, so a run of sizes is measured once.'
            : rapid ? 'Scan each box’s UPC — every scan is one pair on the order, straight away (the same box again = one more). A code we can’t place, or a SKU you type, waits below for its size and quantity while you keep scanning. Type a shelf price ea above once and every pair after it carries that price, until you change or clear it. Check the list on the order before you ship.'
            : 'Scan a shoe’s UPC to begin — its size auto-fills. Add other sizes with the chips, or “+ Custom” if a size isn’t listed. Re-scanning the same shoe bumps its size by 1.'}</p>
        )}

        {rapid && toFinish.length > 0 && (
          <div className="po-finish-panel" role="region" aria-label="Finish these">
            <div className="po-finish-panel-head">
              <b>Finish {toFinish.length === 1 ? 'this one' : `these ${toFinish.length}`}</b>
              <span className="muted xs">keep scanning — these wait for you</span>
            </div>
            <ul className="po-finish-list">
              {toFinish.map((x) => (
                <PoFinishCard key={x.key} entry={x} busy={finishBusy === x.key} onSignOut={onSignOut}
                  onChange={(patch) => patchFinish(x.key, 'cost' in patch ? { ...patch, costTouched: true } : patch)} onDismiss={() => dropFinish(x.key)}
                  onAdd={() => addFinished(x)} onLookUp={lookUpSku}
                  onCodeConfirm={() => { codeDecisionsRef.current.set(x.code, { fix: null }); patchFinish(x.key, { codeCheck: '' }); }}
                  onCodeFix={({ found, sizes, ...fix }) => {
                    codeDecisionsRef.current.set(x.code, { fix: { ...fix, sizes } });
                    patchFinish(x.key, { ...fix, sizeOptions: sizes?.length ? sizes : x.sizeOptions, codeCheck: '' });
                  }} />
              ))}
            </ul>
          </div>
        )}

        {recent.length > 0 && (
          <div className="po-scan-recent">
            <div className="muted sm">Added to {targetLabel}</div>
            <ul className="po-lines">
              {recent.map((r) => (
                <li key={r.key}>
                  <span className="po-line-name">{r.name}</span>
                  <span className="po-line-meta">{r.what} · ×{r.qty}{r.price != null ? ` · $${r.price.toFixed(2)}` : ''}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {draft && (
          // Any interaction with the draft closes the live camera so it can't keep
          // detecting in the background.
          <div className="additem-draft" onPointerDownCapture={() => { if (mCam) setMCam(false); }}>
            <div className="additem-product">
              {draft.image ? <img className="cart-thumb" src={draft.image} alt="" /> : <div className="cart-thumb placeholder">—</div>}
              <div className="cart-fields">
                <input className="cart-name" placeholder="Product name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                <input placeholder="SKU" value={draft.sku} onChange={(e) => setDraft((d) => ({ ...d, sku: e.target.value }))} />
              </div>
            </div>
            {draft.codeCheck && (
              <AliasCodeCheck key={draft.codeCheck} code={draft.codeCheck} current={draft.sku} onSignOut={onSignOut}
                where={(draft.codeCheckUpcs || []).length > 1 ? `each of the ${draft.codeCheckUpcs.length} boxes you scanned` : ''}
                onConfirm={() => {
                  for (const u of draft.codeCheckUpcs || []) codeDecisionsRef.current.set(u, { fix: null });
                  setDraft((d) => ({ ...d, codeCheck: '', codeCheckUpcs: [] }));
                }}
                onFix={({ found, sizes, ...fix }) => {
                  for (const u of draft.codeCheckUpcs || []) codeDecisionsRef.current.set(u, { fix: { ...fix, sizes } });
                  setDraft((d) => ({ ...d, ...fix, sizeOptions: sizes.length ? sizes : d.sizeOptions, codeCheck: '', codeCheckUpcs: [] }));
                }} />
            )}
            <div className="size-rows">
              <div className="muted sm">{boxesOrder
                ? 'Tap the size each box is for (tap again for +1), or “+ Custom” if a size isn’t listed. Give the carton’s dimensions on each row — a new row starts at the last one you typed.'
                : 'The scanned size is filled in below. Tap a chip to add another size (tap again for +1), or “+ Custom” if a size isn’t listed.'}</div>
              <div className="size-chips">
                {sizePool().map((s) => (
                  <button type="button" key={s} className="size-chip" onClick={() => addSize(s)}>{s}</button>
                ))}
                <button type="button" className="size-chip custom" onClick={addCustom}>+ Custom</button>
              </div>
              {[...draft.rows].sort((a, b) => compareSizes(a.size, b.size)).map((r) => (
                <div className="size-line po-size-line" key={r.key}>
                  <div className="po-size-line-top">
                    <input className={`sz ${!String(r.size).trim() ? 'need' : ''}`} placeholder="Size" value={r.size} onChange={(e) => setRow(r.key, { size: e.target.value })} autoFocus={!String(r.size).trim()} />
                    <div className="qty-stepper">
                      <button type="button" className="btn icon ghost step" onClick={() => bump(r.key, -1)}>−</button>
                      <input className="qty" type="number" inputMode="numeric" min="1" value={r.qty} onChange={(e) => setRow(r.key, { qty: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
                      <button type="button" className="btn icon ghost step" onClick={() => bump(r.key, 1)}>+</button>
                    </div>
                    <button type="button" className="btn icon ghost remove" title="Remove size" onClick={() => removeRow(r.key)}>×</button>
                  </div>
                  {/* How big the box for THAT size is. Per row, not per shoe: the whole
                      reason a box is bought is that it fits one size, and a 13 and a 9
                      don't share a carton. */}
                  {boxesOrder && (
                    <DimensionsFields value={r.dims} hint={false} label="Box dimensions"
                      onChange={(d) => setRow(r.key, { dims: d })} />
                  )}
                  {/* Money is per size, so it belongs on the size's own row. */}
                  <div className="po-size-line-money">
                    <label className="po-size-money">
                      <span className="muted xs">{boxesOrder ? 'Cost ea' : 'Shelf price ea'}</span>
                      <span className="po-money-input">
                        <span className="po-money-sym">$</span>
                        <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00"
                          value={r.cost ?? ''} onChange={(e) => setRow(r.key, { cost: e.target.value })} />
                      </span>
                    </label>
                    <label className="po-size-money">
                      <span className="muted xs">Tip ea</span>
                      <span className="po-money-input">
                        <span className="po-money-sym">$</span>
                        <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00"
                          value={r.tip ?? ''} onChange={(e) => setRow(r.key, { tip: e.target.value })} />
                      </span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
            {/* Cost and tip are optional — blank records nothing rather than $0 — so this
                only appears once there's money to add up. */}
            {draftTotal.any && (
              <p className="po-draft-total muted sm">
                {boxesOrder ? 'Cost' : 'Shelf'} ${draftTotal.cost.toFixed(2)}
                {draftTotal.tip > 0 ? ` + tips $${draftTotal.tip.toFixed(2)}` : ''}
                {' = '}<b>${(draftTotal.cost + draftTotal.tip).toFixed(2)}</b>
              </p>
            )}
            {draftMissing && <p className="po-draft-missing sm">{draftMissing}</p>}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => openDraft(null)}>Cancel</button>
              <button type="button" className="btn primary wide" disabled={busy || totalUnits < 1 || !draftReady} onClick={() => enqueue(addToLabel)}>
                Add {totalUnits > 0 ? `${totalUnits} ${boxesOrder ? (totalUnits === 1 ? 'box' : 'boxes') : `unit${totalUnits === 1 ? '' : 's'}`} ` : ''}to {orderMode ? 'order' : 'label'}
              </button>
            </div>
          </div>
        )}

        {pendingSwitch && (
          <div className="modal-overlay" style={{ zIndex: 130 }} onClick={() => setPendingSwitch(null)}>
            <div className="modal confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
              <h3 className="modal-title">Different shoe detected</h3>
              <p className="modal-msg">You scanned <b>{pendingSwitch.name || pendingSwitch.sku || 'a new item'}</b>, different from <b>{draft?.name || draft?.sku || 'the current shoe'}</b>. Add the current shoe to the label and start the new one?</p>
              <div className="modal-actions">
                <button type="button" className="btn ghost" disabled={busy} onClick={() => setPendingSwitch(null)}>Keep current</button>
                <button type="button" className="btn primary" disabled={busy} onClick={() => enqueue(confirmSwitch)}>Add &amp; switch</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
