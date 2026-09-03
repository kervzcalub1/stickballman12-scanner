// "Is this the shoe?" — the human check in front of a UPC backfill.
//
// A scanned barcode is resolved by a third-party catalogue that is sometimes
// wrong: one UPC can come back carrying variants from several different products,
// and the lookup takes the first. So before that code is written onto stock, the
// person holding the box confirms the shoe it named.
//
// The question is deliberately about the INFORMATION, not about saving. Somebody
// asked "shall I save this?" answers from whether they want the chore; asked "is
// this the shoe in your hand?" they answer from the box in front of them, which is
// the only thing they can actually verify. The write is a consequence of the
// answer, not the subject of the question.
import React from 'react';
import { sizeLabel } from '../lib/codes.js';

export default function UpcCheck({ candidate, busy, onYes, onNo }) {
  if (!candidate) return null;
  const { name, sku, size, colorway, gender, image, ambiguous } = candidate;
  return (
    <div className="modal-overlay" onClick={() => !busy && onNo()}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Is this the shoe you scanned?</h3>
        <div className="upccheck-card">
          {image ? <img className="upccheck-img" src={image} alt="" loading="lazy" /> : null}
          <div className="upccheck-facts">
            <div className="upccheck-name">{name || '—'}</div>
            {colorway ? <div className="muted sm">{colorway}</div> : null}
            <div className="upccheck-line"><span className="muted sm">Style</span> <b>{sku || '—'}</b></div>
            <div className="upccheck-line"><span className="muted sm">Size</span> <b>US {sizeLabel(size, gender, name)}</b></div>
          </div>
        </div>
        {/* Said plainly, because this is the case where the catalogue is most
            likely to be wrong and the person needs to read rather than skim. */}
        {ambiguous ? (
          <p className="modal-msg warn-text">This barcode also points at other products — check the name and the size carefully.</p>
        ) : (
          <p className="modal-msg">Check it against the box in your hand — the size especially.</p>
        )}
        <div className="modal-actions">
          <button className="btn ghost" disabled={busy} onClick={onNo}>No</button>
          <button className="btn primary" disabled={busy} onClick={onYes}>{busy ? '…' : 'Yes, that’s it'}</button>
        </div>
      </div>
    </div>
  );
}
