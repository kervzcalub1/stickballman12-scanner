// Locations — browse/manage shelf locations (warehouse + admin) as a drill-down
// tile view, like a desktop file manager. Each level (Site → Area → Row → Bay →
// Shelf) is a full-width grid of tiles that wraps to fit any screen (no columns,
// no horizontal scroll); clicking a tile drills in and pushes a real URL segment
// (/locations/manheim-main-shed/warehouse-rows/a/a2/4), so refresh + browser Back
// work. The final level (a shelf, or a whole-bay pod) shows the shoes stored
// there. Add / bulk-add, delete, activate-deactivate and bulk label printing all still live
// here — plus **edit at every level**: each tile has a pencil, which for a folder (site /
// area / row / bay) rewrites every shelf underneath it, because those levels are the shelves'
// distinct warehouse/area/bay values rather than rows of their own. See EditGroupModal.
import React, { useEffect, useState, lazy, Suspense } from 'react';
import { api } from '../api.js';
import { TopBar, StatusPill, ShelfLabelSheet, ShoeThumb, PhotoLightbox, Modal } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { WAREHOUSES, LOCATION_AREAS } from '../lib/constants.js';
import { useAutoAnimate } from '@formkit/auto-animate/react';

// Lazy-loaded so the barcode library only downloads when the camera is opened.
const CameraScanner = lazy(() => import('../components/CameraScanner.jsx'));

const NO_AREA = '(no area)';
// URL-safe slug of a name/label; unique within a level so it round-trips cleanly.
const slug = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const segsFromPath = () => window.location.pathname.replace(/^\/locations\/?/, '').split('/').map(decodeURIComponent).filter(Boolean).map((s) => s.toLowerCase());
const pathFromSegs = (segs) => '/locations' + segs.map((s) => `/${s}`).join('');

// Small line-glyphs for the tiles, matching the app's Feather-style icon set.
function TileGlyph({ kind }) {
  const p = { width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (kind === 'site') return <svg {...p}><path d="M3 21V8l9-5 9 5v13" /><path d="M9 21v-6h6v6" /></svg>;
  if (kind === 'bay') return <svg {...p}><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></svg>;
  if (kind === 'shelf') return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14h18" /></svg>;
  return <svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>; // folder (area / row)
}

// Walk the tree by URL slugs → the resolved position + a breadcrumb trail.
function resolve(sites, segs, multiSite) {
  const siteList = [...sites.keys()];
  const r = { level: 'sites', trail: [], base: [], site: null, S: null, area: null, A: null, grouped: false, row: null, R: null, bay: null, B: null, wholeBay: false, shelfId: null, shelfObj: null };
  const push = (label, s) => r.trail.push({ label, segs: [...s] });
  push(multiSite ? 'All sites' : (siteList[0] || 'Locations'), []);
  let i = 0; let acc = [];

  if (multiSite) {
    const site = segs[i] != null ? siteList.find((s) => slug(s) === segs[i]) : null;
    if (!site) { r.base = acc; return r; }
    r.site = site; r.S = sites.get(site); acc = [slug(site)]; i++; push(site, acc);
  } else {
    if (!siteList.length) return r;
    r.site = siteList[0]; r.S = sites.get(r.site);
  }

  const areaVals = [...r.S.areas.values()];
  const A = segs[i] != null ? areaVals.find((a) => slug(a.name) === segs[i]) : null;
  if (!A) { r.level = 'areas'; r.base = acc; return r; }
  r.area = A.key; r.A = A; r.grouped = !!A.grouped; acc = [...acc, slug(A.name)]; i++; push(A.name, acc);

  let bayVals;
  if (r.grouped) {
    const R = segs[i] != null ? [...A.rows.values()].find((x) => slug(x.name) === segs[i]) : null;
    if (!R) { r.level = 'rows'; r.base = acc; return r; }
    r.row = R.name; r.R = R; acc = [...acc, slug(R.name)]; i++; push(`Row ${R.name}`, acc);
    bayVals = R.bays;
  } else bayVals = [...A.bays.values()];

  const B = segs[i] != null ? bayVals.find((b) => slug(b.name) === segs[i]) : null;
  if (!B) { r.level = 'bays'; r.base = acc; return r; }
  r.bay = B.name; r.B = B; acc = [...acc, slug(B.name)]; i++; push(B.name, acc);

  // A whole-bay pod is a single location with no shelf → its tile holds the shoes.
  if (B.shelves.length === 1 && B.shelves[0].shelf == null) {
    r.level = 'shelf'; r.wholeBay = true; r.shelfId = B.shelves[0].id; r.shelfObj = B.shelves[0]; r.base = acc; return r;
  }
  const sh = segs[i] != null ? B.shelves.find((x) => String(x.shelf) === segs[i] || slug(x.label || x.code) === segs[i]) : null;
  if (!sh) { r.level = 'shelves'; r.base = acc; return r; }
  acc = [...acc, String(sh.shelf)]; push(sh.label || sh.code, acc);
  r.level = 'shelf'; r.shelfId = sh.id; r.shelfObj = sh; r.base = acc; return r;
}

export function Locations({ onHome, onSignOut }) {
  const [active, setActive] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);     // shoe-search hits | null (browse mode)
  const [searchedFor, setSearchedFor] = useState('');
  const [expandedSkus, setExpandedSkus] = useState(() => new Set()); // which result groups are open
  const toggleSku = (k) => setExpandedSkus((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const [showCam, setShowCam] = useState(false);
  const [camZoom, setCamZoom] = useState(1);
  const [locations, setLocations] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pane, setPane] = useState(null);          // 'add' | 'bulk' | null
  const [sel, setSel] = useState(() => new Set());  // selected shelf ids (for printing)
  const [printLocs, setPrintLocs] = useState(null);
  const [siteAreas, setSiteAreas] = useState({});
  const [segs, setSegs] = useState(segsFromPath);   // current drill path (URL truth)
  const [resultsRef] = useAutoAnimate(); // search hits ease in
  const [tilesRef] = useAutoAnimate();   // tiles reflow as you drill in/out
  const [contents, setContents] = useState(null);   // shoes on the open shelf | 'loading' | null
  const [editShelf, setEditShelf] = useState(null); // the location row being edited | null
  const [editGroup, setEditGroup] = useState(null); // { kind, name, label, match, shelves } | null
  const [delShelf, setDelShelf] = useState(null);   // the location row queued for deletion | null
  const [delBusy, setDelBusy] = useState(false);
  const [pendingNav, setPendingNav] = useState(null); // location id to re-open once the list reloads
  const [busy, setBusy] = useState(false);
  const [lightbox, setLightbox] = useState(null); // urls[] to enlarge, or null

  // Tap a thumbnail → enlarge: the SKU's listing photos if any, else the catalog image.
  async function openThumb(it) {
    try {
      const { photos } = await api.photoList(it.sku);
      const urls = (photos || []).map((p) => p.url).filter(Boolean);
      setLightbox(urls.length ? urls : (it.photo_url ? [it.photo_url] : null));
    } catch { setLightbox(it.photo_url ? [it.photo_url] : null); }
  }

  // Navigate to a level: update state + push a real URL so Back/refresh work.
  const navigate = (newSegs, { replace = false } = {}) => {
    setSegs(newSegs); setEditShelf(null);
    const path = pathFromSegs(newSegs);
    if (window.location.pathname !== path) window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
  };
  useEffect(() => {
    const onPop = () => setSegs(segsFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  async function load() {
    setError('');
    try {
      const { locations: l } = await api.locationList({ active });
      setLocations(l);
      setSiteAreas((prev) => {
        const next = { ...prev };
        for (const loc of l) {
          if (!loc.area) continue;
          const arr = next[loc.warehouse] ? [...next[loc.warehouse]] : [];
          if (!arr.includes(loc.area)) { arr.push(loc.area); next[loc.warehouse] = arr; }
        }
        return next;
      });
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  useEffect(() => { load(); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Locate a shoe: search items by name / SKU / VIN → which shelf each is on.
  async function runLocate(query) {
    const term = query.trim();
    if (!term) { setResults(null); setSearchedFor(''); return; }
    setError('');
    try {
      const { rows } = await api.itemsQuery({ q: term });
      setResults(rows || []); setSearchedFor(term); setExpandedSkus(new Set());
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  // A camera scan (VIN CODE128 or UPC/EAN) → locate it. queryItems matches vin/upc.
  function routeScan(code) {
    const c = String(code || '').trim();
    setShowCam(false); setQ(c); runLocate(c);
  }

  const list = locations || [];

  // --- Build Site → Area → (Row) → Bay → Shelf tree (list arrives pre-sorted) --
  // Seed every official site first so the view always starts at the Site level
  // (Site → Area → Bay → Shelf) and each site shows as a tile even before it has
  // any shelves — so a new/empty site (Mount Joy, Kready's Farm) is visible and
  // you can drill in to add to it. DB rows merge in below; a custom site that
  // only exists in data (not in WAREHOUSES) still appears via the row loop.
  const sites = new Map();
  for (const w of WAREHOUSES) sites.set(w, { name: w, count: 0, ids: [], areas: new Map() });
  for (const l of list) {
    if (!sites.has(l.warehouse)) sites.set(l.warehouse, { name: l.warehouse, count: 0, ids: [], areas: new Map() });
    const S = sites.get(l.warehouse); S.count += l.item_count || 0; S.ids.push(l.id);
    const ak = l.area || '';
    if (!S.areas.has(ak)) S.areas.set(ak, { key: ak, name: ak || NO_AREA, count: 0, ids: [], bays: new Map() });
    const A = S.areas.get(ak); A.count += l.item_count || 0; A.ids.push(l.id);
    if (!A.bays.has(l.bay)) A.bays.set(l.bay, { name: l.bay, count: 0, ids: [], shelves: [] });
    const B = A.bays.get(l.bay); B.count += l.item_count || 0; B.ids.push(l.id); B.shelves.push(l);
  }
  // Adaptive Row/aisle grouping, derived from the bay's leading letters (A1 → "A").
  const rowKeyOf = (bay) => { const m = String(bay).match(/^\s*([A-Za-z]+)/); return m ? m[1].toUpperCase() : String(bay); };
  for (const St of sites.values()) {
    for (const Ar of St.areas.values()) {
      const rows = new Map();
      for (const By of Ar.bays.values()) {
        const rk = rowKeyOf(By.name);
        if (!rows.has(rk)) rows.set(rk, { name: rk, count: 0, ids: [], bays: [] });
        const R = rows.get(rk); R.count += By.count; R.ids.push(...By.ids); R.bays.push(By);
      }
      Ar.rows = rows;
      Ar.grouped = rows.size >= 2 && rows.size < Ar.bays.size;
    }
  }

  const multiSite = sites.size > 1;
  const r = resolve(sites, segs, multiSite);

  // Build the tile-view URL path for a shelf location row (mirrors resolve()).
  function segsForLocation(loc) {
    const S = sites.get(loc.warehouse); if (!S) return null;
    const A = S.areas.get(loc.area || ''); if (!A) return null;
    const out = [];
    if (multiSite) out.push(slug(loc.warehouse));
    out.push(slug(A.name));
    if (A.grouped) out.push(slug(rowKeyOf(loc.bay)));
    out.push(slug(loc.bay));
    if (loc.shelf != null) out.push(String(loc.shelf));
    return out;
  }
  // Jump from a search hit to the shelf it's on.
  function locateOnShelf(it) {
    const loc = it.location_code ? list.find((l) => l.code === it.location_code) : null;
    const target = loc && segsForLocation(loc);
    if (!target) return;
    setResults(null); setSearchedFor(''); setQ('');
    navigate(target);
  }

  // After a shelf moves, re-open it at its new address. Deferred to an effect so the
  // tree (and therefore segsForLocation) is rebuilt from the reloaded list first.
  useEffect(() => {
    if (pendingNav == null || !locations) return;
    const loc = list.find((l) => l.id === pendingNav);
    const target = loc && segsForLocation(loc);
    setPendingNav(null);
    if (target) navigate(target, { replace: true });
  }, [pendingNav, locations]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the open shelf's contents when we land on a shelf.
  useEffect(() => {
    const id = r.shelfId;
    if (id == null) { setContents(null); return; }
    let cancelled = false;
    setContents('loading');
    api.locationItems(id)
      .then(({ items }) => { if (!cancelled) setContents(items || []); })
      .catch((err) => { if (err.unauthorized) return onSignOut(); if (!cancelled) { setContents([]); setError(err.message); } });
    return () => { cancelled = true; };
  }, [r.shelfId]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Print selection (checkboxes on any tile / folder rolls up its ids) -----
  const allSel = (ids) => ids.length > 0 && ids.every((id) => sel.has(id));
  const toggleIds = (ids) => setSel((s) => {
    const n = new Set(s); const on = ids.every((id) => n.has(id));
    ids.forEach((id) => (on ? n.delete(id) : n.add(id))); return n;
  });
  const openPrint = () => setPrintLocs(list.filter((l) => sel.has(l.id)));

  // --- Shelf mutations -------------------------------------------------------
  // A move can change the site/area/bay/shelf #, i.e. where the shelf lives in the
  // tree — and the URL path is derived from exactly those. Reload, then let the effect
  // above re-open the shelf at its new address so you're not dumped at a dead path.
  function onShelfSaved({ location, codeChanged, previousCode }) {
    setEditShelf(null); setError('');
    setLocations((ls) => (ls || []).map((x) => (x.id === location.id ? { ...x, ...location } : x)));
    setNotice(codeChanged
      ? `Moved to ${location.code} (was ${previousCode}) — the old shelf label no longer scans, so reprint it.`
      : `Saved ${location.label || location.code}.`);
    load().then(() => setPendingNav(location.id));
    if (codeChanged) setPrintLocs([location]);
  }
  // A folder rename rewrites every shelf under it. We're standing on the PARENT of the tile we
  // edited, so the current URL stays valid — just reload and, if any barcode moved, put the
  // affected labels straight on screen to reprint (they're the only thing that can't fix itself).
  function onGroupSaved(res) {
    setEditGroup(null); setError('');
    const moved = (res.changes || []).filter((c) => c.from !== c.to).length;
    setNotice(`Updated ${res.count} shelf location${res.count === 1 ? '' : 's'}.${moved
      ? ` ${moved} barcode${moved === 1 ? '' : 's'} changed — those labels no longer scan, so reprint them.`
      : ''}`);
    load();
    if (moved && res.locations?.length) setPrintLocs(res.locations);
  }
  async function doDelete() {
    if (!delShelf) return;
    setDelBusy(true); setError('');
    // Step back to the parent level first — the shelf we're standing on is about to stop existing.
    const parent = r.trail[r.trail.length - 2]?.segs || [];
    try {
      const { location, detached } = await api.locationDelete(delShelf.id);
      setDelShelf(null);
      navigate(parent);
      await load();
      setNotice(`Deleted ${location.label || location.code} (${location.code}).${detached ? ` ${detached} closed unit${detached === 1 ? '' : 's'} kept the code as history.` : ''}`);
    } catch (err) {
      if (err.unauthorized) return onSignOut();
      setDelShelf(null); setError(err.message);
    } finally { setDelBusy(false); }
  }
  async function toggleActive() {
    setBusy(true); setError('');
    try {
      const { location } = await api.locationUpdate(r.shelfObj.id, { active: !r.shelfObj.active });
      setLocations((ls) => ls.map((x) => (x.id === location.id ? { ...x, ...location } : x)));
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  // Tiles for the current level. Each folder tile carries the `match` that identifies its
  // node to `locations/rename-group` — the folders aren't rows in the DB, they're the distinct
  // warehouse/area/bay values on the shelves underneath, so "this tile" IS a query. `area: null`
  // is the real "(no area)" folder, which is why the empty key is normalised to null and not
  // left out (leaving it out would mean "any area").
  const bayVals = r.grouped ? (r.R ? r.R.bays : []) : (r.A ? [...r.A.bays.values()] : []);
  const hereArea = r.A ? (r.A.key || null) : null;
  let tiles = [];
  if (r.level === 'sites') tiles = [...sites.values()].map((s) => ({ key: s.name, slug: slug(s.name), name: s.name, sub: `${s.areas.size} area${s.areas.size === 1 ? '' : 's'}`, count: s.count, ids: s.ids, kind: 'site', match: { warehouse: s.name } }));
  else if (r.level === 'areas') tiles = [...r.S.areas.values()].map((a) => ({ key: a.key, slug: slug(a.name), name: a.name, sub: `${a.bays.size} bay${a.bays.size === 1 ? '' : 's'}`, count: a.count, ids: a.ids, kind: 'area', editName: a.key || '', match: { warehouse: r.site, area: a.key || null } }));
  else if (r.level === 'rows') tiles = [...r.A.rows.values()].map((x) => ({ key: x.name, slug: slug(x.name), name: `Row ${x.name}`, sub: `${x.bays.length} bay${x.bays.length === 1 ? '' : 's'}`, count: x.count, ids: x.ids, kind: 'row', editName: x.name, match: { warehouse: r.site, area: hereArea, bayPrefix: x.name } }));
  else if (r.level === 'bays') tiles = bayVals.map((b) => {
    const whole = b.shelves.length === 1 && b.shelves[0].shelf == null;
    return { key: b.name, slug: slug(b.name), name: b.name, sub: whole ? 'whole bay' : `${b.shelves.length} ${b.shelves.length === 1 ? 'shelf' : 'shelves'}`, count: b.count, ids: b.ids, kind: 'bay', match: { warehouse: r.site, area: hereArea, bay: b.name } };
  });
  else if (r.level === 'shelves') tiles = r.B.shelves.map((sh) => ({ key: sh.id, slug: String(sh.shelf), name: sh.label || sh.code, sub: sh.code, count: sh.item_count, ids: [sh.id], kind: 'shelf', inactive: !sh.active, loc: sh }));

  // A shelf tile opens the single-shelf editor; every folder tile opens the group one.
  const openTileEdit = (t) => (t.kind === 'shelf' ? setEditShelf(t.loc) : setEditGroup({
    kind: t.kind, name: t.editName ?? t.name, label: t.name, match: t.match, shelves: t.ids.length,
  }));

  const onShelf = r.level === 'shelf';
  const levelTitle = { sites: 'Sites', areas: 'Areas', rows: 'Rows', bays: 'Bays', shelves: 'Shelves' }[r.level];
  const allTileIds = tiles.flatMap((t) => t.ids);

  return (
    <div className="app app-wide">
      <TopBar title="Locate Shoe" onHome={onHome} onSignOut={onSignOut} />

      <div className="card">
        <div className="loc-filters">
          <form className="searchrow loc-search" onSubmit={(e) => { e.preventDefault(); runLocate(q); }}>
            <input placeholder="Find a shoe — name, SKU, VIN or UPC…" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
            <button className="btn primary">Locate</button>
            <button type="button" className={`btn ${showCam ? 'primary' : 'ghost'}`} title="Scan a VIN or UPC" onClick={() => setShowCam((v) => !v)}><Icon name="camera" /> Scan</button>
            {results !== null && <button type="button" className="btn ghost" onClick={() => { setQ(''); setResults(null); setSearchedFor(''); }}>Clear</button>}
          </form>
          <label className="loc-showfilter">Show
            <select value={active} onChange={(e) => setActive(e.target.value)}>
              <option value="">All</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </label>
          <span className="loc-add-btns">
            <button className={`btn sm ${pane === 'add' ? 'primary' : 'ghost'}`} onClick={() => setPane(pane === 'add' ? null : 'add')}>+ Add shelf</button>
            <button className={`btn sm ${pane === 'bulk' ? 'primary' : 'ghost'}`} onClick={() => setPane(pane === 'bulk' ? null : 'bulk')}>Bulk add</button>
          </span>
        </div>
        {showCam && (
          <div className="loc-cam mt">
            <Suspense fallback={<p className="muted">Loading camera…</p>}>
              <CameraScanner mode="rescale" onDetected={routeScan} onClose={() => setShowCam(false)} zoom={camZoom} onZoomChange={setCamZoom} />
            </Suspense>
            <p className="muted sm">Scan a shoe’s <b>VIN</b> label or its box <b>UPC</b> — either one locates the pair.</p>
          </div>
        )}
        {pane === 'add' && <AddShelf siteAreas={siteAreas} onDone={(msg) => { setPane(null); setNotice(msg); load(); }} onError={setError} onSignOut={onSignOut} />}
        {pane === 'bulk' && <BulkAdd siteAreas={siteAreas} onDone={(msg) => { setPane(null); setNotice(msg); load(); }} onError={setError} onSignOut={onSignOut} />}
        {error && <div className="error mt">{error}</div>}
        {notice && <div className="notice mt">{notice}</div>}
      </div>

      {results !== null && (
        <div className="card">
          <div className="loc-results-head">
            <span className="loc-level-title">Results for “{searchedFor}” <span className="muted sm">· {results.length} found</span></span>
            {(() => {
              // If every hit is the same SKU (e.g. a UPC scan → one size), offer to
              // broaden to all sizes of that shoe.
              const skus = [...new Set(results.map((x) => x.sku).filter(Boolean))];
              if (skus.length === 1 && searchedFor.toLowerCase() !== skus[0].toLowerCase()) {
                return <button className="btn sm ghost" onClick={() => { setQ(skus[0]); runLocate(skus[0]); }}>↕ Show all sizes of {skus[0]}</button>;
              }
              return null;
            })()}
          </div>
          {!results.length ? <p className="muted">No shoes match “{searchedFor}”. Try a name, SKU, VIN, or UPC.</p> : (
            <div className="loc-results" ref={resultsRef}>
              {(() => {
                // Group units by SKU so a shoe shows once (thumb + name + summary),
                // then compact per-unit rows: VIN | size | status | where it is.
                const groups = Object.values(results.reduce((acc, it) => {
                  const key = it.sku || it.name || '(unknown)';
                  (acc[key] ||= { sample: it, units: [] }).units.push(it);
                  return acc;
                }, {})).sort((a, b) => (a.sample.name || '').localeCompare(b.sample.name || ''));
                groups.forEach((g) => g.units.sort((a, b) => (parseFloat(a.size) || 0) - (parseFloat(b.size) || 0)));
                // One result → keep it open; many → collapse each to a tappable summary.
                const collapsible = groups.length > 1;
                return groups.map((g) => {
                  const key = g.sample.sku || g.sample.name;
                  const shelved = g.units.filter((u) => u.location_code).length;
                  const unshelved = g.units.length - shelved;
                  const open = !collapsible || expandedSkus.has(key);
                  const info = (
                    <div className="loc-group-info">
                      <span className="loc-group-name">{g.sample.name || '—'}</span>
                      <span className="loc-group-meta">
                        {g.sample.sku || '—'} · {g.units.length} pair{g.units.length === 1 ? '' : 's'}
                        {shelved > 0 && <> · <span className="ok-txt">{shelved} shelved</span></>}
                        {unshelved > 0 && <> · <span className="warn-txt">{unshelved} not shelved</span></>}
                      </span>
                    </div>
                  );
                  return (
                    <div className={`loc-sku-group ${open ? 'open' : ''}`} key={key}>
                      <div className="loc-group-head">
                        <ShoeThumb url={g.sample.photo_url} size={46} onOpen={() => openThumb(g.sample)} />
                        {collapsible ? (
                          <button type="button" className="loc-group-toggle" aria-expanded={open} onClick={() => toggleSku(key)}>
                            {info}
                            <span className="loc-caret">{open ? '▾' : '▸'}</span>
                          </button>
                        ) : info}
                      </div>
                      {open && (
                      <div className="loc-group-rows">
                        {g.units.map((u) => {
                          const loc = u.location_code ? list.find((l) => l.code === u.location_code) : null;
                          return (
                            <div className="loc-unit-row" key={u.vin}>
                              <span className="loc-unit-left"><span className="loc-unit-vin vin">{u.vin}</span></span>
                              <span className="loc-unit-size">{u.size && <span className="loc-size-chip">US {u.size}</span>}</span>
                              <span className="loc-unit-status">{u.status !== 'needs_shelf' && <StatusPill status={u.status} />}</span>
                              <span className="loc-unit-loc">
                                {u.location_code ? (
                                  <button className="loc-locate-chip" onClick={() => locateOnShelf(u)} disabled={!loc} title={loc ? `Go to ${u.location_code}` : u.location_code}>
                                    <Icon name="pin" /> {loc ? (loc.label || u.location_code) : u.location_code}
                                  </button>
                                ) : <span className="loc-unshelved" title="In stock but no shelf assigned yet">Not shelved yet</span>}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>
      )}

      <div className="card" hidden={results !== null}>
        {!locations ? <p className="muted">Loading…</p> : !list.length ? (
          <p className="muted">No shelves yet. Add one, or change the filter.</p>
        ) : (
          <>
            <div className="loc-selbar">
              <nav className="loc-crumbs" aria-label="Location path">
                {r.trail.map((c, i) => {
                  const last = i === r.trail.length - 1;
                  return (
                    <React.Fragment key={i}>
                      {i > 0 && <span className="loc-crumb-sep">›</span>}
                      {last ? <span className="loc-crumb here">{c.label}</span>
                        : <button className="loc-crumb" onClick={() => navigate(c.segs)}>{c.label}</button>}
                    </React.Fragment>
                  );
                })}
              </nav>
              {sel.size > 0 && (
                <span className="loc-sel-actions">
                  <b>{sel.size}</b> selected
                  <button className="btn sm primary" onClick={openPrint}><Icon name="print" /> Print labels</button>
                  <button className="btn sm ghost" onClick={() => setSel(new Set())}>Clear</button>
                </span>
              )}
            </div>

            {onShelf ? (
              /* --- Shelf contents ------------------------------------------ */
              <div className="loc-shelf">
                <div className="loc-detail-head">
                  <div className="loc-detail-title">
                    <span className="loc-detail-name">{r.shelfObj.label || r.shelfObj.code}</span>
                    <span className="loc-code muted sm">{r.shelfObj.code}</span>
                    {Array.isArray(contents) && contents.length > 0 && (
                      <span className="loc-pair-count muted sm">· {contents.length} pair{contents.length === 1 ? '' : 's'}</span>
                    )}
                  </div>
                  <div className="loc-detail-actions">
                    <button className="btn sm ghost" onClick={() => setEditShelf(r.shelfObj)}>Edit</button>
                    <button className="btn sm ghost" disabled={busy} onClick={toggleActive}>{r.shelfObj.active ? 'Deactivate' : 'Activate'}</button>
                    <button className="btn sm ghost" onClick={() => setPrintLocs([r.shelfObj])}><Icon name="print" /> Label</button>
                    <button className="btn sm danger" onClick={() => setDelShelf(r.shelfObj)}>Delete</button>
                  </div>
                </div>
                {!r.shelfObj.active && <div className="loc-detail-flag">This shelf is inactive — hidden from put-away.</div>}
                <div className="loc-shelf-items">
                  {contents === 'loading' ? <span className="muted sm">Loading…</span>
                    : !contents || !contents.length ? <span className="muted sm">Empty — nothing shelved here.</span>
                      : contents.map((it) => (
                        <div className="loc-item" key={it.vin}>
                          <ShoeThumb url={it.photo_url} size={46} onOpen={() => openThumb(it)} />
                          <div className="loc-item-main">
                            <div className="loc-item-top">
                              <span className="loc-item-name">{it.name || '—'}</span>
                              {it.size && <span className="loc-size-chip">US {it.size}</span>}
                              <StatusPill status={it.status} />
                            </div>
                            <div className="loc-item-meta muted sm">
                              <span className="vin">{it.vin}</span>
                              <span className="loc-item-dot">·</span>
                              <span>{it.sku || '—'}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                </div>
              </div>
            ) : (
              /* --- Tile grid for the current level ------------------------- */
              <>
                <div className="loc-level-head">
                  <span className="loc-level-title">{levelTitle} <span className="muted sm">· {tiles.length}</span></span>
                  {allTileIds.length > 0 && (
                    <label className="loc-selall"><input type="checkbox" checked={allSel(allTileIds)} onChange={() => toggleIds(allTileIds)} /> Select all</label>
                  )}
                </div>
                {!tiles.length ? (
                  <p className="muted">Nothing here yet — use <b>+ Add shelf</b> or <b>Bulk add</b> to set up {r.site || 'this site'}.</p>
                ) : (
                  <div className="loc-tiles" ref={tilesRef}>
                    {tiles.map((t) => (
                      <div className={`loc-tile ${t.inactive ? 'inactive' : ''}`} key={t.key}>
                        <div className="loc-tile-tools" onClick={(e) => e.stopPropagation()}>
                          {/* Rename/move this whole node — a site, area, row or bay is a query
                              over its shelves, so editing it rewrites every one of them. */}
                          <button type="button" className="loc-tile-edit" title={`Edit ${t.kind}`}
                            aria-label={`Edit ${t.name}`} onClick={() => openTileEdit(t)}>
                            <Icon name="pencil" />
                          </button>
                          <label className="loc-tile-check">
                            <input type="checkbox" checked={allSel(t.ids)} onChange={() => toggleIds(t.ids)} aria-label={`Select ${t.name}`} />
                          </label>
                        </div>
                        <button className="loc-tile-body" onClick={() => navigate([...r.base, t.slug])}>
                          <span className="loc-tile-icon"><TileGlyph kind={t.kind} /></span>
                          <span className="loc-tile-name">{t.name}{t.inactive && <span className="loc-inactive-badge"> inactive</span>}</span>
                          <span className="loc-tile-sub">{t.sub}</span>
                          <span className={`loc-tile-count ${t.count ? '' : 'zero'}`}>{t.count} item{t.count === 1 ? '' : 's'}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
      {editShelf && (
        <EditShelfModal shelf={editShelf} siteAreas={siteAreas} itemCount={Array.isArray(contents) ? contents.length : editShelf.item_count}
          onSaved={onShelfSaved} onClose={() => setEditShelf(null)} onSignOut={onSignOut} />
      )}
      {editGroup && (
        <EditGroupModal node={editGroup} sites={[...sites.keys()]} siteAreas={siteAreas}
          onSaved={onGroupSaved} onClose={() => setEditGroup(null)} onSignOut={onSignOut} />
      )}
      {delShelf && (
        <Modal type="error" title={`Delete ${delShelf.label || delShelf.code}?`}
          message={`${delShelf.code} is removed for good and its barcode stops scanning. To retire a shelf but keep its history, deactivate it instead.`}
          onClose={() => (delBusy ? null : setDelShelf(null))}>
          <button className="btn danger" disabled={delBusy} onClick={doDelete}>{delBusy ? 'Deleting…' : 'Delete shelf'}</button>
          <button className="btn ghost" disabled={delBusy} onClick={() => setDelShelf(null)}>Cancel</button>
        </Modal>
      )}
      {printLocs && <ShelfLabelSheet locations={printLocs} onClose={() => setPrintLocs(null)} />}
      {lightbox && <PhotoLightbox photos={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

// --- Rename / move a whole node: a site, an area, a row, or a bay -------------
// None of those is a row in the database — they're the distinct `warehouse`/`area`/`bay`
// values on the shelves underneath (and a Row is derived from the bays' shared leading
// letters, stored nowhere at all). So editing one rewrites EVERY shelf beneath it, and since
// the site and area are baked into the barcode (MNH-WH-A2-04) it reissues their codes too.
// That's what the dry-run preview is for: you see the count and a sample of from → to before
// committing, because the printed labels are the part that can't fix itself.
const GROUP_KIND = {
  site: { noun: 'site', nameLabel: 'Site name' },
  area: { noun: 'area', nameLabel: 'Area name', nameHint: 'Leave blank for “(no area)”.' },
  row: { noun: 'row', nameLabel: 'Row name', nameHint: 'The bays’ shared prefix — renaming row A to B rewrites A1…A5 as B1…B5.' },
  bay: { noun: 'bay', nameLabel: 'Bay name' },
};

function EditGroupModal({ node, sites = [], siteAreas = {}, onSaved, onClose, onSignOut }) {
  const cfg = GROUP_KIND[node.kind];
  const [name, setName] = useState(node.name || '');
  const [warehouse, setWarehouse] = useState(node.match.warehouse);
  const [area, setArea] = useState(node.match.area ?? '');
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const siteOptions = [...new Set([...WAREHOUSES, ...sites])];
  const areaOptions = [...new Set([...(siteAreas[warehouse] || []), ...LOCATION_AREAS])];
  // A site tile IS the site, and an area tile IS the area, so their name field already covers
  // the move — only a row/bay can be relocated somewhere else.
  const canMove = node.kind === 'row' || node.kind === 'bay';
  const movedSite = warehouse !== node.match.warehouse;
  const movedArea = (area.trim() || null) !== (node.match.area ?? null);

  const patch = () => {
    const p = {};
    if (node.kind === 'site') { p.warehouse = name.trim(); return p; }
    if (node.kind === 'area') {
      p.area = name.trim() || null;
      if (movedSite) p.warehouse = warehouse.trim();
      return p;
    }
    if (node.kind === 'row') p.bayPrefix = name.trim();
    else p.bay = name.trim();
    if (movedSite) p.warehouse = warehouse.trim();
    if (movedArea) p.area = area.trim() || null;
    return p;
  };
  const dirty = name.trim() !== String(node.name || '').trim() || movedSite || (canMove && movedArea);
  const needsName = node.kind !== 'area' && !name.trim();

  // Preview through the same endpoint that will do the write, so what you're shown is what
  // will happen — the code builder lives server-side and duplicating it here would drift.
  useEffect(() => {
    if (!dirty || needsName) { setPreview(null); setError(''); return undefined; }
    let cancelled = false;
    setPreviewBusy(true);
    const t = setTimeout(() => {
      api.locationRenameGroup({ match: node.match, patch: patch(), dryRun: true })
        .then((r) => { if (!cancelled) { setPreview(r); setError(''); } })
        .catch((e) => {
          if (e.unauthorized) return onSignOut();
          if (!cancelled) { setPreview(null); setError(e.message); }
        })
        .finally(() => { if (!cancelled) setPreviewBusy(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); setPreviewBusy(false); };
  }, [name, warehouse, area, dirty, needsName]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setError(''); setBusy(true);
    try { onSaved(await api.locationRenameGroup({ match: node.match, patch: patch() })); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  }

  const changed = (preview?.changes || []).filter((c) => c.from !== c.to);
  return (
    <div className="modal-overlay" onClick={() => (busy ? null : onClose())}>
      <div className="modal loc-edit-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Edit {cfg.noun}</h3>
        <p className="modal-msg">
          <b>{node.label}</b> · {node.shelves} shelf location{node.shelves === 1 ? '' : 's'} underneath
        </p>
        <div className="loc-pane">
          <label className="loc-edit-label">{cfg.nameLabel}
            <input value={name} autoFocus maxLength={80} onChange={(e) => setName(e.target.value)} />
            {cfg.nameHint && <span className="loc-edit-hint">{cfg.nameHint}</span>}
          </label>
          {canMove && (
            <div className="loc-pane-row">
              <label>Move to site<ComboField value={warehouse} onChange={(w) => { setWarehouse(w); setArea(''); }} options={siteOptions} placeholder="New site name" /></label>
              <label>Move to area<ComboField key={warehouse} value={area} onChange={setArea} options={areaOptions} allowNone placeholder="New area name" /></label>
            </div>
          )}
          {node.kind === 'area' && (
            <div className="loc-pane-row">
              <label>Move to site<ComboField value={warehouse} onChange={setWarehouse} options={siteOptions} placeholder="New site name" /></label>
            </div>
          )}
        </div>

        {previewBusy && <p className="muted sm mt">Checking…</p>}
        {!previewBusy && preview && (
          <div className={`loc-edit-warn ${changed.length ? '' : 'calm'}`}>
            {changed.length ? (
              <>
                <b>{changed.length} barcode{changed.length === 1 ? '' : 's'} will change</b> across {preview.count} shelf
                location{preview.count === 1 ? '' : 's'} — the printed labels stop scanning, so reprint them
                (the label sheet opens on save).
                {preview.liveItems > 0 && <> {preview.liveItems} pair{preview.liveItems === 1 ? '' : 's'} stored here stay exactly where they are; only their codes change.</>}
                <ul className="loc-edit-diff">
                  {changed.slice(0, 6).map((c) => (
                    <li key={c.id}><span className="vin">{c.from}</span> → <span className="vin">{c.to}</span></li>
                  ))}
                  {changed.length > 6 && <li className="muted">…and {changed.length - 6} more</li>}
                </ul>
              </>
            ) : (
              <>Renames {preview.count} shelf location{preview.count === 1 ? '' : 's'}. No barcode changes, so nothing needs reprinting.</>
            )}
          </div>
        )}
        {error && <div className="error mt">{error}</div>}
        <div className="modal-actions">
          <button className="btn primary" disabled={busy || !dirty || needsName || previewBusy || !!error} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// --- Edit one shelf: rename, and/or move it to another site/area/bay/shelf # ---
// The scannable `code` is derived from those parts server-side, so moving a shelf
// re-issues its barcode — hence the warning, and the label sheet that opens on save.
function EditShelfModal({ shelf, siteAreas = {}, itemCount = 0, onSaved, onClose, onSignOut }) {
  const [warehouse, setWarehouse] = useState(shelf.warehouse);
  const [area, setArea] = useState(shelf.area || '');
  const [bay, setBay] = useState(shelf.bay || '');
  const [shelfNo, setShelfNo] = useState(shelf.shelf == null ? '' : String(shelf.shelf));
  const [label, setLabel] = useState(shelf.label || '');
  // Most shelves keep the auto name ("A1-03"), which describes the POSITION — so while
  // it's still the default, let it follow a move instead of leaving "A1-03" sitting on
  // shelf 12. A name someone actually typed is never overwritten.
  const autoLabel = (b, s) => (s ? `${String(b).trim()}-${String(s).padStart(2, '0')}` : String(b).trim());
  const [labelTouched, setLabelTouched] = useState(!!shelf.label && shelf.label !== autoLabel(shelf.bay, shelf.shelf));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const areaOptions = [...new Set([...(siteAreas[warehouse] || []), ...LOCATION_AREAS])];
  useEffect(() => {
    if (labelTouched) return;
    setLabel(autoLabel(bay, shelfNo === '' ? null : Number(shelfNo)));
  }, [bay, shelfNo, labelTouched]); // eslint-disable-line react-hooks/exhaustive-deps
  const moved = warehouse !== shelf.warehouse
    || (area.trim() || null) !== (shelf.area || null)
    || bay.trim() !== (shelf.bay || '')
    || (shelfNo === '' ? null : Number(shelfNo)) !== (shelf.shelf ?? null);

  async function save() {
    setError('');
    if (!String(warehouse).trim()) { setError('Pick a warehouse / site.'); return; }
    if (!bay.trim()) { setError('Enter a bay.'); return; }
    setBusy(true);
    try {
      const res = await api.locationUpdate(shelf.id, {
        label: label.trim(),
        warehouse: String(warehouse).trim(),
        area: area.trim() || null,
        bay: bay.trim(),
        shelf: shelfNo === '' ? null : Number(shelfNo),
      });
      onSaved(res);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={() => (busy ? null : onClose())}>
      <div className="modal loc-edit-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Edit shelf</h3>
        <p className="modal-msg">Current barcode <span className="vin">{shelf.code}</span></p>
        <div className="loc-pane">
          <label className="loc-edit-label">Display name<input value={label} maxLength={40} placeholder={shelf.code}
            onChange={(e) => { setLabelTouched(true); setLabel(e.target.value); }} /></label>
          <div className="loc-pane-row">
            <label>Warehouse / Site<ComboField value={warehouse} onChange={(w) => { setWarehouse(w); setArea(''); }} options={WAREHOUSES} placeholder="New site name" /></label>
            <label>Area (optional)<ComboField key={warehouse} value={area} onChange={setArea} options={areaOptions} allowNone placeholder="New area name" /></label>
            <label>Bay<input value={bay} onChange={(e) => setBay(e.target.value)} placeholder="e.g. A2 or Pod 1" autoCapitalize="characters" /></label>
            <label>Shelf #<input type="number" min="1" max="99" value={shelfNo} onChange={(e) => setShelfNo(e.target.value)} placeholder="blank = whole bay" /></label>
          </div>
        </div>
        {moved && (
          <div className="loc-edit-warn">
            Moving the shelf re-issues its barcode, so the printed label stops scanning — reprint it
            (the label sheet opens on save).{itemCount > 0 ? ` The ${itemCount} pair${itemCount === 1 ? '' : 's'} stored here stay on the shelf and follow it.` : ''}
          </div>
        )}
        {error && <div className="error mt">{error}</div>}
        <div className="modal-actions">
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// --- Add a single shelf ---------------------------------------------------
function AddShelf({ siteAreas = {}, onDone, onError, onSignOut }) {
  const [warehouse, setWarehouse] = useState(WAREHOUSES[0]);
  const [area, setArea] = useState('');
  const [bay, setBay] = useState('');
  const [shelf, setShelf] = useState('');
  const [busy, setBusy] = useState(false);
  const areaOptions = [...new Set([...(siteAreas[warehouse] || []), ...LOCATION_AREAS])];

  async function submit() {
    onError('');
    if (!warehouse.trim()) { onError('Enter a warehouse.'); return; }
    if (!bay.trim()) { onError('Enter a bay.'); return; }
    setBusy(true);
    try {
      const { location } = await api.locationCreate({ warehouse: warehouse.trim(), area: area.trim() || null, bay: bay.trim(), shelf: shelf === '' ? null : Number(shelf) });
      onDone(`Added ${location.label || location.code} (${location.code}).`);
      setBay(''); setShelf('');
    } catch (err) { if (err.unauthorized) return onSignOut(); onError(err.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="loc-pane">
      <div className="loc-pane-row">
        <label>Warehouse / Site<ComboField value={warehouse} onChange={(w) => { setWarehouse(w); setArea(''); }} options={WAREHOUSES} placeholder="New site name" /></label>
        <label>Area (optional)<ComboField key={warehouse} value={area} onChange={setArea} options={areaOptions} allowNone placeholder="New area name" /></label>
        <label>Bay<input value={bay} onChange={(e) => setBay(e.target.value)} placeholder="e.g. A2 or Pod 1" autoCapitalize="characters" /></label>
        <label>Shelf #<input type="number" min="1" max="99" value={shelf} onChange={(e) => setShelf(e.target.value)} placeholder="blank = whole bay" /></label>
      </div>
      <div className="ph-edit-actions"><button className="btn sm primary" disabled={busy} onClick={submit}>{busy ? 'Adding…' : 'Add shelf'}</button></div>
    </div>
  );
}

// --- Bulk add a warehouse's bays ------------------------------------------
function BulkAdd({ siteAreas = {}, onDone, onError, onSignOut }) {
  const [warehouse, setWarehouse] = useState(WAREHOUSES[0]);
  const [area, setArea] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const areaOptions = [...new Set([...(siteAreas[warehouse] || []), ...LOCATION_AREAS])];

  function parse(t) {
    return t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(.+?)[\s:,]+(\d+)\s*$/);
      return m ? { bay: m[1].trim(), shelves: Number(m[2]) } : { bay: l, shelves: 1 };
    });
  }
  async function submit() {
    onError('');
    if (!warehouse.trim()) { onError('Enter a warehouse.'); return; }
    const entries = parse(text);
    if (!entries.length) { onError('Add at least one bay (one per line).'); return; }
    setBusy(true);
    try {
      const { inserted, total } = await api.locationBulk({ warehouse: warehouse.trim(), area: area.trim() || null, entries });
      onDone(`Added ${inserted} shelf location${inserted === 1 ? '' : 's'} (${total - inserted} already existed).`);
      setText('');
    } catch (err) { if (err.unauthorized) return onSignOut(); onError(err.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="loc-pane">
      <div className="loc-pane-row">
        <label>Warehouse / Site<ComboField value={warehouse} onChange={(w) => { setWarehouse(w); setArea(''); }} options={WAREHOUSES} placeholder="New site name" /></label>
        <label>Area (optional)<ComboField key={warehouse} value={area} onChange={setArea} options={areaOptions} allowNone placeholder="New area name" /></label>
      </div>
      <label className="loc-bulk-text">Bays — one per line: <span className="muted">“A1 5” (bay + # shelves), “Pod 1 0” for a whole bay</span>
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'A1 5\nA2 5\nA3 3'} />
      </label>
      <div className="ph-edit-actions"><button className="btn sm primary" disabled={busy} onClick={submit}>{busy ? 'Adding…' : 'Add shelves'}</button></div>
    </div>
  );
}

// A preset dropdown that can drop into free-text entry ("Custom…") — used to add
// a brand-new warehouse/site or area not in the presets.
function ComboField({ value, onChange, options, allowNone = false, placeholder = '' }) {
  const [custom, setCustom] = useState(!!value && !options.includes(value));
  if (custom) {
    return (
      <span className="combo">
        <input value={value} placeholder={placeholder} autoFocus autoCapitalize="words" onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="btn sm ghost" title="Back to list" onClick={() => { setCustom(false); onChange(allowNone ? '' : (options[0] || '')); }}>↩</button>
      </span>
    );
  }
  return (
    <select value={options.includes(value) ? value : ''} onChange={(e) => {
      if (e.target.value === '__custom') { setCustom(true); onChange(''); } else onChange(e.target.value);
    }}>
      {allowNone && <option value="">— none —</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
      <option value="__custom">＋ Custom…</option>
    </select>
  );
}
