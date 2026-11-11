// The pick-list strip on a marketplace Orders list (eBay page → Orders, SHEIN page → Orders):
// how many orders are ticked, a quick "select every order still to ship", and Download pick list.
// The PDF is built in the browser from the ticked rows (src/lib/pickList.js) and saved, never printed.
import React, { useState } from 'react';
import { pickListFileName, pickListPdf } from '../lib/pickList.js';

export async function downloadPickList(entries, platform) {
  const now = new Date();
  const blob = (await pickListPdf(entries, { platform, now })).output('blob');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = pickListFileName(platform, now);
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// entries() is called on click, so it always reads the ticks as they are now.
export function PickListBar({ platform, picked, pairs, awaiting, onSelectAwaiting, onClear, entries }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try { await downloadPickList(entries(), platform); }
    catch (e) { setErr(e.message || 'Couldn’t build the pick list.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="pk-bar" data-pick-bar={platform}>
      <button type="button" className="btn sm" disabled={!awaiting} onClick={onSelectAwaiting}>Select awaiting shipment ({awaiting})</button>
      {picked > 0 && <button type="button" className="btn ghost sm" onClick={onClear}>Clear</button>}
      <span className="pk-grow" />
      <span className="muted xs" data-pick-count="">{picked ? `${picked} order${picked === 1 ? '' : 's'} · ${pairs} pair${pairs === 1 ? '' : 's'}` : 'Tick the orders to pick'}</span>
      <button type="button" className="btn primary sm" disabled={!picked || busy} onClick={go}>{busy ? 'Building…' : `Download pick list (${picked})`}</button>
      {err && <div className="error xs pk-err" role="alert">{err}</div>}
      <p className="muted xs pk-note">A 4 × 6 in PDF for the label printer: one pair per entry (order #, shoe, SKU, size), up to 4 a page.</p>
    </div>
  );
}
