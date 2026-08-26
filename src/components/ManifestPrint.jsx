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
import { buildManifestCsv } from '../lib/manifestCsv.js';
import { loadPrefs, savePrefs } from '../prefs.js';

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
export function ManifestPrint({ poId, poCode, boxId = null, boxNumber = null, label = 'Download:', buttonLabel = 'Print box manifest', primary = false, received = null, compare = null, boxDiffs = null, onSignOut }) {
  const [busy, setBusy] = useState('');   // '' | 'perbox' | 'whole' | 'received' | 'discrepancies'
  const [error, setError] = useState('');
  // PDF or CSV, remembered per device: whoever prints these does the same thing every
  // time — one person signs and files paper, another lives in a spreadsheet — and
  // re-picking the format on every download is the kind of small tax that makes people
  // stop using the export.
  const [fmt, setFmt] = useState(() => (loadPrefs().reportFormat === 'csv' ? 'csv' : 'pdf'));
  const pickFmt = (v) => { setFmt(v); savePrefs({ ...loadPrefs(), reportFormat: v }); };
  // What the supplier typed per size — cost and tip per pair, plus the line total.
  // OFF by default, and deliberately not just "always on": the per-box sheet is the
  // one that gets taped INSIDE the parcel, so money goes on it only when somebody asks
  // for it. Remembered per device like the format, because whoever pulls these reports
  // wants the same thing every time.
  const [prices, setPrices] = useState(() => loadPrefs().manifestPrices === true);
  const pickPrices = (v) => { setPrices(v); savePrefs({ ...loadPrefs(), manifestPrices: v }); };

  if (!poId) return null;

  // One line under each button saying what it is and when to reach for it. The four
  // reports split two ways and the split is the thing worth teaching: the first two are
  // the SUPPLIER's declaration in two shapes, the last two are OUR count. Reach for a
  // supplier-side sheet to plan or unpack, an our-side sheet to settle an argument.
  const REPORTS = {
    perbox: ['Per box', 'What the supplier declared, one page per label — the only one with tracking numbers. Print it and tick pairs off as you unpack.'],
    whole: ['Whole order', 'Everything declared as one merged list, no boxes. The total — for checking an invoice, or a manifest they just submitted.'],
    received: ['What we received', 'Our own count, box by box, with their list beside it. This is the sheet you send a supplier when a shipment is short.'],
    discrepancies: ['Discrepancies by box', 'Only the boxes that disagree, and by how much. The short sheet you carry back into the warehouse to re-check them.'],
  };
  const reportBtn = (mode) => (
    <div className="mf-report">
      <button className="btn ghost sm" disabled={!!busy} onClick={() => run(mode)}>
        <Icon name="download" /> {busy === mode ? 'Building…' : REPORTS[mode][0]}
      </button>
      <span className="mf-report-what">{REPORTS[mode][1]}</span>
    </div>
  );

  const run = async (mode) => {
    setBusy(mode); setError('');
    try {
      // Fetched per click, not cached: the component stays mounted across `poId`
      // changes (Reconciliation drives the open PO off a query param), and lines can
      // be minutes stale after an on-behalf manifest edit.
      const d = await api.poGet(poId);
      const generatedAt = `Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} EST`;
      // Both formats are built from the SAME inputs, so a CSV can never disagree with
      // the PDF of the same report.
      const input = {
        po: d.po, boxes: d.boxes, lines: d.lines, businessName: d.businessName, mode, generatedAt,
        boxId: mode === 'perbox' ? boxId : null, shipTo: d.shipTo,
        receivedBoxes: received, compare, boxDiffs, prices,
      };
      let blob;
      if (fmt === 'csv') {
        const text = buildManifestCsv(mode, input);
        if (!text) { setError('That report has no rows to export yet.'); return; }
        blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      } else {
        blob = (await buildManifestPdf(input)).output('blob');
      }
      // Download rather than auto-print: the thermal-label iframe trick fires .print()
      // before a multi-page PDF viewer has rendered, and navigating a popup to a blob
      // PDF is flaky across browsers. A download works everywhere — the user opens the
      // file and prints it with the OS dialog.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const which = boxId != null && mode === 'perbox'
        ? `box-${boxNumber ?? boxId}`
        : mode === 'received' ? 'received'
          : mode === 'discrepancies' ? 'by-box'
            : (mode === 'perbox' ? 'per-box' : 'whole-order');
      const kind = mode === 'received' ? 'received' : mode === 'discrepancies' ? 'discrepancies' : 'manifest';
      a.download = `${kind}-${d.po?.po_code || poCode || poId}-${which}.${fmt}`;
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
        <button className={`btn sm ${primary ? 'primary' : ''}`} disabled={!!busy}
          onClick={() => { pickPrices(false); run('perbox'); }}>
          <Icon name="download" /> {busy && !prices ? 'Building…' : buttonLabel}
        </button>
        {/* A SEPARATE button, not a toggle on the one above: the packing sheet gets
            taped inside the parcel, and a remembered checkbox could quietly put your
            costs on it. This one is for checking your own numbers. */}
        <button className="btn ghost sm" disabled={!!busy} title="The same list with the cost and tip you entered for each size"
          onClick={() => { pickPrices(true); run('perbox'); }}>
          <Icon name="download" /> {busy && prices ? 'Building…' : 'With my prices'}
        </button>
        {error && <span className="mf-print-err sm">{error}</span>}
      </div>
    );
  }

  return (
    <div className="mf-print">
      <span className="muted xs">{label}</span>
      <span className="seg sm mf-fmt" role="group" aria-label="Download format">
        {[['pdf', 'PDF'], ['csv', 'CSV']].map(([v, l]) => (
          <button key={v} type="button" className={`seg-btn ${fmt === v ? 'on' : ''}`}
            aria-pressed={fmt === v} disabled={!!busy} onClick={() => pickFmt(v)}>{l}</button>
        ))}
      </span>
      <label className="mf-prices" title="Add the cost and tip entered for each size, and a line total">
        <input type="checkbox" checked={prices} disabled={!!busy} onChange={(e) => pickPrices(e.target.checked)} />
        <span>Prices</span>
      </label>
      <div className="mf-reports">
        {reportBtn('perbox')}
        {reportBtn('whole')}
        {/* Only once something has actually been received — an empty "here's what we got"
            sheet is worse than no sheet in a dispute. */}
        {received?.length > 0 && reportBtn('received')}
        {/* Only when a box actually differs: a "discrepancies" sheet listing none of them
            is indistinguishable from one nobody produced. */}
        {boxDiffs?.some((b) => b.received && b.diffs?.length > 0) && reportBtn('discrepancies')}
      </div>
      {error && <span className="mf-print-err sm">{error}</span>}
    </div>
  );
}
