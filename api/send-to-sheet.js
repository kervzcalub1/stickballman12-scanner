// POST /api/send-to-sheet  { product, rows }  ->  { ok, message }
// Validates the submission, then appends one row per variant directly to a
// Google Sheet via the Sheets API (service account). Credentials are
// server-side only. If Sheets is not configured, the request is validated
// and acknowledged as a stub.
//
// Each variant becomes a row (columns A–I):
//   [ unique_id, name, sku, size, quantity, price, remarks, status, addedBy ]
// unique_id (column A, hidden + locked in the sheet) is a short, time-ordered
// per-row token used by the verify-and-retry write path to detect/repair
// concurrent overwrites. price/remarks/addedBy are blank; status -> "Not Added".

import {
  getJsonBody, send, applySecurity, rateLimit, requireAuth, cleanSku,
} from './_lib/util.js';
import { upsertVariants, sheetsConfigured } from './_lib/sheets.js';
import { acquireLock, releaseLock } from './_lib/db.js';

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

  const rawSku = cleanSku(product.sku);
  if (!rawSku) return { error: 'Missing or invalid SKU. Search a product first.' };
  // The API gives SKUs with a space (e.g. "HJ5994 106"); the sheet expects the
  // dashed form ("HJ5994-106"). Collapse internal whitespace to a single dash.
  const sku = rawSku.replace(/\s+/g, '-');

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
  const user = requireAuth(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  const body = await getJsonBody(req);
  const v = validate(body);
  if (v.error) return send(res, 400, { ok: false, error: v.error });

  if (!sheetsConfigured()) {
    console.log('[send-to-sheet] (stub, Sheets not configured):',
      JSON.stringify({ name: v.name, sku: v.sku, variants: v.variants }));
    return send(res, 200, {
      ok: true,
      forwarded: false,
      stub: true,
      count: v.variants.length,
      message: 'Validated (Google Sheet not configured yet).',
    });
  }

  // Consolidating write: for each size, if a 'Not Added' row with the same
  // SKU + Size exists, add to its quantity; otherwise append a new row.
  // Scanned by = the signed-in user's name. The per-SKU lock serializes this
  // read/modify/write against concurrent scans of the same product (Bulk or
  // Rapid use the same lock key), so quantities can't be lost.
  const scannedBy = user.name || user.username || '';
  // Single global write lock (shared with Rapid Scan) serializes all sheet
  // writes so the consolidating read/modify/write is race-free.
  const lockKey = 'sheet:write';

  const locked = await acquireLock(lockKey, { waitMs: 15000 }).catch(() => false);
  if (!locked)
    return send(res, 409, { ok: false, error: 'Busy — another scan of this product is in progress. Try again.' });

  try {
    const r = await upsertVariants({ scannedBy, name: v.name, sku: v.sku, variants: v.variants });
    const parts = [];
    if (r.appended) parts.push(`added ${r.appended} new size(s)`);
    if (r.incremented) parts.push(`updated ${r.incremented} existing`);
    return send(res, 200, {
      ok: true,
      forwarded: true,
      count: r.total,
      message: `Sheet ${parts.join(' & ') || 'updated'}.`,
    });
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? 'Google Sheets request timed out.'
      : (e.message || 'Google Sheets error.');
    return send(res, 502, { ok: false, error: msg });
  } finally {
    await releaseLock(lockKey);
  }
}
