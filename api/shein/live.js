// GET  /api/shein/live            -> { ok, connected, run, items (first 3,000), itemsTotal, sync, units, unitCounts, pushes, worker }
// GET  /api/shein/live?run=<id>&all=1 -> { ok, items } — EVERY row of that run (the CSV)
// POST /api/shein/live { action }:
//   start { mode: dry|stock|full, ai }   walk every SHEIN product, one at a time
//   stop                                 stop after the current product
//   orders_on { openAtStart } | orders_off   SHEIN sales → Shopify (admin)
//   push_on | push_off                   Shopify stock changes → SHEIN (admin; registers Shopify's webhook)
//   retry                                retry SHEIN sales that failed to leave Shopify
// docs/context/shein-live-fix.md. PH + admin; the two switches that change how SHOPIFY's
// stock moves are admin-only.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, latestSheinLiveRun, listSheinLiveItems, countSheinLiveItems, recentSheinUnits, sheinUnitCounts, recentSheinPushes, requestSheinLiveStop } from '../_lib/db.js';
import { sheinStatus } from '../_lib/shein.js';
import { startWalk, walkActive, heartbeat, MODES } from '../_lib/shein-live.js';
import { readSync, writeSync, switchOn, switchOff, actOnUnits } from '../_lib/shein-orders.js';
import { sheinWorkerEnabled } from '../_lib/shein-worker.js';
import { shopifyEnsureInventoryWebhook } from '../_lib/shopify.js';

const isAdmin = (u) => u?.role === 'admin' || u?.role === 'superadmin';
const baseUrl = (req) => String(process.env.APP_URL || process.env.PUBLIC_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/+$/, '');

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const by = user.name || user.username || '';

  if (req.method === 'GET') {
    // The CSV wants the whole run; the page's live refresh stays capped (a full run is 4,000+ rows).
    const qs = new URL(req.url, 'http://x').searchParams;
    if (qs.get('all') === '1') {
      const runId = Number(qs.get('run'));
      if (!Number.isInteger(runId) || runId < 1) return send(res, 400, { ok: false, error: 'Which run?' });
      return send(res, 200, { ok: true, items: await listSheinLiveItems(runId, 100_000) });
    }
    await heartbeat();   // keeps a walk alive in THIS process fresh; calls a dead one interrupted
    const [st, run, sync, units, unitCounts, pushes] = await Promise.all([
      sheinStatus().catch(() => null), latestSheinLiveRun(), readSync(), recentSheinUnits(60), sheinUnitCounts(), recentSheinPushes(40),
    ]);
    const [items, itemsTotal] = run ? await Promise.all([listSheinLiveItems(run.id), countSheinLiveItems(run.id)]) : [[], 0];
    return send(res, 200, { ok: true, connected: !!st?.connected, configured: !!st?.configured, run, active: walkActive(), items, itemsTotal, sync, units, unitCounts, pushes,
      worker: sheinWorkerEnabled(), modes: MODES });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const b = await getJsonBody(req);
  try {
    switch (b.action) {
      case 'start': {
        const run = await startWalk({ mode: String(b.mode || 'dry'), by, ai: b.ai !== false });
        return send(res, 200, { ok: true, run });
      }
      case 'stop': {
        const run = await latestSheinLiveRun();
        if (run) await requestSheinLiveStop(run.id);
        return send(res, 200, { ok: true });
      }
      case 'retry': return send(res, 200, { ok: true, ...(await actOnUnits(undefined, { manual: true })) });
      case 'orders_on': case 'orders_off': case 'push_on': case 'push_off': {
        if (!isAdmin(user)) return send(res, 403, { ok: false, error: 'Only an admin can switch the live sync.' });
        if (b.action === 'orders_on') return send(res, 200, { ok: true, ...(await switchOn({ by, openAtStart: !!b.openAtStart })), sync: await readSync() });
        if (b.action === 'orders_off') return send(res, 200, { ok: true, sync: await switchOff(by) });
        if (b.action === 'push_on') {
          const hook = await shopifyEnsureInventoryWebhook(`${baseUrl(req)}/api/shopify/webhook`);
          if (hook.error) return send(res, 502, { ok: false, error: `Shopify didn’t accept the stock webhook: ${hook.error}` });
          return send(res, 200, { ok: true, sync: await writeSync({ push: 'on', pushBy: by, pushAt: new Date().toISOString(), webhookId: hook.id }, by) });
        }
        return send(res, 200, { ok: true, sync: await writeSync({ push: 'off', pushOffBy: by, pushOffAt: new Date().toISOString() }, by) });
      }
      default: return send(res, 400, { ok: false, error: 'Unknown action.' });
    }
  } catch (e) {
    return send(res, e.status || 500, { ok: false, error: e.message });
  }
}
