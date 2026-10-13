// POST /api/shein-fix/ai { products: [{ key, name, sizes:[{ line, sellerSku, size }], candidates:[{ productId, title, variants:[{ sku, size }] }] }] } (≤ 8)
//   -> { ok, model, matches: [{ key, productId|null, confidence, reason, sizes:[{ line, shopifySku|null }] }] }
// The SHEIN fix's AI HELPER (docs/context/shein-fix.md). It only ever SUGGESTS which Shopify
// product + variant a SHEIN size should be linked to, for SHEIN sizes whose seller SKU Shopify
// no longer has and the hard-coded rule (same style code + size) couldn't place. The page
// re-checks every suggestion against the rules (verifyAiLink: the variant exists, is in that
// product, and is the SAME size) and drops anything that fails. Stock is never the AI's call.
// PH + admin. Model: SHEIN_FIX_AI_MODEL, default gpt-5.5 (the most accurate on our key).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';

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

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded — wait a minute.' });
  if (!process.env.OPENAI_API_KEY) return send(res, 503, { ok: false, error: 'The AI helper isn’t set up on this server (OPENAI_API_KEY).' });
  const b = await getJsonBody(req);
  const products = (Array.isArray(b.products) ? b.products : []).slice(0, 8).map((p) => ({
    key: s(p.key, 80), name: s(p.name, 300),
    sizes: (p.sizes || []).slice(0, 40).map((x) => ({ line: Number(x.line) || 0, sellerSku: s(x.sellerSku, 40), size: s(x.size, 30) })),
    candidates: (p.candidates || []).slice(0, 6).map((c) => ({ productId: s(c.productId, 80), title: s(c.title, 300),
      variants: (c.variants || []).slice(0, 60).map((v) => ({ sku: s(v.sku, 40), size: s(v.size, 30) })) })),
  })).filter((p) => p.key && p.sizes.length && p.candidates.length);
  if (!products.length) return send(res, 400, { ok: false, error: 'Nothing to match.' });

  try {
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
      console.error('[shein-fix/ai]', r.status, JSON.stringify(data?.error || data).slice(0, 300));
      return send(res, 502, { ok: false, error: r.status === 429 ? 'The AI is rate-limited — try again in a minute.' : 'The AI helper couldn’t answer just now.' });
    }
    let out;
    try { out = JSON.parse(data?.choices?.[0]?.message?.content || '{}'); } catch { out = { matches: [] }; }
    // Keep only answers about what we asked: known keys, candidate products, candidate SKUs.
    const byKey = new Map(products.map((p) => [p.key, p]));
    const matches = (out.matches || []).filter((m) => byKey.has(m.key)).map((m) => {
      const p = byKey.get(m.key);
      const cand = p.candidates.find((c) => c.productId === m.productId) || null;
      const skus = new Set((cand?.variants || []).map((v) => v.sku));
      const lines = new Set(p.sizes.map((x) => x.line));
      return { key: m.key, productId: cand ? cand.productId : null, confidence: Math.max(0, Math.min(1, Number(m.confidence) || 0)), reason: s(m.reason, 300),
        sizes: (m.sizes || []).filter((x) => lines.has(x.line)).map((x) => ({ line: x.line, shopifySku: cand && skus.has(x.shopifySku) ? x.shopifySku : null })) };
    });
    return send(res, 200, { ok: true, model: MODEL(), matches });
  } catch (e) {
    return send(res, 502, { ok: false, error: e?.name === 'TimeoutError' ? 'The AI took too long — try fewer at a time.' : `AI helper failed (${e.message}).` });
  }
}
