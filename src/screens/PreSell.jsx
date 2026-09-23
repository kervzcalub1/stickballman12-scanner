// Pre-sell — shipments that were sold before they landed.
//
// Those units must NOT be listed to II or the stores: they are already spoken for, and
// offering them again would sell somebody else's pair. So a pre-sell shipment sits out of
// the PH listing world entirely (`items.pre_sell`, guarded in phListItems, pendingCounts,
// the GI refresh and the repricer) and surfaces only here.
//
// The job on this page is one question per row — how many of these are covered by an
// order? — and then one button. What is left over is freed for listing by clearing
// `pre_sell`, which puts it on PH's New Inventory dated by the day it was freed
// (pre-sell.md: that date is what stops a pair off an older shipment landing outside the
// window PH is looking at).
//
// The page also carries the two CORRECTIONS, because pre-sell is declared per shoe at
// receiving and can therefore be got wrong in both directions:
//   · "Not pre-sell" frees one shoe of a shipment — the fix for a batch where one SKU of
//     fifteen was spoken for and all fifteen were held.
//   · "Hold another shoe" puts one back, which is the expensive mistake: a held pair
//     that nobody marked reaches PH, gets listed, and can be sold to a second buyer.
//
// The WAREHOUSE answers all of it, not PH: the team holding the shipment is the one that
// knows which pairs an order covers. PH's part starts after release, when the freed pairs
// appear on New Inventory to be priced and listed to II and the platforms.
//
// Two ways to answer the question, because the warehouse works both ways: type the count
// for a row of identical pairs, or scan the 1ID of a specific one. Both end at the same
// place — `status = 'pre_sold'`, which keeps the pair in inventory as a real thing on a
// shelf that is spoken for. NOT `sold`: that is terminal here, and claiming it before the
// pair has shipped would strand it if the pre-sale fell through.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { TopBar, Modal } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { compareSizes } from '../lib/codes.js';
import { estDate } from '../lib/format.js';
import { useQueryParam } from '../lib/urlstate.js';

export function PreSell({ onHome, onSignOut }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [scan, setScan] = useState('');
  const scanRef = useRef(null);
  const [confirm, setConfirm] = useState(null); // { kind:'release'|'not_presell', ship, shoe?, n }
  const [holdPick, setHoldPick] = useState(null); // { ship, shoes|null }
  // To work / Done. A shipment whose every pair is spoken for has nothing left to answer,
  // so it leaves the worklist — but stays one tap away, because a pre-sale that falls
  // through is normal and lowering its count is how the pair comes back. In the URL so
  // a refresh keeps the tab.
  const [view, setView] = useQueryParam('view', 'work');

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
    for (const s of m.values()) {
      for (const sh of s.shoes.values()) sh.sizes.sort((a, b) => compareSizes(a.size, b.size));
      s.remaining = [...s.shoes.values()].flatMap((sh) => sh.sizes).reduce((n, r) => n + Number(r.remains), 0);
    }
    return [...m.values()];
  }, [rows]);
  const toWork = shipments.filter((s) => s.remaining > 0);
  const done = shipments.filter((s) => s.remaining < 1);
  const showDone = view === 'done';
  const shown = showDone ? done : toWork;

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

  // Free held pairs: the whole shipment, or one shoe of it. Same endpoint, same end
  // state — `reason` only decides what the unit's history says about why.
  async function doFree({ kind, ship, shoe }) {
    setConfirm(null); setBusy(true); setError('');
    try {
      const r = await api.presellRelease(ship.id, shoe
        ? { sku: shoe.sku, reason: kind === 'not_presell' ? 'not_presell' : null }
        : {});
      pulse('ok', `${r.released} pair${r.released === 1 ? '' : 's'} freed — the PH team picks them up on New Inventory.`);
      await load();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  }

  // The way back. Opening the picker fetches the shipment's shoes so the unheld ones can
  // be offered by name — nobody should have to type a style code to correct a tick.
  async function openHoldPick(ship) {
    setHoldPick({ ship, shoes: null }); setError('');
    try {
      const r = await api.presellShoes(ship.id);
      setHoldPick((h) => (h && h.ship.id === ship.id ? { ...h, shoes: r.shoes || [] } : h));
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); setHoldPick(null); }
  }

  async function hold(ship, shoe) {
    setHoldPick(null); setBusy(true); setError('');
    try {
      const r = await api.presellHold(ship.id, shoe.sku);
      pulse('ok', `${r.held} pair${r.held === 1 ? '' : 's'} of ${shoe.name || shoe.sku} held as pre-sell.`);
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
          already spoken for. Say how many of each size an order covers, then free the rest: that hands
          them to the PH team on <b>New Inventory</b> to price and list. A shoe that was never pre-sell
          can be freed on its own, and one that was missed can be put back.
        </p>
        {error && <div className="po-err">{error}</div>}
        <div className="scan-flash-live" role="status" aria-live="polite">
          {flash && <div className={`scan-flash ${flash.kind === 'err' ? 'dup' : 'added'}`}>{flash.text}</div>}
        </div>

        {/* Scan a 1ID to mark that exact pair, when you'd rather name it than count it. */}
        <form className="searchrow presell-scan" onSubmit={(e) => { e.preventDefault(); scanSold(scan); }}>
          {/* No `inputMode="none"` here, unlike the bench scan fields: this page is worked
              from a desk as often as a scanner, so typing a VIN has to stay possible. */}
          <input ref={scanRef} value={scan} autoCapitalize="characters" autoCorrect="off"
            placeholder="Scan a 1ID / VIN to mark that pair sold" onChange={(e) => setScan(e.target.value)} />
          <button className="btn primary" disabled={busy}>Mark sold</button>
        </form>

        {rows != null && shipments.length > 0 && (
          <div className="seg presell-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={!showDone} className={`seg-btn ${!showDone ? 'on' : ''}`}
              onClick={() => setView('work')}>To work<span className="seg-n">{toWork.length}</span></button>
            <button type="button" role="tab" aria-selected={showDone} className={`seg-btn ${showDone ? 'on' : ''}`}
              onClick={() => setView('done')}>Done<span className="seg-n">{done.length}</span></button>
          </div>
        )}

        {rows == null ? <p className="muted">Loading…</p>
          : shipments.length === 0 ? (
            <div className="card empty-state">
              No pre-sell shipments waiting. A shipment lands here when it is ticked
              <b> Pre-sell</b> at receiving.
            </div>
          ) : shown.length === 0 ? (
            <div className="card empty-state">
              {showDone
                ? 'No shipment is fully spoken for yet.'
                : <>Nothing to work — every pair on a pre-sell shipment is marked sold. Those shipments are under <b>Done</b>.</>}
            </div>
          ) : shown.map((ship) => {
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
                      {/* One shoe out of the hold, which whole-batch release cannot do:
                          freeing the fourteen marked in error would otherwise free the
                          one that is genuinely spoken for with them. */}
                      <button className="btn ghost sm presell-shoe-act" disabled={busy}
                        onClick={() => setConfirm({ kind: 'not_presell', ship, shoe: sh, n: sh.sizes.reduce((a, r) => a + Number(r.remains), 0) })}>
                        Not pre-sell
                      </button>
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
                  <button className="btn primary" disabled={busy || remaining < 1}
                    onClick={() => setConfirm({ kind: 'release', ship, n: remaining })}>
                    <Icon name="refresh" /> Free the {remaining} remaining for listing
                  </button>
                  {/* The mirror of "Not pre-sell". Under-holding is the expensive
                      direction: an unmarked pair reaches PH, gets listed, and can be
                      sold to a second buyer while the first order still stands. */}
                  <button className="btn ghost" disabled={busy} onClick={() => openHoldPick(ship)}>
                    ＋ Hold another shoe
                  </button>
                  {remaining < 1 && <span className="muted sm">Every pair is spoken for — nothing to send to the PH team. They leave through the normal scan-out; lower a count here if a sale falls through.</span>}
                </div>
              </div>
            );
          })}

        {confirm && (
          <Modal type="warn"
            title={confirm.kind === 'not_presell'
              ? `${confirm.shoe.name || confirm.shoe.sku} — not pre-sell?`
              : `Free ${confirm.n} pair${confirm.n === 1 ? '' : 's'} from ${confirm.ship.code}?`}
            message={confirm.kind === 'not_presell'
              ? `${confirm.n} pair${confirm.n === 1 ? '' : 's'} of this shoe stop being held and go to the PH team on New Inventory to price and list. The rest of ${confirm.ship.code} stays exactly as it is, and anything already marked sold stays put.`
              : 'They stop being pre-sell and land on New Inventory, where the PH team prices and lists them. Anything already marked sold stays put.'}
            onClose={() => setConfirm(null)}>
            <button className="btn primary" disabled={busy} onClick={() => doFree(confirm)}>
              {confirm.kind === 'not_presell' ? 'Free this shoe' : 'Free them'}
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </Modal>
        )}

        {holdPick && (
          <Modal type="warn" title={`Hold a shoe from ${holdPick.ship.code}`}
            message="Pick the shoe that was sold before it landed. Every pair of it still on our floor is held back from listing; pairs already sold or shipped are left alone."
            onClose={() => setHoldPick(null)}>
            <div className="presell-hold-pick">
              {holdPick.shoes === null ? <p className="muted sm">Loading the shipment…</p>
                : holdPick.shoes.filter((sh) => sh.free > 0).length === 0
                  ? <p className="muted sm">Every shoe on this shipment is already held.</p>
                  : holdPick.shoes.filter((sh) => sh.free > 0).map((sh) => (
                    <button className="btn ghost sm" key={sh.sku} disabled={busy} onClick={() => hold(holdPick.ship, sh)}>
                      <span>{sh.name || sh.sku} <span className="muted">— {sh.sku}</span></span>
                      <span className="muted sm">{sh.free} free{sh.held ? ` · ${sh.held} held` : ''}</span>
                    </button>
                  ))}
            </div>
            <button className="btn ghost" onClick={() => setHoldPick(null)}>Cancel</button>
          </Modal>
        )}
      </div>
    </div>
  );
}
