// Batch Page (V6 Feature 7) — a navigator/manager for multi-box receiving
// batches. Lists OPEN (resumable) batches and recent/closed ones; open a batch
// to see its boxes + progress and manage it: add a box (→ scan items into it via
// the Receiving box-mode), or finish / reopen. The Receiving page remains the
// main place to START a batch (expected boxes + tag live there).
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';

const shortDate = (s) => String(s || '').slice(0, 10);

export function BatchPage({ initialBatchId = null, onAddBox, onOpenItem, onHome, onSignOut }) {
  const [open, setOpen] = useState(null);     // open batches
  const [recent, setRecent] = useState(null); // recent (all) batches
  const [selId, setSelId] = useState(initialBatchId);
  const [detail, setDetail] = useState(null); // { batch, boxes }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
  useEffect(() => { if (selId) loadDetail(selId); else setDetail(null); }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps

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
              <div className="muted sm">{b.supplier_name || '—'} · {shortDate(b.date_received || b.created_at)}{b.batch_tag ? <> · <Icon name="tag" /> {b.batch_tag}</> : ''}</div>
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
              {boxes.map((bx) => (
                <div className="box-row" key={bx.id}>
                  <span className="box-num">Box {bx.box_number}</span>
                  <span className="box-track muted sm">{bx.tracking_number || '—'}</span>
                  <span className="box-count">{bx.item_count} item{bx.item_count === 1 ? '' : 's'}</span>
                  <span className={`box-status ${bx.status}`}>{bx.status === 'received' ? '✓ received' : 'pending'}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <div className="error mt">{error}</div>}
        <div className="batch-bar">
          <button className="btn ghost" onClick={() => setSelId(null)}>← Back</button>
          {isOpen
            ? <button className="btn ghost" disabled={busy} onClick={() => setStatus(b.id, 'done')}>Finish batch</button>
            : <button className="btn ghost" disabled={busy} onClick={() => setStatus(b.id, 'open')}>Reopen</button>}
          {isOpen && <button className="btn primary" onClick={() => onAddBox(b)}>+ Add box</button>}
        </div>
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
                    <span className="batch-code">{b.batch_code}</span>
                    <span className="muted sm">{b.supplier_name || '—'}{b.batch_tag ? <> · <Icon name="tag" /> {b.batch_tag}</> : ''}</span>
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
