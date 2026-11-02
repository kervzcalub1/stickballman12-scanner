// GET  /api/stockx/listings  -> { ok, rows, pull, queue }      our live StockX listings + market
// POST /api/stockx/listings { pull: true } -> { ok, started }   read them fresh from StockX
//
// StockX Reprice (docs/context/stockx-reprice.md). The pull runs in the background: every
// ACTIVE Direct listing (pages of 100), then the market for each size split by programme
// (Standard / Direct / Flex lowest ask + highest bid) — one call per size, at the shared
// StockX pace (~2.5/s), so ~1,700 listings take several minutes. Progress lives in
// app_settings 'stockx_pull', which the page watches live. READ-ONLY on StockX. PH + admin.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured, setSetting, getSetting, saveStockxListings, setStockxMarket, stockxLiveVariants, listStockxListings, stockxQueueSummary } from '../_lib/db.js';
import { stockxConfigured, stockxActiveListingsPage, stockxMarketByProgramme } from '../_lib/stockx.js';

export const PULL_KEY = 'stockx_pull';
const STALE_MS = 30 * 60 * 1000;   // a "running" pull older than this died with the process

export async function runStockxPull(by) {
  const startedAt = new Date().toISOString();
  const put = (o) => setSetting(PULL_KEY, JSON.stringify({ by, startedAt, ...o }), by).catch(() => {});
  try {
    await put({ state: 'running', phase: 'listings', page: 0, listings: 0 });
    const rows = [];
    for (let page = 1; page <= 200; page++) {
      const p = await stockxActiveListingsPage(page, 'DIRECT');
      rows.push(...p.listings);
      await put({ state: 'running', phase: 'listings', page, total: p.count, listings: rows.length });
      if (!p.hasNext || !p.listings.length) break;
    }
    const { ended } = await saveStockxListings(rows, startedAt);
    const variants = await stockxLiveVariants();
    let done = 0; let failed = 0; let lastError = null;
    for (const v of variants) {
      try { await setStockxMarket(v.variant_id, await stockxMarketByProgramme(v.product_id, v.variant_id)); }
      catch (e) { failed++; lastError = e.message; }
      done++;
      if (done % 20 === 0 || done === variants.length) await put({ state: 'running', phase: 'market', done, of: variants.length, failed, listings: rows.length });
    }
    await put({ state: 'done', finishedAt: new Date().toISOString(), listings: rows.length, sizes: variants.length, ended, marketFailed: failed, lastError });
  } catch (e) {
    console.error('[stockx/pull]', e.message);
    await put({ state: 'failed', finishedAt: new Date().toISOString(), error: e.message });
  }
}

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  let last = null;
  try { last = JSON.parse((await getSetting(PULL_KEY)) || 'null'); } catch { /* none */ }
  if (req.method === 'GET') {
    try {
      const [rows, queue] = await Promise.all([listStockxListings(), stockxQueueSummary()]);
      return send(res, 200, { ok: true, rows, pull: last, queue, configured: stockxConfigured() });
    } catch (e) { console.error('[stockx/listings]', e.message); return send(res, 500, { ok: false, error: 'Could not load the StockX listings.' }); }
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const b = await getJsonBody(req);
  if (!b.pull) return send(res, 400, { ok: false, error: 'Nothing to do.' });
  if (!stockxConfigured()) return send(res, 503, { ok: false, error: 'StockX isn’t set up on this server.' });
  if (last?.state === 'running' && Date.now() - Date.parse(last.startedAt) < STALE_MS)
    return send(res, 409, { ok: false, error: `${last.by || 'Someone'} is pulling from StockX right now.` });
  runStockxPull(user.name || user.username || "");
  return send(res, 200, { ok: true, started: true });
}
