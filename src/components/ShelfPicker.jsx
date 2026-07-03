// Hierarchical shelf picker — a "mini Locations" browser for choosing a shelf
// without scanning. Search by code/label for the quick path, or drill down
// Site → Area → Bay → Shelf. Calls onPick(code) with the chosen location code.
// Used by the Shelve page's "pick from list" put-away flow (scanning still works
// too). Only ACTIVE locations are offered.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';

const uniq = (arr) => [...new Set(arr)];

export function ShelfPicker({ onPick, onClose }) {
  const [locs, setLocs] = useState(null);
  const [error, setError] = useState('');
  const [wh, setWh] = useState(null);
  const [area, setArea] = useState(null);
  const [bay, setBay] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.locationList({ active: true })
      .then(({ locations }) => { if (!cancelled) setLocs(locations || []); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Could not load shelves.'); });
    return () => { cancelled = true; };
  }, []);

  const all = locs || [];
  const query = q.trim().toLowerCase();
  const hits = query
    ? all.filter((l) => `${l.code} ${l.label || ''}`.toLowerCase().includes(query)).slice(0, 80)
    : null;

  // Drill-down levels derived from the flat list.
  const warehouses = useMemo(() => uniq(all.map((l) => l.warehouse).filter(Boolean)).sort(), [all]);
  const inWh = useMemo(() => all.filter((l) => l.warehouse === wh), [all, wh]);
  const areas = useMemo(() => uniq(inWh.map((l) => l.area).filter(Boolean)).sort(), [inWh]);
  const inArea = useMemo(() => inWh.filter((l) => l.area === area), [inWh, area]);
  const bays = useMemo(() => uniq(inArea.map((l) => l.bay).filter((b) => b != null && b !== '')).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })), [inArea]);
  // Locations in this area that have no bay are leaves right here (e.g. pods).
  const areaLeaves = useMemo(() => inArea.filter((l) => l.bay == null || l.bay === ''), [inArea]);
  const shelves = useMemo(() => inArea.filter((l) => String(l.bay ?? '') === String(bay ?? '')), [inArea, bay]);

  const back = () => { if (bay != null) setBay(null); else if (area != null) setArea(null); else if (wh != null) setWh(null); };
  const crumb = [wh, area, bay != null ? `Bay ${bay}` : null].filter(Boolean).join(' › ');

  const Tile = ({ onClick, icon, name, sub, count }) => (
    <button type="button" className="sp-tile" onClick={onClick}>
      <span className="sp-tile-ic"><Icon name={icon} /></span>
      <span className="sp-tile-main"><span className="sp-tile-name">{name}</span>{sub ? <span className="sp-tile-sub">{sub}</span> : null}</span>
      {count != null ? <span className="sp-tile-count">{count}</span> : <span className="sp-caret">▸</span>}
    </button>
  );
  const ShelfTile = ({ l }) => (
    <button type="button" className="sp-tile shelf" onClick={() => onPick(l.code)}>
      <span className="sp-tile-ic"><Icon name="shelve" /></span>
      <span className="sp-tile-main"><span className="sp-tile-name">{l.label || l.code}</span><span className="sp-tile-sub mono">{l.code}</span></span>
      <span className="sp-tile-count">{l.item_count} here</span>
    </button>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal sp-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sp-head">
          <h3 className="modal-title">Pick a shelf</h3>
          <button type="button" className="btn icon ghost" onClick={onClose} aria-label="Close">×</button>
        </div>
        <input className="sp-search" placeholder="Search shelf code or name (e.g. A2-04)…" autoFocus
          value={q} onChange={(e) => setQ(e.target.value)} />
        {error && <div className="error sm mt">{error}</div>}

        {locs == null ? <p className="muted mt">Loading shelves…</p> : query ? (
          <div className="sp-list">
            {!hits.length ? <p className="muted">No shelf matches “{q}”.</p>
              : hits.map((l) => <ShelfTile l={l} key={l.id} />)}
          </div>
        ) : (
          <>
            {crumb && (
              <div className="sp-crumbs">
                <button type="button" className="btn sm ghost" onClick={back}>← Back</button>
                <span className="muted sm">{crumb}</span>
              </div>
            )}
            <div className="sp-list">
              {wh == null && warehouses.map((w) => (
                <Tile key={w} icon="locations" name={w} onClick={() => setWh(w)} />
              ))}
              {wh != null && area == null && areas.map((a) => (
                <Tile key={a} icon="locations" name={a} onClick={() => setArea(a)} />
              ))}
              {wh != null && area != null && bay == null && (
                <>
                  {bays.map((b) => <Tile key={b} icon="batches" name={`Bay ${b}`} onClick={() => setBay(b)} />)}
                  {areaLeaves.map((l) => <ShelfTile l={l} key={l.id} />)}
                  {!bays.length && !areaLeaves.length && <p className="muted">No shelves here.</p>}
                </>
              )}
              {wh != null && area != null && bay != null && (
                shelves.length ? shelves.map((l) => <ShelfTile l={l} key={l.id} />) : <p className="muted">No shelves in this bay.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
