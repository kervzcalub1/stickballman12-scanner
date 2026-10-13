// GET /api/ebay/sales-report?from=YYYY-MM-DD&to=YYYY-MM-DD
//   -> { ok, orders, transactions, coverage, ebaySummary, ebaySummaryError }
// The eBay sales report / statement for an EST date range (docs/context/ebay-orders.md):
// the orders created in it and every money movement booked in it, from our synced copy,
// plus eBay's OWN totals for the same range (Finances transaction_summary, live) to check
// ours against. ADMIN only — it's the company's money. The page builds the CSVs.
import { send, applySecurity, rateLimit, requireAdmin } from '../_lib/util.js';
import { dbConfigured, ebayOrdersCreatedBetween, ebayTransactionsBetween } from '../_lib/db.js';
import { ebayConfigured, ebayStatus, fetchEbayTransactionSummary } from '../_lib/ebay.js';
import { readSync } from '../_lib/ebay-orders-sync.js';
import { estDayStart } from '../../src/lib/ebayCoupons.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAdmin(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!ebayConfigured()) return send(res, 503, { ok: false, error: 'eBay isn’t set up on this server.' });
  const q = new URL(req.url, 'http://x').searchParams;
  const fromYmd = q.get('from'); const toYmd = q.get('to');
  if (!YMD.test(fromYmd || '') || !YMD.test(toYmd || '') || toYmd < fromYmd) return send(res, 400, { ok: false, error: 'Pick a from and a to date.' });
  const from = estDayStart(fromYmd); const to = estDayStart(addDays(toYmd, 1));
  if (to - from > 1100 * 86400_000) return send(res, 400, { ok: false, error: 'At most 36 months at a time.' });
  const [orders, transactions, sync, st] = await Promise.all([
    ebayOrdersCreatedBetween(from.toISOString(), to.toISOString()), ebayTransactionsBetween(from.toISOString(), to.toISOString()), readSync(), ebayStatus(),
  ]);
  let ebaySummary = null; let ebaySummaryError = null;
  if (st.canFinances) {
    try { ebaySummary = await fetchEbayTransactionSummary({ from, to: new Date(Math.min(to.getTime(), Date.now())) }); }
    catch (e) { ebaySummaryError = e.message; }
  } else ebaySummaryError = 'Not approved for eBay finances yet — Connect eBay again.';
  return send(res, 200, { ok: true, from: fromYmd, to: toYmd, orders, transactions, ebaySummary, ebaySummaryError,
    coverage: { from: sync?.coveredFrom || null, lastSync: sync?.finishedAt || null, financeError: sync?.financeError || null }, canFinances: st.canFinances });
}
