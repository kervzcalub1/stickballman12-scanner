// App settings (admin / superadmin):
//  • the price margin percent — the GI → Final markup applied across intake, GI
//    refresh, and PH edits. Forward-only: new pricing uses the new %; existing Final
//    prices update when their SKU is next refreshed / re-priced.
//  • the ship-to address — where suppliers send their boxes. Read by every signed-in
//    user (suppliers see it on their order, and it prints as the SHIP TO block on the
//    manifest), so changing it here changes both at once.
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
  const [repriced, setRepriced] = useState(null); // # unlisted items re-priced on the last save
  const BLANK_SHIP_TO = { name: '', street: '', city: '', state: '', zip: '', phone: '', email: '' };
  const [shipTo, setShipTo] = useState(BLANK_SHIP_TO);
  const [shipBusy, setShipBusy] = useState(false);
  const [shipSaved, setShipSaved] = useState(false);
  const [shipError, setShipError] = useState('');

  useEffect(() => {
    api.getSettings()
      .then((r) => {
        if (r?.priceMarkupPct != null) { setMarkupPct(r.priceMarkupPct); setPct(String(r.priceMarkupPct)); }
        if (r?.shipTo) setShipTo({ ...BLANK_SHIP_TO, ...r.shipTo });
      })
      .catch((err) => { if (err.unauthorized) return onSignOut(); setError(err.message); })
      .finally(() => setLoaded(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveShipTo(e) {
    e.preventDefault();
    setShipBusy(true); setShipError(''); setShipSaved(false);
    try {
      const r = await api.setShipTo(shipTo);
      if (r?.shipTo) setShipTo({ ...BLANK_SHIP_TO, ...r.shipTo });
      setShipSaved(true);
    } catch (err) { if (err.unauthorized) return onSignOut(); setShipError(err.message); }
    finally { setShipBusy(false); }
  }
  const shipField = (k) => ({
    value: shipTo[k] ?? '',
    disabled: !loaded || shipBusy,
    onChange: (e) => { setShipTo((s) => ({ ...s, [k]: e.target.value })); setShipSaved(false); },
  });

  async function save(e) {
    e.preventDefault();
    const n = Number(pct);
    if (!Number.isFinite(n) || n < 0 || n > 200) { setError('Enter a margin between 0 and 200%.'); return; }
    setBusy(true); setError(''); setSaved(false); setRepriced(null);
    try {
      const r = await api.setPriceMarkup(n);
      setMarkupPct(r.priceMarkupPct);
      setPct(String(r.priceMarkupPct));
      setSaved(true);
      setRepriced(r.repriced ?? null);
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
          (Final = GI + margin). Changing it immediately re-prices items that aren’t
          listed yet (off Intelligent Inventory and every store), preserving manual
          price overrides. Already-listed items keep their price until re-priced.
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
            {saved && <span className="settings-saved">✓ Saved{repriced != null ? ` — re-priced ${repriced} unlisted item${repriced === 1 ? '' : 's'}` : ''}</span>}
          </div>
        </form>
      </div>

      <div className="card settings-card">
        <h3 className="settings-h">Shipping address</h3>
        <p className="muted sm">
          Where suppliers send their boxes. It shows on their order in the supplier portal
          and prints as the <b>SHIP TO</b> block on every page of the manifest, so a sheet
          separated from the rest still says where the box is going.
        </p>
        {shipError && <div className="error mt">{shipError}</div>}
        <form onSubmit={saveShipTo} className="settings-form">
          <label className="settings-field"><span>Name</span><input {...shipField('name')} /></label>
          <label className="settings-field"><span>Street</span><input {...shipField('street')} /></label>
          <div className="settings-row">
            <label className="settings-field"><span>City</span><input {...shipField('city')} /></label>
            <label className="settings-field sm"><span>State</span><input maxLength={2} {...shipField('state')} /></label>
            <label className="settings-field sm"><span>ZIP</span><input inputMode="numeric" {...shipField('zip')} /></label>
          </div>
          <div className="settings-row">
            <label className="settings-field"><span>Phone</span><input inputMode="tel" {...shipField('phone')} /></label>
            <label className="settings-field"><span>Email</span><input inputMode="email" {...shipField('email')} /></label>
          </div>
          <div className="settings-actions">
            <button className="btn primary" disabled={!loaded || shipBusy}>{shipBusy ? 'Saving…' : 'Save address'}</button>
            {shipSaved && <span className="settings-saved">✓ Saved</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
