// "Fill costs from POs" — the Costs page's bulk half, admin only.
//
// A pair's cost is written once, at receiving, and only on a receive against the PO; a
// pair received before its PO carried a shelf price never got one. This works the landed
// cost out from the PO the way receiving would (api/items/cost-backfill.js) — and it is a
// two-step on purpose: CHECK says exactly what it would write and what it can't reach,
// FILL writes it. Nothing is written by opening the page.
import React, { useState } from 'react';
import { api } from '../api.js';

export function CostBackfill({ onDone, onSignOut }) {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);

  async function check() {
    setBusy('check'); setErr(''); setDone(null);
    try { setPlan((await api.costBackfillPreview()).plan); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }
  async function fill() {
    setBusy('fill'); setErr('');
    try {
      const r = await api.costBackfillApply();
      setDone(r.filled); setPlan(null);
      onDone?.();
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(''); }
  }

  return (
    <div className="cost-backfill">
      <div className="cost-backfill-h">
        <b>Fill costs from POs</b>
        <span className="muted sm">Pairs with no cost whose PO carries a shelf price for their size — landed through the supplier’s preset, the way receiving does it.</span>
        {!plan && (
          <button type="button" className="btn sm" disabled={!!busy} onClick={check}>
            {busy === 'check' ? 'Checking…' : 'Check what can be filled'}
          </button>
        )}
      </div>
      {done != null && <div className="ok sm">Filled {done} pair{done === 1 ? '' : 's'} from their POs. Each pair’s history says which PO and how.</div>}
      {plan && (
        <div className="cost-backfill-plan">
          <p className="sm">
            <b>{plan.fillable}</b> pair{plan.fillable === 1 ? '' : 's'} can be filled
            {plan.byPo.length ? <> from {plan.byPo.length} PO{plan.byPo.length === 1 ? '' : 's'}</> : null}.
            {' '}<span className="muted">Pairs that already have a cost — or are recorded as $0 — are not touched.</span>
          </p>
          {plan.byPo.length > 0 && (
            <ul className="cost-backfill-list sm">
              {plan.byPo.map((p) => (
                <li key={p.poCode}>
                  <b>{p.poCode}</b> · {p.pairs} pair{p.pairs === 1 ? '' : 's'} · preset “{p.preset}”
                </li>
              ))}
            </ul>
          )}
          {plan.noPresetPairs > 0 && (
            <div className="sm">
              <span className="bc-short"><b>{plan.noPresetPairs}</b> pair{plan.noPresetPairs === 1 ? '' : 's'} skipped — the supplier has no cost preset</span>
              {' '}<span className="muted">The PO price is only the shelf price; the actual cost is shelf + the supplier’s preset. Link one (Payout Calculator → presets → “Receiving supplier”), then check again.</span>
              <ul className="cost-backfill-list">
                {plan.noPreset.slice(0, 8).map((p) => (
                  <li key={`${p.poCode}|${p.supplier}`}><b>{p.poCode}</b> · {p.supplier || 'no supplier name'} · {p.pairs} pair{p.pairs === 1 ? '' : 's'}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted sm">
            Can’t be filled: <b>{plan.noLine}</b> on a PO with no shelf price for that SKU + size
            {plan.noLineSample.length > 0 && <> (most: {plan.noLineSample.slice(0, 5).map((x) => `${x.what} ×${x.pairs}`).join(', ')})</>}
            {' '}· <b>{plan.noPo}</b> received without a PO — type those below.
          </p>
          <div className="cost-backfill-actions">
            <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => setPlan(null)}>Cancel</button>
            <button type="button" className="btn sm primary" disabled={!!busy || !plan.fillable} onClick={fill}>
              {busy === 'fill' ? 'Filling…' : `Fill ${plan.fillable} cost${plan.fillable === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
      {err && <div className="error sm">{err}</div>}
    </div>
  );
}
