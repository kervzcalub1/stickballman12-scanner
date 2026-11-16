// StockX DAILY price update (docs/context/stockx-reprice.md → "Daily, automatic").
//   GET  /api/stockx/daily                      -> { ok, settings, days, today, running, enabledHere }
//   POST /api/stockx/daily { settings: {…} }    -> { ok, settings }     ADMIN — the switch + the rules
//   POST /api/stockx/daily { run: true }        -> { ok, started }      ADMIN — don't wait for the hour
//   POST /api/stockx/daily { teach: { variantIds, minPrice?, bigCutOk?, note?, clear? } } -> { ok, count }
// Teaching (PH + admin) is per SIZE: "never ask less than $X", "this big cut is fine", or clear
// what was taught. The switch and the rules are an admin's: turning it on lets the server change
// live StockX asks every day with nobody pressing anything.
import { send, applySecurity, rateLimit, requireRole, getJsonBody, isPrivileged } from '../_lib/util.js';
import { dbConfigured, listStockxDaily, getSetting, setStockxTeach, clearStockxTeach } from '../_lib/db.js';
import { stockxConfigured } from '../_lib/stockx.js';
import { readAuto, writeAuto, estDay } from '../_lib/stockx-daily.js';
import { runStockxDaily, stockxDailyRunning, stockxDailyEnabled } from '../_lib/stockx-daily-worker.js';
import { PULL_KEY } from './listings.js';

const STALE_MS = 30 * 60 * 1000;

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const by = user.name || user.username || '';
  try {
    if (req.method === 'GET') {
      const [settings, days] = await Promise.all([readAuto(), listStockxDaily(14)]);
      return send(res, 200, { ok: true, settings, days, today: estDay(), running: stockxDailyRunning(), enabledHere: stockxDailyEnabled() });
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
    const b = await getJsonBody(req);

    if (b.teach) {
      const t = b.teach;
      const ids = [...new Set((Array.isArray(t.variantIds) ? t.variantIds : []).map((x) => String(x ?? '').trim()).filter(Boolean))];
      if (!ids.length) return send(res, 400, { ok: false, error: 'Which sizes?' });
      if (ids.length > 1000) return send(res, 400, { ok: false, error: 'At most 1,000 at a time.' });
      if (t.clear === true) return send(res, 200, { ok: true, count: await clearStockxTeach(ids) });
      const patch = { by, note: String(t.note || '').trim().slice(0, 300) || null };
      if (t.minPrice !== undefined) {
        const m = t.minPrice === null || t.minPrice === '' ? null : Number(t.minPrice);
        if (m != null && !(Number.isFinite(m) && m > 0 && m <= 100000)) return send(res, 400, { ok: false, error: 'The lowest price must be a dollar amount.' });
        patch.minPrice = m;
      }
      if (t.bigCutOk !== undefined) patch.bigCutOk = t.bigCutOk === true;
      if (patch.minPrice === undefined && patch.bigCutOk === undefined) return send(res, 400, { ok: false, error: 'Nothing to teach.' });
      return send(res, 200, { ok: true, count: await setStockxTeach(ids, patch) });
    }

    // From here on: the switch, the rules and "run now" — an admin's.
    if (!isPrivileged(user.role)) return send(res, 403, { ok: false, error: 'Only an admin can change the automatic update.' });
    if (b.settings && typeof b.settings === 'object') {
      const { on, rule, offset, minProfit, maxCutNoCost, hour } = b.settings;
      const patch = {};
      for (const [k, v] of Object.entries({ on, rule, offset, minProfit, maxCutNoCost, hour })) if (v !== undefined) patch[k] = v;
      return send(res, 200, { ok: true, settings: await writeAuto(patch, by) });
    }
    if (b.run === true) {
      if (!stockxConfigured()) return send(res, 503, { ok: false, error: 'StockX isn’t set up on this server.' });
      // A dev database is a copy and dev shares the ONE StockX account: never from a dev server.
      if (!stockxDailyEnabled()) return send(res, 409, { ok: false, error: 'The daily update only runs on the production server.' });
      let last = null;
      try { last = JSON.parse((await getSetting(PULL_KEY)) || 'null'); } catch { /* none */ }
      if (stockxDailyRunning() || (last?.state === 'running' && Date.now() - Date.parse(last.startedAt) < STALE_MS))
        return send(res, 409, { ok: false, error: 'A market read is already running — wait for it to finish.' });
      runStockxDaily(by).catch((e) => console.error('[stockx/daily] run', e.message));
      return send(res, 200, { ok: true, started: true });
    }
    return send(res, 400, { ok: false, error: 'Nothing to do.' });
  } catch (e) {
    console.error('[stockx/daily]', e.message);
    return send(res, 500, { ok: false, error: 'Could not reach the daily update.' });
  }
}
