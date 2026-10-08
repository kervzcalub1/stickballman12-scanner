// ===== Receipt parser (runs inside Make "Run code" module) =====
// input: tid, g_subject, g_from, g_date, g_text, g_html (Gmail, one result)
//        y_list = [{folder, subject, from, date, text, html}] (Yahoo, one entry per searched folder)
const UPC_API = 'https://bypass-stock-x-host-railway-stock-x.up.railway.app/stockx-upc-search';
const SKU_API = 'https://stickballman12.com/api/sku-lookup?sku=';
// Champs / Foot Locker print no UPC and no style code — only a 15-digit internal code whose last
// 3 digits are the size. The name is resolved to a style code by a helper scenario (6286830):
// data-store cache first, Gemini + Google Search on a miss. One call per UNIQUE name, in parallel.
const NAME_LOOKUP_URL = 'https://hook.us2.make.com/gp1redg9l3dwhq3o5f7ee8ga5m5m4wdk';
const NAME_LOOKUP_TIMEOUT_MS = 20000;

// ---- Yahoo multi-folder search (IMAP has no all-mail; each folder search costs ~4.5 s of IMAP login,
// so folders are searched by a helper scenario (6283660) called here IN PARALLEL, YAHOO_CHUNK folders per call).
// FIXED folder list — the Email app cannot list folders. Keep in sync with the Yahoo account's folders.
const YAHOO_HELPER_URL = 'https://hook.us2.make.com/kkisfswitrr4y62kwlt9ek64xlebdpkc';
const YAHOO_FOLDERS = ['Inbox', 'Bulk', 'Champs Sports', 'Footlocker', 'Finishline', 'Jd sports folder', "Dick's Sporting Goods", 'Orders', 'Purchased for Supplier'];
// 'Bulk' is Yahoo's spam folder — receipts do land there (docs/context/receipts.md). Gmail's spam is
// NOT in [Gmail]/All Mail, so the scenarios search [Gmail]/Spam with a second module.
const YAHOO_CHUNK = 2;          // folders per helper call  (calls run in parallel; keep concurrent IMAP logins <= 4)
const YAHOO_TIMEOUT_MS = 30000; // per helper call

const s = (v) => (v === undefined || v === null) ? '' : String(v);
const num = (v) => { const n = parseFloat(s(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
const r2 = (n) => n === null ? null : Math.round(n * 100) / 100;

function htmlToText(html) {
  return s(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|tr|li|h[1-6]|table|pre|section|article|header|footer|blockquote)\s*>/gi, '\n')
    .replace(/<\s*(td|th)[^>]*>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&(?:zwnj|zwj|shy|#8204|#8205|#173|#x200c|#x200d|#xad);/gi, '')   // zero-width joiners / soft hyphen → gone
    .replace(/&(?:ensp|emsp|thinsp|#8194|#8195|#8201);/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCharCode(parseInt(c, 16)));
}
function cleanText(t) {
  return s(t)
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')   // zero-width chars (adidas emails are full of them)
    .replace(/\u00A0/g, ' ')
    .replace(/&(?:zwnj|zwj|shy);/gi, '')   // the same entities can survive as literal text in the plain part
    .replace(/\r/g, '')
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim());
}

function detectStore(text, from, subject) {
  const hay = (text + ' ' + from + ' ' + subject).toLowerCase();
  // Foot Locker Inc. family shares one receipt format (parseChamps). Check these BEFORE nike:
  // their item names contain "NIKE" and would otherwise be misdetected.
  if (/champssports|champs sports/.test(hay)) return 'champs';
  if (/kidsfootlocker|kids foot locker/.test(hay)) return 'kidsfootlocker';
  if (/footlocker|foot locker/.test(hay)) return 'footlocker';
  if (/adidas|article no:|red tag/.test(hay)) return 'adidas';
  if (/nike|in-store items|jordan/.test(hay)) return 'nike';
  return null;
}

// ---------- CHAMPS / FOOT LOCKER family ----------
// name line / 15-digit line (last 3 digits = size*10) / "qty $price $amount tax%" / Promotion -$x lines
function parseChamps(lines) {
  const items = [];
  const codeIdx = [];
  lines.forEach((l, i) => { if (/^\d{12,15}$/.test(l)) codeIdx.push(i); });
  codeIdx.forEach((ci, k) => {
    const code = lines[ci];
    let ni = ci - 1; while (ni >= 0 && !lines[ni]) ni--;
    // Foot Locker prefixes the name with a MM/DD date token ("08/15 NIKE M AF1 ..."); drop it
    const name = ni >= 0 ? lines[ni].replace(/^\d{2}\/\d{2}\s+/, '') : null;
    const end = k + 1 < codeIdx.length ? codeIdx[k + 1] - 1 : lines.length;
    let qty = 1, price = null, amount = null, promos = 0;
    for (let j = ci + 1; j < end; j++) {
      const l = lines[j];
      if (/^(sub)?total|^tax|^tender|^payment/i.test(l)) break;
      const m = l.match(/^(\d+)\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\s+([\d.]+)%/); // tax% may be decimal (10.25%)
      if (m && price === null) { qty = +m[1]; price = num(m[2]); amount = num(m[3]); continue; }
      const p = l.match(/-\s*\$?([\d,]+\.\d{2})\s*$/);
      if (p) promos += num(p[1]);
    }
    const size = code.length === 15 ? String(parseInt(code.slice(-3), 10) / 10) : null;
    const final = amount !== null ? amount : (price !== null ? r2(price * qty - promos) : null);
    items.push({
      name, sku: code.length === 15 ? code.slice(0, 12) : code, upc: null, style_id: null, size, qty,
      list_price: price, discount: price !== null && final !== null ? r2(price * qty - final) : r2(promos),
      unit_price: final !== null && qty ? r2(final / qty) : null, final_price: final, raw_code: code, lookup: null,
    });
  });
  return items;
}

// ---------- NIKE ----------
// name (+ "$79.99T") / UPC with leading zeros / "Item Percent Discount ... -$24.00" / "Final Price $55.99T"
function parseNike(lines) {
  const items = [];
  const codeIdx = [];
  lines.forEach((l, i) => { if (/^0*\d{11,14}$/.test(l) && /^\d{11,16}$/.test(l)) codeIdx.push(i); });
  const money = /\$\s*([\d,]+\.\d{2})/;
  codeIdx.forEach((ci, k) => {
    const raw = lines[ci];
    const upc = raw.replace(/^0+/, '');
    let ni = ci - 1; while (ni >= 0 && !lines[ni]) ni--;
    let nameLine = ni >= 0 ? lines[ni] : '';
    let list = null;
    if (/^\$\s*[\d,]+\.\d{2}\s*T?$/.test(nameLine)) { // price on its own line: name is the line above it
      list = num(nameLine);
      let pi = ni - 1; while (pi >= 0 && !lines[pi]) pi--;
      nameLine = pi >= 0 ? lines[pi] : '';
    }
    const mm = nameLine.match(money);
    if (mm) { list = num(mm[1]); nameLine = nameLine.replace(/\$\s*[\d,]+\.\d{2}\s*T?\s*$/, '').trim(); }
    if (list === null) { // price on its own line before the name or between name and code
      for (const cand of [lines[ni - 1] || '', lines[ci - 1] || '']) {
        const m2 = cand.match(money); if (m2 && !/final|discount/i.test(cand)) { list = num(m2[1]); break; }
      }
    }
    const end = k + 1 < codeIdx.length ? codeIdx[k + 1] - 1 : lines.length;
    let discount = 0, final = null, qty = 1;
    for (let j = ci + 1; j < end; j++) {
      const l = lines[j];
      if (/^(sub)?total|^tax|^payment|^tender/i.test(l)) break;
      const q = l.match(/\bqty\b[:\s]*(\d+)/i); if (q) qty = +q[1];
      const f = l.match(/final price[:\s]*\$?\s*([\d,]+\.\d{2})/i); if (f) { final = num(f[1]); continue; }
      const d = l.match(/-\s*\$?\s*([\d,]+\.\d{2})\s*T?\s*$/); if (d) discount += num(d[1]);
    }
    let unit = final; // "Final Price" on Nike receipts is per unit
    if (unit === null && list !== null) unit = r2(list - discount / qty);
    items.push({
      name: nameLine || null, sku: null, upc, style_id: null, size: null, qty,
      list_price: list, discount: r2(discount), unit_price: unit, final_price: unit !== null ? r2(unit * qty) : null, raw_code: raw, lookup: null,
    });
  });
  return items;
}

// ---------- ADIDAS ----------
// format A (Sales Receipt): "IH8223 7- [1] 59.97 20.39 T"  ("-" after size = half size)
// format B (item card):     "DURAMO SL2 W FTWWHT ,7-" / "Article No: IH8223" / "Selling Price: $20.39" / "60% OFF RED TAG - 35.98"
function adidasSize(sz, dash) { const n = num(sz); return n === null ? null : String(dash ? n + 0.5 : n); }
function parseAdidasA(lines) {
  const items = [];
  const re = /^([A-Z]{1,2}\d{4,5}|[A-Z0-9]{6})\s+(\d{1,2}(?:\.5)?)(-?)\s*\[(\d+)\]\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})/;
  lines.forEach((l, i) => {
    const m = l.match(re); if (!m) return;
    const qty = +m[4], our = num(m[5]), sell = num(m[6]);
    let name = null, discount = 0;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const t = lines[j]; if (!t) break;
      if (re.test(t)) break;
      if (name === null && !/^\d|off|idme|%/i.test(t)) name = t.replace(/\s+(FTWW|TTD|\().*$/, '').trim();
      const d = t.match(/(?:^|\s)-\s*\$?([\d,]+\.\d{2})\s*$/); if (d && !/TTD/.test(t)) discount += num(d[1]);
    }
    items.push({ name, sku: m[1], upc: null, style_id: m[1], size: adidasSize(m[2], m[3] === '-'), qty,
      list_price: our, discount: r2(our !== null && sell !== null ? our * qty - sell * qty : discount),
      unit_price: sell, final_price: sell !== null ? r2(sell * qty) : null, raw_code: l, lookup: null });
  });
  return items;
}
function parseAdidasB(lines) {
  const items = [];
  lines.forEach((l, i) => {
    const m = l.match(/Article No[:.]?\s*([A-Z0-9]{5,7})\b/i); if (!m) return;
    const sku = m[1].toUpperCase();
    // name + size: on the same line before "Article No" or on a previous line, shaped "... ,7-"
    let name = null, size = null;
    const before = l.slice(0, m.index).trim();
    // adidas' HTML→text leaves several blank lines between the "NAME COLOR ,10-" line and "Article No":
    // walk back over blanks and take the nearest two non-blank lines as candidates.
    const prev = [];
    for (let j = i - 1; j >= 0 && j >= i - 10 && prev.length < 2; j--) if (lines[j]) prev.push(lines[j]);
    const cands = [before].concat(prev);
    for (const c of cands) {
      const sm = c.match(/^(.*?)\s*,\s*(\d{1,2}(?:\.5)?)\s*(-?)\s*$/);
      if (sm) { name = sm[1].trim() || null; size = adidasSize(sm[2], sm[3] === '-'); break; }
    }
    let sell = null, discount = 0, qty = 1;
    for (let j = i; j < Math.min(i + 10, lines.length); j++) {
      const t = lines[j]; if (j > i && /Article No/i.test(t)) break;
      const sp = t.match(/Selling Price[:\s]*\$?\s*([\d,]+\.\d{2})/i); if (sp) sell = num(sp[1]);
      const q = t.match(/\b(?:qty|quantity)\b[:\s]*(\d+)/i); if (q) qty = +q[1];
      const d = t.match(/(?:off|idme|discount|promo)[^\-\n]*-\s*\$?\s*([\d,]+\.\d{2})/i); if (d) discount += num(d[1]);
    }
    items.push({ name, sku, upc: null, style_id: sku, size, qty, list_price: sell !== null ? r2(sell + discount) : null,
      discount: r2(discount * qty), unit_price: sell, final_price: sell !== null ? r2(sell * qty) : null, raw_code: l, lookup: null });
  });
  return items;
}
function parseAdidas(lines) {
  const a = parseAdidasA(lines);
  if (a.length) return a;
  return parseAdidasB(lines);
}

function parseByStore(store, lines) {
  if (store === 'champs' || store === 'footlocker' || store === 'kidsfootlocker') return parseChamps(lines);
  if (store === 'nike') return parseNike(lines);
  if (store === 'adidas') return parseAdidas(lines);
  return [];
}

// ---------- printed totals ----------
// Only figures the receipt itself prints. Never computed. Label and value may sit on one line
// ("Total  $125.98") or the value may be alone on the next line (label/value in separate table rows).
function parseTotals(lines) {
  const moneyEnd = /\$?\s*(-?[\d,]+\.\d{2})\s*T?$/;
  const moneyOnly = /^\$?\s*(-?[\d,]+\.\d{2})\s*T?$/;
  const valueFor = (i) => {
    const l = lines[i];
    const m = l.match(moneyEnd);
    if (m && !/^\$?\s*-?[\d,]+\.\d{2}\s*T?$/.test(l)) return num(m[1]);   // label + value on one line
    let j = i + 1; while (j < lines.length && !lines[j]) j++;
    if (j < lines.length && moneyOnly.test(lines[j])) return num(lines[j]);      // value on the next line
    return null;
  };
  const t = { subtotal: null, tax: null, shipping: null, total: null, item_count_stated: null };
  const labels = [
    ['subtotal', /^sub\s*-?\s*total\b/i],
    ['tax', /^(?:total\s+|sales\s+)?tax(?:es)?\b(?!\s*%)/i],
    ['shipping', /^(?:shipping|delivery)(?:\s*(?:&|and)\s*handling)?\b/i],
    ['total', /^(?:order\s+|grand\s+|amount\s+)?total\b(?!\s*(?:savings|discount|tax|items|qty|quantity|before))/i],
  ];
  lines.forEach((l, i) => {
    for (const [key, re] of labels) {
      if (t[key] === null && re.test(l)) { const v = valueFor(i); if (v !== null) t[key] = v; }
    }
    if (t.item_count_stated === null) {
      const c = l.match(/\bitems?\s*\((\d+)\)/i) || l.match(/^(?:total\s+)?items?\s*[:#]?\s*(\d+)\s*$/i) || l.match(/^(\d+)\s+items?\b/i)
        || l.match(/^sub\s*-?\s*total\b[^\[\n]*\[(\d+)\]/i);   // adidas: "SUBTOTAL [11] … USD 280.39"
      if (c) t.item_count_stated = +c[1];
    }
  });
  return t;
}
function toIso(d) {
  const x = new Date(s(d)); return isNaN(x.getTime()) ? null : x.toISOString();
}

// ---------- store location ----------
// In-store receipts print a header block: "<MALL NAME> <STREET>" / [more street] / "CITY, ST 12345"
// / "United States" / phone, plus "Store: <number>". Online receipts usually print none of it → nulls.
const STATE_ZIP = /^(.+?),\s*([A-Z]{2})\.?\s+(\d{5})(?:-\d{4})?\s*$/;
function parseStoreLocation(lines) {
  const loc = { name: null, store_number: null, address: null, city: null, state: null, zip: null };
  for (const l of lines) {
    const m = l.match(/\bstore\s*(?:#|no\.?|number)?\s*[:#]\s*([A-Z0-9-]{3,12})\b/i);
    if (m) { loc.store_number = m[1]; break; }
  }
  // the address block sits in the first ~40 lines; take the FIRST city/state/zip line there
  let ci = -1;
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    if (STATE_ZIP.test(lines[i]) && !/^(bill|ship|sold)\s*(to|from)\b/i.test(lines[i])) { ci = i; break; }
  }
  if (ci < 0) return loc;
  const cm = lines[ci].match(STATE_ZIP);
  loc.city = cm[1].replace(/^[\s,.-]+|[\s,.-]+$/g, '') || null;
  loc.state = cm[2].toUpperCase();
  loc.zip = cm[3];
  // walk back over the lines above it: they are the name + street (skip blanks/boilerplate)
  const above = [];
  for (let j = ci - 1; j >= 0 && j >= ci - 5 && above.length < 3; j--) {
    const l = lines[j];
    if (!l) continue;
    if (/^(united states|usa|visit us|thank|transaction:|purchase date:|_{3,}|-{3,})/i.test(l)) continue;
    if (/^[\d\s()+.-]{7,}$/.test(l)) continue;                  // phone
    // a forwarded receipt puts the original mail headers right above the store's address block
    if (/^(from|to|cc|bcc|date|sent|subject|reply-to)\s*:/i.test(l)) continue;
    if (/@|-{2,}\s*forwarded message/i.test(l)) continue;
    above.unshift(l);
  }
  if (above.length) {
    const first = above[0];
    // "YORK GALLERIA 2899 WHITEFORD RD STE 265" → name + street; a line starting with the number is all street
    const sm = first.match(/^(.*?[A-Za-z])\s+(\d+\s+[A-Za-z0-9].*)$/);
    if (sm && !/^\d/.test(first)) { loc.name = sm[1].trim(); above[0] = sm[2].trim(); }
    else if (/^\d/.test(first)) { loc.name = null; }
    else { loc.name = first; above.shift(); }
    const street = above.join(' ').replace(/\s{2,}/g, ' ').trim();
    loc.address = street || null;
  }
  if (loc.name) loc.name = loc.name.replace(/\s{2,}/g, ' ').trim() || null;
  return loc;
}

// ---------- order number ----------
// Champs/Foot Locker: "Trans: 179364" (also "Transaction: 179364" in the email header block).
// Everything else: the first explicit order/invoice label. Never a phone, date or money amount.
function parseOrderNumber(lines, store) {
  const text = lines.join('\n');
  if (store === 'champs' || store === 'footlocker' || store === 'kidsfootlocker') {
    const m = text.match(/^\s*(?:trans(?:action)?)\s*[:#]\s*(\d{4,12})\s*$/im) || text.match(/\btrans(?:action)?\s*[:#]\s*(\d{4,12})\b/i);
    if (m) return m[1];
  }
  const m = text.match(/\b(?:order|invoice|receipt|confirmation)\s*(?:number|no\.?|id|#)?\s*[:#]\s*([A-Z0-9][A-Z0-9_-]{3,24})\b/i)
    || text.match(/\b(?:order|invoice)\s*#\s*([A-Z0-9][A-Z0-9_-]{3,24})\b/i)
    || text.match(/\btrans(?:action)?\s*[:#]\s*([A-Z0-9][A-Z0-9_-]{3,24})\b/i);
  return m ? m[1] : null;
}

// ---------- recipients ----------
// headers_list is the Email module's "Headers - list" ([{key, value:[...]}]) — the only reliable way
// to read Delivered-To / X-Forwarded-To / Message-ID (the basic "headers" object drops most of them).
function headerValue(headersList, name) {
  const want = String(name).toLowerCase();
  const rows = Array.isArray(headersList) ? headersList : [];
  for (const h of rows) {
    if (!h || String(h.key || '').toLowerCase() !== want) continue;
    const v = h.value;
    return Array.isArray(v) ? v.join(', ') : s(v);
  }
  return '';
}
// A forwarded receipt carries the ORIGINAL recipient — that is who actually bought it.
function forwardedTo(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!/-{2,}\s*forwarded message\s*-{2,}/i.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const m = lines[j].match(/^to\s*:\s*(.+)$/i);
      if (m) return m[1].trim();
    }
  }
  return '';
}
function parseRecipients(input, lines) {
  const hl = input.headers_list;
  const to = s(input.to) || headerValue(hl, 'to');
  const cc = s(input.cc) || headerValue(hl, 'cc');
  const delivered = s(input.delivered_to) || headerValue(hl, 'delivered-to') || headerValue(hl, 'x-delivered-to');
  const original = s(input.original_to) || headerValue(hl, 'x-forwarded-to') || headerValue(hl, 'x-original-to')
    || headerValue(hl, 'resent-to') || forwardedTo(lines);
  return { to: to || null, cc: cc || null, delivered_to: delivered || null, original_to: original || null };
}

// ---------- is this a receipt? ----------
// The sweep must skip marketing and shipping notices. A receipt either has parsed line items, or
// prints an order number together with a money total.
function looksLikeReceipt(items, totals, orderNumber) {
  if (items.length) return true;
  if (orderNumber && totals.total !== null) return true;
  if (totals.subtotal !== null && totals.total !== null) return true;
  return false;
}

// ---------- lookups ----------
async function fetchJson(url, opts, ms) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
  try {
    const r = await fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {}));
    const j = await r.json();
    return { status: r.status, json: j };
  } finally { if (t) clearTimeout(t); }
}
// Champs / Foot Locker: resolve each UNIQUE item name to a style code via the lookup helper (cached).
// The 12-digit prefix stays in `sku` only when nothing better is known — it is NOT a UPC or a style.
async function enrichByName(store, items, warnings) {
  const names = Array.from(new Set(items.map(it => s(it.name).trim()).filter(Boolean)));
  const results = {};
  await Promise.all(names.map(async (name) => {
    try {
      const { status, json } = await fetchJson(NAME_LOOKUP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, store }) }, NAME_LOOKUP_TIMEOUT_MS);
      if (status !== 200 || !json || !json.ok) { warnings.push('name_lookup_failed:' + name + ' (http ' + status + ')'); return; }
      results[name] = json;
    } catch (e) { warnings.push('name_lookup_failed:' + name + ' ' + String(e && e.message || e)); }
  }));
  for (const it of items) {
    const r = results[s(it.name).trim()];
    if (!r) continue;
    if (!r.found || !r.style_sku) { warnings.push('sku_not_found:' + it.name); it.lookup = { source: 'gemini-search', found: false, reason: r.reason || null }; continue; }
    it.sku = r.style_sku;              // the real style code replaces the 12-digit prefix
    it.style_id = r.style_sku;
    it.lookup = { source: r.cached ? 'gemini-search (cached)' : 'gemini-search', title: r.product_name || null, brand: r.brand || null,
      colorway: r.colorway || null, style_id: r.style_sku, confidence: r.confidence || null, source_url: r.source_url || null, reason: r.reason || null };
    if (r.confidence && r.confidence !== 'high') warnings.push('sku_lookup_' + r.confidence + '_confidence:' + it.name + ' → ' + r.style_sku);
  }
}

async function enrich(store, items, warnings) {
  if (store === 'champs' || store === 'footlocker' || store === 'kidsfootlocker') return enrichByName(store, items, warnings);
  await Promise.all(items.map(async (it) => {
    try {
      if (store === 'nike' && it.upc) {
        const { status, json } = await fetchJson(UPC_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upc: it.upc }) }, 25000);
        const v = json && json.result && json.result.data && json.result.data.variants && json.result.data.variants[0];
        if (!v) { warnings.push('upc_not_found:' + it.upc + ' (http ' + status + ')'); return; }
        const p = v.product || {};
        it.style_id = p.styleId || null;
        it.size = (v.traits && v.traits.size) || (v.sizeChart && v.sizeChart.baseSize) || it.size;
        it.lookup = {
          source: 'stockx', title: p.title || null, brand: p.brand || null, style_id: p.styleId || null,
          size: it.size, size_type: v.sizeChart && v.sizeChart.baseType || null,
          image: p.media && p.media.imageUrl || null, product_id: p.id || null, variant_id: v.id || null,
          lowest_ask: v.market && v.market.state && v.market.state.lowestAsk ? v.market.state.lowestAsk.amount : null,
          highest_bid: v.market && v.market.state && v.market.state.highestBid ? v.market.state.highestBid.amount : null,
        };
        if (!it.name) it.name = p.title || null;
      } else if (store === 'adidas' && it.sku) {
        const { status, json } = await fetchJson(SKU_API + encodeURIComponent(it.sku), { method: 'GET' }, 25000);
        if (!json || json.ok === false || !json.name) { warnings.push('sku_not_found:' + it.sku + ' (http ' + status + ')'); return; }
        it.lookup = { source: json.source || 'sku-lookup', title: json.name, brand: json.brand || null, colorway: json.colorway || null,
          gender: json.gender || null, image: json.image || null, catalog_id: json.catalogId || null, sizes: json.sizes || null };
        it.name = json.name;
      }
    } catch (e) { warnings.push('lookup_failed:' + (it.upc || it.sku) + ' ' + String(e && e.message || e)); }
  }));
}

async function searchYahooFolders(tid, warnings) {
  if (!YAHOO_HELPER_URL || !tid) return [];
  const chunks = [];
  for (let i = 0; i < YAHOO_FOLDERS.length; i += YAHOO_CHUNK) chunks.push(YAHOO_FOLDERS.slice(i, i + YAHOO_CHUNK));
  const results = await Promise.all(chunks.map(async (folders) => {
    try {
      const { status, json } = await fetchJson(YAHOO_HELPER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transaction_id: tid, folders }) }, YAHOO_TIMEOUT_MS);
      if (status !== 200 || !Array.isArray(json)) { warnings.push('yahoo_folders_failed:' + folders.join('|') + ' (http ' + status + ')'); return []; }
      return json;
    } catch (e) { warnings.push('yahoo_folders_failed:' + folders.join('|') + ' ' + String(e && e.message || e)); return []; }
  }));
  return [].concat.apply([], results);
}

// ---------- main ----------
async function run(input) {
  const tid = s(input.tid).trim();
  const warnings = [];
  // y_list may be supplied by the scenario (aggregated Yahoo results); otherwise search via the helper.
  const yList = Array.isArray(input.y_list) && input.y_list.length ? input.y_list : await searchYahooFolders(tid, warnings);
  const boxes = [
    { mailbox: 'gmail', folder: '[Gmail]/All Mail', subject: s(input.g_subject), from: s(input.g_from), date: s(input.g_date), text: s(input.g_text), html: s(input.g_html) },
    // Gmail's spam is NOT inside [Gmail]/All Mail — it needs its own search module (gs_*).
    { mailbox: 'gmail', folder: '[Gmail]/Spam', subject: s(input.gs_subject), from: s(input.gs_from), date: s(input.gs_date), text: s(input.gs_text), html: s(input.gs_html) },
  ].concat(yList.map(y => ({ mailbox: 'yahoo', folder: s(y && y.folder), subject: s(y && y.subject), from: s(y && y.from), date: s(y && y.date), text: s(y && y.text), html: s(y && y.html) })))
   .filter(b => b.text.trim() || b.html.trim());

  if (!boxes.length) {
    return { ok: false, status: 404, body: JSON.stringify({ ok: false, error: 'not_found', message: 'No email matching transaction id in Gmail or Yahoo', transaction_id: tid }) };
  }

  let best = null;
  for (const b of boxes) {
    const variants = [];
    if (b.html.trim()) variants.push(cleanText(htmlToText(b.html)));
    if (b.text.trim()) variants.push(cleanText(b.text));
    for (const lines of variants) {
      const store = detectStore(lines.join('\n'), b.from, b.subject);
      const items = parseByStore(store, lines);
      if (!best || items.length > best.items.length) best = { box: b, store, items, lines, variants };
    }
  }
  const { box, store, items, lines, variants } = best;
  // printed totals: merge across the HTML and plain-text parts of the winning email (first non-null wins)
  const totals = variants.map(parseTotals).reduce((acc, t) => { for (const k in t) if (acc[k] === null) acc[k] = t[k]; return acc; },
    { subtotal: null, tax: null, shipping: null, total: null, item_count_stated: null });
  const emailText = lines.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 65536); // evidence copy: squeeze blank runs
  if (!store) warnings.push('store_not_detected');
  if (!items.length) warnings.push('no_items_parsed');

  // NO dedupe: identical lines are real (e.g. two pairs of the same size on one Champs receipt).
  // Only one part of the email (HTML or text) is parsed, so cross-part duplicates cannot occur.
  const uniq = items;

  await enrich(store, uniq, warnings);

  const payload = {
    ok: true, transaction_id: tid, store, mailbox: box.mailbox, folder: box.folder,
    store_location: parseStoreLocation(lines),
    // headers_list is only mapped for the Gmail module; a Yahoo hit falls back to the forwarded
    // block in the body (the helper 6283660 does not return headers yet).
    recipients: parseRecipients(box.folder === '[Gmail]/All Mail' ? input : {}, lines),
    order_number: parseOrderNumber(lines, store),
    email: { subject: box.subject, from: box.from, date: box.date, date_iso: toIso(box.date), folder: box.folder, text: emailText },
    totals,
    item_count: uniq.length,
    items: uniq,
    warnings,
  };
  return { ok: true, status: 200, body: JSON.stringify(payload), store, item_count: uniq.length, items: uniq, warnings };
}

// ---------- sweep: one email in, one ingest body out ----------
// Used by the scheduled "Receipt sweep" scenario. Returns {post:false} for anything that is not a
// receipt so the scenario can filter instead of POSTing marketing mail.
// POST body contract: /Users/kervz/Stickballman12/api/receipts/ingest.js header comment.
async function sweep(input) {
  const warnings = [];
  const mailbox = s(input.mailbox), folder = s(input.folder);
  const html = s(input.html), text = s(input.text);
  if (!html.trim() && !text.trim()) return { post: false, skip: 'empty', body: null };

  // parse whichever part yields more items, exactly like the lookup does
  const variants = [];
  if (html.trim()) variants.push(cleanText(htmlToText(html)));
  if (text.trim()) variants.push(cleanText(text));
  const from = s(input.from), subject = s(input.subject);
  let best = null;
  for (const lines of variants) {
    const store = detectStore(lines.join('\n'), from, subject);
    const items = parseByStore(store, lines);
    if (!best || items.length > best.items.length) best = { store, items, lines };
  }
  const { store, items, lines } = best;
  const totals = variants.map(parseTotals).reduce((acc, t) => { for (const k in t) if (acc[k] === null) acc[k] = t[k]; return acc; },
    { subtotal: null, tax: null, shipping: null, total: null, item_count_stated: null });
  const orderNumber = parseOrderNumber(lines, store);

  if (!looksLikeReceipt(items, totals, orderNumber)) return { post: false, skip: 'not_a_receipt', store, body: null };
  if (!store) warnings.push('store_not_detected');
  if (!items.length) warnings.push('no_items_parsed');

  await enrich(store, items, warnings);

  const messageId = s(input.message_id) || headerValue(input.headers_list, 'message-id');
  // message_key must be stable per email and unique; Message-ID is the stable part, mailbox+folder
  // keep two copies of one email (inbox + spam) apart. No Message-ID → fall back to from+subject+date.
  const idPart = messageId.replace(/[<>\s]/g, '') || [from, subject, s(input.date)].join('~');
  const body = {
    message_key: [mailbox, folder, idPart].join('|').slice(0, 500),
    mailbox: mailbox || null,
    folder: folder || null,
    received_at: toIso(input.date),
    from: from || null,
    subject: subject || null,
    recipients: parseRecipients(input, lines),
    store: store || null,
    store_location: parseStoreLocation(lines),
    order_number: orderNumber,
    totals: { subtotal: totals.subtotal, tax: totals.tax, shipping: totals.shipping, total: totals.total },
    items: items.map(it => ({ name: it.name, style_id: it.style_id, sku: it.sku, upc: it.upc, size: it.size, qty: it.qty, final_price: it.final_price })),
    text: lines.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 65536),
    warnings,
  };
  return { post: true, store, item_count: items.length, order_number: orderNumber, body: JSON.stringify(body), parsed: body };
}

// ---- Make wrapper: `input` is provided by the module ----
// mode "sweep" = one email → ingest body (Receipt sweep scenario); default = transaction-id lookup (6282792).
return s(input.mode) === 'sweep' ? await sweep(input) : await run(input);
