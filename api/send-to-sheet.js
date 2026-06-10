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

import crypto from 'node:crypto';
import {
  getJsonBody, send, applySecurity, rateLimit, requireAuth, cleanSku,
} from './_lib/util.js';
import { appendRows, sheetsConfigured } from './_lib/sheets.js';

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
  if (!requireAuth(req, res)) return;
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

  // One row per variant, matching the sheet columns A–I:
  // [ unique_id, Product Name, SKU, Size, Quantity, Price, Remarks, Status, Added by ].
  // Column A is a short, time-ordered unique id used to verify the write
  // survived concurrent appends. A plain 1000+ counter is intentionally NOT
  // used: assigning the next number requires reading the sheet's current max
  // before writing, and that read-before-write races under concurrent
  // submissions. Instead we derive a coordination-free token:
  //   <base36 ms timestamp><per-submission salt><row index>
  // — compact (~13 chars), sortable by time, and unique without coordination.
  // Price / Remarks / Added by are blank; Status defaults to "Not Added".
  const stamp = Date.now().toString(36);
  const salt = crypto.randomBytes(2).toString('hex');
  const rows = v.variants.map((variant, i) => [
    `${stamp}${salt}${i}`, v.name, v.sku, variant.size, variant.quantity, '', '', 'Not Added', '',
  ]);

  try {
    const count = await appendRows(rows);
    return send(res, 200, {
      ok: true,
      forwarded: true,
      count,
      message: `Added ${count} size(s) to the sheet.`,
    });
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? 'Google Sheets request timed out.'
      : (e.message || 'Google Sheets error.');
    return send(res, 502, { ok: false, error: msg });
  }
}
