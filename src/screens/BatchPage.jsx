// Batch Page (V6 Feature 7) — a navigator/manager for multi-box receiving
// batches. Lists OPEN (resumable) batches and recent/closed ones; open a batch
// to see its boxes + progress and manage it: add a box (→ scan items into it via
// the Receiving box-mode), or finish / reopen. The Receiving page remains the
// main place to START a batch (expected boxes + tag live there).
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, StatusPill, Modal } from '../components/common.jsx';
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
export function BatchPage({ initialBatchId = null, onAddBox, onOpenItem, onHome, onSignOut, readOnly = false }) {
  const [open, setOpen] = useState(null);     // open batches
  const [recent, setRecent] = useState(null); // recent (all) batches
  const [selId, setSelId] = useState(initialBatchId);
  const [detail, setDetail] = useState(null); // { batch, boxes, items }
  const [openBox, setOpenBox] = useState(null); // box id whose items are expanded
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reopenId, setReopenId] = useState(null);
  // The box whose number is being corrected, + the number typed for it.
  const [renumber, setRenumber] = useState(null); // { box, value }
  // The number on the parcel, kept in ?q= so "the batch this box belongs to" is a link
  // you can paste to whoever is asking.
  const [q, setQ] = useQueryParam('q');
  const [found, setFound] = useState(null);    // server search results (null = not searching)
  const [searching, setSearching] = useState(false);

  async function loadLists() {
    setError('');
    try {
      const [o, r] = await Promise.all([api.openBatches(), api.batchList('receiving')]);
      setOpen(o.batches || []);
      setRecent(r.batches || []);
    } catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }
  async function loadDetail(id) {
    setError('');
    try { const d = await api.batchFull(id); setDetail(d); }
    catch (err) { if (err.unauthorized) return onSignOut(); setError(err.message); }
  }

  useEffect(() => { loadLists(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The search runs on the SERVER, not over the two lists above. Those are windowed
  // (100 newest, 30 shown) and the carton in someone's hand is as likely to be from
  // March — filtering the window would answer "no such batch" for a batch that exists.
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
      api.batchList('receiving', query)
        .then((r) => setFound(r.batches || []))
        .catch((err) => { if (err.unauthorized) return onSignOut(); setError(err.message); setFound([]); })
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOpenBox(null); if (selId) loadDetail(selId); else setDetail(null); }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    return (
      <div className="app">
        <TopBar title="Batch" onHome={onHome} onSignOut={onSignOut}
          right={<button className="btn ghost sm" onClick={() => setSelId(null)}>← Batches</button>} />
        <div className="card">
          <div className="batch-page-head">
            <div>
              <div className="batch-page-code">{b.batch_code} {isOpen ? <span className="badge open">Open</span> : <span className="badge done">Done</span>}</div>
              {/* A stated "no tracking number" is worth showing — otherwise this batch
                  looks like one whose tracking simply never got typed in. */}
              <div className="muted sm">{b.supplier_name || '—'} · {shortDate(b.date_received || b.created_at)}{b.batch_tag ? <> · <Icon name="tag" /> {b.batch_tag}</> : ''}{b.tracking_number ? <> · {b.tracking_number}</> : b.no_tracking ? <> · no tracking #</> : ''}</div>
            </div>
            <div className="batch-progress">
              <b>{received}{expected ? `/${expected}` : ''}</b><span className="muted sm"> boxes</span>
            </div>
          </div>
          {expected ? (
            <div className="progress-bar"><span style={{ width: `${Math.min(100, Math.round((received / expected) * 100))}%` }} /></div>
          ) : null}
        </div>

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
                        {!boxItems.length ? <div className="muted sm box-items-empty">No shoes in this box yet.</div> : boxItems.map((it) => (
                          <div className="batch-detail-row" key={it.id}>
                            {onOpenItem
                              ? <button className="vin vin-link" onClick={() => onOpenItem(it.vin)} title="View full shoe detail + history">{it.vin}</button>
                              : <span className="vin">{it.vin}</span>}
                            <span className="batch-row-name">{it.name}</span>
                            <span className="muted sm">{it.sku || '—'} · size {it.size || '—'}</span>
                            <StatusPill status={it.status} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {error && <div className="error mt">{error}</div>}
        <div className="batch-bar">
          <button className="btn ghost" onClick={() => setSelId(null)}>← Back</button>
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
  const openList = open || [];
  const recentList = (recent || []).filter((r) => !openList.some((o) => o.id === r.id));
  const searchingNow = !!q.trim();
  // While the server answer is in flight, filter what's already on screen — the batch
  // someone wants is usually the one they just received, and a list that reacts as you
  // type beats a spinner. The server result replaces it a moment later, wider.
  const localHits = searchingNow
    ? [...openList, ...recentList].filter((b) => batchMatchesSearch(b, q))
    : [];
  const hits = found ?? localHits;

  const row = (b, { showKind = false } = {}) => (
    <button className="batch-nav-row" key={b.id} onClick={() => setSelId(b.id)}>
      <div className="batch-nav-main">
        <span className="batch-code">{b.batch_code}
          {b.item_count === 0 && <span className="badge warn">Empty</span>}
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
        <label className="batch-search"><span className="muted xs">Tracking number</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Paste or scan a tracking number — or a batch code"
            aria-label="Search batches by tracking number or batch code" /></label>
        <p className="muted sm">Searches every batch, not just the recent ones — the number on any box counts, and the last few digits are enough.</p>
      </div>

      {searchingNow ? (
        <div className="card">
          <h3 className="rows-title">
            Matches <span className="muted">({hits.length}{searching && found == null ? '…' : ''})</span>
          </h3>
          {!hits.length ? (
            searching ? <p className="muted">Searching…</p>
              : <p className="muted">No batch carries that number. Check the digits, or try the batch code printed on the carton.</p>
          ) : (
            <div className="batch-nav-list">{hits.map((b) => row(b, { showKind: true }))}</div>
          )}
          <button className="btn ghost sm" onClick={() => setQ('')}>Clear search</button>
        </div>
      ) : (
      <>

      <div className="card">
        <h3 className="rows-title">Open batches <span className="muted">({openList.length})</span></h3>
        {open == null ? <p className="muted">Loading…</p>
          : !openList.length ? <p className="muted">No open batches{readOnly ? '.' : <>. Start one from <b>Receive New</b>.</>}</p> : (
            <div className="batch-nav-list">{openList.map((b) => row(b))}</div>
          )}
      </div>

      <div className="card">
        <h3 className="rows-title">Recent batches</h3>
        {recent == null ? <p className="muted">Loading…</p>
          : !recentList.length ? <p className="muted">No closed batches yet.</p> : (
            <div className="batch-nav-list">{recentList.slice(0, 30).map((b) => row(b))}</div>
          )}
      </div>
      </>
      )}
    </div>
  );
}
