// "Manifest PDF: [Per box] [Whole order]" — the expected contents of an inbound
// purchase order as a printable packing slip.
//
// Extracted from `PoOverview` (PH) so the WAREHOUSE gets the same thing at the two
// moments it's useful — linking a PO in Receiving (print it, then check pairs off as
// you unpack) and reviewing one in PO Reconciliation — without three copies of the
// download logic drifting apart.
//
// It always re-fetches `po/get` on click rather than trusting a `detail` the caller
// already holds. Three reasons, all of which bit the alternative: `po/get` is the only
// endpoint that returns `businessName` (the PDF letterhead — `poOpen`/`poLookup` omit
// it, so Receiving's copy would print a generic header); the caller's lines can be
// minutes stale after an on-behalf manifest edit; and one code path means callers pass
// nothing but an id. The cost is one request per print, on an explicit user action.
import React, { useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';
import { buildManifestPdf } from '../lib/manifestPdf.js';

// `boxId` switches this to the SUPPLIER's one-box sheet: a single button that builds the
// page for the label they just closed, so it can be taped to that box before it's sealed.
// Everything else (fetch, Letter size, download-don't-print) is the same code path.
// `received` switches it to OUR count: what the warehouse actually pulled out of each
// box, plus a their-list-vs-our-count page. That's the sheet you send a supplier when a
// shipment is short, so it's driven by the reconciliation data the caller already has
// (`receivedBoxes` / `compare`) rather than the supplier's manifest.
// `boxDiffs` adds the DISCREPANCY sheet: only the boxes whose contents disagree with
// what that label declared. It's the sheet somebody carries into the warehouse, so it's
// offered only when there is actually something to look at.
export function ManifestPrint({ poId, poCode, boxId = null, boxNumber = null, label = 'Manifest PDF:', buttonLabel = 'Print box manifest', primary = false, received = null, compare = null, boxDiffs = null, onSignOut }) {
  const [busy, setBusy] = useState('');   // '' | 'perbox' | 'whole' | 'received' | 'discrepancies'
  const [error, setError] = useState('');

  if (!poId) return null;

  const run = async (mode) => {
    setBusy(mode); setError('');
    try {
      // Fetched per click, not cached: the component stays mounted across `poId`
      // changes (Reconciliation drives the open PO off a query param), and lines can
      // be minutes stale after an on-behalf manifest edit.
      const d = await api.poGet(poId);
      const generatedAt = `Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} EST`;
      const doc = await buildManifestPdf({
        po: d.po, boxes: d.boxes, lines: d.lines, businessName: d.businessName, mode, generatedAt,
        boxId: mode === 'perbox' ? boxId : null, shipTo: d.shipTo,
        receivedBoxes: received, compare, boxDiffs,
      });
      // Download rather than auto-print: the thermal-label iframe trick fires .print()
      // before a multi-page PDF viewer has rendered, and navigating a popup to a blob
      // PDF is flaky across browsers. A download works everywhere — the user opens the
      // file and prints it with the OS dialog.
      const url = URL.createObjectURL(doc.output('blob'));
      const a = document.createElement('a');
      a.href = url;
      const which = boxId != null && mode === 'perbox'
        ? `box-${boxNumber ?? boxId}`
        : mode === 'received' ? 'received'
          : mode === 'discrepancies' ? 'by-box'
            : (mode === 'perbox' ? 'per-box' : 'whole-order');
      const kind = mode === 'received' ? 'received' : mode === 'discrepancies' ? 'discrepancies' : 'manifest';
      a.download = `${kind}-${d.po?.po_code || poCode || poId}-${which}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      if (e?.unauthorized && onSignOut) return onSignOut();
      setError(e?.message || 'Could not build the manifest.');
    } finally { setBusy(''); }
  };

  if (boxId != null) {
    return (
      <div className="mf-print">
        <button className={`btn sm ${primary ? 'primary' : ''}`} disabled={!!busy} onClick={() => run('perbox')}>
          <Icon name="download" /> {busy ? 'Building…' : buttonLabel}
        </button>
        {error && <span className="mf-print-err sm">{error}</span>}
      </div>
    );
  }

  return (
    <div className="mf-print">
      <span className="muted xs">{label}</span>
      <button className="btn ghost sm" disabled={!!busy} onClick={() => run('perbox')}>
        <Icon name="download" /> {busy === 'perbox' ? 'Building…' : 'Per box'}
      </button>
      <button className="btn ghost sm" disabled={!!busy} onClick={() => run('whole')}>
        <Icon name="download" /> {busy === 'whole' ? 'Building…' : 'Whole order'}
      </button>
      {/* Only once something has actually been received — an empty "here's what we got"
          sheet is worse than no sheet in a dispute. */}
      {received?.length > 0 && (
        <button className="btn ghost sm" disabled={!!busy} onClick={() => run('received')}>
          <Icon name="download" /> {busy === 'received' ? 'Building…' : 'What we received'}
        </button>
      )}
      {/* Only when a box actually differs: a "discrepancies" sheet listing none of them
          is indistinguishable from one nobody produced. */}
      {boxDiffs?.some((b) => b.received && b.diffs?.length > 0) && (
        <button className="btn ghost sm" disabled={!!busy} onClick={() => run('discrepancies')}>
          <Icon name="download" /> {busy === 'discrepancies' ? 'Building…' : 'Discrepancies by box'}
        </button>
      )}
      {error && <span className="mf-print-err sm">{error}</span>}
    </div>
  );
}
