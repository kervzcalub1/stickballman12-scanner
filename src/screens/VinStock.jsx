// 1ID Stickers — mint and print blank pre-printed VIN stock, and see how many are left.
//
// The point of the whole thing: intake must never stop because a label printer won't
// cooperate. So the stickers are made in bulk ahead of time, off any printer, and the
// warehouse keeps a stack at each bench. Scan the shoe, scan the sticker, done.
//
// A print RUN is kept as a unit (`run_id`) for one reason — a roll that jams at label
// 700 of 1,000 has to be reprintable without minting 1,000 fresh numbers and throwing
// the first 700 away.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, RawVinLabelSheet } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { PH_DATETIME } from '../lib/format.js';

const MINT_SIZES = [100, 250, 500, 1000];
// Below this the warehouse should print more before the stack runs out mid-shift.
const LOW_STOCK = 200;

export function VinStock({ onHome, onSignOut }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [count, setCount] = useState(500);
  const [busy, setBusy] = useState(false);
  const [labels, setLabels] = useState(null); // vins queued for the print dialog
  const [voidInput, setVoidInput] = useState('');

  async function load() {
    setError('');
    try { setSummary(await api.vinStock()); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Mint, then open the print dialog straight away with what was just minted. The two
  // are one action in the warehouse's head — a minted sticker that never got printed
  // is a gap in the stack nobody can explain later.
  async function mint() {
    const n = Number(count) || 0;
    if (n < 1 || n > 2000) { setError('Choose between 1 and 2000 stickers.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const { runId, vins } = await api.mintVins(n);
      setNotice(`Run ${runId} — ${vins.length} stickers minted, ${vins[0]} to ${vins[vins.length - 1]}.`);
      setLabels(vins);
      load();
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setError(err.message);
    } finally { setBusy(false); }
  }

  async function reprint(runId) {
    setError('');
    try {
      const { vins } = await api.vinRun(runId);
      // Only the ones still unused — reprinting a sticker that's already on a shoe
      // would put a duplicate number back into the stack.
      const usable = vins.filter((v) => v.status === 'available').map((v) => v.vin);
      if (!usable.length) { setError(`Every sticker in run ${runId} is already used or voided.`); return; }
      setLabels(usable);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }

  async function voidStickers() {
    const vins = voidInput.split(/[\s,]+/).map((v) => v.trim().toUpperCase()).filter(Boolean);
    if (!vins.length) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { voided } = await api.voidVins(vins);
      const missed = vins.filter((v) => !voided.includes(v));
      setNotice(`${voided.length} sticker${voided.length === 1 ? '' : 's'} voided${missed.length ? ` — ${missed.length} skipped (already on a shoe, or not ours): ${missed.slice(0, 5).join(', ')}` : ''}.`);
      setVoidInput('');
      load();
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  const c = summary?.counts;
  const low = c && c.available < LOW_STOCK;

  return (
    <div className="app">
      <TopBar title="1ID Stickers" onHome={onHome} onSignOut={onSignOut} />

      <div className="card">
        <p className="muted sm">
          Pre-printed stickers for intake. Print a stack, keep it at the bench, and scan
          one onto each pair — no printer, no Wi-Fi, no waiting. Turn it on per person
          under <b>Preferences → Raw 1ID stickers</b> on the Receiving screen.
        </p>

        {loading ? <div className="muted mt">Loading…</div> : (
          <div className={`vs-counts ${low ? 'low' : ''}`}>
            <div className="vs-count big">
              <span className="vs-n">{c?.available ?? 0}</span>
              <span className="muted sm">unused, ready to stick</span>
            </div>
            <div className="vs-count"><span className="vs-n">{c?.assigned ?? 0}</span><span className="muted sm">on a shoe</span></div>
            <div className="vs-count"><span className="vs-n">{c?.void ?? 0}</span><span className="muted sm">voided</span></div>
          </div>
        )}
        {low && (
          <p className="vs-low">
            Under {LOW_STOCK} left — print more before the stack runs out mid-shift.
          </p>
        )}

        {error && <div className="error mt">{error}</div>}
        {notice && <div className="notice mt">{notice}</div>}

        <h3 className="rows-title mt">Print more</h3>
        <div className="vs-mint">
          {MINT_SIZES.map((n) => (
            <button key={n} type="button" className={`btn sm ${Number(count) === n ? 'primary' : 'ghost'}`}
              onClick={() => setCount(n)}>{n}</button>
          ))}
          <input type="number" min={1} max={2000} value={count} aria-label="How many stickers"
            onChange={(e) => setCount(e.target.value)} />
          <button className="btn primary" disabled={busy} onClick={mint}>
            <Icon name="print" /> {busy ? 'Minting…' : `Mint & print ${Number(count) || 0}`}
          </button>
        </div>
        <p className="muted xs">
          Each sticker gets its own number the moment it's minted, so two people printing
          at the same time can never produce the same one.
        </p>
      </div>

      <div className="card">
        <h3 className="rows-title">Print runs</h3>
        {!summary?.runs?.length ? <p className="muted">Nothing minted yet.</p> : (
          <div className="inv-tablewrap">
            <table className="inv-table">
              <thead>
                <tr><th>Run</th><th>Printed</th><th>By</th><th>Range</th><th>Unused</th><th /></tr>
              </thead>
              <tbody>
                {summary.runs.map((r) => (
                  <tr key={r.run_id}>
                    <td>#{r.run_id}</td>
                    <td className="sm">{r.printed_at ? PH_DATETIME.format(new Date(r.printed_at)) : '—'}</td>
                    <td className="sm">{r.printed_by || '—'}</td>
                    <td className="mono sm">{r.first_vin} – {r.last_vin}</td>
                    <td>{r.available} <span className="muted sm">of {r.total}</span></td>
                    <td>
                      <button className="btn sm ghost" disabled={!r.available}
                        title={r.available ? 'Reprint the unused stickers from this run' : 'Nothing left unused in this run'}
                        onClick={() => reprint(r.run_id)}>
                        Reprint
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="rows-title">Void a sticker</h3>
        <p className="muted sm">
          Torn, lost or misprinted. A voided number is never reused — gaps in the run are
          fine, a number on two shoes is not. One already on a shoe can't be voided here.
        </p>
        <div className="vs-void">
          <input value={voidInput} placeholder="SBM-R-000123  SBM-R-000124" aria-label="Stickers to void"
            onChange={(e) => setVoidInput(e.target.value)} />
          <button className="btn ghost danger" disabled={busy || !voidInput.trim()} onClick={voidStickers}>Void</button>
        </div>
      </div>

      {labels && <RawVinLabelSheet vins={labels} onClose={() => setLabels(null)} />}
    </div>
  );
}
