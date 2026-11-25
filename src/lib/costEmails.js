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
// Some stores' "text" is their HTML with the tags half-stripped (adidas): <br> is a line,
// &zwnj; / &nbsp; are padding.
const untag = (text) => String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/&zwnj;|&nbsp;|\u200c/gi, ' ');
export const emailLines = (text) => untag(text).split(/\r?\n/).map((l) => l.replace(URL_RE, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
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

// ── Foot Locker / Champs / Kids Foot Locker ──────────────────────────────────────────────
// "Your order is ready to go" (one email per package) and "Thank you for your order" (the
// confirmation) print each line the same way:
//   name / "Size 08.0" / "Qty 3" / "$420.00"            ← the amount is for the WHOLE line
//   name / "Size 13.0" / "Qty 2" / "$250.00 $179.98"    ← on sale: was, now (both for the line)
// and the store's discount is NOT on the line: it is in the summary under them —
//   SUBTOTAL / (4 items) / $740.00 / … / DISCOUNTS / -$420.04 / … / TOTAL / $319.96
// so a pair's price PAID = line ÷ pairs, less its share of DISCOUNTS (spread by price).
// (2026-11-26: the line was taken as one pair's price — 3 pairs at $420 each — and the
// discount was not read at all.) Some emails leave the summary blank ("$", TOTAL $0.00):
// then nothing says whether there was a discount → `unsure`, and the order is asked.
const MONEY_ALL = /\$\s?([\d,]+\.\d{2})/g;
const moneyAll = (l) => [...String(l || '').matchAll(MONEY_ALL)].map((m) => Number(m[1].replace(/,/g, '')));
function footLockerLines(ls, from) {
  const end = ls.findIndex((l, i) => i > from && /^order summary$/i.test(l));
  const stop = end < 0 ? ls.length : end;
  const items = [];
  for (let i = from + 1; i < stop - 1; i += 1) {
    const s = ls[i].match(/^size\s+(.+)$/i);
    const q = (ls[i + 1] || '').match(/^qty\s+(\d{1,3})$/i);
    if (!s || !q) continue;
    // The line's amounts: one line or two ("$250.00" / "$179.98"), the last is what it sold at.
    let money = []; let j = i + 2;
    while (j < stop && j <= i + 3) { const m = moneyAll(ls[j]); if (!m.length || !/^[\s$\d,.]+$/.test(ls[j])) break; money = money.concat(m); j += 1; }
    const qty = Number(q[1]);
    if (!money.length || !qty) continue;
    let name = ls[i - 1] || '';
    const half = name.slice(0, Math.floor(name.length / 2)).trim();   // the name is printed twice on one line
    if (half && name === `${half} ${half}`) name = half;
    items.push({ name, size: s[1], qty, full: cents(money[0] / qty), each: cents(money[money.length - 1] / qty) });
    i = j - 1;
  }
  if (!items.length) return null;
  // The summary: the first amount under each label ("(4 items)" sits between), "$" = blank.
  const under = (label) => {
    if (end < 0) return null;
    const at = ls.findIndex((l, i) => i > end && label.test(l));
    if (at < 0) return null;
    for (let k = at + 1; k <= at + 2 && k < ls.length; k += 1) { const m = moneyAll(ls[k]); if (m.length) return m[m.length - 1]; if (/^(shipping|discounts?|tax|total|payment|flx)/i.test(ls[k])) break; }
    return null;
  };
  const sub = under(/^subtotal$/i); const off = under(/^discounts?$/i);
  let note = null; let unsure = false;
  if (!(sub > 0)) { unsure = true; note = 'this email shows no order total, so a store discount could not be checked'; }
  else if (off > 0.005 && off < sub) {
    for (const it of items) it.each = cents(it.each * (1 - off / sub));
    note = `store discount $${off.toFixed(2)} spread by price`;
  }
  return { items, note, unsure };
}
export function readFootLockerPackage(email) {
  const ls = emailLines(email?.text);
  const start = ls.findIndex((l) => /^in this package$/i.test(l));
  if (start < 0) return null;
  const r = footLockerLines(ls, start);
  return r ? { items: r.items, priced: true, note: r.note, unsure: r.unsure } : null;
}
// The confirmation ("Thank you for your order, …" / "We’re working on your order now").
export function readFootLockerConfirmation(email) {
  const ls = emailLines(email?.text);
  if (ls.some((l) => /^in this package$/i.test(l)) || !ls.some((l) => /^order summary$/i.test(l))) return null;
  if (!/footlocker|champssports/i.test(String(email?.from || '')) && !ls.some((l) => /working on your order|thank you for shopping with us/i.test(l))) return null;
  const r = footLockerLines(ls, -1);
  return r && !r.unsure ? { lines: r.items, note: r.note } : null;
}

// ── JD Sports ────────────────────────────────────────────────────────────────────────────
// "ORDER UPDATE" lists each parcel under "Tracking: …" (also written "Shipping Tracking: …")
// with its pairs:  name / $80.00 (ONE pair) / Size: 12.0 REG / Quantity: 1.  The confirmation
// ("You've got great taste") lists the order the same way, with no tracking number.
// The discount is on the ORDER — "Coupon: / SAVEMORE / -$294.00", or just Total < Subtotal —
// so it is spread over the pairs by price, and said in the note. An update whose summary is
// all $0.00 says nothing about a discount → `unsure`, and the order's confirmation is asked.
function jdSummary(ls) {
  const val = (label) => {
    const at = ls.findIndex((l) => label.test(l));
    if (at < 0) return null;
    const same = ls[at].slice(ls[at].indexOf(':') + 1).replace(/[$,\s]/g, '');
    if (/^-?\d+(\.\d+)?$/.test(same)) return Math.abs(Number(same));
    for (let k = at + 1; k <= at + 2 && k < ls.length; k += 1) {
      const v = String(ls[k]).replace(/[$,\s]/g, '');
      if (/^-?\d+(\.\d+)?$/.test(v)) return Math.abs(Number(v));
      if (/:/.test(ls[k])) break;                                   // the next label
    }
    return null;
  };
  const sub = val(/^subtotal\b.*:/i); const total = val(/^total:/i);
  const ship = val(/^shipping:/i) || 0; const tax = val(/^tax:/i) || 0;
  const coupon = val(/^coupon:/i);
  if (!(sub > 0)) return { known: false, off: 0, sub: 0 };
  const off = total != null ? cents(sub + ship + tax - total) : cents(coupon || 0);
  return { known: true, off: off > 0.005 && off < sub ? off : 0, sub };
}
function jdItems(ls, tracking) {
  const want = tracking ? bare(tracking) : null;
  const items = [];
  let cur = null;
  for (let i = 0; i < ls.length; i += 1) {
    const t = ls[i].match(/^(?:shipping\s+)?tracking:\s*([A-Z0-9]{8,34})/i);
    if (t) { cur = bare(t[1]); continue; }
    if (/^(processing|order summary|cancell?ed)$/i.test(ls[i])) { cur = null; continue; }
    const s = ls[i].match(/^size:\s*(.+)$/i);
    if (!s || (want && cur !== want)) continue;
    const price = moneyOf(ls[i - 1]);
    const q = (ls[i + 1] || '').match(/^quantity:\s*(\d{1,3})$/i);
    if (price == null || !q) continue;
    items.push({ name: ls[i - 2] || '', size: s[1], qty: Number(q[1]), full: cents(price), each: cents(price) });
  }
  return items;
}
export function readJdUpdate(email, tracking) {
  const ls = emailLines(email?.text);
  if (!ls.some((l) => /^order number:/i.test(l))) return null;
  const items = jdItems(ls, tracking);
  if (!items.length) return null;
  const sum = jdSummary(ls);
  let note = null;
  if (!sum.known) note = 'this email shows no order total, so a store discount could not be checked';
  else if (sum.off) {
    for (const it of items) it.each = cents(it.full * (1 - sum.off / sum.sub));
    note = `order discount $${sum.off.toFixed(2)} spread by price`;
  }
  return { items, priced: true, note, unsure: !sum.known };
}
// Any JD email that lists the whole order WITH its totals (the confirmation, a full update).
export function readJdOrder(email) {
  if (!/jdsports/i.test(String(email?.from || ''))) return null;
  const ls = emailLines(email?.text);
  if (!ls.some((l) => /^order number:/i.test(l))) return null;
  const sum = jdSummary(ls);
  if (!sum.known) return null;
  const items = jdItems(ls, null);
  if (!items.length) return null;
  if (sum.off) for (const it of items) it.each = cents(it.full * (1 - sum.off / sum.sub));
  return { lines: items, note: sum.off ? `order discount $${sum.off.toFixed(2)} spread by price` : null };
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

// ── adidas: "Your adidas receipt" — the one store email that prints the article number ──
//   RESPONSE CL CRYWHT/ ,9-   /   Article No: IG6226   /   Selling Price: $44.19   /
//   60% OFF RED TAG - 77.98   /   IDme 15% Off - 7.80
// "Selling Price" is already after the discounts under it (what was paid); "9-" is 9.5.
export function readAdidasReceipt(email) {
  const ls = emailLines(email?.text);
  const out = [];
  for (let i = 1; i < ls.length - 1; i += 1) {
    const a = ls[i].match(/^article no:?\s*([A-Z0-9]{5,12})$/i);
    const p = (ls[i + 1] || '').match(/^selling price:?\s*\$?\s*([\d,]+\.\d{2})$/i);
    const n = (ls[i - 1] || '').match(/^(.*?)\s*,\s*(\d{1,2}(?:\.5)?)(-)?\s*$/);
    if (!a || !p || !n) continue;
    const each = Number(p[1].replace(/,/g, ''));
    let off = 0;
    for (let j = i + 2; j < ls.length; j += 1) {
      const d = ls[j].match(/\s-\s*([\d,]+\.\d{2})$/);
      if (!d) break;
      off += Number(d[1].replace(/,/g, ''));
    }
    out.push({ sku: a[1].toUpperCase(), name: n[1].replace(/\/$/, '').trim(), size: n[3] ? String(Number(n[2]) + 0.5) : n[2], qty: 1, each: cents(each), full: cents(each + off) });
  }
  return out.length ? { lines: out } : null;
}

// adidas.com order emails (confirmation, "order update"): per shoe
//   SAMBA OG SHOES / $180.00 $45.00 x 4 $120.00 / Color: … / Size: 8 / Quantity: 4 / Article No: KI6956
// = listed $45 a pair, $120 paid for the four → $30 a pair.
export function readAdidasOrder(email) {
  const ls = emailLines(email?.text);
  const out = [];
  for (let i = 3; i < ls.length; i += 1) {
    const a = ls[i].match(/^article no:?\s*([A-Z0-9]{5,12})$/i);
    if (!a) continue;
    const back = ls.slice(Math.max(0, i - 6), i);
    const q = back.map((l) => l.match(/^quantity:\s*(\d{1,3})$/i)).find(Boolean);
    const z = back.map((l) => l.match(/^size:\s*(.+)$/i)).find(Boolean);
    const m = back.map((l) => l.match(/\$([\d,]+\.\d{2})\s*x\s*(\d{1,3})\s+\$([\d,]+\.\d{2})\s*$/i)).find(Boolean);
    if (!q || !z || !m) continue;
    const qty = Number(q[1]);
    if (!qty || Number(m[2]) !== qty) continue;
    const at = back.findIndex((l) => /\$[\d,]+\.\d{2}\s*x\s*\d/.test(l));
    out.push({ sku: a[1].toUpperCase(), name: at > 0 ? back[at - 1] : '', size: z[1], qty, full: cents(Number(m[1].replace(/,/g, ''))), each: cents(Number(m[3].replace(/,/g, '')) / qty) });
  }
  return out.length ? { lines: out } : null;
}

/**
 * The emails a SKU search returned → every priced line that PRINTS that SKU, with the store
 * and the day. Most stores never print the style code (Shoe Palace, Foot Locker, JD: the
 * name only), so this reaches the ones that do — adidas today.
 */
export function readSkuLines(emails, sku) {
  const want = bare(sku);
  const out = [];
  for (const e of emails || []) {
    const r = readAdidasReceipt(e) || readAdidasOrder(e);
    if (!r) continue;
    const store = storeOf(e);
    for (const l of r.lines) if (bare(l.sku) === want) out.push({ ...l, store, order: orderNumberOf(e), date: e.date || null });
  }
  return out;
}

// "Adidas" on the batch and "adidas" in the email are one store; so are "Champs" and
// "Champs Sports". No supplier on the batch = any store.
export const sameStore = (supplier, store) => {
  const a = bare(supplier); const b = bare(store);
  return !a || !b || a.includes(b) || b.includes(a);
};

/**
 * One pair priced by its SKU alone: the lines that print the SKU, from the pair's own store,
 * in its size. One price → that price. Two prices → said, with both, and left for a person:
 * without the parcel or the order, nothing says which purchase this pair came from.
 */
export function priceBySku(pair, lines) {
  const mine = (lines || []).filter((l) => sameStore(pair.supplier, l.store) && sizeNum(l.size) === sizeNum(pair.size));
  if (!mine.length) return { reason: (lines || []).length ? 'The emails with this SKU have no line in this size from this supplier' : 'No store email prints this SKU' };
  const hit = onePrice(mine);
  if (hit) return { each: hit.each, full: hit.full, how: 'sku', name: hit.name, store: hit.store, order: hit.order || null, note: 'matched by SKU and size' };
  const prices = [...new Set(mine.map((l) => l.each))].sort((x, y) => x - y);
  return { reason: `Bought at ${prices.length} prices (${prices.map((v) => `$${v.toFixed(2)}`).join(', ')}) — pick one by hand`, store: mine[0].store };
}

/**
 * Pairs priced from ONE order someone named (its confirmation's lines). With a SKU named
 * too, the person has said "these pairs are that order": the size decides. Otherwise the
 * line must print the SKU, or be the name learned for it.
 */
export function priceFromOrder(pair, order, { trustSize = false, skuNames = new Map() } = {}) {
  if (order?.state !== 'ok') return { reason: 'That order’s confirmation email was not found or cannot be read' };
  const size = order.lines.filter((l) => l.each != null && sizeNum(l.size) === sizeNum(pair.size));
  const names = skuNames.get(bare(pair.sku));
  const fit = size.filter((l) => (l.sku && bare(l.sku) === bare(pair.sku)) || (names && names.has(nameKey(l.name))));
  const hit = onePrice(fit.length ? fit : trustSize ? size : []);
  if (hit) return { each: hit.each, full: hit.full, how: 'order', name: hit.name, note: 'from the order number given' };
  return { reason: size.length ? 'The order has this size, but not clearly this shoe — give the SKU too' : 'The order has no line in this size' };
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
    if (r) return { state: 'ok', store: storeOf(e) || store, order: orderNumberOf(e) || order, items: r.items, priced: r.priced === true, note: r.note || null, ...(r.unsure ? { unsure: true } : {}) };
  }
  // Kept with the answer, so the next reader is written from what the store really sent
  // (2026-11-26: 57 JD parcels and 43 Foot Locker ones were "unreadable" with nothing to look at).
  const seen = [...(mine.length ? mine : withText)].reverse()[0];
  const sample = seen ? { subject: String(seen.subject || '').slice(0, 200), from: String(seen.from || '').slice(0, 120), lines: emailLines(seen.text).slice(0, 90).map((l) => l.slice(0, 160)) } : null;
  return { state: 'unreadable', store, order, subjects: [...new Set(all.map((e) => String(e.subject || '').slice(0, 80)))].slice(0, 12), sample };
}

/** The emails an order-number search returned → its priced lines (the confirmation). */
export function readOrder(emails) {
  for (const e of emails || []) {
    const r = readShopifyConfirmation(e);
    if (r) return { state: 'ok', store: storeOf(e), lines: r.lines, totals: r.totals };
  }
  for (const e of emails || []) {
    const r = readFootLockerConfirmation(e) || readJdOrder(e);
    if (r) return { state: 'ok', store: storeOf(e), lines: r.lines, totals: {}, note: r.note || null };
  }
  // adidas says the shoes in every email about the order; the same line comes many times.
  const seen = new Map();
  let store = null;
  for (const e of emails || []) {
    const r = readAdidasOrder(e);
    if (!r) continue;
    store = store || storeOf(e);
    for (const l of r.lines) seen.set(`${l.sku}|${sizeNum(l.size)}|${l.each}`, l);
  }
  if (seen.size) return { state: 'ok', store, lines: [...seen.values()], totals: {} };
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
  // `unsure` = the parcel's email prints a price but not the order's total (no way to see a
  // discount): the order's own lines win when we have them, else the price stays, with the note.
  const priced = parcel.items.map((it) => {
    if (it.each != null && !(parcel.unsure && lines.length)) return it;
    const same = lines.filter((l) => sizeNum(l.size) === sizeNum(it.size) || (Number.isNaN(sizeNum(l.size)) && Number.isNaN(sizeNum(it.size))));
    const byName = it.name ? same.filter((l) => nameKey(l.name) === nameKey(it.name)) : [];
    const known = it.sku && skuNames.get(bare(it.sku)) ? same.filter((l) => skuNames.get(bare(it.sku)).has(nameKey(l.name))) : [];
    const hit = onePrice(byName.length ? byName : known.length ? known : same);
    return hit ? { ...it, each: hit.each, full: hit.full, lineName: hit.name, note: parcel.unsure ? (order.note ? `${order.note} (from the order’s confirmation)` : 'price from the order’s confirmation') : undefined } : it;
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
    if (inParcel) return { id: p.id, each: inParcel.each, full: inParcel.full ?? inParcel.each, how: 'parcel', name: inParcel.name || inParcel.lineName || null, note: inParcel.note || parcel.note || null, ...(parcel.unsure && !inParcel.note ? { check: true } : {}) };
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
