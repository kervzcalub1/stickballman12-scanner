// The same four PO reports as CSV — the spreadsheet half of `manifestPdf.js`.
//
// A PDF is what you print, sign and send. A CSV is what someone pivots, sorts and
// pastes into the message to the supplier. The reports carry identical data either
// way; only the shape differs, so the two must be generated from the SAME inputs
// (`ManifestPrint` passes exactly what it hands the PDF builder).
//
// One row = one line, with the box repeated on every row rather than written once as a
// heading: a spreadsheet with heading rows can't be sorted or filtered, which is the
// only reason to want a CSV in the first place.

const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// cols: [[key, 'Label'], …]
export function toCsv(cols, rows) {
  const head = cols.map(([, label]) => esc(label)).join(',');
  const body = rows.map((r) => cols.map(([k]) => esc(r[k])).join(',')).join('\n');
  return `${head}\n${body}`;
}

const boxLabel = (b) => (b?.kind === 'replacement' ? 'Replacement' : b?.box_number ?? '');

// What the supplier declared, per label.
function perBoxRows({ boxes, lines, boxId }) {
  const byId = new Map((boxes || []).map((b) => [String(b.id), b]));
  return (lines || [])
    .filter((l) => l.po_box_id != null && (boxId == null || String(l.po_box_id) === String(boxId)))
    .map((l) => {
      const b = byId.get(String(l.po_box_id));
      return {
        box: boxLabel(b), tracking: b?.tracking_number || '',
        name: l.name || '', sku: l.sku || '', size: l.size || '', qty: l.qty_expected ?? '',
      };
    });
}

// The whole order as one list, however it was declared.
function wholeRows({ lines }) {
  const m = new Map();
  for (const l of lines || []) {
    const k = `${l.sku}|${l.size}`;
    const cur = m.get(k);
    if (cur) cur.qty += Number(l.qty_expected) || 0;
    else m.set(k, { name: l.name || '', sku: l.sku || '', size: l.size || '', qty: Number(l.qty_expected) || 0 });
  }
  return [...m.values()];
}

// OUR count, per box we opened.
function receivedRows({ receivedBoxes }) {
  return (receivedBoxes || []).flatMap((b) => (b.items || []).map((i) => ({
    box: b.box_number ?? '', tracking: b.tracking_number || '',
    name: i.name || '', sku: i.sku || '', size: i.size || '', qty: i.qty ?? '',
  })));
}

// Discrepancies per box. Clean boxes are kept as ONE row each ("no difference") for the
// same reason the PDF names them: a sheet of nothing but problems can't be told apart
// from one where nobody looked.
function discrepancyRows({ boxDiffs }) {
  const out = [];
  for (const b of boxDiffs || []) {
    if (!b.received) {
      out.push({ box: b.box_number, declared: b.expected_units, counted: '', result: 'not received yet', qty: '', name: '', sku: '', size: '' });
      continue;
    }
    if (!b.diffs?.length) {
      out.push({ box: b.box_number, declared: b.expected_units, counted: b.received_units, result: 'no difference', qty: '', name: '', sku: '', size: '' });
      continue;
    }
    for (const d of b.diffs) {
      out.push({
        box: b.box_number, declared: b.expected_units, counted: b.received_units,
        result: d.kind === 'missing' ? 'short' : 'extra', qty: d.qty,
        name: d.name || '', sku: d.sku || '', size: d.size || '',
      });
    }
  }
  return out;
}

const SHAPES = {
  perbox: {
    cols: [['box', 'Box'], ['tracking', 'Tracking'], ['name', 'Item'], ['sku', 'SKU'], ['size', 'Size'], ['qty', 'Pairs declared']],
    rows: perBoxRows,
  },
  whole: {
    cols: [['name', 'Item'], ['sku', 'SKU'], ['size', 'Size'], ['qty', 'Pairs declared']],
    rows: wholeRows,
  },
  received: {
    cols: [['box', 'Box'], ['tracking', 'Tracking'], ['name', 'Item'], ['sku', 'SKU'], ['size', 'Size'], ['qty', 'Pairs counted']],
    rows: receivedRows,
  },
  discrepancies: {
    cols: [['box', 'Box'], ['declared', 'Declared'], ['counted', 'Counted'], ['result', 'Result'],
      ['qty', 'Pairs'], ['name', 'Item'], ['sku', 'SKU'], ['size', 'Size']],
    rows: discrepancyRows,
  },
};

// mode → CSV text. Returns '' for a mode with nothing in it, so the caller can say so
// rather than handing someone a file with a header row and no data.
export function buildManifestCsv(mode, data) {
  const shape = SHAPES[mode];
  if (!shape) return '';
  const rows = shape.rows(data) || [];
  if (!rows.length) return '';
  return toCsv(shape.cols, rows);
}
