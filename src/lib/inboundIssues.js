// Inbound Issues — the rules both sides use (docs/context/inbound-issues.md).
// Pure: the server decides with these which receiving issues become a case, and the page
// labels and exports with the same words, so "open" can't mean two things.
//
// THE PROBLEM IT SOLVES (owner, 2026-10-24): the warehouse found a damaged parcel, a short
// count, a wrong pair — recorded it at receiving — and set the box aside, where it sat
// until the owner visited the warehouse. Recording an issue now OPENS A CASE: the PH team
// (Quincy, Ruby, Hyacinth) is told on Telegram, one of them takes it, works it with the
// supplier (refund, return, replacement) and closes it with what happened. One case per
// ISSUE (owner's call): a shipment issue is one case, a flagged pair is one case.
import { toCsv } from './manifestCsv.js';
import { estDate, estTime } from './format.js';
import { ISSUE_TYPES, DEFECT_TYPES } from './constants.js';

// open        → nobody owns it yet (the alert went out; somebody has to take it)
// in_progress → an owner is on it (contacting the supplier, starting a return …)
// waiting     → the owner is waiting on the SUPPLIER (refund promised, RMA asked for)
// resolved    → done, with an outcome
export const STATUSES = { open: 'New', in_progress: 'In progress', waiting: 'Waiting on supplier', resolved: 'Resolved' };
export const OPEN_STATUSES = ['open', 'in_progress', 'waiting'];

// What the supplier gave us — the money side of the case.
export const OUTCOMES = [
  ['refund', 'Refunded'],
  ['partial_refund', 'Partial refund'],
  ['credit', 'Store credit'],
  ['replacement', 'Replacement sent'],
  ['found', 'Found / not a problem after all'],
  ['no_remedy', 'Supplier refused — no remedy'],
  ['other', 'Other'],
];
export const outcomeLabel = (k) => (OUTCOMES.find(([v]) => v === k) || [])[1] || (k ? String(k) : '');
// Outcomes that carry an amount of money back.
export const MONEY_OUTCOMES = ['refund', 'partial_refund', 'credit'];

// What happens to a held PAIR when its case closes. Only a pair case has one.
//   keep     → back to stock: the hold is lifted (status back to what it was)
//   returned → it went back to the supplier: removed from inventory (Deleted archive)
export const DISPOSITIONS = [
  ['keep', 'Keep it — back to stock'],
  ['returned', 'Returned to the supplier — remove from inventory'],
];
export const dispositionLabel = (k) => (DISPOSITIONS.find(([v]) => v === k) || [])[1] || '';

// Which recorded issues open a case. Not every row in shipment_issues is a problem:
//   no_box → the No Box queue already owns it (a box is found, or it isn't)
//   note   → "Key notes", free text about the shipment, not a complaint
// A per-pair "No box" defect is the same No Box rule.
const NOT_A_CASE = ['no_box', 'note'];
export const opensCase = (type) => !NOT_A_CASE.includes(String(type || ''));

const SHIPMENT = Object.fromEntries(ISSUE_TYPES);
const PAIR = Object.fromEntries(DEFECT_TYPES);
export function typeLabel(scope, type) {
  if (type === 'online_order') return 'Doesn’t match the online order';
  return (scope === 'pair' ? PAIR[type] : SHIPMENT[type]) || SHIPMENT[type] || PAIR[type] || String(type || 'Issue');
}
/** The types a person can pick when reporting by hand on the page. */
export const SHIPMENT_TYPES = ISSUE_TYPES;
export const PAIR_TYPES = DEFECT_TYPES.filter(([k]) => k !== 'no_box');

// When a case has sat too long. Unclaimed after a working day is the one the owner kept
// finding; "no movement" is the one Genesis watches for in the daily summary.
export const UNCLAIMED_HOURS = 24;
export const STALE_DAYS = 3;

const HOUR = 3600 * 1000;
/** Age flags for one case at `now` — what the page chips and the daily summary use. */
export function ageFlags(r, now = Date.now()) {
  if (!r || !OPEN_STATUSES.includes(r.status)) return [];
  const out = [];
  const created = new Date(r.created_at).getTime();
  const moved = new Date(r.last_activity_at || r.updated_at || r.created_at).getTime();
  if (r.status === 'open' && now - created >= UNCLAIMED_HOURS * HOUR) out.push('unclaimed');
  if (r.status !== 'open' && now - moved >= STALE_DAYS * 24 * HOUR) out.push('stale');
  return out;
}
export const AGE_FLAGS = { unclaimed: `Nobody has taken it (${UNCLAIMED_HOURS} h+)`, stale: `No update in ${STALE_DAYS}+ days` };

/** "3 h", "2 d" — how long ago, for a list that is read at a glance. */
export function ago(t, now = Date.now()) {
  if (!t) return '';
  const ms = Math.max(0, now - new Date(t).getTime());
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60000))} min`;
  if (ms < 24 * HOUR) return `${Math.round(ms / HOUR)} h`;
  return `${Math.floor(ms / (24 * HOUR))} d`;
}

const when = (t) => (t ? `${estDate(t)} ${estTime(t)}` : '');
const money = (n) => (n == null || n === '' ? '' : Number(n).toFixed(2));

/** One line about WHAT is wrong — the alert, the list row, the CSV. */
export function issueHeadline(r) {
  const what = typeLabel(r.scope, r.type);
  const pair = r.scope === 'pair' ? [r.sku, r.size ? `size ${r.size}` : '', r.vin].filter(Boolean).join(' · ') : '';
  const counts = r.expected_count != null || r.received_count != null
    ? ` (expected ${r.expected_count ?? '?'}, got ${r.received_count ?? '?'})` : '';
  return `${what}${counts}${pair ? ` — ${pair}` : ''}`;
}

const CSV_COLS = [
  ['id', 'Case'], ['status', 'Status'], ['scope', 'Shipment / pair'], ['what', 'Problem'], ['description', 'Details'],
  ['supplier', 'Supplier'], ['po_code', 'PO'], ['tracking_number', 'Tracking #'], ['batch_code', 'Batch'], ['box_number', 'Box'],
  ['vin', 'VIN'], ['sku', 'SKU'], ['size', 'Size'], ['product', 'Shoe'], ['cost', 'Cost'],
  ['reported_by', 'Reported by'], ['reported', 'Reported (EST)'], ['owner', 'Owner'],
  ['supplier_ref', 'Supplier ref / RMA'], ['outcome', 'Outcome'], ['refund_amount', 'Amount back'],
  ['disposition', 'Pair'], ['resolved_by', 'Resolved by'], ['resolved', 'Resolved (EST)'], ['resolution_note', 'Resolution note'],
  ['photos', 'Photos'],
];
export function inboundIssuesCsv(rows) {
  return toCsv(CSV_COLS, (rows || []).map((r) => ({
    ...r,
    id: `#${r.id}`,
    status: STATUSES[r.status] || r.status,
    scope: r.scope === 'pair' ? 'Pair' : 'Shipment',
    what: typeLabel(r.scope, r.type),
    cost: money(r.cost),
    refund_amount: money(r.refund_amount),
    outcome: outcomeLabel(r.outcome),
    disposition: dispositionLabel(r.disposition),
    reported: when(r.created_at),
    resolved: when(r.resolved_at),
    photos: (r.photos || []).join(' '),
  })));
}
