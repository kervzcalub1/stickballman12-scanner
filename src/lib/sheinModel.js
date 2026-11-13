// SHEIN "Product Model" from a Shopify shoe TITLE (owner, 2026-11-14). Pure, no deps — shared by the server
// (publish / live edits: sheinPublish.js shoeAttrDefaults) and the page (the per-shoe editor prefills it).
//
// SHEIN's Product Model is a TYPED detail (attribute_mode 0, id 1000546) and it is PER SHOE: a store-wide
// default ("Dunk Low") put one Nike's model on every shoe of a SHEIN type. So the model comes, in order, from:
//   1. what a person typed for THIS shoe (shein_listing_products.attr_overrides) — always wins;
//   2. the title, when a known model FAMILY matched (`sure: true`);
//   3. nobody → the shoe is blocked "type it for this shoe" (the page prefills the title's guess, `sure: false`).
//
// The rule (matched 50/50 hand-typed models, e2e/fixtures/shein-models.tsv):
//   - strip the style code ("(DZ4857-001)", " - JS4487"), parentheses ("(Women's)"), "Wmns"/"Men's", a
//     collab prefix ("LEGO x Nike …"), the brand ("Nike", "adidas Originals", "A Bathing Ape", "New Balance"…);
//   - the longest known model family at the start ("Air Max 90", "Kobe 8 Protro", "Gazelle Indoor"…);
//   - then qualifier words (Low, Mid, High, Retro, OG, SE, Premium, LV8, Next Nature, GORE-TEX, RM, Golf, Cleat,
//     Mule, Essential…) until the first word that isn't one = the colourway starts;
//   - normalised like the typed values: '07, "Big Bubble", GS/PS/TD/Big Kid and the year dropped; a numbered
//     Jordan is "Air Jordan 6 Retro", a non-numbered one stays "Jordan Stay Loyal"; "Air Flight '89" → "Air
//     Flight 89"; "Ultra Boost 1.0" → "Ultraboost 1.0"; "Air Force 1 Flyknit 2" → "Air Force 1 Flyknit 2.0".
//   - No family → a guess (`sure: false`): everything before a quoted colourway, else the first two words.
//     A guess is NEVER sent to SHEIN — a person checks it first.

export const PRODUCT_MODEL_ATTR_ID = 1000546;

// --- casing: tokens the way the typed values (and the brands) write them -----------------------------------
const CASE = new Map(Object.entries({
  og: 'OG', se: 'SE', lv8: 'LV8', rnr: 'RNR', rm: 'RM', prm: 'PRM', 'gore-tex': 'GORE-TEX', gtx: 'GORE-TEX', sb: 'SB', kd: 'KD',
  ivo: 'IVO', ltd: 'LTD', tw: 'TW', sc: 'SC', gt: 'GT', acg: 'ACG', nmd: 'NMD', ae: 'AE', cl: 'CL', xlg: 'XLG', sl: 'SL', tc: 'TC',
  nyc: 'NYC', nxxt: 'NXXT', ii: 'II', iv: 'IV', lebron: 'LeBron', vapormax: 'VaporMax', zoomx: 'ZoomX', vaporfly: 'Vaporfly',
  shai: 'SHAI', c1ty: 'C1TY', al8: 'AL8', badbo: 'BadBo', dn8: 'Dn8', dn: 'Dn', bia: 'Bia', 'p-6000': 'P-6000', 'ld-1000': 'LD-1000',
  '2k': '2K', '2k4': '2K4', '2k5': '2K5', ext: 'EXT', em: 'EM', flyease: 'FlyEase', progrid: 'ProGrid', mb: 'MB', lafrance: 'LaFrance',
  lamelo: 'LaMelo', cloudstratus: 'CloudStratus', sk8: 'SK8', 'sk8-hi': 'SK8-Hi', jp: 'JP', rtn: 'RTN', '4d': '4D', ss: 'SS',
  of: 'of', "a'one": "A'One", "a'two": "A'Two", 'gel-nyc': 'Gel-NYC', mx: 'MX', '00s': '00s', ad: 'AD',
}));
const caseWord = (w) => {
  const k = w.toLowerCase();
  if (CASE.has(k)) return CASE.get(k);
  if (/^v\d$/i.test(w)) return w.toUpperCase();                    // V5 (RNR), v2 of a Yeezy
  if (/^\d{3,4}v\d$/i.test(w)) return w.toLowerCase();               // New Balance 990v4
  if (/^\d{3,4}[a-z]{1,2}$/i.test(w)) return w.toUpperCase();        // 1906R, 2002R
  if (/^[a-z]/.test(w)) return w[0].toUpperCase() + w.slice(1);      // a lower-case word in a title
  return w;
};
const casing = (s) => s.split(' ').map(caseWord).join(' ').replace(/^(Gel-)(\w)/, (_, g, c) => g + c.toUpperCase());

// --- brands (stripped; the model never carries the brand, except Jordan which IS the model name) -------------
// `key` lets a family belong to one brand only (a bare number is a model only for New Balance).
// [name (regex source), key, keep] — `keep`: the brand word is part of the model there ("Bape Sta"), so it stays.
const BRANDS = [
  ['a bathing ape', 'bape'], ['bape', 'bape', /^bape ?sta\b/i], ['bapesta', 'bape', /^bapesta\b/i],
  ['adidas originals', 'adidas'], ['adidas original', 'adidas'], ['adidas', 'adidas'],
  ['new balance', 'nb'], ['asics', 'asics'], ['puma', 'puma'], ['on running', 'on'], ['on(?=\\s+cloud)', 'on'],
  ['saucony', 'saucony'], ['reebok', 'reebok'], ['converse', 'converse'], ['timberland', 'timberland'], ['vans', 'vans'],
  ['crocs', 'crocs'], ['anta', 'anta'], ['nike', 'nike'],
];
const COLLAB = /^.{2,40}?\s+x\s+(?=(?:nike|adidas|converse|jordan|air jordan|new balance|reebok|puma|asics|vans)\b)/i;

// --- model families: [pattern at the start (brand stripped), canonical | null (keep the title's words), brand?]
// Longest match wins. A pattern ends at a space, a quote or the end (so "Dunk" never matches "Dunkman").
const FAMILY_SRC = [
  // Nike — Air Force / Air Max / VaporMax
  ['air force 1 flyknit 2(?:\\.0)?', 'Air Force 1 Flyknit 2.0'], ['air force 1', 'Air Force 1'], ['air force 1 (?:duckboot|sage)', null],
  ['air max 1 \'?8[67]', (m) => m.replace(/'/, '')], ['air max 2 cb \'?94', 'Air Max 2 CB 94'], ['air max 90 futura', null], ['air max (?:90|97|plus) terrascape', (m) => `Air Max Terrascape ${m.split(' ')[2]}`],
  ['air max (?:\\d{1,4}|plus|tw|dn8|dn|command|correlate|excee|sc|systm|pulse|portal|torch \\d|penny|uptempo|bia|dawn|goadome|ivo|ltd \\d|moto 2k|phoenix|pre-day|solo|terrascape (?:90|plus)|waffle racer|interlock lite|zm950|alpha trainer \\d|furyosa|intrlk)', null],
  ['acg air max goadome', 'ACG Air Max Goadome'],
  ['air vapormax plus', 'Air VaporMax Plus'], ['air vapormax(?: \\d{4}| flyknit \\d)?', null],
  // Nike — running
  ['(?:air )?zoom vomero \\d+', null], ['vomero (?:\\d+|plus|premium)', null],
  ['zoomx vaporfly next% \\d', (m) => `ZoomX Vaporfly Next% ${m.slice(-1)}`], ['zoomx vaporfly \\d', null], ['zoomx invincible run \\d', null], ['zoomx streakfly(?: \\d)?', null],
  ['(?:air zoom )?alphafly next% \\d', null], ['zoom fly \\d', null], ['react pegasus trail \\d', null], ['acg pegasus trail(?: \\d)?', null],
  ['(?:air zoom )?pegasus(?: \\d+| plus| premium)?', null], ['air peg 2k5', null], ['reactx infinity run \\d', null], ['infinity run \\d', null],
  ['react element 55', null], ['react live', null], ['react phantom run flyknit \\d', null], ['run swift \\d', null], ['journey run', null],
  ['free rn(?: flyknit)?(?: \\d\\.\\d)?', (m) => m.replace(/rn/i, 'RN')], ['free metcon \\d', null], ['metcon \\d+', null], ['v2k run', null], ['v[2-5] rnr', null],
  ['wildhorse \\d+', null], ['victory pro \\d', null], ['victory \\d', null], ['dragonfly \\d', null], ['zoom mercurial superfly \\d+', null], ['mercurial vapor \\d+', null],
  ['phantom \\d+', null], ['romaleos \\d', null], ['cosmic unity \\d', null], ['retro gts 97', null], ['air zoom spiridon cage \\d', null], ['zoom long jump', null],
  // Nike — basketball
  ['kd \\d+', null], ['zoom kd \\d+', null], ['lebron \\d+', null], ['(?:zoom )?lebron nxxt gen(?: ampd)?', null], ['lebron witness \\d+', null],
  ['ja \\d', null], ['sabrina \\d', null], ['book \\d', null], ['giannis immortality \\d', null], ['giannis freak \\d', null],
  ['kobe \\d+(?: elite)?(?: low)?(?: em| ext)?(?: protro)?', null], ["a'?ja wilson a'?one", "A'One"], ["a['\\s]?one", "A'One"], ["a'two", "A'Two"],
  ['air zoom gt cut(?: \\d)?(?: turbo)?', null], ['(?:zoom )?gt cut academy', null], ['gt future', null], ['air zoom hyperace \\d', null],
  ['air foamposite (?:one|pro)', null], ['little posite (?:one|pro)', null], ['air more uptempo(?: 96)?', null], ['air zoom flight the glove', null],
  ['air zoom huarache 2k4', null], ['hyperquick', null], ['cortez', 'Cortez'], ['air flight \'?89', 'Air Flight 89'], ['flight legacy', 'Flight Legacy'],
  // Nike — lifestyle / court / other
  ['(?:sb )?dunk', null], ['blazer (?:low|mid)(?: 77)?', null], ['sb zoom blazer low', 'SB Zoom Blazer Low'], ['p-6000', 'P-6000'], ['initiator', 'Initiator'],
  ['court legacy', 'Court Legacy'], ['court vision (?:low|mid)', null], ['court air zoom vapor \\d+', null], ['killshot 2', 'Killshot 2'], ['total 90', 'Total 90'],
  ['shox (?:tl|r4|nz|bb4|ride 2|z)', null], ['air trainer huarache', null], ['air trainer sc', null], ['air huarache(?: runner)?', null], ['air presto', null],
  ['air griffey max \\d', null], ['air monarch iv', null], ['air rift', null], ['air tailwind 79', null], ['tailwind 79', null], ['air tech challenge ii', null],
  ['air tuned max', null], ['air diamond turf(?: \\d)?', null], ['al8', 'AL8'], ['alleyoop', null], ['astro grabber', null], ['ava rover', null], ['c1ty', 'C1TY'],
  ['calm slide', null], ['crater impact', null], ['field general', null], ['force trout \\d+ pro', null], ['gato', 'Gato'], ['(?:sb )?heritage vulc', 'SB Heritage Vulc'],
  ['hot step air terra', null], ['ld-1000', 'LD-1000'], ['lunar roam', null], ['manoa(?: leather)?', null], ['mind 00\\d', null], ['roshe golf', null], ['tc 7900', 'TC 7900'],
  ['waffle debut', null], ['go flyease', null], ['acg izy', null], ['acg ldv', null], ['air zoom vomero 5', 'Air Zoom Vomero 5'],
  // adidas
  ['ultra ?boost(?: \\d\\.\\d)?', (m) => 'Ultraboost' + ((m.match(/\d\.\d/) || [''])[0] ? ' ' + m.match(/\d\.\d/)[0] : '')],
  ['samba', 'Samba'], ['samba (?:jane|jp|lt|xlg)', null], ['sambae', 'Sambae'], ['gazelle(?: indoor| bold)?', null], ['handball spezial', 'Handball Spezial'], ['campus 00s', 'Campus 00s'],
  ['retropy e5', 'Retropy E5'], ['climacool 4d(?: laced)?', null], ['ozweego', 'Ozweego'], ['dame (?:x|\\d+)', null], ['sl 72(?: rtn)?', null], ['superstar', 'Superstar'],
  ['stan smith(?: lo pro)?', null], ['adistar control \\d', null], ['adistar xlg(?: \\d\\.\\d)?', null], ['adizero adios pro \\d', null], ['adizero evo sl', 'Adizero Evo SL'],
  ['adizero sl\\d?', null], ['ae \\d', null], ['badbo \\d\\.\\d', null], ['crazy \\d+', null], ['d\\.o\\.n\\. issue #?\\d+', null], ['ghost sprint', null],
  ['harden vol\\.? \\d+', (m) => `Harden Vol. ${m.match(/\d+$/)[0]}`], ['nmd[ _]r1', 'NMD R1'], ['response cl', null], ['forum (?:low|mid|84)', null],
  ['yeezy boost \\d+(?: v2)?', null], ['yeezy (?:slide|foam runner|qntm)', null],
  // Jordan (not stripped: "Jordan" is part of the model)
  ['(?:air )?jordan \\d+', (m) => `Air Jordan ${m.match(/\d+$/)[0]}`], ['(?:air )?jordan 1 (?:element|elevate)', (m) => `Air Jordan 1 ${m.split(' ').pop()}`],
  ['jordan 6 rings', 'Jordan 6 Rings'],
  ['(?:air )?jordan (?:spizike|son of mars|legacy 312|skyline|sixty plus)', (m) => `Air Jordan ${m.replace(/^(air )?jordan /i, '')}`],
  ['(?:air )?jordan (?:stay loyal(?: \\d)?|heir|tatum \\d|one take \\d|jumpman two trey|max aura \\d|mvp|access|adg \\d|flight court|nu retro 1|trunner lx|why not zer0\\.\\d)',
    (m) => `Jordan ${m.replace(/^(air )?jordan /i, '')}`],
  // New Balance — a model number (550, 9060, 1906R, 990v4, 740v2), and Fresh Foam
  ['\\d{3,4}[a-z]{0,2}(?:v\\d)?', null, 'nb'], ['fresh foam x? ?[a-z]+(?: trail)?(?: v\\d)?', null, 'nb'],
  // ASICS / Puma / On / Saucony / Reebok / Converse / Bape / others
  ['gel[- ][a-z0-9]+(?: \\d+)?', (m) => m.replace(/^gel[- ]/i, 'Gel-'), 'asics'], ['japan pro', 'Japan Pro', 'asics'],
  ['lamelo ball (?:lafranc[eé](?: amour)?|mb\\.?0\\d)', (m) => m.replace(/lafranc[eé]/i, 'LaFrance').replace(/mb\.?0/i, 'MB.0')], ['scoot zeros', null], ['speedcat(?: ballet)?', null],
  ['cloud[a-z]*(?: \\d)?', null, 'on'], ['progrid omni \\d+', null], ['angel reese \\d', null], ['club c 85', null], ['pump omni zone ii', null], ['question (?:mid|low)', null],
  ['chuck taylor all star(?: 70)?', null], ['chuck 70', null], ['one star pro', null], ['shai 001', 'SHAI 001'], ['classic clog', null], ['kai \\d', null], ['old skool', null],
  ['6"? ?(?:inch )?premium(?: waterproof)? boot', '6-Inch Premium Boot', 'timberland'],
  ['bape ?sta(?: low)?', (m) => (/low$/i.test(m) ? 'Bapesta Low' : 'Bapesta'), 'bape'], ['bapesta(?: icon)?', 'Bapesta', 'bape'], ['bape sk8 sta', 'SK8 Sta', 'bape'], ['shark sta', 'Shark Sta'], ['sk8 sta', 'SK8 Sta'], ['tape sta', 'Tape Sta'],
];
const FAMILIES = FAMILY_SRC.map(([p, canon, brand]) => ({ re: new RegExp(`^(?:${p})(?=[\\s'"]|$)`, 'i'), canon, brand: brand || null }));

// Words that belong to the model after the family; stop at the first word that isn't one.
const QUAL = /^(?:low|mid|high|hi|retro|og|se|premium|prm|lv8|next nature|gore-tex|gtx|rm|golf|cleat|mule|essential|ess|pro|2\.0|protro|leather|ox)(?=[\s'"]|$)/i;
// Dropped wherever they sit between the model and the colourway.
const DROP = /^(?:'?07|big bubble|gs|ps|td|big kids?|little kids?|kids|toddler|(?:19|20)\d\d|#\d+(?:-\d+)?|m[12]|w)(?=[\s'"]|$)/i;

function cleanTitle(title) {
  let t = String(title || '').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  t = t.replace(/\([^)]*\)/g, ' ').replace(/\?/g, ' ');                           // "(DZ4857-001)", "(Women's)"
  t = t.replace(/\s+[-–]\s+[A-Za-z0-9][A-Za-z0-9 -]{3,}$/, '');                    // " - JS4487", " - HF3255-005"
  t = t.replace(/\s+[A-Z]{1,3}\d{3,}[A-Z0-9-]*$/, '');                             // a bare trailing style code "JR1267"
  t = t.replace(/\s+/g, ' ').trim();
  if (t === t.toUpperCase() && /[A-Z]{3}/.test(t)) t = t.toLowerCase();           // "JORDAN FLIGHT COURT MENS" → cased later
  t = t.replace(/^nike\s*wmns\b/i, 'Nike');                                       // "NikeWmns  Air More Uptempo"
  t = t.replace(/(^|\s)(?:wmns|women'?s|womens|men'?s|mens)(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(COLLAB, '');
  return t;
}
function stripBrand(t) {
  for (const [name, key, keep] of BRANDS) {
    const re = new RegExp(`^${name.replace(/ /g, '\\s+')}(?=\\s|$)`, 'i');
    if (!re.test(t)) continue;
    const rest = t.replace(re, '').trim();
    if (key === 'bape' && /^(?:bape ?sta|bapesta)\b/i.test(rest)) return { brand: key, rest };   // A Bathing Ape → "Bape Sta …"
    return { brand: key, rest: keep && keep.test(t) ? t : rest };
  }
  if (/^(?:air )?jordan\b/i.test(t)) return { brand: 'jordan', rest: t };
  return { brand: null, rest: t };
}
// An opening quote = a colourway ("'Black Crimson'") — never '89 / '07 (a year) or A'One (inside a word).
const quoteAt = (t) => { const m = t.match(/(^|\s)['"](?!\d\d(?:\s|$))/); return m ? m.index + m[1].length : -1; };

// → { model, sure }. `sure` only when a known model family matched; a guess is never sent to SHEIN.
export function modelFromTitle(title) {
  const cleaned = cleanTitle(title);
  if (!cleaned) return { model: '', sure: false };
  const { brand, rest: t } = stripBrand(cleaned);
  const q = quoteAt(t);
  const pre = (q > 0 ? t.slice(0, q) : t).trim();
  let best = null;
  for (const f of FAMILIES) {
    if (f.brand && f.brand !== brand) continue;
    const m = pre.match(f.re);
    if (m && (!best || m[0].length > best.m[0].length)) best = { f, m };
  }
  if (!best) {
    const words = pre.split(' ').filter(Boolean);
    const guess = q > 0 ? pre : words.slice(0, 2).join(' ');
    return { model: casing(guess.replace(/\s+/g, ' ').trim()), sure: false };
  }
  const { f, m } = best;
  let model = typeof f.canon === 'function' ? f.canon(m[0]) : (f.canon || m[0]);
  let after = pre.slice(m[0].length).trim();
  for (let i = 0; i < 8 && after; i += 1) {
    const d = after.match(DROP);
    if (d) { after = after.slice(d[0].length).trim(); continue; }
    const x = after.match(QUAL);
    if (!x) break;
    if (!new RegExp(`(^|\\s)${x[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(model)) model += ` ${x[0]}`;   // "Kobe 8 Protro" + "Protro" once
    after = after.slice(x[0].length).trim();
  }
  model = model.replace(/\b(?:gore-tex|gtx)\b/gi, 'GORE-TEX').replace(/\s+/g, ' ').trim();
  return { model: casing(model), sure: true };
}

// Which model a shoe gets (the server and the page agree on it):
//   typed (attr_overrides for its product type) → { model, from: 'shoe' } · else title sure → { from: 'title' }
//   · else → { model: guess, from: null, guess: true } (blocked; the page prefills the guess).
export function shoeModel({ title, overrides, productTypeId } = {}) {
  const o = overrides && typeof overrides === 'object' ? overrides[String(PRODUCT_MODEL_ATTR_ID)] : null;
  if (o && Number(o.ptid) === Number(productTypeId) && String((o.extraValues || [])[0] || '').trim()) return { model: String(o.extraValues[0]).trim(), from: 'shoe', sure: true };
  const r = modelFromTitle(title);
  if (r.sure && r.model) return { model: r.model, from: 'title', sure: true };
  return { model: r.model || '', from: null, sure: false, guess: true };
}

// Read-only report (2026-11-14): LIVE shoes whose Product Model on SHEIN came from a Setup default (the leak the
// owner found) and differs from the shoe's own model (typed, else the title when sure). Input rows = the latest
// DONE publish per shoe (what we sent) + the shoe's row; `setupModels` = Map(ptid → [Setup typed values]).
// → [{ productId, spu, title, ptid, sent, should, from, reason }]. No SHEIN call — a correction is the owner's call.
export function setupModelCorrections(rows = [], setupModels = new Map()) {
  const out = [];
  for (const r of rows) {
    const list = Array.isArray(r.body?.product_attribute_list) ? r.body.product_attribute_list : [];
    const sentRow = list.find((a) => Number(a.attribute_id) === PRODUCT_MODEL_ATTR_ID);
    const sent = sentRow?.attribute_extra_value ? String(sentRow.attribute_extra_value).trim() : null;
    if (!sent) continue;
    const ptid = Number(r.product_type_id ?? r.ptid);
    const setup = (setupModels.get(ptid) || []).map((s) => String(s).trim().toLowerCase());
    if (!setup.includes(sent.toLowerCase())) continue;                    // not a Setup default → a person's or the title's value
    const own = shoeModel({ title: r.title, overrides: r.attr_overrides, productTypeId: ptid });
    if (own.sure && own.model.toLowerCase() === sent.toLowerCase()) continue;   // the default happened to be right
    out.push({ productId: r.shopify_product_id, spu: r.spu || null, title: r.title || '', ptid, sent, should: own.sure ? own.model : null, from: own.from,
      guess: own.sure ? null : own.model || null, reason: own.sure ? 'setup_default_differs' : 'setup_default_no_model', sentAt: r.sent_at || null });
  }
  return out;
}
