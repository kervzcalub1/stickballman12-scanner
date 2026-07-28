// 17TRACK sub-status vocabulary, shared by the server (webhook + Sheets forward) and the
// UI so a label reads the same everywhere.
//
// 17TRACK's `latest_status` is { status, sub_status, sub_status_descr }. `status` is the
// coarse stage we already map onto po_boxes.status — InTransit, Delivered, Exception — and
// it's too blunt to act on: "Exception" doesn't say whether customs is holding the parcel
// or the courier already sent it back. `sub_status` is that detail.
//
// Values look like `InTransit_CustomsProcessing`: the part before the underscore repeats
// the coarse status, the part after is what actually happened.

// The ones worth naming properly. Anything unlisted falls back to de-camel-casing, so a
// new 17TRACK code still renders as readable text instead of disappearing.
const SUB_STATUS_LABEL = {
  NotFound_Other: 'Not found yet',
  NotFound_InvalidCode: 'Invalid tracking number',
  InfoReceived: 'Label created — with the sender',
  InTransit_PickedUp: 'Picked up',
  InTransit_Other: 'In transit',
  InTransit_Departure: 'Departed facility',
  InTransit_Arrival: 'Arrived at facility',
  InTransit_CustomsProcessing: 'In customs',
  InTransit_CustomsReleased: 'Released by customs',
  InTransit_CustomsRequiringInformation: 'Customs needs information',
  Expired_Other: 'No updates for a long time',
  AvailableForPickup_Other: 'Ready for pickup',
  OutForDelivery_Other: 'Out for delivery',
  DeliveryFailure_Other: 'Delivery failed',
  DeliveryFailure_NoBody: 'Nobody home',
  DeliveryFailure_Security: 'Refused on delivery',
  DeliveryFailure_Rejected: 'Refused by recipient',
  DeliveryFailure_InvalidAddress: 'Bad address',
  Delivered_Other: 'Delivered',
  Delivered_Signed: 'Delivered — signed for',
  Delivered_Pickup: 'Collected',
  Exception_Other: 'Problem with the shipment',
  Exception_Returning: 'Being returned to sender',
  Exception_Returned: 'Returned to sender',
  Exception_NoBody: 'Nobody home',
  Exception_Security: 'Held — security',
  Exception_Damage: 'Damaged',
  Exception_Rejected: 'Refused by recipient',
  Exception_Delayed: 'Delayed',
  Exception_Lost: 'Reported lost',
  Exception_Destroyed: 'Destroyed',
  Exception_Cancel: 'Cancelled',
};

// Sub-statuses that mean a human has to do something — the parcel isn't just late, it's
// stuck, coming back, or gone. These drive the red treatment and the "needs attention"
// wording; everything else is informational.
const NEEDS_ACTION = new Set([
  'NotFound_InvalidCode',
  'Expired_Other',
  'DeliveryFailure_Other', 'DeliveryFailure_NoBody', 'DeliveryFailure_Security',
  'DeliveryFailure_Rejected', 'DeliveryFailure_InvalidAddress',
  'Exception_Other', 'Exception_Returning', 'Exception_Returned', 'Exception_NoBody',
  'Exception_Security', 'Exception_Damage', 'Exception_Rejected', 'Exception_Lost',
  'Exception_Destroyed', 'Exception_Cancel',
]);

// Slower than usual but nothing to chase yet.
const WATCH = new Set([
  'InTransit_CustomsProcessing', 'InTransit_CustomsRequiringInformation', 'Exception_Delayed',
]);

// `InTransit_CustomsProcessing` → "In customs"; an unknown `InTransit_SomethingNew` →
// "Something new". Never returns the raw code — that's for the sheet, not for people.
export function subStatusLabel(sub) {
  const key = String(sub || '').trim();
  if (!key) return '';
  if (SUB_STATUS_LABEL[key]) return SUB_STATUS_LABEL[key];
  const tail = key.includes('_') ? key.slice(key.indexOf('_') + 1) : key;
  const words = tail.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : '';
}

// 'bad' — someone has to act · 'warn' — worth watching · 'info' — just detail.
export function subStatusTone(sub) {
  const key = String(sub || '').trim();
  if (!key) return 'info';
  if (NEEDS_ACTION.has(key)) return 'bad';
  if (WATCH.has(key)) return 'warn';
  return 'info';
}

export const subStatusNeedsAction = (sub) => subStatusTone(sub) === 'bad';
