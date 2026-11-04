// My Scans reports — CSV + PDF (docs/context/inventory.md "Stock Check" → My Scans).
// Two reports, one per tab: COUNTS (each count: counted vs Shopify, how it was counted)
// and SCANS (every Stock Check scan). CSV and PDF are built from the SAME rows, so the two
// files can never disagree. PDF strings must be plain ASCII (tablePdf strips the rest).
import { toCsv } from './manifestCsv.js';
import { estDate, estClock } from './format.js';
import { statusLabel } from '../statuses.js';
import { countResult } from './stockCheck.js';
import { tablePdf } from './presellReport.js';

const VERDICT = { in: 'In inventory', out: 'Not in inventory', warn: 'Check', gone: 'Sticker on no pair', unknown: 'Unknown code' };
const KIND = { vin: 'VIN', upc: 'Box barcode', sku: 'Typed SKU' };
const VIA = { scanner: 'Scanner', camera: 'Camera', typed: 'Typed' };
const STATUS = { open: 'Not finished', finished: 'Finished', cancelled: 'Cancelled' };

export function scanAnswer(s) {
  const v = VERDICT[s.verdict];
  if (!v) return '';
  return s.item_status && s.verdict !== 'in' ? `${v} (${statusLabel(s.item_status)})` : v;
}

export function scanRows(scans) {
  return (scans || []).map((s) => ({
    date: estDate(s.created_at), time: estClock(s.created_at), by: s.user_name || s.username,
    code: s.code, kind: KIND[s.kind] || s.kind || '', via: VIA[s.via] || '',
    sku: s.sku || '', size: s.size || '', name: s.name || '', vin: s.vin || '',
    answer: scanAnswer(s), shopify: s.shopify_qty == null ? '' : String(s.shopify_qty),
    count: s.count_id ? `#${s.count_id}` : '',
    counted: s.count_id ? (s.undone ? 'Undone' : s.counted ? 'Yes' : 'No') : '',
    note: s.note || '',
  }));
}

export function countRows(counts) {
  return (counts || []).map((c) => {
    const expected = c.status === 'finished' ? c.expected_end : c.expected_start;
    const counted = c.status === 'finished' ? c.counted : c.tally;
    const res = c.status === 'finished' ? countResult(counted, expected) : null;
    return {
      id: `#${c.id}`, date: estDate(c.started_at), time: estClock(c.started_at), by: c.user_name || c.username,
      sku: c.sku, size: c.size, name: c.name || '', mode: c.vin_only ? 'VINs only' : 'Box or VIN',
      counted: counted == null ? '' : String(counted),
      shopifyStart: c.expected_start == null ? '' : String(c.expected_start),
      shopifyEnd: c.expected_end == null ? '' : String(c.expected_end),
      diff: res && expected != null ? String(counted - expected) : '',
      result: res ? res.text : STATUS[c.status] || c.status,
      tone: res ? res.tone : null,
      byVin: c.by_vin, byBarcode: c.by_barcode, typed: c.typed, flagged: c.flagged, refused: c.refused,
      status: STATUS[c.status] || c.status,
    };
  });
}

export function countTotals(rows) {
  const done = rows.filter((r) => r.status === 'Finished');
  return {
    counts: rows.length, finished: done.length,
    matched: done.filter((r) => r.tone === 'in').length,
    short: done.filter((r) => r.tone === 'out').length,
    extra: done.filter((r) => r.tone === 'warn').length,
    typed: rows.reduce((t, r) => t + (r.typed || 0), 0),
  };
}

export function scansCsv(scans) {
  return toCsv([
    ['date', 'Date (EST)'], ['time', 'Time'], ['by', 'By'], ['code', 'Scanned'], ['kind', 'What'], ['via', 'Entered by'],
    ['sku', 'SKU'], ['size', 'Size'], ['name', 'Name'], ['vin', 'VIN'], ['answer', 'Answer'], ['shopify', 'Shopify for sale'],
    ['count', 'Count'], ['counted', 'Counted'], ['note', 'Note'],
  ], scanRows(scans));
}
export function countsCsv(counts) {
  return toCsv([
    ['id', 'Count'], ['date', 'Date (EST)'], ['time', 'Time'], ['by', 'By'], ['sku', 'SKU'], ['size', 'Size'], ['name', 'Name'],
    ['mode', 'Counted by'], ['counted', 'Counted'], ['shopifyStart', 'Shopify at start'], ['shopifyEnd', 'Shopify at finish'],
    ['diff', 'Difference'], ['result', 'Result'], ['byVin', 'By VIN'], ['byBarcode', 'By box barcode'], ['typed', 'Typed by hand'],
    ['flagged', 'Record says gone'], ['refused', 'Scans not counted'],
  ], countRows(counts));
}

const rangeLabel = (from, to) => (from === to ? from : `${from} to ${to}`);

export async function countsPdf(counts, { from, to, who, generatedAt }) {
  const rs = countRows(counts);
  const t = countTotals(rs);
  return tablePdf({
    title: 'Stock counts - counted vs Shopify',
    subtitle: `${rangeLabel(from, to)} (EST)  |  ${who}  |  ${generatedAt}`,
    summary: [['Counts', String(t.counts)], ['Finished', String(t.finished)], ['Matched', String(t.matched)],
      ['Short', String(t.short)], ['Extra', String(t.extra)], ['Typed by hand', String(t.typed)]],
    cols: [['#', 12], ['Date', 26], ['By', 26], ['SKU', 28], ['Name', 0], ['Size', 12], ['Counted', 15, true],
      ['Shopify', 15, true], ['Result', 52], ['VIN / box / typed', 30]],
    cells: rs.map((r) => [r.id, `${r.date} ${r.time}`, r.by, r.sku, r.name, r.size, r.counted,
      r.shopifyEnd || r.shopifyStart || '-', r.result, `${r.byVin ?? 0} / ${r.byBarcode ?? 0} / ${r.typed ?? 0}`]),
    footer: 'Shopify = what Shopify had for sale at the finish. A pair sold but not yet shipped is on the shelf but not in that number. Box barcodes cannot tell two boxes apart; VINs can.',
  });
}
export async function scansPdf(scans, { from, to, who, generatedAt }) {
  const rs = scanRows(scans);
  return tablePdf({
    title: 'Stock Check scans',
    subtitle: `${rangeLabel(from, to)} (EST)  |  ${who}  |  ${generatedAt}`,
    summary: [['Scans', String(rs.length)], ['In a count', String(rs.filter((r) => r.count).length)],
      ['Not in inventory', String(rs.filter((r) => r.answer.startsWith('Not in')).length)],
      ['Typed by hand', String(rs.filter((r) => r.via === 'Typed').length)]],
    cols: [['Date', 26], ['By', 24], ['Scanned', 36], ['What', 20], ['SKU', 26], ['Name', 0], ['Size', 12],
      ['Answer', 40], ['Shopify', 14, true], ['Count', 22]],
    cells: rs.map((r) => [`${r.date} ${r.time}`, r.by, r.code, `${r.kind}${r.via ? ` (${r.via})` : ''}`, r.sku, r.name, r.size,
      r.answer || '-', r.shopify || '-', r.count ? `${r.count} ${r.counted}` : '-']),
    footer: 'Notes (why a scan was not counted) are in the CSV.',
  });
}
