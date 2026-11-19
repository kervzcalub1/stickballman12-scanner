// The claim photos taken at the bench, grouped by what they show (shipping label · boxes ·
// packing slip) — docs/context/receiving-evidence.md. Shown on a case, a manifest report and
// the batch page; renders nothing when the delivery has none.
import React from 'react';
import { EVIDENCE_KEYS, EVIDENCE_LABEL, evidenceCount } from '../lib/receivingEvidence.js';
import { PH_DATETIME } from '../lib/format.js';

export function ReceivingEvidence({ evidence, onOpen, title = 'Photos taken at receiving' }) {
  if (!evidenceCount(evidence)) return null;
  const at = evidence.at ? new Date(evidence.at) : null;
  const open = (u) => (onOpen ? onOpen(u) : window.open(u, '_blank', 'noopener'));
  return (
    <div className="rcv-ev" data-evidence={evidenceCount(evidence)}>
      <b className="rcv-ev-h">{title}</b>
      <span className="muted xs"> {[evidence.by, at && !Number.isNaN(at.getTime()) ? `${PH_DATETIME.format(at)} EST` : null].filter(Boolean).join(' · ')}</span>
      {(evidence.reasons || []).length > 0 && <div className="muted xs">Why they were asked for: {evidence.reasons.join(' · ')}</div>}
      {EVIDENCE_KEYS.map((k) => ((evidence[k] || []).length ? (
        <div className="rcv-ev-group" key={k}>
          <span className="muted xs">{EVIDENCE_LABEL[k]}</span>
          <div className="ii-photos">
            {evidence[k].map((u) => (
              <button type="button" key={u} className="ii-photo" onClick={() => open(u)} aria-label={`Open the photo: ${EVIDENCE_LABEL[k]}`}>
                <img src={u} alt={EVIDENCE_LABEL[k]} loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      ) : null))}
      {evidence.noSlip && !(evidence.slip || []).length && <div className="muted xs">Packing slip: none in the parcel.</div>}
    </div>
  );
}
