// POST /api/send-to-sheet  { product, rows }  ->  { ok, message }
// Validates the submission, then forwards it to the n8n webhook in the shape
// that workflow expects:
//   { name, sku, variants: [{ size, quantity }] }
// The webhook URL is server-side only (SHEET_WEBHOOK_URL). If it is not set,
// the request is validated and acknowledged as a stub.

import {
  getJsonBody, send, applySecurity, rateLimit, requireAuth, cleanSku,
} from './_lib/util.js';

const MAX_VARIANTS = 100;
const MAX_QTY = 9999;

function cleanName(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Returns { error } OR { name, sku, variants }.
function validate(body) {
  const product = body?.product || {};

  const name = cleanName(product.name);
  if (!name) return { error: 'Missing product name. Search a product first.' };

  const sku = cleanSku(product.sku);
  if (!sku) return { error: 'Missing or invalid SKU. Search a product first.' };

  if (!Array.isArray(body?.rows) || body.rows.length === 0)
    return { error: 'Add at least one size with a quantity.' };

  const seen = new Set();
  const variants = [];
  for (const r of body.rows) {
    const size = String(r?.size ?? '').trim().slice(0, 24);
    const quantity = parseInt(r?.quantity, 10);

    if (!size) return { error: 'Every row needs a size.' };
    if (!Number.isInteger(quantity) || quantity < 1)
      return { error: `Quantity for size "${size}" must be a whole number of 1 or more.` };
    if (quantity > MAX_QTY)
      return { error: `Quantity for size "${size}" is too large (max ${MAX_QTY}).` };

    const key = size.toLowerCase();
    if (seen.has(key))
      return { error: `Size "${size}" is listed more than once. Combine it into a single row.` };
    seen.add(key);

    variants.push({ size, quantity });
  }

  if (variants.length > MAX_VARIANTS)
    return { error: `Too many sizes (max ${MAX_VARIANTS}).` };

  return { name, sku, variants };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  const body = await getJsonBody(req);
  const v = validate(body);
  if (v.error) return send(res, 400, { ok: false, error: v.error });

  // Exactly the shape the n8n workflow expects.
  const payload = { name: v.name, sku: v.sku, variants: v.variants };

  const webhook = process.env.SHEET_WEBHOOK_URL;
  if (!webhook) {
    console.log('[send-to-sheet] (stub, no webhook configured):', JSON.stringify(payload));
    return send(res, 200, {
      ok: true,
      forwarded: false,
      stub: true,
      count: v.variants.length,
      message: 'Validated (sheet webhook not configured yet).',
    });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let r;
    try {
      r = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try { data = await r.json(); } catch { /* webhook may not return JSON */ }

    if (!r.ok || (data && data.success === false)) {
      return send(res, 502, {
        ok: false,
        error: (data && data.message) || `Sheet webhook failed (${r.status}).`,
      });
    }

    return send(res, 200, {
      ok: true,
      forwarded: true,
      count: v.variants.length,
      message: (data && data.message) || `Added ${v.variants.length} size(s) to the sheet.`,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Sheet webhook timed out.' : (e.message || 'Sheet webhook error.');
    return send(res, 502, { ok: false, error: msg });
  }
}
