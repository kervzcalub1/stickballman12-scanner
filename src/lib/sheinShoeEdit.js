// SHEIN Listings → one shoe's editor ("Edit this shoe", src/components/SheinPublishBits.jsx → ShoeEditor).
// 2026-11-15 (owner): the same edit menu for EVERY shoe, whatever tile it was opened from. Before, a shoe
// never live on SHEIN (new, or its publish rejected — the Error tile) got the publishing checklist with a
// Change / Edit button on every line, while a shoe already live (most of the Blocked tile: wrong SKU, a size
// SHEIN lacks) got a ✓ / ✕ list whose only buttons fixed the ✕ — no photos, no SHEIN details unless one was
// missing. Pure: the page and the e2e share these.
//
// The menu: the details a person edits on a shoe, photos first (they cause the most rejections).
export const EDIT_MENU = [
  ['photos', 'Photos'],
  ['attributes', 'SHEIN details'],
  ['category', 'Category'],
  ['brand', 'Brand'],
  ['colour', 'Colour'],
  ['title', 'SHEIN title'],
];

// A shoe already live on SHEIN: what can't be changed from here, and why — said on its line, never hidden.
// category = SHEIN's rule (a live product stays in its category; the server refuses the pick, 409);
// brand / colour / title = no edit of a LIVE shoe sends them (the publish does, for a new shoe).
export const LIVE_LOCKS = {
  category: 'SHEIN keeps a shoe that is already on SHEIN in the category it was listed in — it can’t be changed from here.',
  brand: 'A shoe already on SHEIN keeps the brand it was listed with. Changing it isn’t built here — Seller Center.',
  colour: 'A shoe already on SHEIN keeps its colour (SHEIN groups the sizes by it). Changing it isn’t built here — Seller Center.',
  title: 'A shoe already on SHEIN keeps its SHEIN title here. For a shoe we published, “Update prices & sizes” sends Shopify’s title when it changes; 4seller’s titles are never changed.',
};

// The lines of a LIVE shoe, in the publishing checklist's shape ({ n, key, label, ok, blockers, lock?, say? })
// so one renderer (and the same panels) serve both. `codes` group the server's rendered blockers.
const LIVE = [   // what a person can change first (photos, details), then what blocks a send, then what is fixed on SHEIN
  ['photos', 'Photos', ['no_image', 'image_rejected', 'photos_need_priv', 'photo_cap_reached', 'clean_main_unsure']],
  ['attributes', 'SHEIN details', ['missing_attr']],
  ['sizes', 'Every in-stock size has a SHEIN size', ['size_needs_map', 'size_not_on_shein', 'size_unreadable', 'custom_text_invalid', 'no_size_table_value', 'multi_skc_size', 'size_field_retired',
    'shein_size_blank', 'size_already_on_shein']],   // 2026-11-17 (stage 2): a blank / non-US SHEIN size; a size SHEIN sells under another SKU
  ['skus', 'SHEIN sizes carry the right SKUs', ['no_seller_sku', 'dup_seller_sku', 'seller_sku_taken', 'wrong_link', 'spu_spans_products']],
  ['prices', 'Every size has a price', ['no_price', 'price_outlier', 'price_confirmed']],   // + the price check (stage 2; price_no_market stays a quiet note on the size row)
  ['shein', 'SHEIN hasn’t refused anything', ['review_rejected', 'shein_prevalid', 'api_error']],
  ['shopify', 'Active on Shopify', ['shopify_inactive', 'no_shopify_stock']],
  ['category', 'Category', []],
  ['brand', 'Brand', []],
  ['colour', 'Colour', []],
  ['title', 'SHEIN title', ['shein_title_too_long']],
];
const BLOCKING = new Set(['blocked', 'error']);
const isHard = (b) => !b?.level || BLOCKING.has(b.level);

// The "SHEIN refused" blockers of a shoe (its sizes' + its own) — shown on a NEVER-live shoe too: its
// checklist is the publish readiness, which doesn't carry SHEIN's review answer.
export function refusedBlockers(product, variants = []) {
  const codes = LIVE.find((x) => x[0] === 'shein')[2];
  return collect(product, variants, codes);
}

function collect(product, variants, codes, extra = []) {
  const live = (variants || []).filter((v) => v.status !== 'excluded');
  const hits = [
    ...(product?.blockers || []).filter((b) => codes.includes(b.code)),
    ...live.flatMap((v) => (v.blockers || []).filter((b) => codes.includes(b.code)).map((b) => ({ ...b, size: v.shopify_size || v.shein_size || null }))),
    ...extra.filter((b) => codes.includes(b.code)),
  ];
  // one per (code, title): the same blocker on 6 sizes is one line with the sizes listed
  const seen = new Map();
  for (const b of hits) {
    const k = `${b.code}|${b.title || ''}`;
    const cur = seen.get(k);
    if (cur) { if (b.size && !cur.sizes.includes(b.size)) cur.sizes.push(b.size); } else seen.set(k, { ...b, sizes: b.size ? [b.size] : [] });
  }
  return [...seen.values()];
}

// → the lines of a live shoe. `extra` = blockers from its last edits (a required detail SHEIN asked for);
// `photoRejected` = SHEIN's words when it rejected the shoe for its photos; `reviewOpen` = an edit in review.
export function liveShoeLines({ product, variants = [], extra = [], photoRejected = null, reviewOpen = false }) {
  const lines = LIVE.map(([key, label, codes], i) => {
    const blockers = collect(product, variants, codes, extra);
    const hard = blockers.filter(isHard);
    const line = { n: i + 1, key, label, ok: !hard.length, blockers };
    if (LIVE_LOCKS[key]) line.lock = LIVE_LOCKS[key];
    if (key === 'photos' && photoRejected) line.ok = false;
    return line;
  });
  lines.push({ n: lines.length + 1, key: 'review', label: 'No SHEIN review open', ok: reviewOpen ? null : true, blockers: [],
    say: reviewOpen ? 'SHEIN is reviewing an earlier edit of this shoe. You can still change things here; what you send waits until that review closes.' : null });
  return lines;
}

// The ✕ lines, in menu order first (photos, details…), then the rest — the "Fix these first" list.
export function fixFirstLines(lines = []) {
  const order = new Map(EDIT_MENU.map(([k], i) => [k, i]));
  return lines.filter((l) => l.ok === false)
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (order.get(a.l.key) ?? 99) - (order.get(b.l.key) ?? 99) || a.i - b.i)
    .map((x) => x.l);
}
