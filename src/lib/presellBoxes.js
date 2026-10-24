// Pre-sell BOX CONTENTS (docs/presell-box-tracking-plan.md, owner 2026-10-24) — pure helpers
// shared by the server (sale post, arrival post) and the screen (Stock tab, Fulfill).
//
// A box = one of OUR labels on the PO; the supplier packs it, often with mixed sizes (3 × 8,
// 3 × 9, 3 × 10). So a size's tracking numbers are never typed against the size — they're
// derived from what each box holds. One box per stock row looks like:
//   { id, po_id, po_code, box_number, tracking, status, received, eta_from, eta_to,
//     qty: n | null (null = some, count unknown), source: 'supplier' | 'staff' | 'presell' }

// The order the pairs become available in: received boxes first, then delivered, then the
// one the carrier says lands soonest; no ETA last. Sold pairs are promised from the front.
const etaKey = (b) => String(b.eta_from || b.eta_to || '9999-12-31').slice(0, 10);
const stage = (b) => (b.received ? 0 : b.status === 'delivered' ? 1 : 2);
export function boxOrder(boxes) {
  return [...(boxes || [])].sort((a, b) => stage(a) - stage(b) || etaKey(a).localeCompare(etaKey(b))
    || (Number(a.box_number) || 1e9) - (Number(b.box_number) || 1e9) || Number(a.id) - Number(b.id));
}

// Where a stock row stands. Boxes hold PHYSICAL pairs (the supplier's list counts every pair of
// the order, not only the pre-sold ones), so each order is judged on its own (`box_pos`):
//   placed    counted pairs in the boxes
//   unknown   boxes marked "?" (count unknown)
//   unplaced  pre-listed pairs on an order with fewer pairs in its boxes — a to-do, not an error
//   over      more in an order's boxes than the order itself lists (only when it has a list)
// Without box_pos (an older caller) it falls back to boxes vs the row's pairs.
export function boxSummary(row, legacyBoxes) {
  if (typeof row !== 'object' || row == null || legacyBoxes) {
    const list = legacyBoxes || [];
    const placed = list.reduce((n, b) => n + (b.qty == null ? 0 : Number(b.qty) || 0), 0);
    const q = Math.max(0, Number(row) || 0);
    return { placed, unknown: list.filter((b) => b.qty == null).length, unplaced: Math.max(0, q - placed), over: Math.max(0, placed - q), boxes: list.length };
  }
  const boxes = row.boxes || [];
  const pos = row.box_pos || [];
  if (!pos.length) return boxSummary(row.qty, boxes);
  let placed = 0; let unplaced = 0; let over = 0; let unknown = 0;
  for (const p of pos) {
    placed += p.placed; unknown += p.unknown;
    unplaced += Math.max(0, (Number(p.pairs) || 0) - p.placed);
    if (p.expected != null) over += Math.max(0, p.placed - p.expected);
  }
  return { placed, unknown, unplaced, over, boxes: boxes.length };
}

// The box the n-th pair (1-based) comes out of, walking boxOrder by counted pairs. null when
// the pair isn't in a counted box (not placed yet, or only in "count unknown" boxes).
export function boxForPair(boxes, n) {
  let at = 0;
  for (const b of boxOrder(boxes)) {
    if (b.qty == null) continue;
    at += Number(b.qty) || 0;
    if (n <= at) return b;
  }
  return null;
}

// The box a just-sold in-transit pair comes in. Pairs that already arrived were set aside for
// earlier buyers (presell-arrival), so this pair is the owed-th one among the boxes NOT yet
// received, in landing order — the same rule Fulfill uses (transitBoxes). null once every pair
// is here (pull it from the shelf) or when it isn't in a counted box.
export function boxForSale(stock, boxes) {
  if (!stock || stock.arrived_at) return null;
  const owed = Math.max(0, Number(stock.sold || 0) - (Number(stock.arrived_qty || 0) - Number(stock.released_qty || 0)));
  return owed ? boxForPair((boxes || []).filter((b) => !b.received), owed) : null;
}

// Short form for tight spaces: "1Z…4784" (the full number goes in a title / CSV).
export function shortTrack(t) {
  const s = String(t || '').trim();
  return s.length > 10 ? `${s.slice(0, 2)}…${s.slice(-4)}` : s;
}

const md = (d) => String(d || '').slice(5, 10).replace('-', '/');
// Where the box is, in words: received / delivered / on its way (exp m/d) / still with the supplier.
export function boxState(b) {
  if (b.received) return { key: 'received', word: 'received', icon: '✅' };
  if (b.status === 'delivered') return { key: 'delivered', word: 'delivered, not received yet', icon: '📬' };
  if (['in_transit', 'shipped'].includes(b.status)) {
    const eta = b.eta_from || b.eta_to;
    return { key: 'transit', word: eta ? `in transit · exp ${md(eta)}` : 'in transit', icon: '🚚' };
  }
  return { key: 'supplier', word: 'with the supplier', icon: '🏷' };
}

// One line for a box: "3 in 1Z…4784 🚚 in transit · exp 10/26" (count unknown → "some in").
export function boxLine(b, { short = true } = {}) {
  const st = boxState(b);
  const t = b.tracking ? (short ? shortTrack(b.tracking) : b.tracking) : `box ${b.box_number ?? '?'}`;
  return `${b.qty == null ? 'some' : b.qty} in ${t} ${st.icon} ${st.word}`;
}

// Fulfill (where is the pair): orders still waiting on the truck get the box their pair is
// coming in. Pairs that already arrived were set aside for the earliest buyers (assignWhere
// hands those out first), so the orders passed here take the NOT-yet-received boxes from the
// front of boxOrder. `orders` is already sorted most-urgent first. Returns Map(order → box|null).
export function transitBoxes(orders, boxes) {
  const pending = (boxes || []).filter((b) => !b.received);
  const out = new Map();
  (orders || []).forEach((o, i) => out.set(o, boxForPair(pending, i + 1)));
  return out;
}
