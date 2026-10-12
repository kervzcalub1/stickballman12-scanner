// Pre-sell fulfilment — the pure half (docs/context/presell-fulfillment.md). Shared by the
// status sync (api/_lib/presell-fulfill.js), the 📦 Fulfill tab and the pick list.
//
// What the platforms do (checked live 2026-10-12): BOTH make the UPS label AT the sale —
// nobody "fulfils" anything through the API. The warehouse prints the label, packs, hands it
// to UPS, and the platform moves the order on when UPS scans it.
//   · Alias:  ORDER_STATUS_LABEL_GENERATED seconds after the sale; label_url (PDF),
//             label_tracking_number, label_courier, cancels_at = the ship-by deadline (~2.5 d).
//   · StockX: CREATED; the order DETAIL (not the active list) carries shipment.shippingLabelUrl,
//             trackingNumber, shipByDate (~4 d), and /shipping-document the instruction PDFs.
// Our reading of the platform's own status: to_ship | shipped | cancelled (null = unknown yet).
// Anything we haven't seen before that isn't a cancel counts as moved on (shipped) — a new
// pre-ship status would show here as "shipped" with its raw name beside it, never vanish.
export function shipStateOf(platform, status) {
  const s = String(status || '').toUpperCase();
  if (!s) return null;
  if (/PAYOUT/.test(s)) return 'shipped';   // StockX PAYOUTPENDING / PAYOUTFAILED — long gone
  if (/CANCEL|DIDNOTSHIP|DID_NOT_SHIP|RETURN|REFUND|VOID/.test(s)) return 'cancelled';
  if (platform === 'alias') return /LABEL_GENERATED|_NEW$|CONFIRM|PENDING|SELLER_ACTION/.test(s) ? 'to_ship' : 'shipped';
  // StockX: CREATED = sold, label made, not scanned by UPS yet. CCAUTHORIZATIONFAILED = the
  // buyer's card failed; StockX retries — keep it on the list, its status says to wait.
  return s === 'CREATED' || s === 'CCAUTHORIZATIONFAILED' ? 'to_ship' : 'shipped';
}

const TRACK_URL = {
  UPS: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  FEDEX: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
};
const str = (v) => (v == null || v === '' ? null : String(v));

// StockX's /shipping-document answer → the links worth printing.
export function stockxDocs(d) {
  const sd = d?.shippingDocuments;
  if (!sd) return null;
  const out = {
    thermal: str(sd.sellerShippingInstructions?.thermalLabel?.EN_US),
    letter: str(sd.sellerShippingInstructions?.normalLabel?.EN_US),
    labelOnly: str(sd.thermalLabelOnly),
    additionalRequired: !!sd.additionalDocumentsRequired,
    message: str(sd.message),
  };
  return out.thermal || out.letter || out.labelOnly ? out : null;
}

// One platform order (+ StockX's documents) → the columns we keep on presell_sales.
export function orderShipInfo(platform, o, docs = null) {
  if (!o) return null;
  if (platform === 'alias') {
    const carrier = str(o.label_courier)?.toUpperCase() || null;
    const tn = str(o.label_tracking_number);
    return {
      order_status: str(o.status), ship_state: shipStateOf('alias', o.status),
      ship_by: str(o.cancels_at), carrier, tracking_number: tn,
      tracking_url: tn && TRACK_URL[carrier] ? TRACK_URL[carrier](tn) : null,
      label_url: str(o.label_url), ship_docs: null,
    };
  }
  const sh = o.shipment || {};
  const carrier = str(sh.carrierCode)?.toUpperCase() || null;
  const tn = str(sh.trackingNumber);
  return {
    order_status: str(o.status), ship_state: shipStateOf('stockx', o.status),
    ship_by: str(sh.shipByDate), carrier, tracking_number: tn,
    tracking_url: str(sh.trackingUrl) || (tn && TRACK_URL[carrier] ? TRACK_URL[carrier](tn) : null),
    label_url: str(sh.shippingLabelUrl), ship_docs: docs,
  };
}

// The label to print: StockX's label-only PDF beats its PNG; Alias has one PDF.
export const labelLink = (x) => x?.ship_docs?.labelOnly || x?.label_url || null;

// WHERE IS THE PAIR, per order still to ship. Per stock row (SKU + size):
//   set aside so far = arrived − released (pairs the arrivals held back for in-transit buyers);
//   less the orders of that row already shipped = pairs ready on the set-aside shelf now.
// Orders take them most-urgent first; the rest wait on the truck (in transit), come off the
// shelf (everything arrived — a sale that raced the take-down), or must be bought (source it).
export const WHERE = {
  ready: { word: 'Set aside — pull it', short: 'SET ASIDE', rank: 0 },
  shelf: { word: 'Pull from the shelf', short: 'SHELF', rank: 1 },
  transit: { word: 'In transit — not here yet', short: 'IN TRANSIT', rank: 2 },
  source: { word: 'Source it — no pair yet', short: 'SOURCE IT', rank: 3 },
};
const t = (v) => (v ? new Date(v).getTime() : Infinity);
export function assignWhere(rows) {
  const byStock = new Map();
  for (const x of rows || []) {
    const k = x.stock_id ?? `sale-${x.id}`;
    if (!byStock.has(k)) byStock.set(k, []);
    byStock.get(k).push(x);
  }
  const out = [];
  for (const list of byStock.values()) {
    const s = list[0];
    const aside = Math.max(0, Number(s.arrived_qty || 0) - Number(s.released_qty || 0));
    let ready = Math.max(0, aside - Number(s.shipped_n || 0));
    [...list].sort((a, b) => t(a.ship_by) - t(b.ship_by) || t(a.sold_at) - t(b.sold_at)).forEach((x) => {
      let where;
      if (ready > 0) { where = 'ready'; ready--; }
      else if (x.in_transit && !x.arrived_at) where = 'transit';
      else if (x.in_transit) where = 'shelf';
      else where = 'source';
      out.push({ ...x, where });
    });
  }
  return out;
}

// Ship-by urgency, from `now` (ms): overdue | today (under 24 h) | ok | null (no deadline).
export function urgency(shipBy, now) {
  if (!shipBy) return null;
  const left = new Date(shipBy).getTime() - now;
  return left < 0 ? 'overdue' : left < 24 * 3600_000 ? 'today' : 'ok';
}
export function timeLeft(shipBy, now) {
  if (!shipBy) return '';
  const ms = new Date(shipBy).getTime() - now;
  const h = Math.round(Math.abs(ms) / 3600_000);
  const words = h >= 48 ? `${Math.round(h / 24)} days` : `${h} h`;
  return ms < 0 ? `${words} late` : `${words} left`;
}

// Pick-list groups: one per SKU + size, most urgent first; orders inside most urgent first.
export function pickGroups(rows) {
  const g = new Map();
  for (const x of rows || []) {
    const k = `${String(x.sku || '').toUpperCase()}|${x.size ?? ''}`;
    if (!g.has(k)) g.set(k, { key: k, sku: x.sku, name: x.name, image: x.image, size: x.size, orders: [] });
    g.get(k).orders.push(x);
  }
  const groups = [...g.values()];
  for (const gr of groups) {
    gr.orders.sort((a, b) => t(a.ship_by) - t(b.ship_by));
    gr.count = (w) => gr.orders.filter((o) => o.where === w).length;
    gr.firstBy = gr.orders[0]?.ship_by || null;
  }
  return groups.sort((a, b) => t(a.firstBy) - t(b.firstBy) || String(a.sku).localeCompare(String(b.sku)));
}

export function fulfillTotals(rows, now) {
  const r = rows || [];
  return {
    toShip: r.length,
    overdue: r.filter((x) => urgency(x.ship_by, now) === 'overdue').length,
    today: r.filter((x) => urgency(x.ship_by, now) === 'today').length,
    ready: r.filter((x) => x.where === 'ready').length,
    shelf: r.filter((x) => x.where === 'shelf').length,
    transit: r.filter((x) => x.where === 'transit').length,
    source: r.filter((x) => x.where === 'source').length,
    noLabel: r.filter((x) => !labelLink(x)).length,
  };
}
