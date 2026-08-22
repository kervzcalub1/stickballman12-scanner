// Sales velocity — the platform sales export (`sales_history`), which is how the
// advisor answers "how fast does this actually sell".
//
// Runs against the real database (CI runs db:setup first), but touches only rows under
// a sentinel style ID it creates and removes, so it behaves the same on a machine with
// the export loaded and on CI where the table is empty.
import { test, expect } from '@playwright/test';
import './helpers/auth.js';   // loads .env so DATABASE_URL is set
import { salesVelocity } from '../api/_lib/db.js';
import pg from 'pg';

const SOLO = 'ZZTEST-001';                 // a plain style
const FAST = 'ZZTEST-FAST';                // enough sales to clear the weekly line
const PAIR = 'ZZTEST-100/ZZTEST-200';      // the dual-SKU notation the export uses
let pool;

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const rows = [
    // 3 in the last 30 days, 2 more inside 90.
    [SOLO, [SOLO], daysAgo(2)], [SOLO, [SOLO], daysAgo(9)], [SOLO, [SOLO], daysAgo(20)],
    [SOLO, [SOLO], daysAgo(60)], [SOLO, [SOLO], daysAgo(80)],
    // One sale recorded under a DUAL style id.
    [PAIR, ['ZZTEST-100', 'ZZTEST-200'], daysAgo(5)],
    // 6 in 30 days = 1.4/week, just over the weekly threshold.
    ...[1, 3, 6, 11, 17, 25].map((d) => [FAST, [FAST], daysAgo(d)]),
  ];
  for (const [style, codes, date] of rows) {
    await pool.query('INSERT INTO sales_history (style_id, codes, sale_date, source_file) VALUES ($1,$2,$3,$4)',
      [style, codes, date, 'e2e']);
  }
});

test.afterAll(async () => {
  await pool.query("DELETE FROM sales_history WHERE source_file = 'e2e'");
  await pool.end();
});

test('counts the windows a buyer actually cares about', async () => {
  const v = await salesVelocity(SOLO);
  expect(v.sold_total).toBe(5);
  expect(v.sold_30d).toBe(3);
  expect(v.sold_90d).toBe(5);
  expect(v.per_week).toBeCloseTo(0.7, 1);   // 3 in 30 days
  // 0.7/week is UNDER the ≥1/week line, so this is a monthly mover. The bands read off
  // the last 30 days on purpose: a style that sold well in spring and stopped is a slow
  // mover today, and the buyer is deciding today.
  expect(v.liquidity).toBe('monthly');
});

test('the liquidity band turns over at one sale a week', async () => {
  const v = await salesVelocity(FAST);
  expect(v.sold_30d).toBe(6);
  expect(v.per_week).toBeCloseTo(1.4, 1);
  expect(v.liquidity).toBe('weekly');
});

test('either half of a dual SKU finds the sale — and finds it ONCE', async () => {
  // The export writes "315115-112/DD8959-100" for a pair listed under two codes.
  // Looking up either half must find that sale, without counting it twice.
  const a = await salesVelocity('ZZTEST-100');
  const b = await salesVelocity('ZZTEST-200');
  expect(a.sold_total).toBe(1);
  expect(b.sold_total).toBe(1);
  expect(a.sold_30d).toBe(1);
});

test('a dual SKU used AS THE QUERY matches too — and still counts once', async () => {
  // The other direction, and the one that bites: the SKU used during an inquiry can
  // itself be a dual, because that's how our catalogue carries a shoe listed under two
  // codes. Matching only the query-as-one-string returned zero sales for exactly the
  // shoes most likely to be dual-listed.
  const whole = await salesVelocity(PAIR);                 // "ZZTEST-100/ZZTEST-200"
  expect(whole.sold_total).toBe(1);
  // Order and spacing are however someone typed it.
  const reversed = await salesVelocity(' zztest-200 / zztest-100 ');
  expect(reversed.sold_total).toBe(1);
});

test('lookups are case-insensitive — SKUs get typed however they get typed', async () => {
  const v = await salesVelocity('zztest-001');
  expect(v.sold_total).toBe(5);
});

test('a style with no sales is a FINDING; no export at all is missing data', async () => {
  const v = await salesVelocity('ZZTEST-NEVER-SOLD');
  // The table has rows (we just inserted some), so this is a real answer: zero sales.
  expect(v).not.toBeNull();
  expect(v.sold_total).toBe(0);
  expect(v.data_from).toBeTruthy();
  // `null` is reserved for "the export was never loaded on this server", which the
  // advisor must report as unknown rather than as "it never sells".
});
