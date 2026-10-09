// POST /api/ebay/pull -> { ok, started }   read every active eBay listing into ebay_listings
// GET  /api/ebay/pull -> { ok, rows }       what the last pull saw, with our stock per size
// PH + admin. READ-ONLY on eBay. The pull runs in the background (a few pages of 200);
// its progress is app_settings 'ebay_pull', which the page watches live.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, setSetting, getSetting, saveEbayListings, listEbayListings } from '../_lib/db.js';
import { ebayConfigured, fetchActiveListings, inventoryItemCount, accessToken, PULL_KEY } from '../_lib/ebay.js';
import { styleFromTitle } from '../../src/lib/ebayReprice.js';

const STALE_MS = 15 * 60 * 1000;   // a "running" pull older than this died with the process

async function run(by) {
  const startedAt = new Date().toISOString();
  const put = (o) => setSetting(PULL_KEY, JSON.stringify({ by, startedAt, ...o }), by).catch(() => {});
  try {
    await put({ state: 'running', page: 0, pages: null, listings: 0 });
    const { rows, listings } = await fetchActiveListings(
      (t) => styleFromTitle(t),
      (page, pages, n) => put({ state: 'running', page, pages, listings: n }),
    );
    const inv = await inventoryItemCount();
    const { removed } = await saveEbayListings(rows, startedAt);
    await put({ state: 'done', finishedAt: new Date().toISOString(), listings, rows: rows.length, removed,
      inventoryItems: inv.count, inventoryError: inv.error || null,
      noStyle: rows.filter((r) => !r.style).length, noSize: rows.filter((r) => !r.size).length });
  } catch (e) {
    console.error('[ebay/pull]', e.message);
    await put({ state: 'failed', finishedAt: new Date().toISOString(), error: e.message });
  }
}

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  if (req.method === 'GET') {
    try { return send(res, 200, { ok: true, rows: await listEbayListings() }); }
    catch (e) { console.error('[ebay/pull] list', e.message); return send(res, 500, { ok: false, error: 'Could not load the eBay listings.' }); }
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!ebayConfigured()) return send(res, 503, { ok: false, error: 'eBay isn’t set up on this server yet.' });
  let last = null;
  try { last = JSON.parse((await getSetting(PULL_KEY)) || 'null'); } catch { /* none */ }
  if (last?.state === 'running' && Date.now() - Date.parse(last.startedAt) < STALE_MS)
    return send(res, 409, { ok: false, error: `${last.by || 'Someone'} is pulling from eBay right now.` });
  // Fail fast on the one thing a person can fix (not connected / expired) before going background.
  try { await accessToken(); } catch (e) { return send(res, e.notConnected ? 409 : 502, { ok: false, error: e.message }); }
  run(user.name || user.username || '');
  return send(res, 200, { ok: true, started: true });
}
