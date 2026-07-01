// Locations — browse/manage shelf locations (warehouse + admin). Filter by
// warehouse / area / active / search; each shelf shows its live item count and
// expands to its contents. Add a single shelf, bulk-add a warehouse's bays, and
// rename / activate-deactivate. (Label printing lands in Phase 5.)
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, StatusPill } from '../components/common.jsx';
import { WAREHOUSES, LOCATION_AREAS } from '../lib/constants.js';

export function Locations({ onHome, onSignOut }) {
  const [warehouse, setWarehouse] = useState('');
  const [area, setArea] = useState('');
  const [active, setActive] = useState('');
  const [q, setQ] = useState('');
  const [locations, setLocations] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [contents, setContents] = useState({}); // id -> items | 'loading'
  const [editId, setEditId] = useState(null);
  const [editLabel, setEditLabel] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [pane, setPane] = useState(null); // 'add' | 'bulk' | null

  async function load() {
    setError('');
    try {
      const { locations: l } = await api.locationList({ warehouse, area, active, q });
      setLocations(l);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, [warehouse, area, active]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleContents(id) {
    if (contents[id]) { setContents((c) => { const n = { ...c }; delete n[id]; return n; }); return; }
    setContents((c) => ({ ...c, [id]: 'loading' }));
    try { const { items } = await api.locationItems(id); setContents((c) => ({ ...c, [id]: items || [] })); }
    catch (err) { if (err.unauthorized) return onSignOut(); setContents((c) => { const n = { ...c }; delete n[id]; return n; }); setError(err.message); }
  }
  async function saveLabel(loc) {
    const label = editLabel.trim();
    setBusyId(loc.id); setError('');
    try {
      const { location } = await api.locationUpdate(loc.id, { label });
      setLocations((ls) => ls.map((x) => (x.id === location.id ? { ...x, ...location } : x)));
      setEditId(null);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusyId(null); }
  }
  async function toggleActive(loc) {
    setBusyId(loc.id); setError('');
    try {
      const { location } = await api.locationUpdate(loc.id, { active: !loc.active });
      setLocations((ls) => ls.map((x) => (x.id === location.id ? { ...x, ...location } : x)));
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusyId(null); }
  }

  const list = locations || [];
  // Group by area (in listing order) for section headers.
  const groups = [];
  const seen = new Map();
  for (const l of list) {
    const key = `${l.warehouse}|${l.area || ''}`;
    if (!seen.has(key)) { const g = { warehouse: l.warehouse, area: l.area, rows: [] }; seen.set(key, g); groups.push(g); }
    seen.get(key).rows.push(l);
  }

  return (
    <div className="app app-wide">
      <TopBar title="Locations" onHome={onHome} onSignOut={onSignOut} />

      <div className="card">
        <div className="loc-filters">
          <label>Warehouse
            <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
              <option value="">All</option>
              {WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </label>
          <label>Area
            <select value={area} onChange={(e) => setArea(e.target.value)}>
              <option value="">All</option>
              {LOCATION_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label>Show
            <select value={active} onChange={(e) => setActive(e.target.value)}>
              <option value="">All</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </label>
          <form className="searchrow loc-search" onSubmit={(e) => { e.preventDefault(); load(); }}>
            <input placeholder="Search code / label / bay…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn primary">Search</button>
          </form>
          <span className="loc-add-btns">
            <button className={`btn sm ${pane === 'add' ? 'primary' : 'ghost'}`} onClick={() => setPane(pane === 'add' ? null : 'add')}>+ Add shelf</button>
            <button className={`btn sm ${pane === 'bulk' ? 'primary' : 'ghost'}`} onClick={() => setPane(pane === 'bulk' ? null : 'bulk')}>Bulk add</button>
          </span>
        </div>
        {pane === 'add' && <AddShelf onDone={(msg) => { setPane(null); setNotice(msg); load(); }} onError={setError} onSignOut={onSignOut} />}
        {pane === 'bulk' && <BulkAdd onDone={(msg) => { setPane(null); setNotice(msg); load(); }} onError={setError} onSignOut={onSignOut} />}
        {error && <div className="error mt">{error}</div>}
        {notice && <div className="notice mt">{notice}</div>}
      </div>

      <div className="card">
        {!locations ? <p className="muted">Loading…</p> : !list.length ? <p className="muted">No shelves match. Add one, or clear the filters.</p> : (
          <div className="loc-list">
            <div className="muted sm">{list.length} shelf location{list.length === 1 ? '' : 's'}</div>
            {groups.map((g) => (
              <div className="loc-group" key={`${g.warehouse}|${g.area || ''}`}>
                <div className="loc-group-head">{g.warehouse}{g.area ? ` · ${g.area}` : ''} <span className="muted">({g.rows.length})</span></div>
                {g.rows.map((loc) => {
                  const items = contents[loc.id];
                  const open = items !== undefined;
                  return (
                    <div className={`loc-row-wrap ${loc.active ? '' : 'inactive'}`} key={loc.id}>
                      <div className="loc-row">
                        <button className="loc-row-main" onClick={() => toggleContents(loc.id)} title="Show contents">
                          <span className="loc-caret">{open ? '▾' : '▸'}</span>
                          {editId === loc.id ? (
                            <input className="loc-label-edit" value={editLabel} autoFocus onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setEditLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveLabel(loc); } }} />
                          ) : (
                            <span className="loc-label">{loc.label || loc.code}</span>
                          )}
                          <span className="loc-code muted sm">{loc.code}</span>
                          <span className={`loc-count ${loc.item_count ? '' : 'zero'}`}>{loc.item_count} item{loc.item_count === 1 ? '' : 's'}</span>
                          {!loc.active && <span className="loc-inactive-badge">inactive</span>}
                        </button>
                        <span className="loc-row-actions">
                          {editId === loc.id ? (
                            <>
                              <button className="btn sm primary" disabled={busyId === loc.id} onClick={() => saveLabel(loc)}>Save</button>
                              <button className="btn sm ghost" onClick={() => setEditId(null)}>Cancel</button>
                            </>
                          ) : (
                            <>
                              <button className="btn sm ghost" onClick={() => { setEditId(loc.id); setEditLabel(loc.label || ''); }}>Rename</button>
                              <button className="btn sm ghost" disabled={busyId === loc.id} onClick={() => toggleActive(loc)}>{loc.active ? 'Deactivate' : 'Activate'}</button>
                            </>
                          )}
                        </span>
                      </div>
                      {open && (
                        <div className="loc-contents">
                          {items === 'loading' ? <span className="muted sm">Loading…</span>
                            : !items.length ? <span className="muted sm">Empty — nothing shelved here.</span>
                              : items.map((it) => (
                                <div className="loc-item" key={it.vin}>
                                  <span className="vin">{it.vin}</span>
                                  <span className="loc-item-name">{it.name || '—'}</span>
                                  <span className="muted sm">{it.sku || '—'} · {it.size ? `US ${it.size}` : '—'}</span>
                                  <StatusPill status={it.status} />
                                </div>
                              ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Add a single shelf ---------------------------------------------------
function AddShelf({ onDone, onError, onSignOut }) {
  const [warehouse, setWarehouse] = useState(WAREHOUSES[0]);
  const [area, setArea] = useState('');
  const [bay, setBay] = useState('');
  const [shelf, setShelf] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    onError('');
    if (!bay.trim()) { onError('Enter a bay.'); return; }
    setBusy(true);
    try {
      const { location } = await api.locationCreate({ warehouse, area: area || null, bay: bay.trim(), shelf: shelf === '' ? null : Number(shelf) });
      onDone(`Added ${location.label || location.code} (${location.code}).`);
      setBay(''); setShelf('');
    } catch (err) { if (err.unauthorized) return onSignOut(); onError(err.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="loc-pane">
      <div className="loc-pane-row">
        <label>Warehouse<select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>{WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}</select></label>
        <label>Area (optional)<select value={area} onChange={(e) => setArea(e.target.value)}><option value="">— none —</option>{LOCATION_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}</select></label>
        <label>Bay<input value={bay} onChange={(e) => setBay(e.target.value)} placeholder="e.g. A2 or Pod 1" autoCapitalize="characters" /></label>
        <label>Shelf #<input type="number" min="1" max="99" value={shelf} onChange={(e) => setShelf(e.target.value)} placeholder="blank = whole bay" /></label>
      </div>
      <div className="ph-edit-actions"><button className="btn sm primary" disabled={busy} onClick={submit}>{busy ? 'Adding…' : 'Add shelf'}</button></div>
    </div>
  );
}

// --- Bulk add a warehouse's bays ------------------------------------------
function BulkAdd({ onDone, onError, onSignOut }) {
  const [warehouse, setWarehouse] = useState(WAREHOUSES[0]);
  const [area, setArea] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  function parse(t) {
    return t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(.+?)[\s:,]+(\d+)\s*$/);
      return m ? { bay: m[1].trim(), shelves: Number(m[2]) } : { bay: l, shelves: 1 };
    });
  }
  async function submit() {
    onError('');
    const entries = parse(text);
    if (!entries.length) { onError('Add at least one bay (one per line).'); return; }
    setBusy(true);
    try {
      const { inserted, total } = await api.locationBulk({ warehouse, area: area || null, entries });
      onDone(`Added ${inserted} shelf location${inserted === 1 ? '' : 's'} (${total - inserted} already existed).`);
      setText('');
    } catch (err) { if (err.unauthorized) return onSignOut(); onError(err.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="loc-pane">
      <div className="loc-pane-row">
        <label>Warehouse<select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>{WAREHOUSES.map((w) => <option key={w} value={w}>{w}</option>)}</select></label>
        <label>Area (optional)<select value={area} onChange={(e) => setArea(e.target.value)}><option value="">— none —</option>{LOCATION_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}</select></label>
      </div>
      <label className="loc-bulk-text">Bays — one per line: <span className="muted">“A1 5” (bay + # shelves), “Pod 1 0” for a whole bay</span>
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'A1 5\nA2 5\nA3 3'} />
      </label>
      <div className="ph-edit-actions"><button className="btn sm primary" disabled={busy} onClick={submit}>{busy ? 'Adding…' : 'Add shelves'}</button></div>
    </div>
  );
}
