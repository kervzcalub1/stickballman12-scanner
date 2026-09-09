// Packing the receipt into boxes — the step that turns a receipt into a per-box manifest.
//
// The old order carried ONE list for the whole purchase, which could tell the warehouse
// what the purchase contained and never what THIS carton should contain. A short box was
// only ever discoverable as a short order. Now every pair goes into a specific label, so
// a receiver checks one printed sheet against one carton and a shortage is located on
// the day it lands: not "the order is one pair short" but "box 2 is one 8.5W short".
//
// The screen is a COUNTDOWN, not a form. The buyer is standing over an open carton with
// a phone in one hand, so the only question it asks is "which box is this going in", and
// the only thing it shows is what is still loose. A pair that cannot be packed is one the
// receipt does not have — the server refuses it, and says which pair it was looking for.
import React, { useState } from 'react';
import { api } from '../api.js';

const BOX_STATE = {
  pending: 'Filling',
  packed: 'Closed for shipment',
  pre_transit: 'Label made',
  shipped: 'Shipped',
  in_transit: 'In transit',
  delivered: 'Delivered',
};

export function BuyCartPack({ cart, canPack, onChanged, onSignOut }) {
  const pack = cart.pack;
  const [box, setBox] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  if (!pack || !pack.poId) return null;

  // Only a box still filling can take stock. A closed box's manifest is the sheet that
  // was printed and taped inside it; editing it silently would invalidate that sheet.
  const fillable = (pack.boxes || []).filter((b) => b.status === 'pending');
  const active = fillable.find((b) => b.id === box) || fillable[0] || null;

  async function move(row, qty) {
    if (!active) return;
    setBusy(`${row.sku}|${row.size}|${qty}`); setErr('');
    try { await api.cartPack(cart.id, active.id, row.sku, row.size || '', qty); await onChanged(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  const done = pack.unpacked === 0 && pack.totalQty > 0;

  return (
    <section className="card bc-pack">
      <h3 className="bc-h">
        Packing <span className="muted sm">{pack.totalPacked} of {pack.totalQty} pairs in a box</span>
      </h3>

      {/* The number that decides whether this order can ship at all. Under a per-box
          manifest an unpacked pair is not counted as expected by anything downstream —
          it is absent from the arithmetic, not short in it. */}
      <div className={`bc-pack-bar ${done ? 'ok' : ''}`}>
        <div className="bc-pack-fill" style={{ width: `${pack.totalQty ? Math.round((pack.totalPacked / pack.totalQty) * 100) : 0}%` }} />
      </div>
      <p className={done ? 'bc-covered sm' : 'muted sm'}>
        {done
          ? 'Every pair on the receipt is in a box. The order can ship.'
          : `${pack.unpacked} pair${pack.unpacked === 1 ? '' : 's'} still loose — the last box can’t ship until they are packed.`}
        {pack.overPacked > 0 && (
          <span className="bc-short"> · {pack.overPacked} more packed than the receipt covers.</span>
        )}
      </p>

      {fillable.length > 1 && (
        <div className="bc-pack-boxes" role="group" aria-label="Which box">
          {fillable.map((b) => (
            <button key={b.id} type="button"
              className={`btn sm ${active && active.id === b.id ? 'primary' : 'ghost'}`}
              onClick={() => setBox(b.id)}>
              Box {b.box_number ?? b.id} <span className="muted xs">{b.units}</span>
            </button>
          ))}
        </div>
      )}

      {canPack && !active && (
        <p className="muted sm">
          Every box is closed for shipment. Reopen one on the order, or add a label, to pack anything else.
        </p>
      )}

      {(pack.rows || []).length > 0 && (
        <div className="bc-scroll">
          <table className="table bc-table">
            <thead>
              <tr>
                <th>Pair</th><th>Size</th>
                <th className="num">On the receipt</th><th className="num">Packed</th><th className="num">Left</th>
                {canPack && active && <th>Into box {active.box_number ?? active.id}</th>}
              </tr>
            </thead>
            <tbody>
              {pack.rows.map((r) => (
                <tr key={`${r.sku}|${r.size}`} className={r.remaining === 0 ? 'bc-line approved' : 'bc-line'}>
                  <td><b>{r.sku}</b>{r.name && <div className="muted xs">{r.name}</div>}</td>
                  <td>{r.size || '—'}</td>
                  <td className="num">{r.qty}</td>
                  <td className="num">{r.packed}</td>
                  <td className="num">{r.remaining === 0 ? <span className="bc-covered">✓</span> : r.remaining}</td>
                  {canPack && active && (
                    <td className="bc-pack-actions">
                      <button type="button" className="btn sm" disabled={!!busy || r.remaining === 0}
                        onClick={() => move(r, 1)} aria-label={`Pack one ${r.sku} ${r.size || ''}`}>+1</button>
                      {r.remaining > 1 && (
                        <button type="button" className="btn sm ghost" disabled={!!busy}
                          onClick={() => move(r, r.remaining)}>+{r.remaining}</button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* What is actually in each carton, which is what gets printed and taped inside it.
          Shown for closed and shipped boxes too — after the fact this is the only record
          of what the buyer said was in a box somebody is now opening. */}
      <ul className="bc-pack-list">
        {(pack.boxes || []).map((b) => (
          <li key={b.id}>
            <div className="bc-pack-box-head">
              <b>Box {b.box_number ?? b.id}</b>
              <span className={`po-chip ${b.status === 'pending' ? 'warn' : 'shipped'}`}>{BOX_STATE[b.status] || b.status}</span>
              <span className="muted sm">{b.units} pair{b.units === 1 ? '' : 's'}</span>
              {b.tracking_number && <span className="muted xs">{b.tracking_number}</span>}
            </div>
            {b.lines.length === 0 && <p className="muted xs">Empty.</p>}
            {b.lines.map((l) => (
              <div key={l.id} className="bc-pack-line">
                <span>{l.sku}{l.size ? ` · ${l.size}` : ''}</span>
                <span className="num">×{l.qty_expected}</span>
                {canPack && b.status === 'pending' && (
                  <button type="button" className="btn sm ghost" disabled={!!busy}
                    onClick={() => move({ sku: l.sku, size: l.size }, -1)}
                    aria-label={`Take one ${l.sku} out of box ${b.box_number ?? b.id}`}>−1</button>
                )}
              </div>
            ))}
          </li>
        ))}
      </ul>

      {err && <div className="error mt">{err}</div>}
    </section>
  );
}
