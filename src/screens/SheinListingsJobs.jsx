// SHEIN Listings → Jobs tab: every server job (Re-read, Ask SHEIN, …) with its progress. A job
// runs on the server — closing the tab never stops it; a server restart leaves it
// "interrupted" with Resume, which carries on from the first unfinished product. `?job=<id>`
// opens one job's items; its CSV has every item.
import React, { useState } from 'react';
import { ProgressBar } from '../components/common.jsx';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { downloadCSV } from '../lib/csv.js';
import { estToday } from '../lib/format.js';
import { fmt, when, NEEDS_PRIV } from '../components/SheinListingsBits.jsx';
import { DryRunView } from '../components/SheinDryRunSheet.jsx';
import { isUpdateOps, isPublishOps } from '../lib/sheinListings.js';

export const KIND_LABEL = { snapshot: 'Re-read Shopify + SHEIN', probe: 'Ask SHEIN (read-only)', recheck: 'Shopify change recheck', preview: 'Dry run', run: 'Send to SHEIN' };
// A dry run says which of the two it is (scope.ops: add sizes, or update prices & sizes).
export const jobLabel = (j) => (j?.kind === 'preview' ? `Dry run · ${isPublishOps(j.scope?.ops) ? 'publish new products' : isUpdateOps(j.scope?.ops) ? 'update prices & sizes' : 'add sizes'}` : KIND_LABEL[j?.kind] || j?.kind);
const JOB_CHIP = { done: 'ok', running: 'info', queued: '', stopped: '', failed: 'bad', interrupted: 'warn', awaiting_confirm: 'violet' };
const JOB_WORD = { done: 'Done', running: 'Running', queued: 'Queued', stopped: 'Stopped', failed: 'Failed', interrupted: 'Interrupted', awaiting_confirm: 'Waiting for you' };
const ITEM_CHIP = { done: 'ok', failed: 'bad', skipped: '', pending: '', sending: 'info', sent: 'info', in_review: 'violet', deferred: 'warn', changed: 'warn' };

function took(j) {
  const a = j.started_at || j.created_at; const b = j.finished_at;
  if (!a || !b) return '—';
  const s = Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}
function result(j) {
  const c = j.counts || {};
  if (j.kind === 'snapshot' && c.products != null) return `${fmt(c.products)} products · ${fmt(c.shein_products)} on SHEIN · ${fmt(c.shein_calls)} SHEIN reads · ${fmt(c.shein_writes)} writes`;
  if (j.kind === 'probe' && c.categories != null) return `${fmt(c.categories)} categories · ${fmt(c.shein_calls)} SHEIN reads · ${fmt(c.shein_writes)} writes${c.errors ? ` · ${fmt(c.errors)} errors` : ''}`;
  if (j.kind === 'preview' && c.products != null && isPublishOps(j.scope?.ops)) return `${fmt(c.publishable)} of ${fmt(c.products)} ready to publish · ${fmt(c.publish_sizes)} sizes · ${fmt(c.shein_writes)} SHEIN writes`;
  if (j.kind === 'preview' && c.products != null && isUpdateOps(j.scope?.ops)) return `${fmt(c.sendable)} changes · ${fmt(c.prices)} prices (${fmt(c.price_rises)} up) · ${fmt(c.sizes_on)} sizes back on · ${fmt(c.relinks)} SKUs · ${fmt(c.shein_writes)} SHEIN writes`;
  if (j.kind === 'preview' && c.products != null) return `${fmt(c.sendable)} of ${fmt(c.products)} products to send · ${fmt(c.sizes)} sizes · ${fmt(c.shein_writes)} SHEIN writes`;
  if (j.kind === 'run' && Object.keys(c).length) return ['in_review', 'done', 'deferred', 'changed', 'failed'].filter((k) => c[k]).map((k) => `${fmt(c[k])} ${({ in_review: 'in review', done: 'done', deferred: 'waiting', changed: 'not sent (Shopify changed)', failed: 'error' })[k]}`).join(' · ') || `${fmt(c.shein_writes || 0)} SHEIN writes`;
  return j.total ? `${fmt(j.done)} of ${fmt(j.total)}` : '—';
}
const JobChip = ({ status }) => <span className={`ebo-chip ${JOB_CHIP[status] || ''}`.trim()}>{JOB_WORD[status] || status}</span>;

function JobDetail({ id, onBack, onSignOut, canWrite, isAdmin, setJob }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    try { setD(await api.sheinListingJob(id)); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useLive(['shein_listing_jobs', 'shein_listing_job_items'], load, { every: d?.job?.status === 'running' ? 5_000 : 60_000 });
  async function csv() {
    setBusy(true);
    try {
      const r = await api.sheinListingJobAll(id);
      const cols = ['seq', 'shopify_product_id', 'spu', 'op', 'status', 'attempts', 'error', 'trace_id', 'updated_at'];
      const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      downloadCSV(`SHEIN listings job ${id} ${estToday()}.csv`, [cols.join(','), ...(r.items || []).map((it) => cols.map((k) => esc(it[k])).join(','))].join('\n'));
      if (r.truncated) setErr(`The CSV has the first ${Number(r.cap).toLocaleString('en-US')} items only — filter by status for the rest.`);
    } catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setBusy(false); }
  }
  const j = d?.job;
  // A dry run / a send: the same view as the sheet (review, Confirm, per-product status, Retry).
  if (['preview', 'run'].includes(j?.kind)) {
    return (
      <>
        <button type="button" className="btn ghost sm shl-back" onClick={onBack}>← All jobs</button>
        <DryRunView inline jobId={id} canWrite={canWrite} isAdmin={isAdmin} onSwitch={(n) => setJob(String(n))} onSignOut={onSignOut} />
      </>
    );
  }
  return (
    <div className="card">
      <button type="button" className="btn ghost sm" onClick={onBack}>← All jobs</button>
      {err && <p className="error sm mt">{err}</p>}
      {!d && !err && <div className="shl-skel shl-skel-row mt" />}
      {j && (
        <>
          <h3 className="er-step-title mt">Job #{j.id} · {jobLabel(j)} <JobChip status={j.status} /></h3>
          <p className="muted sm">Started {when(j.started_at || j.created_at)}{j.started_by ? ` by ${j.started_by}` : ''}{j.finished_at ? ` · ended ${when(j.finished_at)} (${took(j)})` : ''}{j.resumes ? ` · resumed ${fmt(j.resumes)}×` : ''}</p>
          {j.phase && <p className="sm">{j.phase}{j.current ? ` · now ${j.current}` : ''}</p>}
          {['running', 'queued'].includes(j.status) && <ProgressBar value={j.total ? j.done / j.total : 0} indeterminate={!j.total} label={j.total ? `${fmt(j.done)} of ${fmt(j.total)} SHEIN products` : undefined} />}
          {j.error && <p className="error sm">{j.error}</p>}
          <p className="sm">{result(j)}</p>
          <div className="shl-chiprow">{Object.entries(d.itemCounts || {}).map(([k, n]) => <span key={k} className={`ebo-chip ${ITEM_CHIP[k] || ''}`.trim()}>{fmt(n)} {k}</span>)}</div>
          <div className="er-actions">
            <button type="button" className="btn ghost sm" disabled={busy || !d.items?.length} onClick={csv}>{busy ? 'Preparing CSV…' : '⬇ Every item (CSV)'}</button>
          </div>
          {d.items?.length > 0 && (
            <table className="shl-rtable mt">
              <thead><tr><th className="num">#</th><th>SHEIN product</th><th>Step</th><th>Status</th><th>Note</th></tr></thead>
              <tbody>
                {d.items.slice(0, 300).map((it) => (
                  <tr key={it.id}>
                    <td data-label="#" className="num">{it.seq}</td>
                    <td data-label="Product" className="shl-mono">{it.spu || it.shopify_product_id || '—'}</td>
                    <td data-label="Step">{it.op === 'read' ? 'read' : it.op}</td>
                    <td data-label="Status"><span className={`ebo-chip ${ITEM_CHIP[it.status] || ''}`.trim()}>{it.status}</span></td>
                    <td data-label="Note" className="xs">{it.error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d.items?.length > 300 && <p className="muted xs">Showing 300 of {fmt(d.items.length)} on this page — the CSV has every item.</p>}
        </>
      )}
    </div>
  );
}

export function SheinListingsJobs({ job, setJob, active, canWrite, isAdmin, connected, onAct, busy, onSignOut }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  async function load() {
    try { setD(await api.sheinListingJobs()); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useLive(['shein_listing_jobs'], load, { every: active ? 5_000 : 60_000 });
  const id = Number(job) || 0;
  if (id) return <JobDetail id={id} onBack={() => setJob('')} onSignOut={onSignOut} canWrite={canWrite} isAdmin={isAdmin} setJob={setJob} />;
  const jobs = d?.jobs || [];
  const a = d?.active || active;
  return (
    <>
      {a && (
        <div className="card shl-jobcard">
          <h3 className="er-step-title">Running now: #{a.id} · {jobLabel(a)}</h3>
          <p className="muted sm">{a.phase || a.status}{a.current ? ` · now ${a.current}` : ''} · started {when(a.started_at || a.created_at)}{a.started_by ? ` by ${a.started_by}` : ''}. It runs on the server — closing this tab doesn’t stop it.</p>
          <ProgressBar value={a.total ? a.done / a.total : 0} indeterminate={!a.total} label={a.total ? `${fmt(a.done)} of ${fmt(a.total)}` : 'Starting…'} />
          <div className="er-actions">
            <button type="button" className="btn ghost sm" disabled={!!busy || a.stop_requested} onClick={() => onAct('stop', { jobId: a.id })}>{a.stop_requested ? 'Stopping after this product…' : 'Stop after this product'}</button>
            <button type="button" className="btn ghost sm" onClick={() => setJob(String(a.id))}>Open →</button>
          </div>
        </div>
      )}
      <div className="card">
        <h3 className="er-step-title">Jobs</h3>
        {err && <p className="error sm">{err}</p>}
        {!d && !err && <><div className="shl-skel shl-skel-row" /><div className="shl-skel shl-skel-row" /></>}
        {d && !jobs.length && <div className="empty-state">No jobs yet. “Re-read Shopify + SHEIN” starts the first one.</div>}
        {jobs.length > 0 && (
          <table className="shl-rtable">
            <thead><tr><th className="num">#</th><th>What</th><th>Started</th><th>By</th><th>Status</th><th>Result</th><th>Took</th><th /></tr></thead>
            <tbody>
              {jobs.map((j) => {
                const canResume = ['interrupted', 'stopped'].includes(j.status) && ['snapshot', 'probe'].includes(j.kind);
                const resumeOk = connected && !a && (j.kind !== 'probe' || canWrite);
                return (
                  <tr key={j.id}>
                    <td data-label="#" className="num">{j.id}</td>
                    <td data-label="What">{jobLabel(j)}</td>
                    <td data-label="Started">{when(j.started_at || j.created_at)}</td>
                    <td data-label="By">{j.started_by || '—'}</td>
                    <td data-label="Status"><JobChip status={j.status} />{j.error && <span className="shl-bad-text xs shl-block">{j.error}</span>}</td>
                    <td data-label="Result" className="xs">{result(j)}</td>
                    <td data-label="Took">{took(j)}</td>
                    <td data-label="" className="shl-rt-act">
                      <button type="button" className="btn xs" onClick={() => setJob(String(j.id))}>{j.status === 'awaiting_confirm' ? 'Review →' : 'Open'}</button>
                      {canResume && <button type="button" className="btn xs" disabled={!resumeOk || !!busy} title={!resumeOk ? (j.kind === 'probe' && !canWrite ? NEEDS_PRIV : !connected ? 'Connect SHEIN first' : 'A job is already running') : 'Carries on from the first unfinished product'}
                        onClick={() => onAct('resume', { jobId: j.id }, `Job #${j.id} resumed on the server.`)}>Resume</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
