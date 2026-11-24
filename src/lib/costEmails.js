// Costs from the stores' emails (docs/context/costs.md → "Fill from emails"). Pure: no
// network, no database — the server (api/_lib/cost-emails.js) hands these the emails.
//
// The chain, per parcel:  tracking number → the store's shipping email (which order, and
// usually which pairs are in THIS parcel) → the order's confirmation (what each pair was
// PAID: the line after the store's discount, before any gift card) → the pairs we scanned
// under that tracking number.
//
// An email is { subject, from, date, text } (plain text; what Make scenario 7082222 returns).
// Each store writes its emails its own way, so each has a reader. A store with no reader, or
// whose emails are HTML only (no text reaches us), is reported as such — never guessed.

const URL_RE = /\[?\(?\s*https?:\/\/\S+\s*\)?/g;
export const emailLines = (text) => String(text || '').split(/\r?\n/).map((l) => l.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
export const bare = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// "08.0", "12.0 REG", "7.5W", "5Y" → the number. The letters are the box's sizing, not a
// different pair (the same rule the online-order check uses).
export const sizeNum = (z) => { const m = String(z ?? '').match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
const moneyOf = (l) => { const m = String(l || '').match(/^\$\s?([\d,]+(?:\.\d{1,2})?)(?:\s*USD)?$/i); return m ? Number(m[1].replace(/,/g, '')) : null; };
const cents = (n) => Math.round(Number(n) * 100) / 100;
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const STORES = [
  [/shoepalace/i, 'Shoe Palace'], [/champssports/i, 'Champs Sports'], [/kidsfootlocker/i, 'Kids Foot Locker'],
  [/footlocker/i, 'Foot Locker'], [/jdsports/i, 'JD Sports'], [/dtlr/i, 'DTLR'], [/supremenewyork/i, 'Supreme'],
  [/nike/i, 'Nike'], [/adidas/i, 'adidas'], [/dickssportinggoods/i, 'Dick’s Sporting Goods'], [/puma/i, 'Puma'],
];
export function storeOf(email) {
  const from = String(email?.from || '');
  const hit = STORES.find(([re]) => re.test(from));
  if (hit) return hit[1];
  // A Shopify store sends from shopifyemail.com; its name is the line above "Order #…".
  const ls = emailLines(email?.text);
  const at = ls.findIndex((l) => /^order\s*#/i.test(l));
  if (at > 0 && ls[at - 1].length <= 40 && !/[.!]$/.test(ls[at - 1])) return ls[at - 1];
  return (from.split('@')[1] || '').replace(/^(t|em|e|mail|notifications?|ship)\./i, '').split('.')[0] || null;
}

// "order #SP2520297", "Order 5864970 Has Been Fulfilled", "Order: P7502258312436543488",
// "Order Number: 60033625400". Needs a digit and 5+ characters; the subject is asked first.
const ORDER_RE = /\border\s*(?:number|no\.?|id)?\s*[:#]?\s*#?\s*([A-Z]{0,4}\d[A-Z0-9-]{4,25})\b/i;
export function orderNumberOf(email) {
  for (const s of [email?.subject, ...emailLines(email?.text).slice(0, 60)]) {
    const m = String(s || '').match(ORDER_RE);
    if (m && /\d{4}/.test(m[1])) return m[1].toUpperCase();
  }
  return null;
}
const mentions = (email, tracking) => bare(email?.text).includes(bare(tracking)) || bare(email?.subject).includes(bare(tracking));

// ── Shopify (Shoe Palace, DTLR's confirmation, …) ────────────────────────────────────────
// Shipping email:  "Items in this shipment" → name… ×  /  "1 of 10"  /  size  /  [code / (-$x)]
export function readShopifyShipment(email) {
  const ls = emailLines(email?.text);
  const start = ls.findIndex((l) => /^items in this shipment$/i.test(l));
  if (start < 0) return null;
  const items = [];
  let name = [];
  for (let i = start + 1; i < ls.length; i += 1) {
    const l = ls[i];
    if (/^-{3,}$/.test(l)) continue;
    if (/^(if you have any questions|customer information|shipping address)/i.test(l)) break;
    if (/^\(-\$[\d,.]+\)$/.test(l)) { name = []; continue; }   // the discount under a line; its code was read as a name
    if (!/×$/.test(l)) { name.push(l); continue; }
    name.push(l.replace(/\s*×$/, ''));
    const q = (ls[i + 1] || '').match(/^(\d{1,3})(?:\s+of\s+\d{1,3})?$/i);
    if (!q) { name = []; continue; }
    i += 1;
    let size = null;
    const v = ls[i + 1] || '';
    if (v && v.length <= 30 && !/×$/.test(v) && !/^\(-\$/.test(v) && !/^(if you have any questions|customer information)/i.test(v)) { size = v; i += 1; }
    items.push({ name: name.join(' ').trim(), size, qty: Number(q[1]) });
    name = [];
  }
  return items.length ? { items } : null;
}

// Confirmation: "Order summary" → name… × N / size / [code / (-$x) / $full] / $paid … Subtotal.
// `paid` is the line AFTER the store's discount — what was paid for those pairs.
export function readShopifyConfirmation(email) {
  const ls = emailLines(email?.text);
  const start = ls.findIndex((l) => /^order summary$/i.test(l));
  if (start < 0) return null;
  const out = [];
  const totals = {};
  let name = [];
  let i = start + 1;
  while (i < ls.length) {
    const l = ls[i];
    if (/^-{3,}$/.test(l)) { i += 1; continue; }
    const t = l.match(/^(subtotal|shipping|taxes|estimated taxes|total)$/i);
    if (t) { totals[t[1].toLowerCase()] = moneyOf(ls[i + 1]); i += 2; continue; }
    if (/^(customer information|you saved|gift card)/i.test(l)) break;
    const m = l.match(/^(.*?)\s*×\s*(\d{1,3})$/);
    if (!m) { name.push(l); i += 1; continue; }
    name.push(m[1]);
    let j = i + 1;
    let size = null;
    if (ls[j] && moneyOf(ls[j]) == null && !/×\s*\d{1,3}$/.test(ls[j]) && ls[j].length <= 30) { size = ls[j]; j += 1; }
    const money = [];
    while (j < ls.length) {
      const v = moneyOf(ls[j]);
      if (v != null) { money.push(v); j += 1; continue; }
      if (money.length) break;                                  // the next shoe's name
      if (/^(subtotal)$/i.test(ls[j])) break;
      j += 1;                                                   // the discount code and "(-$x)"
    }
    if (money.length) {
      const qty = Number(m[2]);
      const paid = money[money.length - 1];
      out.push({ name: name.join(' ').trim(), size, qty, full: cents(money[0] / qty), each: cents(paid / qty) });
    }
    name = [];
    i = j;
  }
  return out.length ? { lines: out, totals } : null;
}

// ── DTLR's "Order N Has Been Fulfilled": SKU + size + the tracking number, no price ──────
export function readDtlrFulfilled(email, tracking) {
  const want = bare(tracking);
  const items = [];
  for (const l of emailLines(email?.text)) {
    const m = l.match(/([A-Z0-9]{2,}(?:-[A-Z0-9]+)*)\s*Color=[^;]*;\s*Size=(\S+)\s+(\d+)\s+(\d+)\s+.*?([A-Z0-9]{10,34})\s*$/i);
    if (m && bare(m[5]) === want && Number(m[4]) > 0) items.push({ sku: m[1].toUpperCase(), name: null, size: m[2], qty: Number(m[4]) });
  }
  return items.length ? { items } : null;
}

// ── Foot Locker / Champs / Kids Foot Locker: "Your order is ready to go" ─────────────────
// One email per package, with the pairs and the price of each:  name / "Size 08.0" /
// "Qty 1" / "$105.00".
export function readFootLockerPackage(email) {
  const ls = emailLines(email?.text);
  const start = ls.findIndex((l) => /^in this package$/i.test(l));
  if (start < 0) return null;
  const items = [];
  for (let i = start + 1; i < ls.length - 2; i += 1) {
    if (/^order summary$/i.test(ls[i])) break;
    const s = ls[i].match(/^size\s+(.+)$/i);
    const q = (ls[i + 1] || '').match(/^qty\s+(\d{1,3})$/i);
    const p = moneyOf(ls[i + 2]);
    if (!s || !q || p == null) continue;
    let name = ls[i - 1] || '';
    const half = name.slice(0, Math.floor(name.length / 2)).trim();   // the name is printed twice on one line
    if (half && name === `${half} ${half}`) name = half;
    items.push({ name, size: s[1], qty: Number(q[1]), each: cents(p), full: cents(p) });
    i += 2;
  }
  return items.length ? { items, priced: true } : null;
}

// ── JD Sports: "ORDER UPDATE" lists each parcel under "Tracking: …" with its pairs ───────
// The discount is on the ORDER (Total < Subtotal + shipping + tax), so it is spread over the
// pairs by price — said in the note, because it is worked out rather than printed per pair.
export function readJdUpdate(email, tracking) {
  const ls = emailLines(email?.text);
  if (!ls.some((l) => /^order number:/i.test(l))) return null;
  const want = bare(tracking);
  const items = [];
  let cur = null;
  for (let i = 0; i < ls.length; i += 1) {
    const t = ls[i].match(/^tracking:\s*([A-Z0-9]{8,34})/i);
    if (t) { cur = bare(t[1]); continue; }
    if (/^(processing|order summary|cancell?ed)$/i.test(ls[i])) { cur = null; continue; }
    const s = ls[i].match(/^size:\s*(.+)$/i);
    if (!s || cur !== want) continue;
    const price = moneyOf(ls[i - 1]);
    const q = (ls[i + 1] || '').match(/^quantity:\s*(\d{1,3})$/i);
    if (price == null || !q) continue;
    items.push({ name: ls[i - 2] || '', size: s[1], qty: Number(q[1]), full: cents(price), each: cents(price) });
  }
  if (!items.length) return null;
  const val = (label) => {
    const at = ls.findIndex((l) => label.test(l));
    if (at < 0) return null;
    const v = String(ls[at + 1] || '').replace(/^\$/, '').replace(/,/g, '');
    return /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
  };
  const sub = val(/^subtotal\b/i); const total = val(/^total:?$/i);
  const ship = val(/^shipping:$/i) || 0; const tax = val(/^tax:$/i) || 0;
  let note = null;
  if (sub > 0 && total != null) {
    const off = cents(sub + ship + tax - total);
    if (off > 0.005 && off < sub) {
      for (const it of items) it.each = cents(it.full * (1 - off / sub));
      note = `order discount $${off.toFixed(2)} spread by price`;
    }
  }
  return { items, priced: true, note };
}

// ── Supreme: "online shop order has been shipped" — Style / Size / Quantity / Price ─────
export function readSupremeShipped(email) {
  const ls = emailLines(email?.text);
  if (!ls.some((l) => /^your tracking number is/i.test(l))) return null;
  const items = [];
  for (let i = 0; i < ls.length; i += 1) {
    const s = ls[i].match(/^size:\s*(.+)$/i);
    if (!s) continue;
    const q = (ls[i + 1] || '').match(/^quantity:\s*(\d{1,3})$/i);
    const price = /^price:?$/i.test(ls[i + 2] || '') ? Number(String(ls[i + 3] || '').replace(/[$,]/g, '')) : NaN;
    if (!q || !Number.isFinite(price)) continue;
    const style = (ls[i - 1] || '').match(/^style:\s*(.+)$/i);
    items.push({ name: `${ls[i - (style ? 2 : 1)] || ''}${style ? ` (${style[1]})` : ''}`.trim(), size: s[1], qty: Number(q[1]), full: cents(price), each: cents(price) });
  }
  return items.length ? { items, priced: true } : null;
}

/**
 * The emails a tracking-number search returned → what that parcel is.
 * → { state: 'ok', store, order, items: [{ name, sku?, size, qty, each?, full? }], priced, note }
 *   | { state: 'no_email' | 'no_text' | 'unreadable', store?, order? }
 * `priced` false = the pairs are known but not their price: the order's confirmation has it.
 */
export function readParcel(emails, tracking) {
  const all = (emails || []).filter((e) => e && (e.subject || e.text));
  if (!all.length) return { state: 'no_email' };
  const withText = all.filter((e) => String(e.text || '').trim().length > 40);
  const store = storeOf(all[0]);
  if (!withText.length) return { state: 'no_text', store };
  const mine = withText.filter((e) => mentions(e, tracking));
  const order = (mine.length ? mine : withText).map(orderNumberOf).find(Boolean) || null;
  // The newest email that names the parcel says the most (a later update lists more pairs).
  for (const e of [...mine].reverse()) {
    const r = readFootLockerPackage(e) || readJdUpdate(e, tracking) || readSupremeShipped(e) || readDtlrFulfilled(e, tracking) || readShopifyShipment(e);
    if (r) return { state: 'ok', store: storeOf(e) || store, order: orderNumberOf(e) || order, items: r.items, priced: r.priced === true, note: r.note || null };
  }
  return { state: 'unreadable', store, order };
}

/** The emails an order-number search returned → its priced lines (the confirmation). */
export function readOrder(emails) {
  for (const e of emails || []) {
    const r = readShopifyConfirmation(e);
    if (r) return { state: 'ok', store: storeOf(e), lines: r.lines, totals: r.totals };
  }
  return { state: (emails || []).length ? 'unreadable' : 'no_email' };
}

const womensOf = (emailSize, boxSize) => /\dW$/i.test(String(boxSize || '').trim()) && !/W$/i.test(String(emailSize || '').trim())
  && sizeNum(boxSize) - 1.5 === sizeNum(emailSize);
// One price out of a set of candidates, or null when they disagree.
const onePrice = (list) => {
  const set = [...new Set(list.map((x) => x.each).filter((v) => v != null))];
  return set.length === 1 ? list.find((x) => x.each === set[0]) : null;
};

/**
 * Price the pairs we scanned under one tracking number.
 *   pairs      [{ id, sku, size }]
 *   parcel     readParcel's answer
 *   order      readOrder's answer (or null when the parcel email already carries prices)
 *   skuNames   Map(bare SKU → Set(nameKey)) learned from parcels that hold ONE shoe
 * → [{ id, each, full, how, note } | { id, reason }]
 *
 * A pair takes the price of the parcel's line for its size (and its SKU, when the email
 * prints one). Two shoes of one size at two prices is settled by the name learned for the
 * SKU, else left for a person. A pair not in the parcel's email (two parcels scanned under
 * one number) falls back to the ORDER's lines, on the same rule.
 */
export function priceParcel(pairs, parcel, order = null, skuNames = new Map()) {
  if (!parcel || parcel.state !== 'ok') {
    const why = { no_email: 'No email carries this tracking number', no_text: 'The store’s emails are pictures only (no text to read)', unreadable: 'The store’s email is not one we can read yet' }[parcel?.state] || 'Not found';
    return pairs.map((p) => ({ id: p.id, reason: why }));
  }
  const lines = order?.state === 'ok' ? order.lines : [];
  // The parcel's pairs with a price each: printed in the email, or taken from the order.
  const priced = parcel.items.map((it) => {
    if (it.each != null) return it;
    const same = lines.filter((l) => sizeNum(l.size) === sizeNum(it.size) || (Number.isNaN(sizeNum(l.size)) && Number.isNaN(sizeNum(it.size))));
    const byName = it.name ? same.filter((l) => nameKey(l.name) === nameKey(it.name)) : [];
    const known = it.sku && skuNames.get(bare(it.sku)) ? same.filter((l) => skuNames.get(bare(it.sku)).has(nameKey(l.name))) : [];
    const hit = onePrice(byName.length ? byName : known.length ? known : same);
    return hit ? { ...it, each: hit.each, full: hit.full, lineName: hit.name } : it;
  });
  const pick = (list, p) => {
    let size = list.filter((x) => x.each != null && sizeNum(x.size) === sizeNum(p.size));
    // The box in women's sizing ("9.5W") for the men's size the store sold (8): the same
    // pair, a size and a half apart — the rule the online-order check already uses.
    if (!size.length) size = list.filter((x) => x.each != null && womensOf(x.size, p.size));
    const bySku = size.filter((x) => x.sku && bare(x.sku) === bare(p.sku));
    if (bySku.length) return onePrice(bySku);
    const names = skuNames.get(bare(p.sku));
    const byName = names ? size.filter((x) => names.has(nameKey(x.name || x.lineName))) : [];
    return onePrice(byName.length ? byName : size.filter((x) => !x.sku));
  };
  return pairs.map((p) => {
    const inParcel = pick(priced, p);
    if (inParcel) return { id: p.id, each: inParcel.each, full: inParcel.full ?? inParcel.each, how: 'parcel', name: inParcel.name || inParcel.lineName || null, note: parcel.note || null };
    const inOrder = lines.length ? pick(lines, p) : null;
    if (inOrder && skuNames.get(bare(p.sku))) return { id: p.id, each: inOrder.each, full: inOrder.full, how: 'order', name: inOrder.name, note: 'not listed in this parcel’s email; priced from the order by shoe and size' };
    const sizes = priced.filter((x) => sizeNum(x.size) === sizeNum(p.size) || womensOf(x.size, p.size));
    if (!sizes.length) return { id: p.id, reason: 'This size is not in the parcel’s email' };
    if (sizes.every((x) => x.each == null)) return { id: p.id, reason: order?.state === 'ok' ? 'The order’s confirmation has no line for this pair' : 'The order’s confirmation email was not found' };
    return { id: p.id, reason: 'Two shoes of this size at different prices in the parcel' };
  });
}

/** Learn SKU → the store's name for it, from parcels that hold exactly one shoe each way. */
export function learnNames(skuNames, pairs, parcel) {
  if (parcel?.state !== 'ok') return;
  const skus = [...new Set(pairs.map((p) => bare(p.sku)).filter(Boolean))];
  const names = [...new Set(parcel.items.map((i) => nameKey(i.name)).filter(Boolean))];
  if (skus.length !== 1 || names.length !== 1) return;
  if (!skuNames.has(skus[0])) skuNames.set(skus[0], new Set());
  skuNames.get(skus[0]).add(names[0]);
}
