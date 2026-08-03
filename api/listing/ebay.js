// GET /api/listing/ebay?sku=IQ9404-349   (public, key-gated via x-listing-key / ?key=)
//
// Composes a search-optimized eBay listing — TITLE + ITEM SPECIFICS + DESCRIPTION —
// from our own product data, following eBay's listing-optimization guide. Naming is the
// canonical Alias catalog name (the same source used everywhere else); colorway prefers
// Nike's official naming with an Alias fallback; the feature bullets + intro paragraph are
// derived from Nike/GOAT prose. Powers the "eBay Listing" Chrome extension.
//
// Listings are VARIANT listings (one listing, many sizes), so nothing size-specific goes
// into the composed content — no size, no per-size UPC. eBay carries those in its variation
// matrix. Key-gated (LISTING_API_KEY) rather than open, but no login: the extension stores
// the key in its options. Returns { ok, sku, title, titleLength, itemSpecifics[],
// descriptionHtml, descriptionText, features[], meta }.
import { send, applySecurity, rateLimit, cleanSku } from '../_lib/util.js';
import { aliasCatalogBySku } from '../_lib/alias.js';
import { nikeSpecData } from '../_lib/nike.js';
import { kicksdbSpecData } from '../_lib/kicksdb.js';
import { specBulletsFromDescription, MATERIAL_RE } from '../_lib/branding.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };

// ---- text helpers -------------------------------------------------------------
const stripQuotes = (s) => String(s || '').replace(/[’‘'"“”*]/g, '').replace(/\s+/g, ' ').trim();
const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sentences = (s) => String(s || '').split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean);

// Department from the catalogue's gender field.
function department(gender) {
  const g = String(gender || '').toLowerCase();
  if (/wom|female|\bw\b/.test(g)) return "Women's";
  if (/kid|youth|child|infant|toddler|\bgs\b|\bps\b|\btd\b/.test(g)) return 'Kids';
  if (/men|male/.test(g)) return "Men's";
  return 'Unisex';
}

// The lead colour for the title/heading: Nike's PRIMARY colour name if present, else the
// first segment of the colourway string.
function primaryColor(nike, colorway) {
  const prim = (nike?.colors || []).find((c) => String(c.type).toUpperCase() === 'PRIMARY');
  if (prim?.name) return prim.name;
  const first = String(colorway || '').split(/[/\-]/)[0];
  return stripQuotes(first) || null;
}

// Feature bullets straight from the brand's "Benefits" prose — the sentences that lead with
// a real shoe component (leather upper, foam midsole, rubber outsole …). Bold the lead words
// to match the reference format. Falls back to the short inferred spec bullets when a brand
// has no prose (non-Nike). The colourway is always appended as the final line.
const COMPONENT = /^(leather|foam|rubber|mesh|textile|synthetic|knit|flyknit|primeknit|boost|zoom|react|air|gum|suede|padded|cushioned|lightstrike|bounce|eva|phylon|molded|woven|canvas|nubuck|full-grain)\b/i;
function featureBullets(prose, specBullets, colorway) {
  const after = String(prose || '').split(/\bBenefits\b/i)[1] || '';
  const benefit = [];
  for (const s of sentences(after)) {
    if (COMPONENT.test(s) && s.length < 170) benefit.push(s.replace(/\.$/, ''));
    if (benefit.length >= 5) break;
  }
  let bullets;
  if (benefit.length >= 2) {
    // Bold the first two words (e.g. "Leather upper …").
    bullets = benefit.map((s) => escapeHtml(s).replace(/^(\S+\s+\S+)/, '<b>$1</b>'));
  } else {
    // No usable prose — use the short inferred bullets, minus the department + colourway
    // lines (department is a Type specific; colourway is appended below).
    bullets = (specBullets || [])
      .filter((b) => !/^colorway:/i.test(b) && !/\b(shoes?|sneakers?)$/i.test(b))
      .map((b) => escapeHtml(b));
  }
  if (colorway) bullets.push(`Colorway: ${escapeHtml(String(colorway).replace(/\//g, ' / '))}`);
  return bullets;
}

// A short, honest intro paragraph: the first couple of sentences of the brand prose (before
// the "Benefits" block), plus the "edition" sentence if the copy has one.
function leadParagraph(prose) {
  if (!prose) return '';
  const before = String(prose).split(/\bBenefits\b/i)[0];
  let lead = sentences(before.trim() ? before : prose).slice(0, 2).join(' ');
  const ed = sentences(prose).find((s) => /\bedition\b/i.test(s));
  if (ed && !lead.includes(ed)) lead = `${lead} ${ed}`.trim();
  return lead.replace(/\s+/g, ' ').trim();
}

// Pull a material value out of the inferred spec bullets ("Leather Upper" -> "Leather").
function material(specBullets, kind) {
  const b = (specBullets || []).find((x) => new RegExp(`\\b${kind}\\b`, 'i').test(x));
  return b ? stripQuotes(b.replace(new RegExp(`\\s*${kind}\\s*$`, 'i'), '')) : null;
}

// ---- title (<= 80 chars; no size — variant listing) ---------------------------
function buildTitle({ brand, nameClean, dept, color, code }) {
  const parts = { prefix: 'New', brand, name: nameClean, dept, color, code };
  let keys = ['prefix', 'brand', 'name', 'dept', 'color', 'code'];
  const render = () => keys.map((k) => parts[k]).filter(Boolean).join(' ');
  // If over 80, shed the lowest-value tokens first: colour, then the style code.
  for (const drop of ['color', 'code']) {
    if (render().length <= 80) break;
    keys = keys.filter((k) => k !== drop);
  }
  return render();
}

// ---- the pure composer (exported for tests) -----------------------------------
// `styleToken` (Intelligent Inventory): emit II's dynamic {STYLE_ID} token in the DESCRIPTION
// where the style code appears, so II substitutes the real SKU per item on store sync. The
// title and Style Code item-specific stay the literal SKU (separate fields; eBay title search
// needs the real code).
export function buildEbayListing({ sku, alias, nike, kicks, styleToken = false }) {
  const name = alias?.name || nike?.name || null;
  if (!name) return null;
  const styleRef = styleToken ? '{STYLE_ID}' : sku;
  const brand = alias?.brand || 'Nike';
  const colorway = nike?.colorway || alias?.colorway || kicks?.colorway || '';
  const prose = [nike?.description, kicks?.description].filter(Boolean).join(' ');
  const specBullets = specBulletsFromDescription(prose, colorway, { subtitle: nike?.subtitle });
  const dept = department(alias?.gender);
  const color = primaryColor(nike, colorway);
  const yearMatch = String(name).match(/\b(?:19|20)\d{2}\b/);
  const year = yearMatch ? yearMatch[0] : null;

  // Name without the leading brand, quotes/asterisks stripped (for the title + Model).
  const nameNoBrand = String(name).replace(new RegExp(`^${brand}\\s+`, 'i'), '').trim();
  const nameClean = stripQuotes(nameNoBrand);
  const model = nameClean || null;
  const productLine = `${brand} ${nameClean.split(/\s+/)[0] || ''}`.trim();

  const title = buildTitle({ brand, nameClean, dept, color, code: sku });

  const itemSpecifics = [
    { label: 'Brand', value: brand },
    { label: 'Department', value: dept },
    { label: 'Type', value: 'Athletic Sneakers' },
    { label: 'Product Line', value: productLine },
    { label: 'Model', value: model },
    { label: 'Style Code (MPN)', value: sku },
    { label: 'Colorway', value: colorway || null },
    { label: 'Upper Material', value: material(specBullets, 'Upper') },
    { label: 'Outsole Material', value: material(specBullets, 'Outsole') },
    { label: 'Color', value: color ? `${(nike?.colors || []).find((c) => String(c.type).toUpperCase() === 'SIMPLE')?.name || color}${colorway.split('/').length > 1 ? ' / Multicolor' : ''}` : null },
    { label: 'Release Year', value: year },
  ].filter((s) => s.value);

  const intro = leadParagraph(prose);
  const features = featureBullets(prose, specBullets, colorway);
  const headColor = color ? ` &mdash; ${escapeHtml(color)}` : '';

  // A blank-line spacer: rich-text editors (eBay, Intelligent Inventory) normalize away our
  // CSS margins, so an explicit empty paragraph is the only thing that reliably renders as a
  // blank line between sections in every editor.
  const SP = '  <p style="margin:0;line-height:1.5;">&nbsp;</p>';
  const descriptionHtml = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#1a1a1a;">',
    `  <h3 style="font-size:20px;margin:0;color:#111;">${escapeHtml(name)}${headColor}</h3>`,
    `  <p style="font-size:13px;color:#6b6b6b;margin:4px 0 0;">Style ${escapeHtml(styleRef)} &middot; ${escapeHtml(dept)}</p>`,
    ...(intro ? [SP, `  <p style="margin:0;">${escapeHtml(intro)}</p>`] : []),
    SP,
    '  <h4 style="font-size:15px;text-transform:uppercase;letter-spacing:.04em;margin:0;color:#111;">Features</h4>',
    '  <ul style="margin:6px 0 0;padding-left:22px;">',
    ...features.map((f) => `    <li style="margin:5px 0;">${f}</li>`),
    '  </ul>',
    SP,
    `  <p style="background:#f4f6f5;border-radius:8px;padding:12px 16px;font-size:14px;color:#333;margin:0;"><b>Brand:</b> ${escapeHtml(brand)} &nbsp;&middot;&nbsp; <b>Model:</b> ${escapeHtml(model || '')} &nbsp;&middot;&nbsp; <b>Style Code:</b> ${escapeHtml(styleRef)}</p>`,
    SP,
    '  <h4 style="font-size:15px;text-transform:uppercase;letter-spacing:.04em;margin:0;color:#111;">Condition</h4>',
    `  <p style="border-left:3px solid #0a7d4e;padding-left:14px;margin:6px 0 0;"><strong style="color:#0a7d4e;">Brand new, deadstock</strong> &mdash; never worn or tried on. Ships in the original box. 100% authentic, sourced and verified through our inventory system.</p>`,
    SP,
    '  <p style="font-size:14px;color:#555;margin:0;">Available in multiple sizes &mdash; choose your size from the options above.</p>',
    '</div>',
  ].join('\n');

  const plainFeatures = features.map((f) => f.replace(/<[^>]+>/g, ''));
  const descriptionText =
`${name}${color ? ` — ${color}` : ''}
Style ${styleRef} · ${dept}

${intro}

FEATURES
${plainFeatures.map((f) => `- ${f}`).join('\n')}

Brand: ${brand} · Model: ${model || ''} · Style Code: ${styleRef}

CONDITION
Brand new, deadstock — never worn or tried on. Ships in the original box. 100% authentic, sourced and verified through our inventory system.

Available in multiple sizes — choose your size from the options above.`;

  return {
    sku, title, titleLength: title.length,
    itemSpecifics, descriptionHtml, descriptionText,
    features: plainFeatures,
    meta: {
      name, brand, colorway, primaryColor: color, department: dept,
      sizes: alias?.sizes || [],
      sources: { name: alias ? 'alias' : (nike ? 'nike' : null), colorway: nike?.colorway ? 'nike' : (alias?.colorway ? 'alias' : (kicks?.colorway ? 'kicksdb' : null)) },
    },
  };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  // Key gate — public (no login) but not open. The extension stores LISTING_API_KEY.
  const expected = process.env.LISTING_API_KEY;
  if (!expected) return send(res, 503, { ok: false, error: 'Listing API is not configured (LISTING_API_KEY missing on the server).' });
  const url = new URL(req.url, 'http://x');
  const provided = req.headers['x-listing-key'] || url.searchParams.get('key') || '';
  if (provided !== expected) return send(res, 401, { ok: false, error: 'Invalid or missing listing key.' });

  const skuIn = normSku(url.searchParams.get('sku'));
  if (!skuIn) return send(res, 400, { ok: false, error: 'A valid ?sku= is required.' });
  if (!process.env.ALIAS_API_KEY) return send(res, 500, { ok: false, error: 'Server is missing the Alias API key.' });
  // ?token=1 → emit II's {STYLE_ID} dynamic token in the description instead of the literal SKU.
  const styleToken = /^(1|true|yes)$/i.test(url.searchParams.get('token') || '');

  try {
    // Alias + Nike first (unmetered); KicksDB is metered and only ever a FALLBACK here —
    // it feeds `colorway` last and adds prose. So only pay for it when Nike's copy names
    // no material (the bullets/features would otherwise come out thin) or nothing has a
    // colourway. Nike SKUs with full copy now make zero KicksDB calls.
    const [alias, nike] = await Promise.all([
      aliasCatalogBySku(skuIn).catch(() => null),
      nikeSpecData(skuIn).catch(() => null),
    ]);
    const needsKicks = !MATERIAL_RE.test(nike?.description || '') || !(nike?.colorway || alias?.colorway);
    const kicks = needsKicks ? await kicksdbSpecData(skuIn).catch(() => null) : null;
    const listing = buildEbayListing({ sku: skuIn, alias, nike, kicks, styleToken });
    if (!listing) return send(res, 404, { ok: false, error: `No catalogue match for "${skuIn}".` });
    return send(res, 200, { ok: true, ...listing });
  } catch (e) {
    console.error('[listing/ebay]', e.message);
    return send(res, 502, { ok: false, error: 'Could not build the listing.' });
  }
}
