// Batch Page (V6 Feature 7) — a navigator/manager for multi-box receiving
// batches. Lists OPEN (resumable) batches and recent/closed ones; open a batch
// to see its boxes + progress and manage it: add a box (→ scan items into it via
// the Receiving box-mode), or finish / reopen. The Receiving page remains the
// main place to START a batch (expected boxes + tag live there).
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { TopBar, StatusPill, Modal, Pager } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';
import { batchMatchesSearch } from '../lib/postatus.js';
import { useQueryParam } from '../lib/urlstate.js';

const shortDate = (s) => String(s || '').slice(0, 10);

// Everything a batch carries a tracking number in, as one list — the batch's own number
// (single-box shipments, or whatever was typed at intake) plus one per box.
const allTracking = (b) => [b?.tracking_number, ...(b?.box_tracking_numbers || [])].filter(Boolean);

// `readOnly` is the PH team's view of this page (2026-08-27). They look a parcel up to
// see which batch it became and what was in it; adding boxes, finishing, reopening and
// renumbering are warehouse work — and warehouse-only server-side, so those buttons
// would 403 anyway. Hiding them is honesty, not decoration.
// How many open batches to show at once. The recent list and the search are paged by the
// SERVER (`pageSize` comes back with them); the open list arrives whole, so it's paged
// here — same size, so "page 2" means the same number of rows in both cards.
const OPEN_PAGE = 25;
// Only used before the first response lands — the server sends the real page size with
// the rows, and it is the one that decides what a page is.
const PAGE_FALLBACK = 25;

export function BatchPage({ initialBatchId = null, onAddBox, onOpenItem, onHome, onSignOut, readOnly = false }) {
  const [open, setOpen] = useState(null);     // open batches
  const [recent, setRecent] = useState(null); // { batches, total, page, pageSize }
  // WHICH BATCH IS OPEN LIVES IN THE URL (?b=), and opening one PUSHES a history entry.
  // That is what makes the device/browser Back button close the batch and return to the
  // list — with the search still in it — instead of walking out to the home page. The
  // same reason the search itself is in ?q=: the page's state is the URL, so Back,
  // Forward, refresh and a pasted link all agree about what you are looking at.
  const [selIdRaw, setSelIdRaw] = useQueryParam('b');
  const selId = selIdRaw ? Number(selIdRaw) : null;
  // Set when WE pushed the detail entry, so the in-page "← Batches" can undo that push
  // (history.back()) rather than replacing it — replacing leaves a dead entry behind,
  // and the next Back press then looks like it did nothing.
  const pushedDetail = useRef(false);
  const openBatch = (id) => { pushedDetail.current = true; setSelIdRaw(String(id), { replace: false }); };
  const closeBatch = () => {
    if (pushedDetail.current) { pushedDetail.current = false; window.history.back(); return; }
    setSelIdRaw('');   // deep-linked straight to ?b= — there is no entry of ours to pop
  };
  const [detail, setDetail] = useState(null); // { batch, boxes, items }
  const [openBox, setOpenBox] = useState(null); // box id whose items are expanded
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reopenId, setReopenId] = useState(null);
  // The box whose number is being corrected, + the number typed for it.
  const [renumber, setRenumber] = useState(null); // { box, value }
  // The number on the parcel, kept in ?q= so "the batch this box belongs to" is a link
  // you can paste to whoever is asking.
  const [pageRaw, setPageRaw] = useQueryParam('p');
  const page = Math.max(1, Number(pageRaw) || 1);
  // Filters, in the URL like the search — a narrowed list is something you send someone.
  const [from, setFromRaw] = useQueryParam('from');
  const [to, setToRaw] = useQueryParam('to');
  const [supplier, setSupplierRaw] = useQueryParam('supplier');
  const [po, setPoRaw] = useQueryParam('po');
  const [suppliers, setSuppliers] = useState([]);
  const [poCodes, setPoCodes] = useState([]);
  const [q, setQRaw] = useQueryParam('q');
  // Starting a search PUSHES one entry; refining it replaces. So Back from a set of
  // results returns to the unsearched list — one entry for "I started searching", not
  // one per keystroke.
  const setQ = (v) => { setQRaw(v, { replace: !!q.trim() }); if (page !== 1) setPageRaw(''); };
  // Any filter change goes back to page 1 — narrowing while on page 4 of a 2-page result
  // shows an empty list that looks like "nothing matches".
  const onPage1 = (set) => (v) => { set(v); if (page !== 1) setPageRaw(''); };
  const setFrom = onPage1(setFromRaw); const setTo = onPage1(setToRaw);
  const setSupplier = onPage1(setSupplierRaw); const setPo = onPage1(setPoRaw);
  const filtering = !!(from || to || supplier || po);
  const clearFilters = () => { setFromRaw(''); setToRaw(''); setSupplierRaw(''); setPoRaw(''); setPageRaw(''); };
  const [found, setFound] = useState(null);    // server search results (null = not searching)
  const [searching, setSearching] = useState(false);
  const [openPageRaw, setOpenPageRaw] = useQueryParam('op');
  const openPage = Math.max(1, Number(openPageRaw) || 1);

  async function loadLists() {
    setError('');
    try {
      const [o, r] = await Promise.all([
        api.openBatches(),
        api.batchList({ kind: 'receiving', page, excludeOpen: true, from, to, supplier, po }),
      ]);
      setOpen(o.batches || []);
      setRecent(r);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  // A batch that was merged away keeps its code (it is on printed labels) but holds
  // nothing. Landing on an empty page after scanning that code is the exact confusion the
  // "no boxes" bug caused, so follow the pointer and SAY that you did.
  const [mergedFrom, setMergedFrom] = useState(null);
  async function loadDetail(id) {
    setError('');
    try {
      const d = await api.batchFull(id);
      const into = d.batch?.merged_into_batch_id;
      if (into && Number(into) !== Number(id)) {
        setMergedFrom(d.batch.batch_code);
        setSelIdRaw(String(into));   // replaces, so Back still returns to the list
        return;
      }
      setMergedFrom((f) => (selId && Number(selId) === Number(id) ? f : null));
      setDetail(d);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }

  useEffect(() => { loadLists(); }, [page, from, to, supplier, po]); // eslint-disable-line react-hooks/exhaustive-deps

  // The pickers offer only what is actually on a batch — a supplier with no shipments or
  // an order with none received is a dead option that returns an empty list.
  useEffect(() => {
    api.batchFilterOptions()
      .then((r) => { setSuppliers(r.suppliers || []); setPoCodes(r.poCodes || []); })
      .catch(() => { /* the filters still work typed into the URL */ });
  }, []);

  // A batch id handed in by the app (returning from "add a box") opens that batch
  // without adding a history entry — the entry it came from is already behind us.
  useEffect(() => { if (initialBatchId && !selIdRaw) setSelIdRaw(String(initialBatchId)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The search runs on the SERVER, not over the two lists above. Those show one page
  // (25) and the carton in someone's hand is as likely to be from March — filtering the
  // page on screen would answer "no such batch" for a batch that exists.
  useEffect(() => {
    const query = q.trim();
    if (!query) { setFound(null); setSearching(false); return undefined; }
    // Drop the previous answer the moment the query changes — otherwise the last
    // search's results sit under a different number while the new one is in flight,
    // which is the one thing this page must never do.
    setFound(null);
    setSearching(true);
    // Typing "1Z999AA10123456784" is 20 renders; wait for the pause before asking.
    const t = setTimeout(() => {
      api.batchList({ kind: 'receiving', q: query, page, from, to, supplier, po })
        .then((r) => setFound(r))
        .catch((err) => { if (err.unauthorized) return onSignOut(); setError(err.message); setFound({ batches: [], total: 0 }); })
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q, page, from, to, supplier, po]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOpenBox(null); if (selId) loadDetail(selId); else { setDetail(null); setMergedFrom(null); } }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Put the number on the row back in step with the label on the carton. Boxes that
  // arrive out of order get whatever "+ Add box" had left (max+1) — box 6 of 9 landing a
  // day late becomes box 10 — and from then on nothing lines up with the shipment.
  async function saveRenumber() {
    const n = Number(renumber?.value);
    // The message goes in the modal, not the page behind it — the overlay would hide it.
    if (!Number.isInteger(n) || n < 1) { setRenumber((r) => ({ ...r, err: 'Enter a whole box number of 1 or more.' })); return; }
    setBusy(true); setRenumber((r) => ({ ...r, err: '' }));
    try {
      await api.batchRenumberBox(selId, Number(renumber.box.id), n);
      setRenumber(null);
      await loadDetail(selId);
    } catch (err) { if (err.unauthorized) return onSignOut(); setRenumber((r) => (r ? { ...r, err: err.message } : r)); }
    finally { setBusy(false); }
  }

  async function setStatus(id, status) {
    setBusy(true);
    try { await api.batchSetStatus(id, status); await Promise.all([loadDetail(id), loadLists()]); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
    finally { setBusy(false); }
  }

  // ---- Batch detail view ----
  if (selId && detail) {
    const b = detail.batch;
    const boxes = detail.boxes || [];
    // Group every unit under its box so each box row can drill into its shoes.
    const itemsByBox = new Map();
    for (const it of (detail.items || [])) {
      const k = String(it.box_id ?? '');
      if (!itemsByBox.has(k)) itemsByBox.set(k, []);
      itemsByBox.get(k).push(it);
    }
    const received = boxes.filter((x) => x.status === 'received').length;
    const expected = b.expected_boxes;
    const isOpen = b.status === 'open';
    // MOST BATCHES HAVE NO BOXES AT ALL, and that is normal — not old data.
    // `batch_boxes` rows exist only for a multi-box batch or one received against a PO;
    // the ordinary receiving wizard commits its pairs straight to the batch with
    // `box_id` NULL. Grouping every item under a box therefore hid the contents of 165
    // of 190 batches on prod (984 pairs), showing "Boxes (0) · No boxes yet" over a
    // batch that plainly has 13 shoes in it. Anything without a box is listed on its own.
    const unboxed = itemsByBox.get('') || [];
    const itemRow = (it) => (
      <div className="batch-detail-row" key={it.id}>
        {onOpenItem
          ? <button className="vin vin-link" onClick={() => onOpenItem(it.vin)} title="View full shoe detail + history">{it.vin}</button>
          : <span className="vin">{it.vin}</span>}
        <span className="batch-row-name">{it.name}</span>
        <span className="muted sm">{it.sku || '—'} · size {it.size || '—'}</span>
        <StatusPill status={it.status} />
      </div>
    );
    return (
      <div className="app">
        <TopBar title="Batch" onHome={onHome} onSignOut={onSignOut}
          right={<button className="btn ghost sm" onClick={closeBatch}>← Batches</button>} />
        {mergedFrom && (
          <div className="card merge-note">
            <b>{mergedFrom}</b> was merged into this batch — its pairs are here.
          </div>
        )}
        <div className="card">
          <div className="batch-page-head">
            <div>
              <div className="batch-page-code">{b.batch_code} {isOpen ? <span className="badge open">Open</span> : <span className="badge done">Done</span>}</div>
              {/* A stated "no tracking number" is worth showing — otherwise this batch
                  looks like one whose tracking simply never got typed in. */}
              <div className="muted sm">{b.supplier_name || '—'} · {shortDate(b.date_received || b.created_at)}{b.batch_tag ? <> · <Icon name="tag" /> {b.batch_tag}</> : ''}{b.tracking_number ? <> · {b.tracking_number}</> : b.no_tracking ? <> · no tracking #</> : ''}</div>
            {/* Against an order, or not — stated on the batch as well as on each pair,
                because "which PO was this?" is asked of the shipment more often than of
                a single shoe. Inside the left column: `.batch-page-head` is a flex row,
                so a third child would sit beside the box count and squeeze it. */}
            <div className="muted sm batch-po">
              {b.po_id
                ? <>Received against <b>{b.po_code || `PO #${b.po_id}`}</b>
                    {b.po_status ? <> · {b.po_status}</> : null}
                    {b.po_link_source === 'linked'
                      ? <> · attached to the order afterwards{b.po_linked_by ? ` by ${b.po_linked_by}` : ''}</>
                      : b.po_link_source === 'receiving' ? <> · received straight against it</> : null}
                  </>
                : <span className="prov-none">Not received against a purchase order</span>}
            </div>
            </div>
            <div className="batch-progress">
              {/* A batch that was never split into boxes gets its item count instead —
                  "0 boxes" over thirteen shoes reads like something went missing. */}
              {boxes.length || expected
                ? <><b>{received}{expected ? `/${expected}` : ''}</b><span className="muted sm"> boxes</span></>
                : <><b>{detail.items?.length ?? 0}</b><span className="muted sm"> item{(detail.items?.length ?? 0) === 1 ? '' : 's'}</span></>}
            </div>
          </div>
          {expected ? (
            <div className="progress-bar"><span style={{ width: `${Math.min(100, Math.round((received / expected) * 100))}%` }} /></div>
          ) : null}
        </div>

        {(boxes.length > 0 || expected || (isOpen && !readOnly)) && (
        <div className="card">
          <div className="step-head">
            <h3 className="rows-title">Boxes <span className="muted">({boxes.length})</span></h3>
            {isOpen && !readOnly && <button className="btn primary sm" onClick={() => onAddBox(b)}>+ Add box</button>}
          </div>
          {isOpen && !readOnly && boxes.some((x) => x.status !== 'received') && (
            <p className="muted sm">“Pending” means the box is recorded but nothing has been scanned into it yet — tap <b>Add items</b> on its row to continue it. <b>+ Add box</b> is for a box that isn’t listed here at all.</p>
          )}
          {boxes.length > 1 && !readOnly && (
            <p className="muted sm">Boxes that arrive out of order are numbered as they land — use the <Icon name="pencil" /> on a row to put its number back in step with the label on the carton.</p>
          )}
          {!boxes.length ? <p className="muted">No boxes yet{isOpen && !readOnly ? ' — tap “Add box” to scan the first one.' : '.'}</p> : (
            <div className="box-list">
              {boxes.map((bx) => {
                const boxItems = itemsByBox.get(String(bx.id)) || [];
                const isBoxOpen = openBox === bx.id;
                const empty = bx.item_count === 0;
                return (
                  <div className={`box-row-wrap ${isBoxOpen ? 'open' : ''}`} key={bx.id}>
                    <div className="box-row-line">
                      <button className="box-row" onClick={() => setOpenBox(isBoxOpen ? null : bx.id)} title={boxItems.length ? 'Show shoes in this box' : 'No shoes in this box yet'}>
                        <span className="box-caret">{boxItems.length ? (isBoxOpen ? '▾' : '▸') : '·'}</span>
                        <span className="box-num">Box {bx.box_number}</span>
                        <span className="box-track muted sm">{bx.tracking_number || 'no tracking'}</span>
                        <span className="box-count" style={empty ? { color: '#e08f8f', fontWeight: 600 } : undefined}>{bx.item_count} item{bx.item_count === 1 ? '' : 's'}</span>
                        <span className={`box-status ${bx.status}`}>{bx.status === 'received' ? '✓ received' : 'pending'}</span>
                      </button>
                      {/* How you CONTINUE a box. A pending row is a box that was recorded
                          (its tracking scanned, or its slot created up front) but never
                          scanned into — and without this the row was a dead end: the only
                          visible action was "+ Add box", which creates box N+1 rather than
                          filling this one. Scans land in THIS box, keeping its number and
                          tracking. Received boxes get no button: they're closed, and the
                          commit would be refused anyway. */}
                      {/* Renumbering stays available on a RECEIVED box: a box arriving
                          out of order is numbered max+1, and that only becomes obviously
                          wrong once its contents are in and the count doesn't match the
                          label on the carton. */}
                      {!readOnly && (
                        <button className="btn ghost sm box-row-renum" title={`Change the number on box ${bx.box_number}`}
                          onClick={() => { setError(''); setRenumber({ box: bx, value: String(bx.box_number ?? '') }); }}>
                          <Icon name="pencil" />
                        </button>
                      )}
                      {isOpen && !readOnly && bx.status !== 'received' && (
                        <button className="btn primary sm box-row-add" onClick={() => onAddBox(b, bx)}
                          title={`Scan shoes into box ${bx.box_number}`}>Add items</button>
                      )}
                    </div>
                    {isBoxOpen && (
                      <div className="box-items">
                        {!boxItems.length ? <div className="muted sm box-items-empty">No shoes in this box yet.</div> : boxItems.map(itemRow)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}

        {/* The shoes themselves. For a boxed batch this is what the box rows didn't
            claim; for an ordinary one it is the whole batch. Either way, a pair that is
            in this batch appears on this page. */}
        {unboxed.length > 0 && (
          <div className="card">
            <h3 className="rows-title">
              {boxes.length ? <>Not in a box <span className="muted">({unboxed.length})</span></> : <>Items <span className="muted">({unboxed.length})</span></>}
            </h3>
            {boxes.length ? (
              <p className="muted sm">Scanned into the batch rather than into one of its boxes — usually pairs added before the boxes were recorded.</p>
            ) : null}
            <div className="box-items">{unboxed.map(itemRow)}</div>
          </div>
        )}

        {error && <div className="error mt">{error}</div>}
        <div className="batch-bar">
          <button className="btn ghost" onClick={closeBatch}>← Back</button>
          {!readOnly && (isOpen
            ? <button className="btn ghost" disabled={busy} onClick={() => setStatus(b.id, 'done')}>Finish batch</button>
            : <button className="btn ghost" disabled={busy} onClick={() => setReopenId(b.id)}>Reopen</button>)}
          {isOpen && !readOnly && <button className="btn primary" onClick={() => onAddBox(b)}>+ Add box</button>}
        </div>
        {renumber && (
          <Modal type="warn" title={`Box ${renumber.box.box_number} — change its number`}
            message={`Use the number printed on the carton / on the purchase order's label. ${renumber.box.item_count} item${renumber.box.item_count === 1 ? '' : 's'} and its tracking number move with it — nothing is rescanned.`}
            onClose={() => setRenumber(null)}>
            <div className="renum-form">
              <label>Box number
                <input type="number" min="1" step="1" inputMode="numeric" value={renumber.value}
                  onChange={(e) => setRenumber((r) => ({ ...r, value: e.target.value }))} />
              </label>
              <p className="muted sm">
                If that number is an empty <b>pending</b> box, this box takes its place. A box
                that already has stock in it won’t be overwritten.
              </p>
              {renumber.err && <div className="error">{renumber.err}</div>}
              <div className="renum-acts">
                <button className="btn primary" disabled={busy} onClick={saveRenumber}>Save number</button>
                <button className="btn ghost" disabled={busy} onClick={() => setRenumber(null)}>Cancel</button>
              </div>
            </div>
          </Modal>
        )}
        {reopenId != null && (
          <Modal type="warn" title={`Reopen ${b.batch_code}?`}
            message="This puts a finalized batch back to open so boxes/items can be added. Only reopen if you need to correct it."
            onClose={() => setReopenId(null)}>
            <button className="btn primary" onClick={() => { const id = reopenId; setReopenId(null); setStatus(id, 'open'); }}>Reopen batch</button>
            <button className="btn ghost" onClick={() => setReopenId(null)}>Cancel</button>
          </Modal>
        )}
      </div>
    );
  }

  // ---- List view ----
  // The open list has its own endpoint and arrives whole, so the same filters are applied
  // here. Leaving it unfiltered would show a card full of batches the filter excludes,
  // directly above one that honours it.
  const inRange = (b) => {
    const d = String(b.date_received || b.created_at || '').slice(0, 10);
    if (from && (!d || d < from)) return false;
    if (to && (!d || d > to)) return false;
    if (supplier && String(b.supplier_name || '').trim() !== supplier) return false;
    // The open list carries no PO code, only whether it has an order at all — enough for
    // "none", and a named order is answered by the Recent list below.
    if (po === 'none' && b.po_id) return false;
    if (po && po !== 'none' && !b.po_id) return false;
    return true;
  };
  const openList = (open || []).filter(inRange);
  // The open list arrives whole (it is the active worklist, and the endpoint has no
  // limit), so its page is sliced here rather than asked for.
  const openPages = Math.max(1, Math.ceil(openList.length / OPEN_PAGE));
  const openShown = openList.slice((Math.min(openPage, openPages) - 1) * OPEN_PAGE, Math.min(openPage, openPages) * OPEN_PAGE);
  // No client-side de-duplication against the open list: the query excludes open batches
  // (`excludeOpen`), so the two cards are already disjoint. Filtering here as well is what
  // made a page of 25 render 21 rows under a pager that said "1–25 of 466".
  const recentList = recent?.batches || [];
  const searchingNow = !!q.trim();
  // While the server answer is in flight, filter what's already on screen — the batch
  // someone wants is usually the one they just received, and a list that reacts as you
  // type beats a spinner. The server result replaces it a moment later, wider.
  const localHits = searchingNow
    ? [...openList, ...recentList].filter((b) => batchMatchesSearch(b, q))
    : [];
  const hits = found?.batches ?? localHits;

  const row = (b, { showKind = false } = {}) => (
    <button className="batch-nav-row" key={b.id} onClick={() => openBatch(b.id)}>
      <div className="batch-nav-main">
        <span className="batch-code">{b.batch_code}
          {b.merged_into_code
            ? <span className="badge">merged into {b.merged_into_code}</span>
            : b.item_count === 0 && <span className="badge warn">Empty</span>}
          {showKind && b.kind && b.kind !== 'receiving' && <span className="badge">{b.kind}</span>}
        </span>
        <span className="muted sm">{b.supplier_name || '—'}{b.batch_tag ? <> · <Icon name="tag" /> {b.batch_tag}</> : ''}{b.date_received || b.created_at ? ` · ${shortDate(b.date_received || b.created_at)}` : ''}</span>
        {/* The number that was searched for is the reason this row is here — show it,
            or the answer is "some batch" rather than "this parcel's batch". A batch that
            states it has no tracking says so; one that simply never had a number typed
            in stays blank, because those are different facts. */}
        <span className="muted xs batch-nav-track">
          {allTracking(b).length ? allTracking(b).join(' · ') : b.no_tracking ? 'no tracking #' : ''}
        </span>
      </div>
      <span className="batch-nav-prog">
        {b.received_boxes != null ? <><b>{b.received_boxes}{b.expected_boxes ? `/${b.expected_boxes}` : ''}</b> boxes · </> : null}
        {b.item_count} item{b.item_count === 1 ? '' : 's'}
      </span>
      <span className="batch-caret">▸</span>
    </button>
  );

  return (
    <div className="app">
      <TopBar title="Batches" onHome={onHome} onSignOut={onSignOut} />
      {error && <div className="error mt">{error}</div>}

      <div className="card">
        <div className="po-ov-filters batch-filters">
          <label><span className="muted xs">Received from</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Received from" /></label>
          <label><span className="muted xs">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Received to" /></label>
          <label><span className="muted xs">Supplier</span>
            <select value={supplier} onChange={(e) => setSupplier(e.target.value)} aria-label="Supplier">
              <option value="">All suppliers</option>
              {suppliers.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label><span className="muted xs">Purchase order</span>
            <select value={po} onChange={(e) => setPo(e.target.value)} aria-label="Purchase order">
              <option value="">Any</option>
              {/* Worth its own option now that a batch says whether it came in against an
                  order: "what did we receive that no PO accounts for?" */}
              <option value="none">Not against a PO</option>
              {poCodes.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          {filtering && <button className="btn sm ghost" onClick={clearFilters}>Clear filters</button>}
        </div>
        <label className="batch-search"><span className="muted xs">Tracking number</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Paste or scan a tracking number — or a batch code"
            aria-label="Search batches by tracking number or batch code" /></label>
        <p className="muted sm">Searches every batch, not just the recent ones — the number on any box counts, and the last few digits are enough.</p>
      </div>

      {searchingNow ? (
        <div className="card">
          <h3 className="rows-title">
            Matches <span className="muted">({found?.total ?? hits.length}{searching && found == null ? '…' : ''})</span>
          </h3>
          {!hits.length ? (
            searching ? <p className="muted">Searching…</p>
              : <p className="muted">No batch carries that number. Check the digits, or try the batch code printed on the carton.</p>
          ) : (
            <>
              <div className="batch-nav-list">{hits.map((b) => row(b, { showKind: true }))}</div>
              <Pager page={found?.page || page} pageSize={found?.pageSize || PAGE_FALLBACK} total={found?.total || 0}
                label="matches" onPage={(n) => setPageRaw(n === 1 ? '' : String(n))} />
            </>
          )}
          <button className="btn ghost sm" onClick={() => setQ('')}>Clear search</button>
        </div>
      ) : (
      <>

      <div className="card">
        <h3 className="rows-title">Open batches {open != null && <span className="muted">({openList.length})</span>}</h3>
        {open == null ? <p className="muted">Loading…</p>
          : !openList.length ? <p className="muted">No open batches{readOnly ? '.' : <>. Start one from <b>Receive New</b>.</>}</p> : (
            <>
              <div className="batch-nav-list">{openShown.map((b) => row(b))}</div>
              <Pager page={Math.min(openPage, openPages)} pageSize={OPEN_PAGE} total={openList.length}
                label="open" onPage={(n) => setOpenPageRaw(n === 1 ? '' : String(n))} />
            </>
          )}
      </div>

      <div className="card">
        <h3 className="rows-title">Recent batches</h3>
        {recent == null ? <p className="muted">Loading…</p>
          : !recentList.length ? (
            // An empty page past the end is NOT an empty list — the window count rides on
            // the rows, so there is nothing to count when you page off the end. Saying
            // "no batches" there would be a lie about the whole list.
            page > 1
              ? <p className="muted">Nothing on page {page}. <button className="btn ghost sm" onClick={() => setPageRaw('')}>Back to the first page</button></p>
              : <p className="muted">No closed batches yet.</p>
          ) : (
            <>
              <div className="batch-nav-list">{recentList.map((b) => row(b))}</div>
              <Pager page={recent?.page || page} pageSize={recent?.pageSize || PAGE_FALLBACK} total={recent?.total || 0}
                label="batches" onPage={(n) => setPageRaw(n === 1 ? '' : String(n))} />
            </>
          )}
      </div>
      </>
      )}
    </div>
  );
}
