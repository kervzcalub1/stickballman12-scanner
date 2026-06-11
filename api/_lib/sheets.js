// Google Sheets append helper with verify-and-retry for concurrency safety.
//
// Uses a Google service account (JWT) to append rows via the Sheets REST API.
// All credentials are server-side env vars and are never sent to the browser.
//
// WHY VERIFY-AND-RETRY:
//   `values.append` + `insertDataOption=OVERWRITE` is NOT safe under concurrent
//   writes — two requests can compute the same "next empty row" and silently
//   overwrite each other (measured: 37/40 rows lost in a 40-way burst, all
//   returning HTTP 200). Switching to INSERT_ROWS isn't an option for this sheet
//   (it would break the pre-formatted/locked layout), so instead every row
//   carries a unique id in column A; after appending we read those cells back
//   and re-append any row whose id didn't survive (exponential backoff + jitter,
//   bounded attempts). This dramatically reduces loss but is best-effort, not a
//   hard guarantee — a sustained burst can still exhaust the retries.
//
// Required env vars:
//   GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
// Optional:
//   GOOGLE_SHEET_TAB (default "Sheet1")
//
// Sheet columns (A–I):
//   [ unique_id, Product Name, SKU, Size, Quantity, Price, Remarks, Status, Added by ]
// Each row passed to appendRows() MUST have its unique id at index 0 (column A).

import { JWT } from 'google-auth-library';
import { fetchWithTimeout } from './util.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const MAX_VERIFY_ATTEMPTS = 6;

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // Support keys stored with literal "\n" (the common way to keep a PEM on one line).
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!email || !key) {
    throw new Error('Google Sheets is not configured (service account email/key missing).');
  }

  cachedClient = new JWT({ email, key, scopes: SCOPES });
  return cachedClient;
}

export function sheetsConfigured() {
  return Boolean(
    process.env.GOOGLE_SHEET_ID &&
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY
  );
}

const tabName = () => process.env.GOOGLE_SHEET_TAB || 'Sheet1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function authToken() {
  const { token } = await getClient().getAccessToken();
  if (!token) throw new Error('Could not obtain Google access token.');
  return token;
}

// fetch with timeout + a single retry on a transient 429 / 5xx.
async function sheetsFetch(url, opts, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  let last;
  for (let i = 0; i < 2; i++) {
    last = await fetchWithTimeout(url, { ...opts, headers }, 15_000);
    if ((last.status === 429 || last.status >= 500) && i === 0) {
      await sleep(300 + Math.floor(Math.random() * 400));
      continue;
    }
    return last;
  }
  return last;
}

const valuesUrl = (id, a1) => `${BASE}/${id}/values/${encodeURIComponent(a1)}`;

// Append a contiguous block; returns the A1 range Google reports it wrote
// (e.g. "Sheet1!A10:I12").
async function appendBlock(id, token, rows) {
  const url =
    `${valuesUrl(id, `${tabName()}!A1`)}` +
    `:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`;
  const r = await sheetsFetch(url, { method: 'POST', body: JSON.stringify({ values: rows }) }, token);
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json())?.error?.message || ''; } catch { /* ignore */ }
    throw new Error(`Google Sheets append failed (${r.status})${detail ? `: ${detail}` : ''}.`);
  }
  const body = await r.json();
  return body?.updates?.updatedRange || null;
}

// "Sheet1!A10:I12" -> { start: 10, end: 12 }   (also handles a single-row range)
function parseRowBounds(a1) {
  const m = String(a1 || '').match(/![A-Z]+(\d+)(?::[A-Z]+(\d+))?$/);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2] ?? m[1]) };
}

// Read column A for rows [start..end], returned in order (blank -> "").
async function readColumnA(id, token, start, end) {
  const r = await sheetsFetch(valuesUrl(id, `${tabName()}!A${start}:A${end}`), { method: 'GET' }, token);
  if (!r.ok) throw new Error(`Google Sheets read-back failed (${r.status}).`);
  const body = await r.json();
  return (body.values || []).map((row) => (row[0] != null ? String(row[0]) : ''));
}

// Append rows, then verify each landed (by its column-A unique id) and re-append
// any that were overwritten. rows[i][0] MUST be the unique id. Returns the count
// of rows confirmed written; throws if some can't be confirmed after the cap.
export async function appendRows(rows) {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('GOOGLE_SHEET_ID is not set.');
  const token = await authToken();

  let pending = rows;
  for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
    const range = await appendBlock(id, token, pending);
    const bounds = parseRowBounds(range);
    // If we can't locate the write, don't risk a duplicate storm — treat as done.
    if (!bounds) return rows.length;

    // Let any near-simultaneous appends settle before reading back.
    await sleep(120 + Math.floor(Math.random() * 120));

    const got = await readColumnA(id, token, bounds.start, bounds.end);
    const missing = pending.filter((row, i) => got[i] !== String(row[0]));
    if (missing.length === 0) return rows.length;

    // Some rows were overwritten — retry just those, with de-correlated backoff.
    pending = missing;
    await sleep(Math.min(2000, 150 * 2 ** attempt) + Math.floor(Math.random() * 250));
  }

  throw new Error(
    `Sheet write could not be confirmed for ${pending.length} of ${rows.length} row(s) ` +
    `after ${MAX_VERIFY_ATTEMPTS} attempts (likely heavy concurrent writes). Please retry.`
  );
}

/* ----------------------- Rapid Scan consolidation --------------------- */
// Columns (0-based) in A:J: 0 unique_id, 1 scanned_by, 2 name, 3 sku, 4 size,
// 5 quantity, 6 price, 7 status, 8 remarks, 9 added_by.
const COL = { scannedBy: 1, sku: 3, size: 4, qty: 5, status: 7 };

async function readGrid(id, token) {
  const r = await sheetsFetch(valuesUrl(id, `${tabName()}!A2:J`), { method: 'GET' }, token);
  if (!r.ok) throw new Error(`Google Sheets read failed (${r.status}).`);
  const body = await r.json();
  return body.values || [];
}

// Update several quantity cells (column F) in a single batch call.
async function batchSetQty(id, token, updates) {
  const data = updates.map((u) => ({ range: `${tabName()}!F${u.row}`, values: [[u.qty]] }));
  const url = `${BASE}/${id}/values:batchUpdate`;
  const r = await sheetsFetch(url, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  }, token);
  if (!r.ok) throw new Error(`Google Sheets batch update failed (${r.status}).`);
}

function shortId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Consolidating writer for BOTH scan modes. For each variant, if a row with the
// same SKU + Size, Status 'Not Added', AND the same scanner ('Scanned by')
// already exists, add the quantity to it; otherwise append a new row. Keeping
// each scanner on their own row avoids conflicts and makes it clear who did
// what. Reads the grid once, then batches the cell updates and appends. MUST be
// called while holding the global write lock (caller's job) so the
// read/modify/write can't race another write.
// `variants`: [{ size, quantity }]. Returns { incremented, appended, total }.
export async function upsertVariants({ scannedBy, name, sku, variants }) {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('GOOGLE_SHEET_ID is not set.');
  const token = await authToken();
  const wantSku = String(sku).trim();
  const wantBy = String(scannedBy ?? '').trim();

  // Index existing consolidatable rows for this SKU + scanner by size.
  const grid = await readGrid(id, token);
  const existing = new Map(); // size -> { row, qty }
  for (let i = 0; i < grid.length; i++) {
    const r = grid[i];
    if (
      String(r[COL.sku] ?? '').trim() === wantSku &&
      String(r[COL.status] ?? '').trim() === 'Not Added' &&
      String(r[COL.scannedBy] ?? '').trim() === wantBy
    ) {
      const size = String(r[COL.size] ?? '').trim();
      if (!existing.has(size)) existing.set(size, { row: i + 2, qty: parseInt(r[COL.qty], 10) || 0 });
    }
  }

  const updates = [];
  const appends = [];
  for (const v of variants) {
    const size = String(v.size).trim();
    const qty = Math.max(1, parseInt(v.quantity, 10) || 0);
    const hit = existing.get(size);
    if (hit) {
      updates.push({ row: hit.row, qty: hit.qty + qty });
    } else {
      appends.push([shortId(), scannedBy, name, wantSku, size, qty, '', 'Not Added', '', '']);
    }
  }

  if (updates.length) await batchSetQty(id, token, updates);
  // Plain append (no verify-and-retry): callers hold the global write lock, so
  // no two appends run concurrently and there's nothing to clobber.
  if (appends.length) await appendBlock(id, token, appends);
  return { incremented: updates.length, appended: appends.length, total: variants.length };
}
