// Purchase-order status vocabulary, shared by the PO list and the PO page.
//
// Extracted when the order detail moved to its own screen (`PoDetail.jsx`): both places
// have to say the same thing about the same order, and a second copy of poChipOf is
// exactly how a list and a page start disagreeing about where a shipment is.
export const PO_STATUS = {
  draft:      { label: 'Filling',    cls: 'draft' },
  shipped:    { label: 'Shipped',    cls: 'shipped' },
  receiving:  { label: 'Receiving',  cls: 'receiving' },
  reconciled: { label: 'Reconciled', cls: 'ok' },
  closed:     { label: 'Closed',     cls: 'muted' },
};

// ── What the order is FOR ─────────────────────────────────────────────────────
// We don't only buy shoes. A pair turns up with a crushed box or no box at all, so the
// same suppliers ship us EMPTY SHOE BOXES to swap in — same paperwork, same labels, same
// reconciliation, an entirely different manifest. Every role needs to be able to tell the
// two apart at a glance, because almost nothing else on the screen says which it is: the
// PH team raising it, the supplier packing it, the warehouse unpacking it.
//
// A box line's DIMENSIONS are what a shoe line's size is — the thing that makes two
// otherwise identical lines two different things to order, count and pay for — so the
// manifest column swaps rather than gaining one.
export const isBoxesOrder = (po) => String(po?.order_kind || 'shoes') === 'boxes';
export const orderKindChip = (po) => (isBoxesOrder(po)
  ? { label: 'Empty boxes', cls: 'boxes', title: 'This order is for empty shoe boxes — replacements for crushed and missing ones. Its manifest is declared by box dimensions, not shoe size.' }
  : { label: 'Shoes', cls: 'shoes', title: 'This order is for shoes. Its manifest is declared per size.' });
// What one manifest line is called, and what the column that identifies it is called.
export const lineNoun = (po) => (isBoxesOrder(po) ? 'box' : 'pair');
export const lineNounPlural = (po) => (isBoxesOrder(po) ? 'boxes' : 'pairs');
export const lineKeyLabel = (po) => (isBoxesOrder(po) ? 'Dimensions' : 'Size');
// The value that identifies a line, whichever kind of order it is on.
export const lineKeyValue = (line) => (line?.dimensions || line?.size || '');

export const boxStatusLabel = (s) => (s === 'delivered' ? 'Delivered ✓'
  : s === 'in_transit' ? 'In transit'
  : s === 'pre_transit' ? 'With supplier · label made'
  : s === 'shipped' ? 'Shipped'
  : s === 'packed' ? 'Ready to ship' : 'Filling');

export const boxChipCls = (s) => (s === 'delivered' ? 'ok'
  : s === 'in_transit' ? 'receiving'
  : s === 'pre_transit' ? 'pretransit'
  : s === 'shipped' ? 'shipped'
  : s === 'packed' ? 'packed' : 'draft');

// 17TRACK's checkpoint text is very often the status over again, shouted — a label read
// "UPS · Delivered" and then "Delivered, DELIVERED" underneath. Show the checkpoint only
// when it says something the status line didn't.
export const trackWords = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function checkpointAdds(checkpoint, status) {
  const c = trackWords(checkpoint);
  if (!c) return false;
  const said = new Set(trackWords(status).split(' ').filter(Boolean));
  return c.split(' ').filter(Boolean).some((w) => !said.has(w));
}

// The chip says where the ORDER actually is, which is not the same as the raw status
// column. `purchase_orders.status` only ever advances as far as `receiving`, and an order
// received with nothing declared never auto-reconciles (that decision is a person's), so
// PO-100003 sat reading "Receiving" with all nine labels delivered and 54 pairs counted —
// contradicting the very line underneath it. The same wrong-by-a-stage bug shows one step
// earlier too: a `draft` order whose labels have all shipped read "Filling", as if the
// supplier were still packing.
//
// So: once every label has landed, say so; the reconciliation queue owns what happens next.
// Falls back to the raw status whenever the counts can't say better (a supplier's own
// response carries no `received_units`, and older callers pass no counts at all).
// A label that has ACTUALLY LEFT THE SUPPLIER — the client-side twin of
// LEFT_SUPPLIER_STATUSES in api/_lib/db.js. `pre_transit` is deliberately NOT here:
// tracking registers when the PO is created, so the carrier acknowledges the label within
// minutes while the box is still on the supplier's floor. `packed` isn't either — the box
// is closed, but nobody has collected it.
export const LEFT_SUPPLIER = ['shipped', 'in_transit', 'delivered'];
export const hasLeftSupplier = (box) => LEFT_SUPPLIER.includes(box?.status);
// How many of an order's own labels are on their way, out of how many there are.
// Replacements are excluded: a reship is not one of the boxes the order was raised for,
// so counting it would make the denominator disagree with the order.
export function shippedProgress(boxes) {
  const own = (boxes || []).filter((b) => b.kind !== 'replacement');
  return { gone: own.filter(hasLeftSupplier).length, total: own.length,
    delivered: own.filter((b) => b.status === 'delivered').length };
}

// Who raised it, and whether it is waiting on us. Both are facts about the ORDER rather
// than where it is, so they read as their own chips beside the status one.
// ── Where a manifest LIVES, which is two questions and not one ────────────────
// `purchase_orders.manifest_scope` has three values, and the mistake it is easy to make
// is to treat it as a single yes/no:
//
//   'box'        the supplier declares per label. Boxes carry lines; the order does not.
//   'po'         Path C — the supplier gave ONE list for the whole purchase and there is
//                no per-box breakdown at all (`purchase-orders.md`).
//   'order+box'  BOTH, and the two lists mean different things. The order-level list is
//                OURS — a buying request's receipt, written when the order is raised, so
//                we know what we are owed before a single box is filled. The per-box
//                lists are the BUYER'S packing list, saying which carton each pair is in.
//
// So every branch site has to say which question it is asking. Sites that ask
// "where does `expected` come from?" want `expectsAtOrderLevel`; sites that ask "does a
// box carry its own lines?" want `declaresPerBox`. Reading `=== 'po'` and meaning either
// one is how 'order+box' would silently behave like Path C in half the app.
export const expectsAtOrderLevel = (po) => ['po', 'order+box'].includes(String(po?.manifest_scope || 'box'));
export const declaresPerBox = (po) => ['box', 'order+box'].includes(String(po?.manifest_scope || 'box'));
// The order was raised from a buying request, so its order-level list is a receipt we
// already hold rather than a supplier's account of what they sent.
export const hasOrderedList = (po) => String(po?.manifest_scope || 'box') === 'order+box';

export const isSupplierRaised = (po) => String(po?.raised_by || 'ph') === 'supplier';
export const awaitingLabels = (po) => !!po?.labels_requested_at;

export function poChipOf(p) {
  if (p.status === 'reconciled' || p.status === 'closed') return PO_STATUS[p.status];
  // The supplier has packed and is waiting on us to buy labels. It outranks "Filling",
  // which is what the raw status still says and which reads as if the ball were theirs.
  if (awaitingLabels(p) && p.status === 'draft') {
    return { label: 'Labels requested', cls: 'warn' };
  }
  const boxes = Number(p.box_count) || 0;
  const delivered = Number(p.delivered_count) || 0;
  const shipped = Number(p.shipped_count) || 0;
  const received = Number(p.received_units) || 0;
  // "How many of the 22 are actually moving" is the question this chip is asked most, and
  // it used to be answerable only by opening the order and counting labels by eye.
  const frac = (n, noun) => (boxes === 1
    ? { label: noun === 'shipped' ? 'Shipped' : 'Delivered', cls: noun === 'shipped' ? 'shipped' : 'ok' }
    : { label: `${n}/${boxes} ${noun}`, cls: noun === 'shipped' ? 'shipped' : 'ok' });
  if (boxes > 0 && delivered === boxes) {
    return received > 0
      ? { label: 'Delivered · to reconcile', cls: 'ok' }
      : { label: 'All delivered', cls: 'ok' };
  }
  if (p.status === 'receiving') return PO_STATUS.receiving;
  // Everything has left, and some has landed — the useful number has moved on from "how
  // many shipped" to "how many are here".
  if (boxes > 0 && shipped === boxes && delivered > 0) return frac(delivered, 'delivered');
  // A label out with the carrier means the supplier has stopped filling, whatever the
  // order row still says.
  if (shipped > 0) return frac(shipped, 'shipped');
  return PO_STATUS[p.status] || { label: p.status, cls: 'muted' };
}

// ── Finding an order by the number on the parcel ──────────────────────────────
// A tracking number is what a person actually has in hand when they go looking: it is
// on the box, in the courier's email, in the supplier's message. It was the one
// identifier none of the PO lists could search by.
//
// Matching is deliberately loose in three ways, because of how the number arrives:
//   · **Substring, not equality** — people quote the last 4-6 digits ("...4821?") far
//     more often than the whole 20-character string.
//   · **Punctuation and spaces stripped** — a number pasted out of an email arrives as
//     "1Z 999 AA1 01 2345 6784", and a scanner types it clean. Those are one number.
//   · **PO code too** — same box, same intent ("find me this order"), and someone
//     holding a printed manifest has the code, not the tracking number.
// Case-insensitive throughout: `1z999…` off a phone keyboard is the same parcel.
export const trackKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── The reconciliation chip: what the RECONCILIATION of an order should actually SAY ──
// "To reconcile" on a 13-of-13 all-matched PO is noise — it reads as a chore when there
// is nothing to decide. So name the real state: what's wrong, or what's still on its
// way, or that it's done.
//   rc = { clean, no_manifest, shortage, overage, wrong_size, wrong_sku, unpacked,
//          expected_units, received_units, intake_done, awaiting_boxes }
// Lives here (not on the Reconciliation screen) because the PO list searches by it.
export function reconcileChipOf(status, rc) {
  if (status === 'reconciled') return { cls: 'ok', label: 'Reconciled' };
  if (status === 'closed') return { cls: 'muted', label: 'Archived' };
  if (!rc) return { cls: 'receiving', label: 'To reconcile' };
  if (!rc.intake_done) return { cls: 'receiving', label: 'Receiving' };
  if (rc.no_manifest) return { cls: 'warn', label: 'Received blind' };
  const issues = (rc.shortage || 0) + (rc.overage || 0) + (rc.wrong_size || 0)
    + (rc.wrong_sku || 0) + (rc.unpacked || 0);
  if (issues) return { cls: 'bad', label: `${issues} discrepanc${issues === 1 ? 'y' : 'ies'}` };
  // Clean, but auto-reconcile held off because a label hasn't left the supplier yet —
  // more units are still due, so closing now would freeze an incomplete picture.
  if (rc.awaiting_boxes) return { cls: 'receiving', label: 'Boxes still out' };
  return { cls: 'ok', label: 'Matched · ready to close' };
}

// ── One search box for everything a person knows about an order ─────────────────
// The box started as "tracking number or PO code" and that was the identifier people had
// in HAND. What they have in their HEAD is different: the shoe ("which order had the
// Chicagos"), a style code, or where it is ("the ones still shipping", "anything with a
// discrepancy"). All of it goes through the one box, because a row of dropdowns for
// status × reconciliation × kind is a form, and this is a search.
//
// Two kinds of match, chosen per WORD:
//   · CODES (PO code, tracking numbers, SKUs) match through `trackKey` — punctuation and
//     case stripped, substring — so `dz5485-612`, `DZ5485612` and `5485` all find the
//     same style, and the last four digits of a tracking number still work.
//   · WORDS (shoe names, supplier, and the status/reconciliation vocabulary the chips
//     print) match as lowercase substrings.
// Every word must land somewhere on the order, so `chicago shipped` narrows to shipped
// orders carrying the Chicagos rather than everything that is either.
//
// The status words are the CHIP LABELS, exactly as the list prints them (`poChipOf`,
// `reconcileChipOf`, the kind chip), plus the raw column value — a person searches for
// what they can read on the screen, and "labels requested" is on the screen while
// `draft` is not. A reconciliation state is only searchable where the row carries `rc`
// (the Reconciliation page); the PO list knows "received blind" and "to reconcile" from
// its own counts.
export function poSearchWords(p) {
  const words = [p?.status, PO_STATUS[p?.status]?.label, poChipOf(p || {}).label, orderKindChip(p).label];
  if (awaitingLabels(p)) words.push('labels requested');
  if (p?.status === 'receiving') words.push('to reconcile');
  if (Number(p?.unit_count) === 0 && Number(p?.received_units) > 0) words.push('received blind');
  if (p?.rc || ['reconciled', 'closed'].includes(p?.status)) words.push(reconcileChipOf(p.status, p.rc).label);
  if (p?.resolution_state === 'open') words.push('resolution open');
  if (p?.resolution_state === 'settled') words.push('resolved');
  return words.filter(Boolean).map((w) => String(w).toLowerCase());
}

// `lines` on a list row: one entry per style — `{ sku, name, qty, upcs }` — off the
// order's manifest (`listPos` and friends). The name is words; the SKU and the UPCs
// (one per size the manifest declared) are codes.
const poLines = (p) => (p?.lines || []).filter((l) => l && (l.sku || l.name));

// One WORD against one piece of text / one code — the two comparisons in the header.
const hitText = (text, w) => { const t = String(text ?? '').toLowerCase(); const l = String(w || '').toLowerCase(); return !!t && !!l && t.includes(l); };
const hitCode = (code, w) => { const c = trackKey(code); const k = trackKey(w); return !!c && !!k && c.includes(k); };

// The THINGS a word can land on. An ITEM is one line of the manifest (its name, its
// style code, its UPCs) or one tracking number; the GLOBALS are facts about the order
// as a whole — its code, its supplier, and the status words the chips print.
const lineItem = (l) => ({ line: l, name: l.name, codes: [l.sku, ...(l.upcs || [])].filter(Boolean) });
const trackItem = (t) => ({ tracking: t, name: '', codes: [t] });
const itemHit = (item, w) => hitText(item.name, w) || item.codes.some((c) => hitCode(c, w));
const globalHit = (p, w) => hitCode(p?.po_code, w) || hitText(p?.supplier_name, w) || hitText(p?.tag_code, w)
  || poSearchWords(p).some((s) => hitText(s, w));

// THE RULE: every word must land on the SAME item, or on the order as a whole.
// "nike dunk low" used to match any order with a Nike SOMETHING on one line and a
// Dunk on another — each word landed somewhere, and "somewhere" was the whole order.
// Now the content words have to land on one line (or one tracking number), while a
// word about the order — "shipped", the supplier's name — still counts from anywhere,
// so "chicago shipped" keeps narrowing to shipped orders carrying the Chicagos.
const itemSatisfies = (p, item, words) => words.every((w) => (item && itemHit(item, w)) || globalHit(p, w));

export function poMatchesSearch(p, query) {
  const raw = String(query || '').trim();
  if (!raw) return true;
  const lines = poLines(p);
  const items = [...lines.map(lineItem), ...(p?.tracking_numbers || []).map(trackItem)];
  // The whole query as ONE code first: a tracking number pasted out of an email arrives
  // as "1Z 999 AA1 01 2345 6784", and splitting that into words must not stop it
  // matching as the single number it is.
  if (hitCode(p?.po_code, raw) || items.some((it) => it.codes.some((c) => hitCode(c, raw)))) return true;
  const words = raw.split(/\s+/);
  // `null` stands for "no item" — an order with nothing inside can still match on its
  // own code, supplier or status.
  return [null, ...items].some((it) => itemSatisfies(p, it, words));
}

// ── What a matched row should SHOW, before it is opened ─────────────────────────
// A list of PO codes that all "match chicago" is a list you still have to open one by
// one. So each row previews the part of itself the search landed on: the manifest lines
// the search satisfied (first), the tracking number it satisfied, and the status word
// it landed on — each marked up by `segmentsFor` so the eye goes straight to the hit.
// When the search landed on nothing INSIDE the order (a PO code, the supplier), the row
// still previews its biggest lines: the person is asking what is in these orders, and
// "nothing matched inside" is not an answer to that.
//
// Pure, no clock. `words` is the query split into words PLUS the whole query, so a
// spaced tracking number is marked as the one code it is — the same rule as the filter.
export function poSearchHits(p, query, { maxLines = 3 } = {}) {
  const raw = String(query || '').trim();
  if (!raw) return null;
  const words = raw.split(/\s+/);
  const lines = poLines(p);
  // A line is a hit when the SEARCH is satisfied on it — same rule as the filter — and
  // at least one word actually landed on the line itself rather than on the order.
  const satisfied = (item) => (item.codes.some((c) => hitCode(c, raw)))
    || (itemSatisfies(p, item, words) && words.some((w) => itemHit(item, w)));
  const hitLines = lines.filter((l) => satisfied(lineItem(l)));
  const rest = lines.filter((l) => !hitLines.includes(l));
  const shown = [...hitLines, ...rest].slice(0, Math.max(maxLines, hitLines.length));
  const tracking = (p?.tracking_numbers || []).filter((t) => satisfied(trackItem(t)));
  // Status words as the chips print them; only the ones the search landed on — and one
  // chip for a state, not two: the raw column value ("shipped") sits inside the chip's
  // own label ("2/2 shipped") and printing both said the same thing twice.
  const landed = [...new Set(poSearchWords(p).filter((s) => words.some((w) => hitText(s, w))))];
  const status = landed.filter((w) => !landed.some((o) => o !== w && o.includes(w)));
  return {
    words: [...new Set([raw, ...words])],
    lines: shown.map((l) => ({ ...l, hit: hitLines.includes(l) })),
    more: Math.max(0, lines.length - shown.length),
    tracking,
    status,
    insideHit: hitLines.length > 0 || tracking.length > 0 || status.length > 0,
  };
}

// The same question asked of a receiving BATCH: "which batch is this parcel?"
//
// A batch carries tracking in two places and both are the number on a real carton —
// `tracking_number` on the batch (a single-box shipment, or the one typed at intake) and
// one per box in `box_tracking_numbers`. Searching only the first finds nothing for the
// multi-box shipments, which are most of them.
//
// This is the CLIENT-side filter over a list already on screen. The server has its own
// matcher (`searchBatches` in api/_lib/db.js) for looking beyond that window; both
// normalise through trackKey so they agree on what counts as the same number.
export function batchMatchesSearch(b, query) {
  const q = trackKey(query);
  if (!q) return true;
  if (trackKey(b?.batch_code).includes(q)) return true;
  if (b?.tracking_number && trackKey(b.tracking_number).includes(q)) return true;
  return (b?.box_tracking_numbers || []).some((t) => trackKey(t).includes(q));
}
