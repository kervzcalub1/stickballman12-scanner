#!/usr/bin/env node
// One-off repair for the receiving bug that stamped ONE UPC on every size in a box
// (the cart carried the UPC on the shoe line, not on the size row — fixed in
// src/screens/Receiving.jsx). Units whose UPC belongs to a DIFFERENT size get it
// cleared, so the No-Box / Box Labels "needs UPC" prompt asks for the real code
// instead of printing another size's barcode onto a replacement box.
//
// Ground truth is the StockX UPC lookup — the only source that resolves a UPC to
// its exact size (same proxy api/upc-search.js uses). A UPC it can't resolve is
// left ALONE unless it is provably ambiguous (sitting on >1 size in one box), in
// which case every unit under it is cleared: we cannot tell which pair is the one
// the code was really scanned from, and a confident wrong barcode is worse than a
// prompt.
//
//   node scripts/repair-unit-upcs.mjs                 # dry run, prints the plan
//   node scripts/repair-unit-upcs.mjs --apply         # writes
//   node scripts/repair-unit-upcs.mjs --local         # run against DATABASE_URL
import fs from 'node:fs';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const LOCAL = process.argv.includes('--local');
const STOCKX_BASE = 'https://bypass-stock-x-host-railway-stock-x.up.railway.app';

function dbUrl() {
  const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
  const key = LOCAL ? 'DATABASE_URL' : 'PROD_DATABASE_URL';
  const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m) throw new Error(`${key} is not in .env`);
  return m[1].trim().replace(/^["']|["']$/g, '');
}

// Same normalisation the PO reconciliation uses: a shoe can carry two style codes
// ("305381-007/CW2290-111"), and either half is a legitimate match.
const codes = (sku) => String(sku || '').split('/').map((s) => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean);
const sameSku = (a, b) => codes(a).some((x) => codes(b).includes(x));
// "10", "10.0", " 10 " are one size; "10W"/"10Y" are not size 10.
const normSize = (s) => {
  const t = String(s || '').trim().toUpperCase().replace(/\s+/g, '');
  const m = t.match(/^([\d.]+)([WY]?)$/);
  return m ? `${parseFloat(m[1])}${m[2]}` : t;
};

async function stockxSize(upc) {
  const ctl = AbortSignal.timeout(20_000);
  const r = await fetch(`${STOCKX_BASE}/stockx-upc-search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upc }), signal: ctl,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json().catch(() => null);
  if (data?.ok === false) return null;
  const variant = data?.result?.data?.variants?.[0];
  const product = variant?.product;
  const sku = product?.styleId || product?.sku || null;
  const size = variant?.traits?.size || variant?.sizeChart?.baseSize
    || variant?.sizeChart?.displayOptions?.[0]?.size || null;
  if (!sku || !size) return null;
  return { sku: String(sku).trim(), size: String(size).trim() };
}

const c = new pg.Client({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } });
await c.connect();

// Every unit carrying a UPC that ALSO sits on another size somewhere. A UPC found
// on exactly one size everywhere is either right or unfalsifiable from our data.
const { rows } = await c.query(`
  select i.id, i.vin, i.sku, i.size, i.upc, i.batch_id, i.box_id
    from items i
   where i.upc is not null and i.upc <> ''
     and exists (select 1 from items j where j.upc = i.upc and j.size <> i.size)
   order by i.upc, i.id
`);
const upcs = [...new Set(rows.map((r) => r.upc))];
// A UPC on >1 size inside ONE box can only be the bug: one box, one size.
const ambiguous = new Set((await c.query(`
  select distinct i.upc from items i
   where i.upc is not null and i.upc <> ''
     and exists (select 1 from items j where j.upc = i.upc and j.size <> i.size
                   and j.batch_id = i.batch_id and coalesce(j.box_id,0) = coalesce(i.box_id,0))
`)).rows.map((r) => r.upc));

console.log(`${rows.length} units under ${upcs.length} suspect UPCs (${ambiguous.size} provably ambiguous). Resolving against StockX…`);

const truth = new Map();
let n = 0;
for (const upc of upcs) {
  n += 1;
  try { truth.set(upc, await stockxSize(upc)); }
  catch (err) { truth.set(upc, undefined); console.log(`  ! ${upc} lookup failed: ${err.message}`); }
  if (n % 25 === 0) console.log(`  … ${n}/${upcs.length}`);
}

const clear = [];
const keep = [];
const untouched = [];
for (const r of rows) {
  const t = truth.get(r.upc);
  if (t === null || t === undefined) {
    // No ground truth. Only the provably-ambiguous ones get cleared.
    (ambiguous.has(r.upc) ? clear : untouched).push({ ...r, why: t === null ? 'no StockX match' : 'lookup failed' });
    continue;
  }
  const sizeOk = normSize(t.size) === normSize(r.size);
  const skuOk = sameSku(t.sku, r.sku);
  if (sizeOk && skuOk) keep.push(r);
  else clear.push({ ...r, why: !skuOk ? `UPC is ${t.sku}, unit is ${r.sku}` : `UPC is size ${t.size}, unit is size ${r.size}` });
}

const resolved = [...truth.values()].filter(Boolean).length;
console.log(`\nUPCs resolved by StockX: ${resolved}/${upcs.length}`);
console.log(`  keep    ${keep.length} units — UPC matches the unit's own size`);
console.log(`  CLEAR   ${clear.length} units — UPC belongs to another size/product`);
console.log(`  leave   ${untouched.length} units — unresolvable and not provably wrong`);

const byWhy = clear.reduce((m, r) => { m[r.why.replace(/is (size )?\S+/g, 'is …')] = (m[r.why.replace(/is (size )?\S+/g, 'is …')] || 0) + 1; return m; }, {});
console.log('\nreasons:', byWhy);
console.log('\nsample of what would be cleared:');
for (const r of clear.slice(0, 12)) console.log(`  ${r.vin}  ${r.sku}  US ${r.size}  upc ${r.upc}  — ${r.why}`);

if (!APPLY) { console.log(`\nDRY RUN — nothing written. Re-run with --apply to clear those ${clear.length}.`); await c.end(); process.exit(0); }

// Keep the evidence: the old code goes into the unit's notes, so a pair whose
// barcode has to be re-scanned still says where its wrong one came from.
await c.query('begin');
try {
  const ids = clear.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    await c.query(
      `update items set upc = null,
              notes = trim(coalesce(notes,'') || ' [upc ' || upc || ' cleared 2026-09-03: belonged to another size]'),
              updated_at = now()
        where id = any($1::bigint[])`, [chunk],
    );
  }
  await c.query('commit');
  console.log(`\nCleared ${ids.length} unit UPCs.`);
} catch (err) { await c.query('rollback'); throw err; }
await c.end();
