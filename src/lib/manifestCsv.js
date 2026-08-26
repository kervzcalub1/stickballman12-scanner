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

// A declared amount, or null. BLANK IS NOT ZERO: a line the supplier left empty has
// nothing said about it, and writing 0 into the cell would invent a number — the same
// rule the Costs page enforces. An empty cell also keeps SUM() honest in a spreadsheet.
const declared = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const money = (n) => (n == null ? '' : n.toFixed(2));
// Cost and tip are both PER PAIR, per size, so a line is qty x (cost + tip).
function moneyCells(l) {
  const c = declared(l.unit_cost); const t = declared(l.tip);
  const q = Number(l.qty_expected) || 0;
  return {
    cost: money(c), tip: money(t),
    line: money(c == null && t == null ? null : ((c || 0) + (t || 0)) * q),
  };
}

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
        ...moneyCells(l),
      };
    });
}

// The whole order as one list, however it was declared.
function wholeRows({ lines }) {
  const m = new Map();
  for (const l of lines || []) {
    const k = `${l.sku}|${l.size}`;
    const cur = m.get(k);
    // Same SKU+size declared on two labels merges into one row, so its money merges
    // too: the per-pair cost is carried from the first line that named one (they are
    // the same pair at the same price), and the line total re-derives from the merged
    // qty rather than being added up out of step with it.
    if (cur) {
      cur.qty += Number(l.qty_expected) || 0;
      cur._cost = cur._cost ?? declared(l.unit_cost);
      cur._tip = cur._tip ?? declared(l.tip);
    } else {
      m.set(k, {
        name: l.name || '', sku: l.sku || '', size: l.size || '', qty: Number(l.qty_expected) || 0,
        _cost: declared(l.unit_cost), _tip: declared(l.tip),
      });
    }
  }
  return [...m.values()].map((r) => ({
    name: r.name, sku: r.sku, size: r.size, qty: r.qty,
    cost: money(r._cost), tip: money(r._tip),
    line: money(r._cost == null && r._tip == null ? null : ((r._cost || 0) + (r._tip || 0)) * r.qty),
  }));
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

// Money columns ride on the END of the row so an existing sheet's columns keep their
// positions — anyone with a saved formula or a pivot pointing at column D still works.
const MONEY_COLS = [['cost', 'Cost per pair'], ['tip', 'Tip per pair'], ['line', 'Line total']];

const SHAPES = {
  perbox: {
    cols: [['box', 'Box'], ['tracking', 'Tracking'], ['name', 'Item'], ['sku', 'SKU'], ['size', 'Size'], ['qty', 'Pairs declared']],
    money: true,
    rows: perBoxRows,
  },
  whole: {
    cols: [['name', 'Item'], ['sku', 'SKU'], ['size', 'Size'], ['qty', 'Pairs declared']],
    money: true,
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
  // `received` and `discrepancies` are OUR count of what came out of the box, not what
  // the supplier declared — there is no per-line money on them, so they stay unpriced
  // whatever the caller asks for.
  const cols = data?.prices && shape.money ? [...shape.cols, ...MONEY_COLS] : shape.cols;
  return toCsv(cols, rows);
}
