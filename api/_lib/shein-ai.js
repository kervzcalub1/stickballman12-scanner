// The SHEIN fix's AI helper, shared by the page (api/shein-fix/ai.js) and the live walk
// (api/_lib/shein-live.js). It only SUGGESTS which Shopify product + variant a SHEIN size
// should link to; the rules (verifyAiLink) decide whether a suggestion counts.
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = () => process.env.SHEIN_FIX_AI_MODEL || 'gpt-5.5';

// What we learned about the listings on 2026-10-13 — the context the model needs.
const SYSTEM = `You match SHEIN marketplace sizes to the Shopify variants they should be linked to, for a sneaker store (Stickballman12).

How the data works:
- Each SHEIN size carries a "seller SKU" that should equal the SKU of ONE Shopify variant (one shoe, one size). The warehouse ships whatever variant that SKU is, so a wrong link ships the wrong shoe.
- The SKUs you are given no longer exist in Shopify — usually because the Shopify product was deleted and re-created with new SKUs. Find the Shopify product that is the SAME shoe (same model AND same colorway; the style code like DD1391-100 or IB7936-100 is the strongest evidence; "GS"/"(Women's)"/"PS"/"TD" in the name tells the age group) and, inside it, the variant of the SAME size.
- Sizes: SHEIN writes "US9", "US9.5W", "7 Toddler"; Shopify writes "9", "9.5W", "7Y", "4C". W = women, Y = youth/GS, C/Toddler = small kids. A size only matches if the number AND the age group match (US6 ≈ 6W on a women's shoe is fine; 7 Toddler is NOT 7Y).
- A previous tool (4seller) caused the damage by pushing sizes SHEIN didn't have onto the nearest SHEIN size, so NEVER map to a "nearest" size — exact size or null.

Rules for your answer:
- Pick a candidate productId only if you are confident it is the same shoe; otherwise null.
- For each SHEIN size, give the shopifySku of the same-size variant in that product, or null if that product has no such size.
- confidence 0..1. reason: one short sentence (what made you sure, or why not).
- Only use productIds and SKUs that appear in the candidates. Never invent one.`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['matches'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['key', 'productId', 'confidence', 'reason', 'sizes'],
        properties: {
          key: { type: 'string' }, productId: { type: ['string', 'null'] }, confidence: { type: 'number' }, reason: { type: 'string' },
          sizes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['line', 'shopifySku'], properties: { line: { type: 'integer' }, shopifySku: { type: ['string', 'null'] } } } },
        },
      },
    },
  },
};

const s = (v, n = 200) => String(v ?? '').slice(0, n);

export const sheinAiConfigured = () => !!process.env.OPENAI_API_KEY;
export const sheinAiModel = MODEL;

// products: [{ key, name, sizes:[{ line, sellerSku, size }], candidates:[{ productId, title, variants:[{ sku, size }] }] }]
// -> [{ key, productId|null, confidence, reason, sizes:[{ line, shopifySku|null }] }] — only
// keys, candidate products and candidate SKUs we sent (anything else is dropped).
export async function sheinAiMatch(input) {
  const products = (Array.isArray(input) ? input : []).slice(0, 8).map((p) => ({
    key: s(p.key, 80), name: s(p.name, 300),
    sizes: (p.sizes || []).slice(0, 40).map((x) => ({ line: Number(x.line) || 0, sellerSku: s(x.sellerSku, 40), size: s(x.size, 30) })),
    candidates: (p.candidates || []).slice(0, 6).map((c) => ({ productId: s(c.productId, 80), title: s(c.title, 300),
      variants: (c.variants || []).slice(0, 60).map((v) => ({ sku: s(v.sku, 40), size: s(v.size, 30) })) })),
  })).filter((p) => p.key && p.sizes.length && p.candidates.length);
  if (!products.length) return [];
  const r = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL(), reasoning_effort: 'medium',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify({ products }) }],
      response_format: { type: 'json_schema', json_schema: { name: 'shein_links', strict: true, schema: SCHEMA } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    console.error('[shein-ai]', r.status, JSON.stringify(data?.error || data).slice(0, 300));
    throw Object.assign(new Error(r.status === 429 ? 'The AI is rate-limited — try again in a minute.' : 'The AI helper couldn’t answer just now.'), { status: r.status });
  }
  let out;
  try { out = JSON.parse(data?.choices?.[0]?.message?.content || '{}'); } catch { out = { matches: [] }; }
  const byKey = new Map(products.map((p) => [p.key, p]));
  return (out.matches || []).filter((m) => byKey.has(m.key)).map((m) => {
    const p = byKey.get(m.key);
    const cand = p.candidates.find((c) => c.productId === m.productId) || null;
    const skus = new Set((cand?.variants || []).map((v) => v.sku));
    const lines = new Set(p.sizes.map((x) => x.line));
    return { key: m.key, productId: cand ? cand.productId : null, confidence: Math.max(0, Math.min(1, Number(m.confidence) || 0)), reason: s(m.reason, 300),
      sizes: (m.sizes || []).filter((x) => lines.has(x.line)).map((x) => ({ line: x.line, shopifySku: cand && skus.has(x.shopifySku) ? x.shopifySku : null })) };
  });
}
