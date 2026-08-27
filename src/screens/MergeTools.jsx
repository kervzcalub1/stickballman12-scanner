// Merge duplicates — SUPERADMIN ONLY (2026-08-28).
//
// Two tools, one shape: **preview, then confirm.** Both merges are irreversible from the
// screen, and both rewrite records other people rely on, so neither can be fired from a
// name alone — you see what would move before you move it. "Erick" carrying 123 units is
// a different decision from "Erick" carrying none.
//
//  · Suppliers — one person typed two ways. Rewrites the name on batches and purchase
//    orders and drops the losing name from the dropdown. The supplier's LOGIN and payout
//    preset are deliberately left alone; the preview says so rather than staying silent.
//  · Batches — two batches that are really one inbound. Boxes and items move; a source
//    that kept its tracking on the batch itself becomes a box inside the target. The
//    losing batch is emptied, never deleted, because its code is on printed labels.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { TopBar, Modal } from '../components/common.jsx';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function SupplierMerge({ onSignOut }) {
  const [names, setNames] = useState([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const load = () => api.suppliers()
    .then((r) => setNames(r.suppliers || []))
    .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function check() {
    setError(''); setPreview(null); setDone(null); setBusy(true);
    try { setPreview((await api.previewSupplierMerge(from, to)).preview); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError('');
    try {
      const r = await api.mergeSuppliers(from, to);
      setDone(r.result); setPreview(null); setFrom(''); setTo('');
      await load();
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="card settings-card">
      <h3 className="settings-h">Merge suppliers</h3>
      <p className="muted sm">One person entered twice — <b>Erick</b> and <b>Erick lujano</b>. The losing
        name is rewritten on every batch and purchase order, then dropped from the dropdown.</p>
      <div className="merge-row">
        <label>Merge this name
          <select value={from} onChange={(e) => { setFrom(e.target.value); setPreview(null); setDone(null); }}>
            <option value="">Choose…</option>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <span className="merge-arrow" aria-hidden="true">→</span>
        <label>into this one
          <select value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); setDone(null); }}>
            <option value="">Choose…</option>
            {names.filter((n) => n !== from).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button className="btn ghost" disabled={!from || !to || busy} onClick={check}>Check</button>
      </div>
      {error && <div className="error mt">{error}</div>}
      {done && (
        <div className="merge-done">
          <b>{done.from}</b> is now <b>{done.to}</b> — {plural(done.batches, 'batch', 'batches')} and{' '}
          {plural(done.pos, 'purchase order')} moved{done.units ? `, carrying ${plural(done.units, 'pair')}` : ''}.
        </div>
      )}
      {preview && (
        <div className="merge-preview">
          <h4>What moves</h4>
          <ul>
            <li><b>{plural(preview.batches, 'batch', 'batches')}</b>{preview.units ? <> holding <b>{plural(preview.units, 'pair')}</b></> : null}</li>
            <li><b>{plural(preview.pos, 'purchase order')}</b></li>
            <li>{preview.inList ? <>“{preview.from}” is removed from the supplier dropdown</> : <>“{preview.from}” isn’t in the dropdown — only old stock carries it</>}</li>
          </ul>
          {/* Named explicitly rather than left to assumption: these exist and are NOT
              part of the merge, which is the thing a reader would otherwise wonder. */}
          {(preview.accounts.length > 0 || preview.presets.length > 0) && (
            <p className="muted sm merge-untouched">
              Left untouched:{' '}
              {preview.accounts.map((a) => `the login “${a.username}”`).join(', ')}
              {preview.accounts.length && preview.presets.length ? ' and ' : ''}
              {preview.presets.map((p) => `the payout preset “${p.name}”`).join(', ')}.
              A login is a credential and a preset is scoped to an account, so neither follows a name.
            </p>
          )}
          {preview.batches === 0 && preview.pos === 0 && (
            <p className="muted sm">Nothing is filed under this name — merging only tidies the dropdown.</p>
          )}
          <button className="btn primary" disabled={busy} onClick={apply}>
            Merge {preview.from} into {preview.to}
          </button>
        </div>
      )}
    </div>
  );
}

function BatchMerge({ onSignOut }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const [source, setSource] = useState(null);
  const [target, setTarget] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  // The same search the Batches page uses — a batch code OR the tracking number on any of
  // its boxes, which is what someone holding two duplicate parcels actually has.
  useEffect(() => {
    const query = q.trim();
    if (!query) { setHits(null); return undefined; }
    const t = setTimeout(() => {
      api.batchList({ kind: 'receiving', q: query })
        .then((r) => setHits(r.batches || []))
        .catch((e) => { if (e.unauthorized) return onSignOut(); setError(e.message); });
    }, 250);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  async function check(src, tgt) {
    setError(''); setPreview(null); setDone(null); setBusy(true);
    try { setPreview((await api.previewBatchMerge(src.id, tgt.id)).preview); }
    catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError('');
    try {
      const r = await api.mergeBatches(source.id, target.id);
      setDone(r.result); setPreview(null); setConfirm(false);
      setSource(null); setTarget(null); setQ(''); setHits(null);
    } catch (e) { if (e.unauthorized) return onSignOut(); setError(e.message); }
    finally { setBusy(false); }
  }

  const pick = (b) => {
    if (!source) { setSource(b); return; }
    if (source.id === b.id) { setSource(null); setPreview(null); return; }
    setTarget(b); check(source, b);
  };
  const line = (b) => `${b.batch_code} · ${b.item_count} item${b.item_count === 1 ? '' : 's'} · ${b.status}${b.tracking_number ? ` · ${b.tracking_number}` : ''}`;

  return (
    <div className="card settings-card">
      <h3 className="settings-h">Merge batches</h3>
      <p className="muted sm">Two batches that are really one inbound — a parcel received on its own
        beside the rest of its shipment. Boxes and pairs move to the batch you keep; the other is
        emptied and marked “merged into”, never deleted, because its code is on printed labels.</p>
      <label className="batch-search"><span className="muted xs">Find a batch</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Batch code, or the tracking number on any of its boxes"
          aria-label="Find a batch by code or tracking number" /></label>
      <p className="muted sm">Pick the batch to <b>merge away</b> first, then the one to <b>keep</b>.</p>

      <div className="merge-picked">
        <span>Merge away: <b>{source ? source.batch_code : '—'}</b></span>
        <span className="merge-arrow" aria-hidden="true">→</span>
        <span>Keep: <b>{target ? target.batch_code : '—'}</b></span>
        {(source || target) && (
          <button className="btn ghost sm" onClick={() => { setSource(null); setTarget(null); setPreview(null); }}>Reset</button>
        )}
      </div>

      {hits != null && (
        <div className="merge-hits">
          {!hits.length ? <p className="muted sm">No batch matches that.</p> : hits.slice(0, 8).map((b) => (
            <button key={b.id} className={`merge-hit ${source?.id === b.id ? 'picked' : ''}`} onClick={() => pick(b)}>
              {line(b)}
            </button>
          ))}
        </div>
      )}

      {error && <div className="error mt">{error}</div>}
      {done && (
        <div className="merge-done">
          <b>{done.source}</b> was merged into <b>{done.target}</b> — {plural(done.items, 'pair')} and{' '}
          {plural(done.boxes, 'box', 'boxes')} moved
          {done.looseAttached ? `, ${plural(done.looseAttached, 'pair')} attached to its box by tracking number` : ''}.
        </div>
      )}

      {preview && (
        <div className="merge-preview">
          <h4>What moves</h4>
          <ul>
            <li><b>{plural(preview.units, 'pair')}</b> from <b>{preview.source.batch_code}</b> into <b>{preview.target.batch_code}</b></li>
            <li><b>{plural(preview.boxes.length, 'box', 'boxes')}</b>{preview.boxes.length ? ` (${preview.boxes.map((b) => `box ${b.box_number}`).join(', ')}) — renumbered after the ones already there` : ''}</li>
            {preview.looseGoesTo?.kind === 'existing-box' && (
              <li><b>{plural(preview.loose, 'pair')}</b> with no box join <b>box {preview.looseGoesTo.box_number}</b>, matched by tracking number</li>
            )}
            {preview.looseGoesTo?.kind === 'new-box' && (
              <li><b>{plural(preview.loose, 'pair')}</b> with no box become a new box carrying <code>{preview.looseGoesTo.tracking_number}</code></li>
            )}
            {preview.looseGoesTo?.kind === 'stays-loose' && (
              <li><b>{plural(preview.loose, 'pair')}</b> stay unboxed — that batch has no tracking number, and inventing a box would invent a parcel</li>
            )}
          </ul>
          <button className="btn primary" disabled={busy} onClick={() => setConfirm(true)}>
            Merge {preview.source.batch_code} into {preview.target.batch_code}
          </button>
        </div>
      )}

      {confirm && preview && (
        <Modal type="warn" title={`Merge ${preview.source.batch_code} into ${preview.target.batch_code}?`}
          message={`${plural(preview.units, 'pair')} move. This cannot be undone from this screen — ${preview.source.batch_code} keeps its code but ends up empty, pointing at ${preview.target.batch_code}.`}
          onClose={() => setConfirm(false)}>
          <button className="btn primary" disabled={busy} onClick={apply}>Merge them</button>
          <button className="btn ghost" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
        </Modal>
      )}
    </div>
  );
}

export function MergeTools({ onHome, onSignOut }) {
  return (
    <div className="app">
      <TopBar title="Merge duplicates" onHome={onHome} onSignOut={onSignOut} />
      <div className="wrap-narrow">
        <p className="muted sm">Superadmin only. Both tools show you what would move before anything moves.</p>
        <SupplierMerge onSignOut={onSignOut} />
        <BatchMerge onSignOut={onSignOut} />
      </div>
    </div>
  );
}
