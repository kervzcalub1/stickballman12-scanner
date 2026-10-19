// Undelivered tracking — the rules behind the page (docs/context/undelivered.md).
//
// Rows come from /api/undelivered (PO labels + online orders the carrier has not
// delivered and the warehouse has not received). This file decides what each row SAYS,
// how old it is, and what the CSV / PDF contain — so the screen and both files always
// agree. Pure: `now` is passed in, never read from the clock deep in the chain.
//
// ⚠️ Strings drawn into the PDF must be ASCII (tablePdf strips the rest).
import { toCsv } from './manifestCsv.js';
import { estDate } from './format.js';
import { subStatusLabel, subStatusTone } from './trackstatus.js';
import { carrierName, courierKeyFor, courierTrackLink } from './carriers.js';
import { orderCode } from './onlineOrders.js';

export const SOURCES = { po: 'PO label', online: 'Online order' };

// Whole days since the number was added (EST days don't matter here: it's an age).
export const ageDays = (row, now) => {
  const t = new Date(row?.added_at).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : null;
};

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// What the courier feed last said, in words, plus a tone for the chip.
// 'none' = we have no courier feed for this number at all (most online orders: their
// numbers are not registered with 17TRACK) — the courier link is the only way to know.
export function feedStatus(row) {
  const st = words(row?.tracking_status);
  if (!st) {
    return row?.has_feed === false || row?.source === 'online'
      ? { label: 'No courier feed', tone: 'muted', key: 'none' }
      : { label: 'No update yet', tone: 'muted', key: 'none' };
  }
  const sub = subStatusLabel(row.tracking_sub_status);
  const tone = subStatusTone(row.tracking_sub_status);
  if (st.includes('notfound')) return { label: sub || 'Not found yet', tone: 'warn', key: 'notfound' };
  if (st.includes('inforeceived')) return { label: 'Label created - not picked up', tone: 'warn', key: 'label' };
  if (st.includes('expired')) return { label: sub || 'No updates for a long time', tone: 'bad', key: 'problem' };
  if (st.includes('exception') || st.includes('deliveryfailure') || st.includes('undelivered'))
    return { label: sub || 'Problem with the shipment', tone: 'bad', key: 'problem' };
  if (st.includes('availableforpickup')) return { label: 'Ready for pickup', tone: 'warn', key: 'transit' };
  if (st.includes('outfordelivery')) return { label: 'Out for delivery', tone: 'info', key: 'transit' };
  return { label: sub || 'In transit', tone: tone === 'bad' ? 'bad' : 'info', key: 'transit' };
}

export const rowKey = (r) => `${r.source}:${r.ref_id}`;
export const courierOf = (r) => carrierName(courierKeyFor(r.tracking_number, r.carrier_key || r.carrier)) || '';
export const codeOf = (r) => (r.source === 'online' ? orderCode(r.order_id) : r.order_code || '');

// One plain row per number — the screen's cells and both exports.
export function reportRows(rows, now) {
  return (rows || []).map((r) => {
    const fs = feedStatus(r);
    return {
      key: rowKey(r),
      added: r.added_at ? estDate(r.added_at) : '',
      age: ageDays(r, now),
      source: SOURCES[r.source] || r.source,
      order: codeOf(r),
      label: r.source === 'po' ? (r.box_kind === 'replacement' ? 'Replacement' : r.box_number != null ? `Label ${r.box_number}` : '') : (r.order_number ? `#${r.order_number}` : ''),
      party: r.party || '',
      ordered: r.ordered_on || '',
      tracking: String(r.tracking_number || '').trim(),
      courier: courierOf(r),
      status: fs.label,
      lastScan: r.last_move_at && r.tracking_status ? estDate(r.last_move_at) : '',
      checkpoint: r.last_checkpoint || '',
      pairs: Number(r.pairs) || 0,
      link: courierTrackLink(r.tracking_number, r.carrier_key || r.carrier)?.url || '',
    };
  });
}

// Sort by when the number was ADDED (newest first by default); ties by order code.
export function sortRows(rows, dir = 'new') {
  const sign = dir === 'old' ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const ta = new Date(a.added_at).getTime() || 0;
    const tb = new Date(b.added_at).getTime() || 0;
    return (ta - tb) * sign || String(a.order_code || '').localeCompare(String(b.order_code || ''));
  });
}

const COLS = [
  ['added', 'Added (EST)'], ['age', 'Days since added'], ['source', 'Source'], ['order', 'Order'], ['label', 'Label / order #'],
  ['party', 'Supplier / store'], ['ordered', 'Ordered (EST)'], ['tracking', 'Tracking #'], ['courier', 'Courier'],
  ['status', 'Last courier status (17TRACK)'], ['lastScan', 'Last scan (EST)'], ['checkpoint', 'Last checkpoint'],
  ['pairs', 'Pairs'], ['link', 'Courier tracking page'],
];
export const undeliveredCsv = (rows) => toCsv(COLS, rows);

export async function undeliveredPdf(rows, { generatedAt, scope = '' }) {
  const { tablePdf } = await import('./presellReport.js');
  const pairs = rows.reduce((t, r) => t + r.pairs, 0);
  const po = rows.filter((r) => r.source === SOURCES.po).length;
  const oldest = rows.reduce((m, r) => (r.age != null && r.age > m ? r.age : m), 0);
  return tablePdf({
    title: 'Undelivered tracking numbers',
    subtitle: `${scope ? `${scope}  |  ` : ''}${generatedAt}`,
    summary: [['Tracking numbers', String(rows.length)], ['PO labels', String(po)], ['Online orders', String(rows.length - po)],
      ['Pairs on them', String(pairs)], ['Oldest', rows.length ? `${oldest} days` : '-']],
    cols: [['Added', 20], ['Days', 11, true], ['Source', 22], ['Order', 32], ['Supplier / store', 30], ['Tracking #', 46],
      ['Courier', 18], ['Last status (17TRACK)', 0], ['Last scan', 20], ['Pairs', 12, true]],
    cells: rows.map((r) => [r.added, r.age == null ? '' : String(r.age), r.source, [r.order, r.label].filter(Boolean).join(' '),
      r.party, r.tracking, r.courier || '-', r.status, r.lastScan || '-', r.pairs ? String(r.pairs) : '-']),
    footer: 'Not delivered per the courier feed and not received at the warehouse. 17TRACK can lag - check the courier site (CSV has the link per number) before chasing.',
  });
}
