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
import React, { useState } from 'react';
import { subStatusLabel, subStatusTone } from '../lib/trackstatus.js';
import { checkpointAdds, trackWords } from '../lib/postatus.js';
import { TrackingTimeline } from './common.jsx';
import { Icon } from './NavIcons.jsx';

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
// Its own open state, one box at a time. The PO page keeps a set of open box ids
// because it also drives a per-label Refresh from the same row; the warehouse rows
// have no such coupling, so holding it here keeps both call sites to one prop.
export function DeliveryStatusLine({ box }) {
  const [open, setOpen] = useState(false);
  if (!box) return null;
  const events = Array.isArray(box.tracking_events) ? box.tracking_events : [];
  const has = box.tracking_status || box.last_checkpoint || box.tracking_sub_status;
  if (!has) {
    if (!String(box.tracking_number || '').trim()) return null;
    return (
      <div className="po-track-status muted sm">
        <span className="po-track-state untracked" title="This number was never registered with the courier feed — it did not come in on a purchase order. Nothing is wrong with the parcel; we just have no status for it.">
          No courier updates
        </span>
      </div>
    );
  }
  return (
    <div className="box-track-block">
      <DeliveryStatus box={box} />
      {/* The latest checkpoint answers "where is it"; the history answers "what
          happened to it" — which is the question being asked when a box is late, is
          the wrong weight, or turned up somewhere it should not have. */}
      {events.length > 0 && (
        <button type="button" className="btn ghost sm box-track-history" onClick={() => setOpen((v) => !v)}>
          <Icon name="tag" /> {open ? 'Hide history' : `Tracking history (${events.length})`}
        </button>
      )}
      {open && events.length > 0 && <TrackingTimeline events={events} status={box.tracking_status} />}
    </div>
  );
}
