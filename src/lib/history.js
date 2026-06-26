// Item event-history formatting, shared by the Inventory detail view and the
// PH/admin/warehouse History modal.
import { statusLabel } from '../statuses.js';
import { DEFECT_TYPES } from './constants.js';

const DEFECT_LABEL = Object.fromEntries(DEFECT_TYPES);

// Photo URLs attached to an event (per-VIN defect issues store `photos`).
export const eventPhotos = (e) => (Array.isArray(e?.details?.photos) ? e.details.photos : []);

// One history line, naming WHO did it. System-driven changes (e.g. the sold →
// delist cascade) are tagged "(system-generated)".
export function eventLabel(e) {
  const by = e.created_by || '—';
  if (e.type === 'scanned') return `Scanned by ${e.details?.by || by}`;
  if (e.type === 'received') return `Received into inventory (by ${by})`;
  if (e.type === 'rescaled') return `Rescaled${e.details?.reason ? ` (${e.details.reason})` : ''}${e.details?.note ? ` — ${e.details.note}` : ''} (by ${by})`;
  if (e.type === 'status_change') return `Status → ${statusLabel(e.details?.status)}${e.details?.note ? ` — ${e.details.note}` : ''} (marked by: ${by})`;
  if (e.type === 'ph_update') return `${e.details?.text || 'Updated'} ${(e.details?.soldCascade || e.details?.system) ? '(system-generated)' : `(by ${by})`}`;
  if (e.type === 'note') return `Note: ${e.details?.text || ''} (by ${by})`;
  if (e.type === 'issue') {
    const t = e.details?.defectType;
    const label = t ? (DEFECT_LABEL[t] || t.replace(/_/g, ' ')) : '';
    const note = e.details?.note || e.details?.text || '';
    const desc = [label, note].filter(Boolean).join(' — ');
    return `Issue${desc ? `: ${desc}` : ''} (by ${by})`;
  }
  return `${e.type} (by ${by})`;
}

// One PH edit applies to several VINs at once → identical events. Collapse exact
// duplicates (same type / details / who / time) so the timeline reads once.
export function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events || []) {
    const k = `${e.type}|${e.created_by}|${e.created_at}|${JSON.stringify(e.details)}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(e);
  }
  return out;
}
