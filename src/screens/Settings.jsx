// App settings (admin / superadmin). Currently the price margin percent — the
// GI → Final markup applied across intake, GI refresh, and PH edits. Changing it
// is forward-only: new pricing uses the new %; existing Final prices update when
// their SKU is next refreshed / re-priced.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { setMarkupPct, getMarkupPct } from '../lib/config.js';

export function Settings({ onHome, onSignOut }) {
  const [pct, setPct] = useState(String(getMarkupPct()));
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings()
      .then((r) => { if (r?.priceMarkupPct != null) { setMarkupPct(r.priceMarkupPct); setPct(String(r.priceMarkupPct)); } })
      .catch((err) => { if (err.unauthorized) return onSignOut(); setError(err.message); })
      .finally(() => setLoaded(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e) {
    e.preventDefault();
    const n = Number(pct);
    if (!Number.isFinite(n) || n < 0 || n > 200) { setError('Enter a margin between 0 and 200%.'); return; }
    setBusy(true); setError(''); setSaved(false);
    try {
      const r = await api.setPriceMarkup(n);
      setMarkupPct(r.priceMarkupPct);
      setPct(String(r.priceMarkupPct));
      setSaved(true);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  const preview = Number.isFinite(Number(pct)) ? (100 * (1 + Number(pct) / 100)).toFixed(0) : '—';

  return (
    <div className="app">
      <TopBar title="Settings" onHome={onHome} onSignOut={onSignOut} />
      {error && <div className="error mt">{error}</div>}
      <div className="card settings-card">
        <h3 className="settings-h">Price margin</h3>
        <p className="muted sm">
          The markup applied to the Global Indicator to get the Final price
          (Final = GI + margin). Applies going forward — existing prices update when
          their SKU is next refreshed or re-priced.
        </p>
        <form onSubmit={save} className="settings-form">
          <label className="settings-field">
            <span>Margin %</span>
            <input
              type="number" inputMode="decimal" min="0" max="200" step="0.5"
              value={pct} disabled={!loaded || busy}
              onChange={(e) => { setPct(e.target.value); setSaved(false); }} autoFocus
            />
          </label>
          <p className="muted sm">Preview: GI $100 → Final <b>${preview}</b> (GI + {Number.isFinite(Number(pct)) ? Number(pct) : '—'}%)</p>
          <div className="settings-actions">
            <button className="btn primary" disabled={!loaded || busy}>{busy ? 'Saving…' : 'Save margin'}</button>
            {saved && <span className="settings-saved">✓ Saved</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
