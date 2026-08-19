// "Import manifest PDF" — the bulk version of *Add items on their behalf*.
//
// A supplier who doesn't scan out still sends a printed manifest: one page per box,
// each with its tracking number and a Product Name / SKU / Size / Qty table. Typing
// 18 of those into the per-box modal is an hour of work that a parser does exactly.
// So: read the PDF in the browser (src/lib/manifestImport.js — the inverse of the
// manifest PRINTER in manifestPdf.js; same approach as the shipping-labels import in
// trackingOcr.js), match each page to a label BY TRACKING NUMBER, show what
// will happen, and only then write — through the same on-behalf path, so every line
// is still stamped as entered by our team.
//
// It only fills labels that have NOTHING declared. A label already carrying a
// manifest is listed as skipped rather than merged into: this fills the gaps, it
// never silently doubles a count somebody already recorded. The server enforces that
// too, so a preview left open while someone else types can't apply twice.
import React, { useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';

const STATUS_TEXT = {
  ready: 'will be added',
  has_manifest: 'already has a manifest — skipped',
  unmatched: 'no label on this order matches',
  empty: 'no items could be read',
};

export function PoManifestImport({ po, boxes, lines, onImported, onSignOut }) {
  const fileRef = useRef(null);
  const [status, setStatus] = useState('');
  const [pages, setPages] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  // How many expected lines each label already carries — what decides "this label has
  // nothing on it yet". Same rule the server re-checks before writing.
  const boxesWithCounts = useMemo(() => {
    const counts = new Map();
    for (const l of lines || []) {
      const id = Number(l.po_box_id);
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return (boxes || []).map((b) => ({ ...b, lineCount: counts.get(Number(b.id)) || 0 }));
  }, [boxes, lines]);

  async function readFile(file) {
    if (!file) return;
    setError(''); setResult(null); setPages(null); setStatus('Reading PDF…');
    try {
      const { parseManifestPdf, matchPagesToBoxes } = await import('../lib/manifestImport.js');
      const parsed = await parseManifestPdf(file, (p, n) => setStatus(`Reading page ${p} of ${n}…`));
      if (!parsed.length) { setStatus(''); setError('That PDF had no pages to read.'); return; }
      setPages(matchPagesToBoxes(parsed, boxesWithCounts));
      setStatus('');
    } catch (e) {
      setStatus('');
      setError(`Could not read that PDF. ${e.message || ''}`.trim());
    }
  }

  const ready = (pages || []).filter((p) => p.status === 'ready');
  const readyUnits = ready.reduce((n, p) => n + p.unitCount, 0);

  async function doImport() {
    if (!ready.length) return;
    setBusy(true); setError('');
    try {
      const payload = ready.map((p) => ({ poBoxId: Number(p.box.id), lines: p.lines }));
      const r = await api.poManifestImport(Number(po.id), payload);
      setResult(r);
      setPages(null);
      onImported?.();
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setError(e.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="po-mf-import">
      <div className="po-mf-head">
        <span className="po-mf-title"><Icon name="receiving" /> Supplier sent a manifest PDF?</span>
        <button type="button" className="btn sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          Import manifest PDF…
        </button>
        <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden
          onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      <p className="muted xs po-mf-hint">
        One page per box. Each page is matched to a label by its tracking number, and only
        labels with nothing declared yet are filled — entered on the supplier's behalf.
      </p>

      {status ? <p className="muted sm">{status}</p> : null}
      {error ? <div className="error sm">{error}</div> : null}

      {result && (
        <div className="notice sm po-mf-result">
          Added <b>{result.applied.reduce((n, a) => n + a.units, 0)}</b> pair
          {result.applied.reduce((n, a) => n + a.units, 0) === 1 ? '' : 's'} across{' '}
          <b>{result.applied.length}</b> label{result.applied.length === 1 ? '' : 's'}.
          {result.skipped.length ? ` ${result.skipped.length} label${result.skipped.length === 1 ? '' : 's'} left untouched.` : ''}
        </div>
      )}

      {pages && (
        <div className="po-mf-preview">
          <div className="po-mf-summary">
            <b>{pages.length}</b> page{pages.length === 1 ? '' : 's'} read ·{' '}
            <b>{ready.length}</b> label{ready.length === 1 ? '' : 's'} to fill ·{' '}
            <b>{readyUnits}</b> pair{readyUnits === 1 ? '' : 's'}
            {pages.length - ready.length > 0 ? ` · ${pages.length - ready.length} skipped` : ''}
          </div>
          <div className="po-mf-rows">
            {pages.map((p) => (
              <div className={`po-mf-row ${p.status}`} key={p.page}>
                <span className="po-mf-page">p{p.page}</span>
                <span className="po-mf-box">
                  {p.box ? `Label ${p.box.box_number}` : `Box ${p.boxNumber ?? '?'}`}
                  {p.via === 'box number' ? <span className="muted xs"> · matched by box number</span> : null}
                </span>
                <span className="po-mf-trk muted xs">{p.tracking || '— no tracking on page'}</span>
                <span className="po-mf-units">{p.unitCount} pair{p.unitCount === 1 ? '' : 's'}</span>
                {/* The sheet prints its own Total. If ours disagrees the page didn't fully
                    parse, and importing it would under-declare the box — say so here rather
                    than let it land quietly in the expected counts. */}
                {p.declaredTotal != null && p.declaredTotal !== p.unitCount ? (
                  <span className="po-mf-warn">⚠ sheet says {p.declaredTotal}</span>
                ) : null}
                <span className="po-mf-status muted xs">{STATUS_TEXT[p.status]}</span>
              </div>
            ))}
          </div>
          <div className="po-mf-actions">
            <button className="btn sm primary" disabled={busy || !ready.length} onClick={doImport}>
              {busy ? 'Adding…' : `Add ${readyUnits} pair${readyUnits === 1 ? '' : 's'} to ${ready.length} label${ready.length === 1 ? '' : 's'}`}
            </button>
            <button className="btn sm ghost" disabled={busy} onClick={() => setPages(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
