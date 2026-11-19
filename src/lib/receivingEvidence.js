// Receiving evidence — the photos a claim needs, taken while the parcel is still on the bench
// (docs/context/receiving-evidence.md).
//
// THE PROBLEM (Alex, 2026-11-20): a shipment turns out short days after it was received; by
// then the carton, its shipping label and the packing slip are in the bin, and the store
// (Shoe Palace) asks for a picture of the label before it will look at the claim.
//
// So: every shipment receive ASKS for a photo of the shipping label, and the moment anything
// is off — short or wrong against the order, a problem typed on the Issues step, no manifest —
// the three claim photos are REQUIRED before the box can be saved. They are kept on the
// receiving record (the batch, or the box of a multi-box batch), so every case about that
// delivery shows them, including one opened days later.
import { CLAIM_PHOTOS } from './onlineOrders.js';

export { CLAIM_PHOTOS };
export const EVIDENCE_KEYS = CLAIM_PHOTOS.map((c) => c.key);   // label · pairs · slip
export const EVIDENCE_LABEL = { label: 'Shipping label', pairs: 'Boxes that arrived', slip: 'Packing slip / manifest' };
export const MAX_EVIDENCE_PHOTOS = 6;

// A problem typed on the Issues step that a supplier or a store may have to answer for. The two
// box-swap housekeeping types are not a claim.
const NOT_A_CLAIM = new Set(['box_missing', 'box_no_lid', 'note', 'no_box']);
export const needsEvidence = (type) => !!type && !NOT_A_CLAIM.has(String(type));

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Why this receive needs the claim photos — one short sentence per reason, [] when it doesn't.
 *   online / po : a checklist summary's totals ({ missing, extra }) when it is NOT clean, else null
 *   issues      : the manual shipment issues typed on the Issues step ([{ type }])
 *   noManifest  : the receiver answered "No" to "Did this package come with a manifest?"
 */
export function evidenceReasons({ online = null, po = null, issues = [], noManifest = false, issueLabel = (t) => t } = {}) {
  const out = [];
  const off = (t, against) => {
    if (!t) return;
    const bits = [t.missing ? `${plural(t.missing, 'pair')} missing against ${against}` : null, t.extra ? `${plural(t.extra, 'pair')} not on ${against}` : null].filter(Boolean);
    if (bits.length) out.push(bits.join(' · '));
  };
  off(online, 'the online order');
  off(po, 'the purchase order');
  const typed = [...new Set((issues || []).map((i) => i?.type).filter(needsEvidence))];
  if (typed.length) out.push(`Reported: ${typed.map(issueLabel).join(', ')}`);
  if (noManifest) out.push('Received without a manifest');
  return out;
}

/** The photo kinds still to take. `slipOptional`: nothing was sent, so there may be no paper. */
export function evidenceLeft(photos = {}, { noSlip = false, slipOptional = false } = {}) {
  return CLAIM_PHOTOS.filter((c) => !(photos[c.key] || []).length && !(c.key === 'slip' && (noSlip || slipOptional)));
}

const urls = (list) => [...new Set((Array.isArray(list) ? list : []).map((u) => String(u || '').trim()).filter((u) => /^https:\/\/\S+$/.test(u)))].slice(0, MAX_EVIDENCE_PHOTOS);

/** What the server keeps: only https photo links, the reasons as short text. null = nothing to keep. */
export function cleanEvidence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ev = { label: urls(raw.label), pairs: urls(raw.pairs), slip: urls(raw.slip), noSlip: raw.noSlip === true,
    reasons: (Array.isArray(raw.reasons) ? raw.reasons : []).map((r) => String(r || '').replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 8) };
  return ev.label.length || ev.pairs.length || ev.slip.length ? ev : null;
}

export const evidenceCount = (ev) => (ev ? EVIDENCE_KEYS.reduce((n, k) => n + (ev[k] || []).length, 0) : 0);
/** Enough for a claim without asking the floor again: the label and the boxes. */
export const evidenceCoversClaim = (ev) => !!ev && (ev.label || []).length > 0 && (ev.pairs || []).length > 0;
/** "label ×1, boxes ×2, slip ×1" — for a Telegram line or a case note. */
export const evidenceWords = (ev) => (ev ? [
  `label ×${(ev.label || []).length}`, `boxes ×${(ev.pairs || []).length}`,
  (ev.slip || []).length ? `packing slip ×${ev.slip.length}` : ev.noSlip ? 'no packing slip in the parcel' : 'packing slip ×0',
].join(', ') : '');
