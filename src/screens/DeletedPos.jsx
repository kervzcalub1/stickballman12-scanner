// Deleted POs (docs/context/purchase-orders.md): every purchase order deleted from the
// system, with who raised it, who deleted it, when and why — and everything it had
// (labels, tracking numbers, the manifest, the comment thread) frozen at the moment of
// deletion. Staff can download its labels PDF and RESTORE it exactly as it was.
// Orders deleted before the archive existed show as "Recovered": only what survived.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { PH_DATETIME } from '../lib/format.js';
import { downloadCSV } from '../lib/csv.js';
import { useLive } from '../hooks.js';
import { TopBar } from '../components/common.jsx';

const when = (v) => (v ? `${PH_DATETIME.format(new Date(v))} EST` : '—');

function saveBlob({ blob, filename }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function DeletedPos({ onBack, onHome, onSignOut, canRestore = false, onOpenPo }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);       // id
  const [detail, setDetail] = useState({});     // id -> full row
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [confirm, setConfirm] = useState(null); // row to restore

  const load = () => api.poDeletedList()
    .then((r) => setRows(r.rows || []))
    .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['deleted_pos'], load, { mount: false, minGap: 5000 });

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows || [];
    return (rows || []).filter((r) => [r.po_code, r.supplier_name, r.tag_code, r.deleted_by, r.po_created_by, r.reason]
      .some((v) => String(v || '').toLowerCase().includes(t)));
  }, [rows, q]);

  const toggle = async (r) => {
    if (open === r.id) { setOpen(null); return; }
    setOpen(r.id);
    if (!detail[r.id]) {
      try { const { row } = await api.poDeletedGet(r.id); setDetail((d) => ({ ...d, [r.id]: row })); }
      catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    }
  };
  const labels = async (r) => {
    setBusy(`l${r.id}`); setError('');
    try { saveBlob(await api.poDeletedLabels(r.id)); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(''); }
  };
  const restore = async () => {
    const r = confirm;
    setBusy(`r${r.id}`); setError('');
    try {
      const out = await api.poDeletedRestore(r.id);
      setConfirm(null); setMsg(`${out.poCode} is back on Purchase Orders.`); await load();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); setConfirm(null); }
    finally { setBusy(''); }
  };
  const csv = () => {
    const head = ['PO', 'Supplier', 'Tag', 'Status when deleted', 'Boxes', 'Units', 'Created by', 'Created', 'Deleted by', 'Role', 'Deleted', 'Reason', 'Restored'];
    const body = shown.map((r) => [r.po_code, r.supplier_name, r.tag_code, r.status, r.box_count, r.unit_count, r.po_created_by,
      when(r.po_created_at), r.deleted_by, r.deleted_by_role, r.deleted_at ? when(r.deleted_at) : 'unknown', r.reason,
      r.restored_at ? `${when(r.restored_at)} by ${r.restored_by || '?'}` : ''].map(esc).join(','));
    downloadCSV('deleted-purchase-orders.csv', [head.map(esc).join(','), ...body].join('\n'));
  };

  return (
    <div className="app">
      <TopBar title="Deleted POs" onHome={onHome} onSignOut={onSignOut} />
      <div className="wrap-narrow">
        <button type="button" className="btn ghost sm po-back" onClick={onBack}>← All purchase orders</button>
        <p className="muted sm">Every purchase order deleted from the system: who raised it, who deleted it, when and why, and everything it had when it went. Tap one to see it.</p>
        {error && <div className="po-err">{error}</div>}
        {msg && <div className="dpo-msg">{msg}</div>}
        <div className="dpo-tools">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="PO code, supplier, tag, who deleted it…" aria-label="Search deleted purchase orders" />
          <button type="button" className="btn ghost sm" onClick={csv} disabled={!shown.length}>⬇ CSV</button>
        </div>
        {rows == null ? <p className="muted">Loading…</p> : !shown.length ? <div className="card empty-state">{rows.length ? 'Nothing matches that search.' : 'No purchase order has been deleted.'}</div> : (
          <ul className="dpo-list">
            {shown.map((r) => {
              const d = detail[r.id];
              const c = d?.children || {};
              const rec = d?.recovered;
              return (
                <li key={r.id} className={`card dpo-row${r.restored_at ? ' restored' : ''}`}>
                  <button type="button" className="dpo-head" onClick={() => toggle(r)} aria-expanded={open === r.id}>
                    <span className="dpo-code">{r.po_code}</span>
                    <span className="dpo-sup">{[r.supplier_name, r.tag_code].filter(Boolean).join(' · ') || '—'}</span>
                    {r.is_recovered && <span className="dpo-chip rec" title="Deleted before the archive existed — only what survived is here">Recovered</span>}
                    {r.restored_at && <span className="dpo-chip ok">Restored</span>}
                    <span className="muted sm dpo-meta">
                      {r.box_count != null && `${r.box_count} box${r.box_count === 1 ? '' : 'es'}`}{r.unit_count ? ` · ${r.unit_count} pairs` : ''}{r.status ? ` · was ${r.status}` : ''}
                    </span>
                    <span className="sm dpo-who">
                      Created by <b>{r.po_created_by || 'unknown'}</b>{r.po_created_at ? ` · ${when(r.po_created_at)}` : ''}<br />
                      Deleted by <b>{r.deleted_by || 'unknown'}</b>{r.deleted_by_role ? ` (${r.deleted_by_role})` : ''} · {r.deleted_at ? when(r.deleted_at) : 'date unknown'}
                      {r.reason && <><br />Reason: {r.reason}</>}
                      {r.restored_at && <><br />Restored by <b>{r.restored_by || '?'}</b> · {when(r.restored_at)}</>}
                    </span>
                  </button>
                  {open === r.id && (
                    <div className="dpo-body">
                      {!d ? <p className="muted">Loading…</p> : (
                        <>
                          <div className="dpo-acts">
                            {(r.labels_key || rec?.labels_key) && <button type="button" className="btn ghost sm" disabled={busy === `l${r.id}`} onClick={() => labels(r)}>{busy === `l${r.id}` ? 'Downloading…' : '⬇ Labels PDF'}</button>}
                            {r.restored_at && onOpenPo && <button type="button" className="btn ghost sm" onClick={() => onOpenPo(r.po_id)}>Open {r.po_code}</button>}
                            {canRestore && !r.restored_at && !r.is_recovered && <button type="button" className="btn primary sm" onClick={() => setConfirm(r)}>↩ Restore</button>}
                          </div>
                          {d.po_json && (
                            <dl className="dpo-facts">
                              <div><dt>Purchased</dt><dd>{d.po_json.date_of_purchase ? String(d.po_json.date_of_purchase).slice(0, 10) : '—'}</dd></div>
                              <div><dt>Kind</dt><dd>{d.po_json.order_kind || 'shoes'}{d.po_json.by_store ? ' · store order' : ''}</dd></div>
                              <div><dt>Raised by</dt><dd>{d.po_json.raised_by === 'supplier' ? 'the supplier' : 'our team'}</dd></div>
                              <div><dt>Labels</dt><dd>{d.po_json.labels_name || '—'}{d.po_json.labels_uploaded_by ? ` (by ${d.po_json.labels_uploaded_by})` : ''}</dd></div>
                              {d.po_json.notes && <div className="wide"><dt>Notes</dt><dd>{d.po_json.notes}</dd></div>}
                            </dl>
                          )}
                          {rec && (
                            <div className="dpo-rec">
                              <b>What survived</b>
                              {rec.summary && <p className="sm">{rec.summary}</p>}
                              {rec.likely_reraised_as && <p className="sm">Most likely raised again as <b>{rec.likely_reraised_as}</b>{rec.reraised_note ? ` — ${rec.reraised_note}` : ''}.</p>}
                              {Array.isArray(rec.label_tags) && rec.label_tags.length > 0 && (
                                <p className="sm">Written on its labels: {rec.label_tags.join(' · ')}</p>
                              )}
                              {rec.sources && <p className="muted sm">Found in: {rec.sources}</p>}
                            </div>
                          )}
                          {(c.po_boxes || []).length > 0 && (
                            <>
                              <h4 className="dpo-h">Boxes / labels</h4>
                              <table className="dpo-table"><thead><tr><th>Box</th><th>Tracking #</th><th>Status</th></tr></thead>
                                <tbody>{c.po_boxes.map((b) => <tr key={b.id}><td>{b.box_number}{b.kind === 'replacement' ? ' (reship)' : ''}</td><td className="mono">{b.tracking_number || '—'}</td><td>{b.status}</td></tr>)}</tbody></table>
                            </>
                          )}
                          {(c.po_lines || []).length > 0 && (
                            <>
                              <h4 className="dpo-h">Manifest</h4>
                              <table className="dpo-table"><thead><tr><th>SKU</th><th>Shoe</th><th>Size</th><th>Qty</th></tr></thead>
                                <tbody>{c.po_lines.map((l) => <tr key={l.id}><td className="mono">{l.sku || '—'}</td><td>{l.name || ''}</td><td>{l.size || l.dimensions || ''}</td><td>{l.qty_expected}</td></tr>)}</tbody></table>
                            </>
                          )}
                          {(c.po_comments || []).length > 0 && (
                            <>
                              <h4 className="dpo-h">Comments</h4>
                              <ul className="dpo-comments">{c.po_comments.map((m) => <li key={m.id}><b>{m.author_name || '?'}</b> <span className="muted sm">{when(m.created_at)}</span><br />{m.body}</li>)}</ul>
                            </>
                          )}
                          {d.po_json && !(c.po_boxes || []).length && !(c.po_lines || []).length && <p className="muted sm">No boxes or manifest lines were on it.</p>}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {confirm && (
        <div className="modal-overlay" onClick={() => !busy && setConfirm(null)}>
          <div className="modal confirm" role="dialog" aria-modal="true" aria-label={`Restore ${confirm.po_code}`} onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Restore {confirm.po_code}?</h3>
            <p className="modal-msg">It comes back exactly as it was when it was deleted: same number, labels, boxes, manifest and comments.</p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setConfirm(null)} disabled={!!busy}>Cancel</button>
              <button className="btn primary" onClick={restore} disabled={!!busy}>{busy ? 'Restoring…' : 'Restore'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
