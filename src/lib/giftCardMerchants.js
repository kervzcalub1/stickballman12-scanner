// Which merchant's gift cards a buying request needs (docs/context/buy-cart.md,
// "The gift card merchant").
//
// A closed list, not a free-text box: the desk has to hand over a card the till will
// actually take, and "Footlocker", "Foot Locker #2231" and "champs" are one answer
// spelled three ways. Some banners share a card, so each merchant names every store its
// card covers. Foot Locker cards work at Champs Sports, and Finish Line cards at JD Sports.
//
// Used on both sides: the server checks a posted key against this list, and the screens
// show the label. The KEY is what's stored (`buy_carts.gc_merchant`), so a label can be
// reworded later without touching any rows.
export const GIFT_CARD_MERCHANTS = [
  { key: 'nike', label: 'Nike' },
  { key: 'footlocker', label: 'Foot Locker / Champs Sports' },
  { key: 'adidas', label: 'Adidas' },
  { key: 'finishline', label: 'Finish Line / JD Sports' },
  { key: 'dicks', label: "Dick's Sporting Goods" },
];

const BY_KEY = new Map(GIFT_CARD_MERCHANTS.map((m) => [m.key, m]));

// A posted value → a known key, or null. Anything not on the list is null, never stored as typed.
export const merchantKey = (v) => (BY_KEY.has(String(v ?? '').trim()) ? String(v).trim() : null);

// The label for a stored key; null when there isn't one (requests opened before the list existed).
export const merchantLabel = (key) => BY_KEY.get(String(key ?? ''))?.label || null;

// The buyer can switch merchants only until the desk records a card. After that, a new
// merchant would leave the cards already handed over as the wrong ones.
export const merchantEditable = (cart) =>
  !!cart && ['draft', 'submitted', 'approved', 'denied'].includes(cart.status) && !(Number(cart.gc_total) > 0);
