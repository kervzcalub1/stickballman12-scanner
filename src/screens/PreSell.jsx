// Pre-sell — shipments that were sold before they landed.
//
// Those units must NOT be listed to II or the stores: they are already spoken for, and
// offering them again would sell somebody else's pair. So a pre-sell shipment sits out of
// the PH listing world entirely (`items.pre_sell`, guarded in phListItems, pendingCounts,
// the GI refresh and the repricer) and surfaces only here.
//
// The job on this page is one question per row — how many of these are covered by an
// order? — and then one button. What is left over is released for listing by clearing
// `pre_sell` and setting `restock_pending`, which puts it on the Rescale Stock worklist:
// the place stock already gets priced and pushed to the stores. Nothing new had to be
// invented for "subject for upload"; that worklist is it.
//
// Two ways to answer the question, because the warehouse works both ways: type the count
// for a row of identical pairs, or scan the 1ID of a specific one. Both end at the same
// place — `status = 'pre_sold'`, which keeps the pair in inventory as a real thing on a
// shelf that is spoken for. NOT `sold`: that is terminal here, and claiming it before the
// pair has shipped would strand it if the pre-sale fell through.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { compareSizes } from '../lib/codes.js';
import { estDate } from '../lib/format.js';

export function PreSell({ onHome, onSignOut }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [scan, setScan] = useState('');
  const scanRef = useRef(null);

  const load = () => api.presellList()
    .then((r) => setRows(r.rows || []))
    .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  // Wrapped, NOT `useEffect(load, [])`: `load` returns a promise, and React treats
  // anything an effect returns as its cleanup function — "destroy is not a function".
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pulse = (kind, text) => { setFlash({ kind, text }); setTimeout(() => setFlash(null), 2200); };

  // Grouped the way the question is asked: shipment → shoe → size.
  const shipments = useMemo(() => {
    const m = new Map();
    for (const r of rows || []) {
      const b = Number(r.batch_id);
      if (!m.has(b)) m.set(b, { id: b, code: r.batch_code, supplier: r.supplier_name, date: r.date_received, shoes: new Map() });
      const ship = m.get(b);
      const k = r.sku || r.name || '—';
      if (!ship.shoes.has(k)) ship.shoes.set(k, { sku: r.sku, name: r.name, sizes: [] });
      ship.shoes.get(k).sizes.push(r);
    }
    for (const s of m.values()) for (const sh of s.shoes.values()) sh.sizes.sort((a, b) => compareSizes(a.size, b.size));
    return [...m.values()];
  }, [rows]);

  async function setSold(row, qty) {
    const n = Math.max(0, Math.min(Number(row.arrived) || 0, parseInt(qty, 10) || 0));
    if (n === Number(row.sold)) return;
    setBusy(true); setError('');
    try {
      await api.presellMarkSold({ batchId: row.batch_id, sku: row.sku, size: row.size, qty: n });
      await load();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  }

  // The scan path: name one pair instead of counting a row. Same end state.
  async function scanSold(code) {
    const vin = String(code).trim();
    if (!vin) return;
    setScan(''); setError('');
    try {
      const r = await api.presellMarkSold({ vin });
      pulse('ok', `✓ ${r.item?.vin || vin} marked sold${r.item?.size ? ` · size ${r.item.size}` : ''}`);
      await load();
    } catch (e) {
      if (e.unauthorized) return onSignOut();
      setError(e.message); pulse('err', e.message);
    } finally { scanRef.current?.focus(); }
  }

  async function release(ship, remaining) {
    if (!window.confirm(
      `Send ${remaining} unit${remaining === 1 ? '' : 's'} from ${ship.code} for rescale?\n\n`
      + 'They stop being pre-sell and land on Rescale Stock, where you price and list them. '
      + 'Anything already marked sold stays put.')) return;
    setBusy(true); setError('');
    try {
      const r = await api.presellRelease(ship.id);
      pulse('ok', `${r.released} unit${r.released === 1 ? '' : 's'} sent for rescale — price them on Rescale Stock.`);
      await load();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="app">
      <TopBar title="Pre-sell" onHome={onHome} onSignOut={onSignOut} />
      <div className="wrap-narrow">
        <p className="muted sm">
          Shipments sold <b>before</b> they arrived. Nothing here is listed to II or the stores — it is
          already spoken for. Say how many of each size an order covers, then send the rest for rescale
          so they can be priced and listed.
        </p>
        {error && <div className="po-err">{error}</div>}
        <div className="scan-flash-live" role="status" aria-live="polite">
          {flash && <div className={`scan-flash ${flash.kind === 'err' ? 'dup' : 'added'}`}>{flash.text}</div>}
        </div>

        {/* Scan a 1ID to mark that exact pair, when you'd rather name it than count it. */}
        <form className="searchrow presell-scan" onSubmit={(e) => { e.preventDefault(); scanSold(scan); }}>
          {/* No `inputMode="none"` here, unlike the warehouse scan fields: this page is
              worked from a desk, and a PH user with no scanner has to be able to type. */}
          <input ref={scanRef} value={scan} autoCapitalize="characters" autoCorrect="off"
            placeholder="Scan a 1ID / VIN to mark that pair sold" onChange={(e) => setScan(e.target.value)} />
          <button className="btn primary" disabled={busy}>Mark sold</button>
        </form>

        {rows == null ? <p className="muted">Loading…</p>
          : shipments.length === 0 ? (
            <div className="card empty-state">
              No pre-sell shipments waiting. A shipment lands here when it is ticked
              <b> Pre-sell</b> at receiving.
            </div>
          ) : shipments.map((ship) => {
            const all = [...ship.shoes.values()].flatMap((sh) => sh.sizes);
            const arrived = all.reduce((n, r) => n + Number(r.arrived), 0);
            const sold = all.reduce((n, r) => n + Number(r.sold), 0);
            const remaining = arrived - sold;
            return (
              <div className="card presell-ship" key={ship.id}>
                <div className="po-card-top">
                  <h3 className="rows-title">{ship.code}</h3>
                  <span className="muted sm">{ship.supplier}{ship.date ? ` · ${estDate(ship.date)}` : ''}</span>
                </div>
                <div className="presell-totals muted sm">
                  <b>{arrived}</b> arrived · <b>{sold}</b> sold · <b>{remaining}</b> to list
                </div>

                {[...ship.shoes.values()].map((sh) => (
                  <div className="presell-shoe" key={sh.sku || sh.name}>
                    <div className="presell-shoe-head">
                      <span className="po-line-name">{sh.name || sh.sku}</span>
                      <span className="po-line-meta">{sh.sku}</span>
                    </div>
                    <div className="presell-rows">
                      <div className="presell-row head" aria-hidden="true">
                        <span>Size</span><span>Arrived</span><span>Sold</span><span>Remains</span>
                      </div>
                      {sh.sizes.map((r) => (
                        <div className={`presell-row ${Number(r.remains) === 0 ? 'done' : ''}`} key={`${r.sku}|${r.size}`}>
                          <span className="presell-size">{r.size || '—'}</span>
                          <span className="presell-n">{r.arrived}</span>
                          <span className="presell-sold">
                            {/* Uncontrolled so typing is never fought mid-edit — but keyed on
                                the server's count, so a clamped or rejected number is replaced
                                by the truth rather than left standing on screen. */}
                            <input type="number" min="0" max={r.arrived} inputMode="numeric"
                              key={String(r.sold)} defaultValue={r.sold} disabled={busy}
                              onBlur={(e) => setSold(r, e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                          </span>
                          <span className="presell-n">{r.remains}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                <div className="presell-actions">
                  <button className="btn primary" disabled={busy || remaining < 1} onClick={() => release(ship, remaining)}>
                    <Icon name="refresh" /> Send the {remaining} remaining for rescale
                  </button>
                  {remaining < 1 && <span className="muted sm">Every unit on this shipment is spoken for.</span>}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
