// PO Phase 3: reconciliation. Warehouse/PH review a received PO's expected-vs-
// received table (grouped by SKU+size), see per-line flags (match / shortage /
// overage / wrong-size / wrong-sku), copy a discrepancy report to send the
// supplier in the group chat, and (warehouse) reconcile & close the PO — which
// freezes the snapshot onto it. See docs/context/purchase-orders.md.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, copyToClipboard } from '../components/common.jsx';
import { Icon } from '../components/NavIcons.jsx';

const FLAG = {
  match:      { label: 'Match', cls: 'ok' },
  shortage:   { label: 'Short', cls: 'bad' },
  overage:    { label: 'Over', cls: 'warn' },
  wrong_size: { label: 'Wrong size', cls: 'warn' },
  wrong_sku:  { label: 'Not on PO', cls: 'bad' },
};

function flagText(r) {
  if (r.flag === 'shortage') return `Short ${r.expected - r.received}`;
  if (r.flag === 'overage') return `Over +${r.received - r.expected}`;
  return FLAG[r.flag]?.label || r.flag;
}

// Plain-text discrepancy report for the group chat.
function buildReport(po, rows, summary) {
  const bad = rows.filter((r) => r.flag !== 'match');
  // Received with no manifest: nothing was declared, so a per-line "not on PO" list is
  // noise — report the totals and that it was received blind instead.
  if (summary.no_manifest) {
    const lines = [`${po.po_code} · ${po.supplier_name}`,
      `No manifest was provided for this shipment — received blind.`,
      `${summary.received_units} unit${summary.received_units === 1 ? '' : 's'} received and logged; none were pre-declared, so nothing is flagged as a discrepancy.`];
    return lines.join('\n');
  }
  const lines = [`${po.po_code} · ${po.supplier_name}`,
    `Received ${summary.received_units} of ${summary.expected_units} expected units.`];
  if (bad.length === 0) { lines.push('All items matched — no discrepancies. ✅'); return lines.join('\n'); }
  lines.push('', 'Discrepancies:');
  for (const r of bad) {
    const label = r.flag === 'shortage' ? `short ${r.expected - r.received}`
      : r.flag === 'overage' ? `over +${r.received - r.expected}`
      : r.flag === 'wrong_size' ? 'wrong size — not on the PO'
      : 'not on the PO';
    lines.push(`- ${r.sku} size ${r.size}: ${label} (expected ${r.expected}, got ${r.received})`);
  }
  if (summary.match) lines.push('', `Matched: ${summary.match} line${summary.match === 1 ? '' : 's'}.`);
  return lines.join('\n');
}

export function Reconciliation({ canReconcile, onHome, onSignOut }) {
  const [pos, setPos] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null); // { po, rows, summary }
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadList = () => {
    api.poReconcileList()
      .then((r) => setPos(r.pos || []))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  };
  useEffect(loadList, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (id) => {
    setOpenId(id); setDetail(null); setError(''); setCopied(false);
    api.poReconciliation(id)
      .then((r) => setDetail({ po: r.po, rows: r.rows, summary: r.summary }))
      .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  };

  const doReconcile = async () => {
    if (!window.confirm('Reconcile & close this PO? This freezes the current received-vs-expected snapshot.')) return;
    setBusy(true);
    try {
      const r = await api.poReconcile(openId);
      setDetail({ po: r.po, rows: r.rows, summary: r.summary });
      loadList();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  };

  const doArchive = async () => {
    if (!window.confirm('Archive this PO? It drops off the reconciliation list.')) return;
    setBusy(true);
    try {
      await api.poClose(openId);
      setOpenId(null); setDetail(null); loadList();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  };

  const copyReport = async () => {
    const ok = await copyToClipboard(buildReport(detail.po, detail.rows, detail.summary));
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1800); }
  };

  // ---- List ----
  if (!openId) {
    return (
      <div className="app">
        <TopBar title="PO Reconciliation" onHome={onHome} onSignOut={onSignOut} />
        <div className="wrap-narrow">
          {error && <div className="po-err">{error}</div>}
          {pos == null ? <p className="muted">Loading…</p>
            : pos.length === 0 ? <div className="card empty-state">No received purchase orders yet. Reconciliation shows up here once a PO has been received against.</div>
            : (
              <div className="po-list">
                {pos.map((p) => (
                  <button key={p.id} className="po-card" onClick={() => open(p.id)}>
                    <div className="po-card-top">
                      <span className="po-code">{p.po_code}</span>
                      <span className={`po-chip ${p.status === 'reconciled' ? 'ok' : 'receiving'}`}>{p.status === 'reconciled' ? 'Reconciled' : 'To reconcile'}</span>
                    </div>
                    <div className="po-card-meta">
                      <span>{p.supplier_name}</span>
                      {p.tag_code && <span>{p.tag_code}</span>}
                      <span>{p.unit_count} expected unit{p.unit_count === 1 ? '' : 's'}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
        </div>
      </div>
    );
  }

  // ---- Detail ----
  const po = detail?.po; const s = detail?.summary;
  return (
    <div className="app">
      <TopBar title={po ? po.po_code : 'Reconciliation'} onHome={onHome} onSignOut={onSignOut}
        right={<button className="btn ghost sm" onClick={() => { setOpenId(null); setDetail(null); }}>← All</button>} />
      <div className="wrap-narrow">
        {error && <div className="po-err">{error}</div>}
        {!po ? <p className="muted">Loading…</p> : (
          <>
            <div className="card">
              <div className="po-card-top">
                <h3 className="rows-title">{po.po_code}{po.tag_code ? ` · ${po.tag_code}` : ''}</h3>
                <span className={`po-chip ${po.status === 'reconciled' ? 'ok' : 'receiving'}`}>{po.status === 'reconciled' ? 'Reconciled' : 'To reconcile'}</span>
              </div>
              <p className="muted sm">{po.supplier_name} · received <b>{s.received_units}</b> of <b>{s.expected_units}</b> expected units</p>
              {s.no_manifest ? (
                <p className="rc-no-manifest sm">
                  <b>No manifest provided.</b> The supplier didn’t scan out and no one entered a manifest on their behalf, so every received unit is logged but nothing is flagged as a discrepancy. The items below are what the warehouse actually received.
                </p>
              ) : (
                <div className="rc-summary">
                  {s.match ? <span className="po-flag ok">{s.match} match</span> : null}
                  {s.shortage ? <span className="po-flag bad">{s.shortage} short</span> : null}
                  {s.overage ? <span className="po-flag warn">{s.overage} over</span> : null}
                  {s.wrong_size ? <span className="po-flag warn">{s.wrong_size} wrong size</span> : null}
                  {s.wrong_sku ? <span className="po-flag bad">{s.wrong_sku} not on PO</span> : null}
                  {s.clean ? <span className="po-flag ok">All matched ✓</span> : null}
                </div>
              )}
              {po.manifest_scope === 'po' && !s.no_manifest && (
                <p className="muted xs" style={{ marginTop: '8px' }}>Whole-order manifest — matched on order totals, no per-box breakdown.</p>
              )}
            </div>

            <div className="card">
              <div className="rc-table">
                <div className="rc-row rc-head">
                  <span>SKU / size</span><span className="rc-n">Exp</span><span className="rc-n">Got</span><span className="rc-flag">Status</span>
                </div>
                {detail.rows.map((r, i) => (
                  <div className={`rc-row ${r.flag}`} key={i}>
                    <span className="rc-item"><b>{r.sku || '—'}</b> · size {r.size}<span className="muted rc-name"> · {r.name}</span></span>
                    <span className="rc-n">{r.expected}</span>
                    <span className="rc-n">{r.received}</span>
                    <span className="rc-flag">{s.no_manifest
                      ? <span className="po-flag">Received</span>
                      : <span className={`po-flag ${FLAG[r.flag]?.cls || ''}`}>{flagText(r)}</span>}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rc-actions">
              <button className="btn ghost" onClick={copyReport}>{copied ? 'Copied ✓' : 'Copy report'}</button>
              {canReconcile && po.status === 'receiving' && (
                <button className="btn primary" disabled={busy} onClick={doReconcile}>{busy ? 'Reconciling…' : 'Reconcile & close'}</button>
              )}
              {po.status === 'reconciled' && po.reconciled_at && (
                <span className="muted sm"><Icon name="reconcile" /> Reconciled {String(po.reconciled_at).slice(0, 10)}</span>
              )}
              {canReconcile && po.status === 'reconciled' && (
                <button className="btn ghost" disabled={busy} onClick={doArchive}>Archive</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
