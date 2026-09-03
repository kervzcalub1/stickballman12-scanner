// Where a parcel actually is, as the courier last reported it.
//
// One renderer, three places: the PO's own box list, the warehouse's Receiving box
// slots, and the Batch page. It was PO-only, which meant the team who is physically
// waiting for the box — the warehouse — had to open a purchase order to find out
// whether it had landed.
//
// Nothing here fetches. The status is written by the 17TRACK webhook onto po_boxes
// and reaches the warehouse pages matched by tracking number (`listBatchBoxes`), so
// this component only ever renders what is already known.
import React from 'react';
import { subStatusLabel, subStatusTone } from '../lib/trackstatus.js';
import { checkpointAdds, trackWords } from '../lib/postatus.js';

// `carrierOf` lets the PO page keep its rule — don't repeat a carrier the line above
// already names — while the warehouse pages, which have no such line, always show it.
export function DeliveryStatus({ box, carrierOf = null, className = '' }) {
  if (!box) return null;
  const { tracking_status: status, tracking_sub_status: sub, tracking_sub_status_descr: descr,
    last_checkpoint: checkpoint, carrier } = box;
  if (!status && !checkpoint && !sub) return null;
  const showCarrier = carrier && (!carrierOf || trackWords(carrier) !== trackWords(carrierOf(box)));
  return (
    <div className={`po-track-status muted sm ${className}`.trim()}>
      {showCarrier ? <span className="po-track-carrier">{carrier}{status ? ' · ' : ''}</span> : null}
      {status ? <span className="po-track-state">{status}</span> : null}
      {/* Why it is stuck, not just that it is. */}
      {sub && (
        <div className="po-substatus">
          <span className={`po-flag ${subStatusTone(sub)}`}>{subStatusLabel(sub)}</span>
          {descr && <span className="po-substatus-detail">{descr}</span>}
        </div>
      )}
      {checkpointAdds(checkpoint, status) ? <div className="po-track-checkpoint">{checkpoint}</div> : null}
    </div>
  );
}

// The warehouse case needs an answer even when there is none: a box slot with a
// tracking number and no status is NOT "not moving", it is a number the courier feed
// has never been asked about (it was never on a PO). Saying that plainly beats a
// blank space somebody reads as bad news.
export function DeliveryStatusLine({ box }) {
  if (!box) return null;
  const has = box.tracking_status || box.last_checkpoint || box.tracking_sub_status;
  if (has) return <DeliveryStatus box={box} />;
  if (!String(box.tracking_number || '').trim()) return null;
  return (
    <div className="po-track-status muted sm">
      <span className="po-track-state untracked" title="This number was never registered with the courier feed — it did not come in on a purchase order. Nothing is wrong with the parcel; we just have no status for it.">
        No courier updates
      </span>
    </div>
  );
}
