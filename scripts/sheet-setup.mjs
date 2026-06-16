// One-off: create the v4 tabs (Inventory, Batches, Issues) with headers in the
// configured spreadsheet. Idempotent — skips tabs that already exist; never
// touches the existing monitoring tab (Sheet1). Run:  npm run sheet:setup
import fs from 'node:fs';
import { JWT } from 'google-auth-library';

if (!process.env.GOOGLE_SHEET_ID) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const SS = process.env.GOOGLE_SHEET_ID;
if (!SS) { console.error('GOOGLE_SHEET_ID not set.'); process.exit(1); }

const HEADERS = {
  Inventory: ['VIN', 'Product Name', 'SKU', 'Size', 'Cost', 'Status',
    'Supplier', 'Buyer', 'Batch', 'Tracking #', 'Date Received', 'Scanned By', 'Date Added', 'Notes'],
  Batches: ['Batch Code', 'Date Received', 'Supplier', 'Buyer', 'Tracking #', 'Items',
    'Total Cost', 'Default Cost', 'Special Rules', 'Notes', 'Issues', 'Created By', 'Created At'],
  Issues: ['Batch Code', 'Date', 'Type', 'Description', 'Expected', 'Received', 'Reported By'],
};

const client = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const { token } = await client.getAccessToken();
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = (p) => `https://sheets.googleapis.com/v4/spreadsheets/${SS}${p}`;

const meta = await (await fetch(api('?fields=sheets.properties.title'), { headers: auth })).json();
const existing = new Set(meta.sheets.map((s) => s.properties.title));

const toAdd = Object.keys(HEADERS).filter((t) => !existing.has(t));
if (toAdd.length) {
  const r = await fetch(api(':batchUpdate'), {
    method: 'POST', headers: auth,
    body: JSON.stringify({ requests: toAdd.map((title) => ({ addSheet: { properties: { title } } })) }),
  });
  console.log(`addSheet [${toAdd.join(', ')}] -> ${r.ok ? 'OK' : 'FAILED ' + r.status}`);
} else {
  console.log('All v4 tabs already exist.');
}

// Write/refresh header rows.
for (const [title, header] of Object.entries(HEADERS)) {
  await fetch(api(`/values/${encodeURIComponent(title + '!A1')}?valueInputOption=RAW`), {
    method: 'PUT', headers: auth, body: JSON.stringify({ values: [header] }),
  });
}
console.log('✓ Headers written for: ' + Object.keys(HEADERS).join(', '));
