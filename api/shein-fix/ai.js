// POST /api/shein-fix/ai { products: [{ key, name, sizes:[{ line, sellerSku, size }], candidates:[{ productId, title, variants:[{ sku, size }] }] }] } (≤ 8)
//   -> { ok, model, matches: [{ key, productId|null, confidence, reason, sizes:[{ line, shopifySku|null }] }] }
// The SHEIN fix's AI HELPER (docs/context/shein-fix.md). It only ever SUGGESTS which Shopify
// product + variant a SHEIN size should be linked to, for SHEIN sizes whose seller SKU Shopify
// no longer has and the hard-coded rule (same style code + size) couldn't place. The page
// re-checks every suggestion against the rules (verifyAiLink: the variant exists, is in that
// product, and is the SAME size) and drops anything that fails. Stock is never the AI's call.
// PH + admin. Model: SHEIN_FIX_AI_MODEL, default gpt-5.5 (the most accurate on our key).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { sheinAiMatch, sheinAiModel, sheinAiConfigured } from '../_lib/shein-ai.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded — wait a minute.' });
  if (!sheinAiConfigured()) return send(res, 503, { ok: false, error: 'The AI helper isn’t set up on this server (OPENAI_API_KEY).' });
  const b = await getJsonBody(req);
  if (!Array.isArray(b.products) || !b.products.length) return send(res, 400, { ok: false, error: 'Nothing to match.' });
  try {
    const matches = await sheinAiMatch(b.products);
    if (!matches.length && !b.products.some((p) => p?.sizes?.length && p?.candidates?.length)) return send(res, 400, { ok: false, error: 'Nothing to match.' });
    return send(res, 200, { ok: true, model: sheinAiModel(), matches });
  } catch (e) {
    if (e.status) return send(res, 502, { ok: false, error: e.message });
    return send(res, 502, { ok: false, error: e?.name === 'TimeoutError' ? 'The AI took too long — try fewer at a time.' : `AI helper failed (${e.message}).` });
  }
}
