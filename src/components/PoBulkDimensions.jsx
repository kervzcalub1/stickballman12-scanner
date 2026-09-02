// "They all ship in the same box" — one carton size across a whole manifest at once.
//
// An empty-box order is routinely thirty SKUs in one size of carton. Declaring that
// thirty times, on a phone, is how a wrong number gets in, so the dimensions are stated
// once here and per line only where a SKU actually differs (the Dimensions box on each
// row does the individual edit). Both go through the same server path, so the merge rule
// is the same: two lines of one SKU that end up on the same dimensions become one line
// with their quantities summed.
//
// Two scopes rather than a checkbox column: "every line" is what you reach for when the
// order is one carton throughout, and "only the ones still blank" is what you reach for
// after correcting a handful by hand — which is the whole reason a bulk apply must not
// silently overwrite a considered per-line value.
import React, { useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';
import { DimensionsFields, dimsComplete, dimsToText, emptyDims } from './PoDimensions.jsx';

export function PoBulkDimensions({ lines = [], disabled = false, onApplied, onSignOut }) {
  const [open, setOpen] = useState(false);
  const [dims, setDims] = useState(emptyDims);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  if (!lines.length) return null;
  const blank = lines.filter((l) => !l.dimensions);

  const apply = async (scope) => {
    const ids = (scope === 'blank' ? blank : lines).map((l) => Number(l.id));
    if (!ids.length) { setError('There are no lines to apply that to.'); return; }
    setBusy(true); setError(''); setNote('');
    try {
      const r = await api.poLinesDimensions(ids, dimsToText(dims));
      const done = (r.updated || 0) + (r.merged || 0);
      setNote(done
        ? `Set ${r.dimensions} on ${done} line${done === 1 ? '' : 's'}`
          + (r.merged ? `, merging ${r.merged} that became the same box.` : '.')
        : 'Those lines already carry that size.');
      onApplied?.();
    } catch (e) {
      if (e.unauthorized) return onSignOut?.();
      setError(e.message);
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button type="button" className="btn ghost sm po-bulk-dims-btn" disabled={disabled} onClick={() => setOpen(true)}>
        <Icon name="pencil" /> Set box size for {lines.length} line{lines.length === 1 ? '' : 's'}
        {blank.length > 0 && <span className="po-bulk-dims-n"> · {blank.length} blank</span>}
      </button>
    );
  }
  const ready = dimsComplete(dims);
  return (
    <div className="po-bulk-dims">
      <div className="po-bulk-dims-head">
        <b className="sm">Same box for many lines</b>
        <button type="button" className="btn icon ghost" aria-label="Close" onClick={() => { setOpen(false); setError(''); setNote(''); }}>×</button>
      </div>
      <DimensionsFields value={dims} onChange={setDims} disabled={busy || disabled} label="Box dimensions" />
      <div className="po-bulk-dims-actions">
        <button type="button" className="btn primary sm" disabled={!ready || busy || disabled} onClick={() => apply('all')}>
          {busy ? 'Applying…' : `Apply to all ${lines.length}`}
        </button>
        <button type="button" className="btn sm" disabled={!ready || busy || disabled || !blank.length}
          title="Leaves every line that already has a box size alone" onClick={() => apply('blank')}>
          Only the {blank.length} still blank
        </button>
      </div>
      <p className="muted xs">A line that already carries this exact size is left alone. Anything different is overwritten by “Apply to all”.</p>
      {error && <div className="error sm">{error}</div>}
      {note && <div className="po-bulk-dims-note sm">{note}</div>}
    </div>
  );
}
