// GET  /api/presell-listings/compete  -> { ok, master, all, lastRun, running, here, shoes:[…], log:[…] }
// POST /api/presell-listings/compete
//   { action: 'master', on }                       the competition switch
//   { action: 'lock', on }                         🔒 put back prices changed outside the app
//   { action: 'all', on, mode }                    "All shoes" + its default mode
//   { action: 'sku', sku, enabled, mode }          one shoe on/off + its mode
//   { action: 'sku', sku, clear: true }            back to following "All shoes"
//   { action: 'size', stockId, override }          'on' | 'off' | null (= follow the shoe)
//   { action: 'base', stockId, platform }          forget the price we set → retaken from the live price
//   { action: 'run', sku? }                        one pass now (only where PRESELL_WATCH=on)
// Pre-sell market competition (docs/context/presell-listings.md → "Market competition").
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  dbConfigured, setSetting, presellCompSettings, presellCompSkus, presellCompRows, listPresellCompLog,
  setPresellCompSku, clearPresellCompSku, setPresellCompOverride, setPresellCompBase, getPresellStock,
} from '../_lib/db.js';
import { runCompetition, competitionRunning } from '../_lib/presell-compete.js';
import { arrivalsEnabled } from '../_lib/presell-arrival.js';
import { compEffective } from '../../src/lib/presellCompete.js';
import { priceAlertChatId } from '../_lib/telegram.js';

const MODES = new Set(['undercut', 'match']);

async function overview() {
  const cfg = await presellCompSettings();
  const skus = new Map((await presellCompSkus()).map((s) => [s.sku, s]));
  const shoes = new Map();
  for (const r of await presellCompRows()) {
    if (!shoes.has(r.sku)) shoes.set(r.sku, { sku: r.sku, name: r.name, image: r.image, setting: skus.get(r.sku) || null, sizes: [] });
    const sku = skus.get(r.sku) || null;
    shoes.get(r.sku).sizes.push({ ...r, mode: compEffective({ master: true, all: cfg.all, sku, override: r.comp_override }) });
  }
  return {
    ...cfg, running: competitionRunning(), here: arrivalsEnabled(), alertGroup: !!priceAlertChatId(),
    everyMin: Math.max(5, Number(process.env.PRESELL_COMP_EVERY_MIN) || 15),
    shoes: [...shoes.values()], log: await listPresellCompLog(150),
  };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['warehouse', 'ph_team']);   // admin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 90 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const actor = user.name || user.username || null;
  try {
    if (req.method === 'GET') return send(res, 200, { ok: true, ...(await overview()) });
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
    const b = await getJsonBody(req);
    const mode = MODES.has(b.mode) ? b.mode : 'undercut';
    if (b.action === 'master') await setSetting('presell_comp_master', b.on === true ? 'on' : '', actor);
    else if (b.action === 'lock') await setSetting('presell_lock', b.on === true ? 'on' : 'off', actor);
    else if (b.action === 'all') {
      await setSetting('presell_comp_all', b.on === true ? 'on' : '', actor);
      await setSetting('presell_comp_all_mode', mode, actor);
    } else if (b.action === 'sku') {
      const sku = String(b.sku || '').trim().toUpperCase().slice(0, 60);
      if (!sku) return send(res, 400, { ok: false, error: 'Which shoe?' });
      if (b.clear === true) await clearPresellCompSku(sku);
      else await setPresellCompSku(sku, { enabled: b.enabled === true, mode }, actor);
    } else if (b.action === 'size' || b.action === 'base') {
      const id = Number(b.stockId);
      if (!Number.isSafeInteger(id) || id <= 0 || !(await getPresellStock(id))) return send(res, 404, { ok: false, error: 'That size no longer exists.' });
      if (b.action === 'size') await setPresellCompOverride(id, ['on', 'off'].includes(b.override) ? b.override : null, actor);
      else {
        if (!['alias', 'stockx'].includes(b.platform)) return send(res, 400, { ok: false, error: 'Which platform?' });
        await setPresellCompBase(id, b.platform, null);
      }
    } else if (b.action === 'run') {
      // Only the environment that acts on the shared Alias / StockX accounts may move prices.
      if (!arrivalsEnabled()) return send(res, 409, { ok: false, error: 'Competition only runs on the live server (PRESELL_WATCH=on) — nothing was changed here.' });
      if (competitionRunning()) return send(res, 409, { ok: false, error: 'A pass is already running — give it a minute.' });
      const sku = b.sku ? String(b.sku).trim().toUpperCase().slice(0, 60) : null;
      // In the background: a full pass can take minutes with StockX paced.
      runCompetition({ sku }).catch((e) => console.error('[presell-compete] run now', e.message));
    } else return send(res, 400, { ok: false, error: 'Unknown action.' });
    return send(res, 200, { ok: true, ...(await overview()) });
  } catch (e) {
    console.error('[presell-listings/compete]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update market competition.' });
  }
}
