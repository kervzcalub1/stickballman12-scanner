// POST /api/rapid-send  { product, size }  ->  { ok, action, quantity }
// Rapid Scan: record one scanned box (quantity 1). Consolidates by SKU + Size
// onto an existing 'Not Added' row (qty +1) or appends a new row. A DB lock on
// SKU+Size serializes the read/modify/write so concurrent scans of the same
// variant can't lose an increment.

import {
  getJsonBody, send, applySecurity, rateLimit, requireAuth, cleanSku,
} from './_lib/util.js';
import { upsertVariants, sheetsConfigured } from './_lib/sheets.js';
import { acquireLock, releaseLock } from './_lib/db.js';

function cleanName(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 90 })) // rapid scans come fast
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  const body = await getJsonBody(req);
  const product = body?.product || {};

  const name = cleanName(product.name);
  if (!name) return send(res, 400, { ok: false, error: 'Missing product name.' });

  const rawSku = cleanSku(product.sku);
  if (!rawSku) return send(res, 400, { ok: false, error: 'Missing or invalid SKU.' });
  const sku = rawSku.replace(/\s+/g, '-'); // sheet stores the dashed form

  const size = String(body.size ?? '').trim().slice(0, 24);
  if (!size) return send(res, 400, { ok: false, error: 'A size is required.' });

  if (!sheetsConfigured())
    return send(res, 200, { ok: true, action: 'stub', quantity: 1, message: 'Validated (Sheet not configured).' });

  const scannedBy = user.name || user.username || '';
  // Single global write lock: serializes all sheet writes so the consolidating
  // read/modify/write and the append are race-free (no verify-retry needed).
  const lockKey = 'sheet:write';

  const locked = await acquireLock(lockKey, { waitMs: 15000 }).catch(() => false);
  if (!locked)
    return send(res, 409, { ok: false, error: 'Busy — another scan of this product is in progress. Try again.' });

  try {
    const result = await upsertVariants({ scannedBy, name, sku, variants: [{ size, quantity: 1 }] });
    const action = result.incremented ? 'increment' : 'append';
    return send(res, 200, {
      ok: true,
      action,
      message: action === 'increment'
        ? `Updated — ${name} size ${size} (+1).`
        : `Added — ${name} size ${size} (qty 1).`,
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'Google Sheets request timed out.' : (e.message || 'Sheet error.');
    return send(res, 502, { ok: false, error: msg });
  } finally {
    await releaseLock(lockKey);
  }
}
