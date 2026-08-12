// Batch Page (V6 Feature 7) — a navigator/manager for multi-box receiving
// batches. Lists OPEN (resumable) batches and recent/closed ones; open a batch
// to see its boxes + progress and manage it: add a box (→ scan items into it via
// the Receiving box-mode), or finish / reopen. The Receiving page remains the
// main place to START a batch (expected boxes + tag live there).
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, StatusPill, Modal } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';

const shortDate = (s) => String(s || '').slice(0, 10);

export function BatchPage({ initialBatchId = null, onAddBox, onOpenItem, onHome, onSignOut }) {
  const [open, setOpen] = useState(null);     // open batches
  const [recent, setRecent] = useState(null); // recent (all) batches
  const [selId, setSelId] = useState(initialBatchId);
  const [detail, setDetail] = useState(null); // { batch, boxes, items }
  const [openBox, setOpenBox] = useState(null); // box id whose items are expanded
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reopenId, setReopenId] = useState(null);

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
  useEffect(() => { setOpenBox(null); if (selId) loadDetail(selId); else setDetail(null); }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps

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
            {isOpen && <button className="btn primary sm" onClick={() => onAddBox(b)}>+ Add box</button>}
          </div>
          {!boxes.length ? <p className="muted">No boxes yet{isOpen ? ' — tap “Add box” to scan the first one.' : '.'}</p> : (
            <div className="box-list">
              {boxes.map((bx) => {
                const boxItems = itemsByBox.get(String(bx.id)) || [];
                const isBoxOpen = openBox === bx.id;
                const empty = bx.item_count === 0;
                return (
                  <div className={`box-row-wrap ${isBoxOpen ? 'open' : ''}`} key={bx.id}>
                    <button className="box-row" onClick={() => setOpenBox(isBoxOpen ? null : bx.id)} title={boxItems.length ? 'Show shoes in this box' : 'No shoes in this box yet'}>
                      <span className="box-caret">{boxItems.length ? (isBoxOpen ? '▾' : '▸') : '·'}</span>
                      <span className="box-num">Box {bx.box_number}</span>
                      <span className="box-track muted sm">{bx.tracking_number || 'no tracking'}</span>
                      <span className="box-count" style={empty ? { color: '#e08f8f', fontWeight: 600 } : undefined}>{bx.item_count} item{bx.item_count === 1 ? '' : 's'}</span>
                      <span className={`box-status ${bx.status}`}>{bx.status === 'received' ? '✓ received' : 'pending'}</span>
                    </button>
                    {isBoxOpen && (
                      <div className="box-items">
                        {!boxItems.length ? <div className="muted sm box-items-empty">No shoes in this box yet.</div> : boxItems.map((it) => (
                          <div className="batch-detail-row" key={it.id}>
                            <button className="vin vin-link" onClick={() => onOpenItem?.(it.vin)} title="View full shoe detail + history">{it.vin}</button>
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
          {isOpen
            ? <button className="btn ghost" disabled={busy} onClick={() => setStatus(b.id, 'done')}>Finish batch</button>
            : <button className="btn ghost" disabled={busy} onClick={() => setReopenId(b.id)}>Reopen</button>}
          {isOpen && <button className="btn primary" onClick={() => onAddBox(b)}>+ Add box</button>}
        </div>
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
  return (
    <div className="app">
      <TopBar title="Batches" onHome={onHome} onSignOut={onSignOut} />
      {error && <div className="error mt">{error}</div>}

      <div className="card">
        <h3 className="rows-title">Open batches <span className="muted">({openList.length})</span></h3>
        {open == null ? <p className="muted">Loading…</p>
          : !openList.length ? <p className="muted">No open batches. Start one from <b>Receive New</b>.</p> : (
            <div className="batch-nav-list">
              {openList.map((b) => (
                <button className="batch-nav-row" key={b.id} onClick={() => setSelId(b.id)}>
                  <div className="batch-nav-main">
                    <span className="batch-code">{b.batch_code} {b.item_count === 0 && <span className="badge warn">Empty</span>}</span>
                    <span className="muted sm">{b.supplier_name || '—'}{b.batch_tag ? <> · <Icon name="tag" /> {b.batch_tag}</> : ''}{b.date_received ? ` · ${shortDate(b.date_received)}` : ''}</span>
                  </div>
                  <span className="batch-nav-prog"><b>{b.received_boxes}{b.expected_boxes ? `/${b.expected_boxes}` : ''}</b> boxes · {b.item_count} items</span>
                  <span className="batch-caret">▸</span>
                </button>
              ))}
            </div>
          )}
      </div>

      <div className="card">
        <h3 className="rows-title">Recent batches</h3>
        {recent == null ? <p className="muted">Loading…</p>
          : !recentList.length ? <p className="muted">No closed batches yet.</p> : (
            <div className="batch-nav-list">
              {recentList.slice(0, 30).map((b) => (
                <button className="batch-nav-row" key={b.id} onClick={() => setSelId(b.id)}>
                  <div className="batch-nav-main">
                    <span className="batch-code">{b.batch_code}</span>
                    <span className="muted sm">{b.supplier_name || '—'} · {shortDate(b.date_received || b.created_at)}</span>
                  </div>
                  <span className="batch-nav-prog">{b.item_count} item{b.item_count === 1 ? '' : 's'}</span>
                  <span className="batch-caret">▸</span>
                </button>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}
