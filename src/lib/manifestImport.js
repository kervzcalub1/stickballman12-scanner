// Read an inbound-shipment manifest PDF INTO structured lines — the inverse of
// `manifestPdf.js`, which writes one. PH imports what a supplier sent instead of
// typing it in box by box. Same idea as the shipping-labels import in
// `trackingOcr.js`: one page = one box, read the page's own text layer, and hand the
// result back for a human to confirm before anything is written.
//
// It reads BOTH templates: the supplier's own sheet (Product Name / SKU / Size / Qty)
// and the one this app prints (ITEM / SKU / SIZE / PAIRS), so a manifest we generated
// can be re-imported as well as one we received.
//
// The sheet looks like this (one per box, 18 boxes = 18 pages):
//
//     INBOUND SHIPMENT MANIFEST
//     Supplier: Andrew B.(Chris)
//     Box Number: 1/18
//     Tracking Number: 1Z 3YY 408 03 1745 7414
//     PRODUCT DETAILS
//     Product Name | SKU        | Size | Qty
//     Alphafly     | IM6673 100 | 15   | 1
//     …
//     Total | 12
//
// Text-layer only, no OCR fallback: these are generated PDFs, not scans, and a
// silently mis-OCR'd SKU or qty would be written into the expected counts the
// warehouse then reconciles against. A page we can't read is reported as unreadable
// so someone can look at it.

// PDF text comes back as loose fragments with coordinates. Group them into visual
// rows by y (rounded, since a row's fragments jitter by a fraction of a point), then
// order each row left-to-right by x.
export function rowsFromTextContent(content) {
  const buckets = new Map();
  for (const it of content.items || []) {
    const s = (it?.str ?? '').trim();
    if (!s) continue;
    const x = it.transform?.[4] ?? 0;
    const y = it.transform?.[5] ?? 0;
    const key = Math.round(y / 4) * 4;          // 4pt tolerance = one visual line
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ s, x });
  }
  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])                 // PDF y grows upward: top row first
    .map(([, cells]) => cells.sort((a, b) => a.x - b.x).map((c) => c.s));
}

// "IM6673 100" → "IM6673-100". The manifest prints style codes with a space; our
// items carry the dashed form, and the PO reconciliation keys on
// `trim().toUpperCase()` WITHOUT stripping separators (`rcSku` in db.js) — so
// importing the printed form verbatim would leave every single line unmatched and
// report a fully-correct shipment as "wrong SKU". Normalising here is what makes
// the imported manifest reconcilable at all.
export function normalizeManifestSku(raw) {
  return String(raw || '').trim().toUpperCase().replace(/\s+/g, '-');
}

// Tracking numbers are printed spaced ("1Z 3YY 408 03 1745 7414") and stored however
// they were captured, so compare on alphanumerics alone.
export const trackingKey = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const SIZE_RE = /^\d{1,2}(\.\d)?[A-Za-z]?$/;     // 7, 8.5, 11.5, 5Y
const QTY_RE = /^\d{1,3}$/;

// One page → { boxNumber, boxTotal, tracking, lines, declaredTotal }.
// `lines` are aggregated by SKU+size: the sheet prints one row per PAIR (the same
// SKU/size repeats), while po_lines holds a qty per SKU+size. Aggregating here means
// one write per line instead of one per pair, and the imported numbers read the same
// way the supplier's own scan-out would.
export function parseManifestPage(rows) {
  const out = { boxNumber: null, boxTotal: null, tracking: '', lines: [], declaredTotal: null };
  let inProducts = false;

  for (const cells of rows) {
    const joined = cells.join(' ');

    // The colon is NOT reliable — the same document prints "Box Number: 1/18" on some
    // pages and "Box Number 4/18" on others (and "Tracking Number:1Z…" with no space).
    // Requiring it silently lost the box number on 10 of 18 pages here, which only
    // shows up when tracking fails to match and the fallback is all that's left.
    const box = joined.match(/Box\s*Number\s*:?\s*(\d+)\s*(?:\/\s*(\d+))?/i);
    if (box) { out.boxNumber = Number(box[1]); out.boxTotal = box[2] ? Number(box[2]) : null; continue; }

    const trk = joined.match(/Tracking\s*Number\s*:?\s*(.+)$/i);
    if (trk) { out.tracking = trk[1].trim(); continue; }

    // The column header opens the product block; "Total" closes it. Everything the
    // sheet prints after that (the receiving checklist, signature lines) is ignored.
    if (/^(Product\s*Name|ITEM)$/i.test(cells[0] || '')
        || /(Product\s*Name|ITEM).*SKU.*SIZE.*(QTY|PAIRS)/i.test(joined)) {
      inProducts = true; continue;
    }
    if (inProducts && /^(Total|TOTAL\s*PAIRS)$/i.test(cells[0] || '')) {
      const n = [...cells].reverse().find((c) => QTY_RE.test(c));
      out.declaredTotal = n ? Number(n) : null;
      inProducts = false; continue;
    }
    if (!inProducts) continue;

    // Product row: name … sku, size, qty — read from the RIGHT, because a shoe name
    // can be one cell or several ("AJ1 TS", "Nike Dunk Low GS 'Panda'").
    if (cells.length < 3) continue;
    const qty = cells[cells.length - 1];
    const size = cells[cells.length - 2];
    const sku = cells[cells.length - 3];
    if (!QTY_RE.test(qty) || !SIZE_RE.test(size)) continue;
    const name = cells.slice(0, cells.length - 3).join(' ').trim();
    out.lines.push({ name: name || null, sku: normalizeManifestSku(sku), size: size.trim(), qty: Number(qty) });
  }

  // Aggregate the per-pair rows into per-SKU+size quantities.
  const byKey = new Map();
  for (const l of out.lines) {
    const k = `${l.sku}|${l.size}`;
    const cur = byKey.get(k);
    if (cur) { cur.qty += l.qty; if (!cur.name && l.name) cur.name = l.name; }
    else byKey.set(k, { ...l });
  }
  out.lines = [...byKey.values()];
  return out;
}

// Parse the whole file. `onProgress(page, total)` fires per page.
// Returns [{ page, boxNumber, boxTotal, tracking, lines, declaredTotal, unitCount }].
export async function parseManifestPdf(file, onProgress) {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      onProgress?.(p, pdf.numPages);
      const page = await pdf.getPage(p);
      let parsed = { boxNumber: null, boxTotal: null, tracking: '', lines: [], declaredTotal: null };
      try {
        parsed = parseManifestPage(rowsFromTextContent(await page.getTextContent()));
      } catch { /* unreadable page — reported below, never silently dropped */ }
      page.cleanup?.();
      pages.push({
        page: p, ...parsed,
        unitCount: parsed.lines.reduce((n, l) => n + l.qty, 0),
      });
    }
  } finally {
    pdf.destroy?.();
  }
  return pages;
}

// Match parsed pages to the PO's labels. Tracking number first — it's what the box
// physically IS (the same rule the labels PDF and the received-batch link use);
// box number is the fallback for a sheet whose tracking didn't read.
//
// `boxes` are the PO's labels as the client holds them ({ id, box_number,
// tracking_number, lineCount, kind }). Returns one row per page with its verdict, so
// the preview can explain every page rather than quietly importing a subset.
export function matchPagesToBoxes(pages, boxes) {
  const byTracking = new Map();
  const byNumber = new Map();
  for (const b of boxes || []) {
    const t = trackingKey(b.tracking_number);
    if (t) byTracking.set(t, b);
    if (b.box_number != null) byNumber.set(Number(b.box_number), b);
  }
  return (pages || []).map((p) => {
    const box = byTracking.get(trackingKey(p.tracking)) || byNumber.get(Number(p.boxNumber)) || null;
    const via = !box ? null : (byTracking.has(trackingKey(p.tracking)) ? 'tracking' : 'box number');
    let status = 'ready';
    if (!p.lines.length) status = 'empty';                    // nothing readable on the page
    else if (!box) status = 'unmatched';                      // no label on this PO carries it
    else if (box.lineCount > 0) status = 'has_manifest';      // already declared — leave it alone
    return { ...p, box, via, status };
  });
}
