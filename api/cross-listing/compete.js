// GET  /api/cross-listing/compete  -> { ok, master, lock, all, lastRun, running, here, alertChat, everyMin, groups:[…], log:[…] }
// POST /api/cross-listing/compete
//   { action: 'master', on }                         the competition switch
//   { action: 'lock', on }                           🔒 put back prices changed outside the app
//   { action: 'all', on, mode }                      "All shoes" + its default mode
//   { action: 'group', groupId, enabled, mode }      one shoe on/off + its mode
//   { action: 'group', groupId, clear: true }        back to following "All shoes"
//   { action: 'size', poolId, override }             'on' | 'off' | null (= follow the shoe)
//   { action: 'base', poolId, groupSkuId }           forget the price we set → retaken from the live price
//   { action: 'run', groupId? }                      one pass now (only where PRESELL_WATCH=on)
// Alias Cross-Listing ⚔ price compete (docs/context/alias-cross-listing.md → "Price compete").
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  dbConfigured, setSetting, crossCompSettings, crossCompRows, listCrossCompLog, setCrossGroupComp, setCrossPoolOverride,
  setCrossComp, getCrossPool, getCrossGroupSkus,
} from '../_lib/db.js';
import { runCrossCompetition, crossCompetitionRunning, groupSetting } from '../_lib/cross-compete.js';
import { crossPriceChatId } from '../_lib/cross.js';
import { arrivalsEnabled } from '../_lib/presell-arrival.js';
import { compEffective } from '../../src/lib/presellCompete.js';

const MODES = new Set(['undercut', 'match']);
const posInt = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

async function overview() {
  const cfg = await crossCompSettings();
  const groups = new Map();
  for (const r of await crossCompRows()) {
    const gid = Number(r.group_id);
    if (!groups.has(gid)) groups.set(gid, { id: gid, name: r.group_name, image: null, setting: groupSetting(r), skus: [], sizes: [] });
    const g = groups.get(gid);
    if (!g.image && r.image) g.image = r.image;
    if (!g.skus.includes(r.sku)) g.skus.push(r.sku);
    let z = g.sizes.find((x) => x.poolId === Number(r.pool_id));
    if (!z) {
      // `mode` = what the size WOULD compete in with the master switch on (the page says "paused" when it is off).
      z = { poolId: Number(r.pool_id), size: r.size, comp_override: r.comp_override, mode: compEffective({ master: true, all: cfg.all, sku: g.setting, override: r.comp_override }), skus: [] };
      g.sizes.push(z);
    }
    z.skus.push({ groupSkuId: Number(r.group_sku_id), sku: r.sku, live: r.live, off: r.off, price: r.price, lock_cents: r.lock_cents, base_cents: r.base_cents, state: r.state || null });
  }
  return {
    ...cfg, running: crossCompetitionRunning(), here: arrivalsEnabled(), alertChat: !!(await crossPriceChatId()),
    everyMin: Math.max(5, Number(process.env.PRESELL_COMP_EVERY_MIN) || 15),
    groups: [...groups.values()], log: await listCrossCompLog(150),
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
    if (b.action === 'master') await setSetting('cross_comp_master', b.on === true ? 'on' : '', actor);
    else if (b.action === 'lock') await setSetting('cross_lock', b.on === true ? 'on' : 'off', actor);
    else if (b.action === 'all') {
      await setSetting('cross_comp_all', b.on === true ? 'on' : '', actor);
      await setSetting('cross_comp_all_mode', mode, actor);
    } else if (b.action === 'group') {
      const id = posInt(b.groupId);
      const set = b.clear === true ? { enabled: null, mode: null } : { enabled: b.enabled === true, mode };
      if (!id || !(await setCrossGroupComp(id, set))) return send(res, 404, { ok: false, error: 'That shoe is no longer cross-listed.' });
    } else if (b.action === 'size') {
      const id = posInt(b.poolId);
      if (!id || !(await setCrossPoolOverride(id, ['on', 'off'].includes(b.override) ? b.override : null, actor))) return send(res, 404, { ok: false, error: 'That size no longer exists.' });
    } else if (b.action === 'base') {
      const id = posInt(b.poolId);
      const pool = id ? await getCrossPool(id) : null;
      if (!pool) return send(res, 404, { ok: false, error: 'That size no longer exists.' });
      const sku = (await getCrossGroupSkus(pool.group_id)).find((k) => Number(k.id) === Number(b.groupSkuId));
      if (!sku) return send(res, 400, { ok: false, error: 'Which SKU?' });
      await setCrossComp(id, Number(sku.id), { base: null });
    } else if (b.action === 'run') {
      // Only the environment that acts on the shared Alias account may move prices.
      if (!arrivalsEnabled()) return send(res, 409, { ok: false, error: 'Price compete only runs on the live server (PRESELL_WATCH=on) — nothing was changed here.' });
      if (crossCompetitionRunning()) return send(res, 409, { ok: false, error: 'A pass is already running — give it a minute.' });
      // In the background: a pass reads Alias once or more per size × SKU.
      runCrossCompetition({ groupId: posInt(b.groupId) }).catch((e) => console.error('[cross-compete] run now', e.message));
    } else return send(res, 400, { ok: false, error: 'Unknown action.' });
    return send(res, 200, { ok: true, ...(await overview()) });
  } catch (e) {
    console.error('[cross-listing/compete]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update price compete.' });
  }
}
