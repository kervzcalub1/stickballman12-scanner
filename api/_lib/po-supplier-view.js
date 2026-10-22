// What a SUPPLIER may read of one of their own orders — one place, used by every endpoint a
// supplier can reach that hands back order data (po/get, po/list, po/track-refresh,
// po/close-box, po/ship, po/reopen-box, po/request-labels, the store endpoints).
//
// Kept to a single strip-list on purpose: each endpoint used to strip its own fields, and
// the ones that only stripped `boxes` leaked whatever a later column added to the order row.
// The rules it holds:
//   · which staff member did something is ours — the supplier sees "<business>'s Staff";
//   · what WE counted (received units, batches, the reconciliation) is never shown before
//     the count is settled with them;
//   · the audit side of a store order — card charges, credits, the audit itself, our
//     "invoice checked" and "landed" marks — is internal (docs/store-orders-plan.md §4.8).
import { hideReceivedUnits } from './util.js';

const PO_HIDDEN = [
  'reconcile_note_by', 'labels_key', 'reconciliation',
  'audited_at', 'audited_by', 'audit_note', 'audit_snapshot',
  'invoice_checked_at', 'invoice_checked_by',
  'landed_override_at', 'landed_override_by', 'landed_override_note',
];
const STORE_HIDDEN = ['charged_total', 'charge_count', 'credit_agreed', 'credit_received', 'credit_note'];

const omit = (obj, keys) => {
  if (!obj) return obj;
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

export const supplierPoRow = (po) => omit(po, PO_HIDDEN);
export const supplierStoreRow = (st) => omit(st, STORE_HIDDEN);

// `data` = getPoFull's { po, boxes, lines, batches, stores } (any subset).
export function supplierPoView(data) {
  const out = { ...data };
  if (out.po) out.po = supplierPoRow(out.po);
  if (out.lines) out.lines = out.lines.map(({ entered_by, entered_by_name, entered_by_username, ...rest }) => rest);
  if (out.boxes) out.boxes = hideReceivedUnits(out.boxes);
  if (out.stores) out.stores = out.stores.map(supplierStoreRow);
  delete out.batches;
  return out;
}

export const PO_SUPPLIER_HIDDEN_KEYS = [...PO_HIDDEN];
export const STORE_SUPPLIER_HIDDEN_KEYS = [...STORE_HIDDEN];
