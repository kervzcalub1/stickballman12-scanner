// GET /api/presell-listings/list?tab=stock|listings|sales|pos&view=&platform=&q=&stock=&from=&to=
// from / to = YYYY-MM-DD (EST): Stock by the day first listed, Listings by the day created,
// Sales by the day sold.
// Pre-sell Listings (docs/context/presell-listings.md) — the three read views.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listPresellStock, listPresellListings, listPresellSales, presellPoOptions } from '../_lib/db.js';

const VIEWS = new Set(['all', 'live', 'off', 'pending', 'sold', 'deleted', 'failed']);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const p = new URL(req.url, 'http://x').searchParams;
  const q = String(p.get('q') || '').trim().slice(0, 80) || null;
  const day = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(String(p.get(k) || '')) ? p.get(k) : null);
  const from = day('from'); const to = day('to');
  try {
    const tab = p.get('tab');
    if (tab === 'stock') return send(res, 200, { ok: true, rows: await listPresellStock({ q, from, to }) });
    // A date range is a report: every sale in it, not just the latest 300.
    if (tab === 'sales') return send(res, 200, { ok: true, rows: await listPresellSales({ from, to, limit: from || to ? 5000 : 300 }) });
    if (tab === 'pos') return send(res, 200, { ok: true, pos: await presellPoOptions() });
    const platform = ['alias', 'stockx'].includes(p.get('platform')) ? p.get('platform') : null;
    const stockId = Number(p.get('stock')) > 0 ? Number(p.get('stock')) : null;
    const out = await listPresellListings({ view: VIEWS.has(p.get('view')) ? p.get('view') : 'all', platform, q, stockId, from, to, limit: from || to ? 5000 : 1000 });
    return send(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error('[presell-listings/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the pre-sell listings.' });
  }
}
