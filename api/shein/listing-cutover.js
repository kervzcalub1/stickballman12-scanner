// SHEIN Listings Phase 5 — the 4seller cut-over + go-live checklists (docs/context/shein-listings.md →
// "Phase 5"; src/lib/sheinCutover.js does the reading). DB only: nothing here calls SHEIN or Shopify.
//
// GET  /api/shein/listing-cutover            -> { ok, canWrite, now, cutover, golive, ticks }   (PH + admin)
// POST /api/shein/listing-cutover { action }:   admin or Connect integrations (403 otherwise)
//   tick   { key, date?, note? }   a person's ✓ (who + when recorded; date = the EST day they give)
//   untick { key }                 takes it back (the 4seller-paused one also ends the 30 days)
//   restart                        the 30 days start again from now (after a miss), the paused date kept
// Gates: applySecurity → requireRole(['ph_team']) (admin auto) → privilege read fresh → rateLimit → getJsonBody.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, getSetting, setSetting, getListingCache, listingCutoverFacts, listingGoliveFacts } from '../_lib/db.js';
import { hasPrivilege } from '../_lib/buycart.js';
import { readBoxDefaults } from '../_lib/shein-publish.js';
import { TICKS, TICKS_KEY, SHEIN_CONTROLLED, GOLIVE_TABLES, evaluateCutover, evaluateGolive, validTickDate } from '../../src/lib/sheinCutover.js';
import { estDate } from '../../src/lib/format.js';

const HOOKS_KEY = 'shein_listing_hooks';
const COLUMNS = ['first_seen_at', 'settled_at', 'size_statuses', 'title_override'];
const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
export async function readTicks() { const t = parse(await getSetting(TICKS_KEY)); return t && typeof t === 'object' ? t : {}; }

export async function cutoverState(now = new Date()) {
  const ticks = await readTicks();
  const since = ticks.paused_4seller?.at || null;
  const [facts, gl, hooks, probe, box] = await Promise.all([
    listingCutoverFacts({ since, sheinControlled: SHEIN_CONTROLLED }),
    listingGoliveFacts(GOLIVE_TABLES, COLUMNS),
    getSetting(HOOKS_KEY).catch(() => null), getListingCache('probe', 'last').catch(() => null), readBoxDefaults().catch(() => null),
  ]);
  const cutover = evaluateCutover({ ticks, facts, now });
  const golive = evaluateGolive({ ticks, cutover, facts: { ...gl, hooks: parse(hooks),
    probe: probe ? { at: probe.payload?.askedAt || probe.fetched_at, by: probe.payload?.by || null } : null,
    box: box ? { confirmed: !!box.confirmed, by: box.by, at: box.at } : null } });
  return { ticks, cutover, golive };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  const isAdmin = user.role === 'admin' || user.role === 'superadmin';
  const canWrite = isAdmin || await hasPrivilege(user, 'connect_integrations');   // fresh from the DB every call
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const now = new Date();
  if (req.method === 'GET') return send(res, 200, { ok: true, canWrite, now: now.toISOString(), ...await cutoverState(now) });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!canWrite) return send(res, 403, { ok: false, error: 'Ticking the checklist needs an admin, or the “Connect integrations” privilege.' });
  const b = await getJsonBody(req);
  const by = user.name || user.username || '';
  const ticks = await readTicks();
  const action = String(b?.action || '');
  if (action === 'restart') {
    if (!ticks.paused_4seller) return send(res, 400, { ok: false, error: 'Tick “4seller paused” first — the 30 days start from it.' });
    ticks.paused_4seller = { ...ticks.paused_4seller, at: now.toISOString(), restartedBy: by, restarts: (ticks.paused_4seller.restarts || 0) + 1 };
  } else {
    const key = String(b?.key || '');
    const def = TICKS[key];
    if (!def) return send(res, 400, { ok: false, error: 'Unknown checklist line.' });
    if (action === 'untick') delete ticks[key];
    else if (action === 'tick') {
      const row = { by, at: now.toISOString() };
      if (def.date) {
        const date = String(b.date || estDate(now)).slice(0, 10);
        const bad = validTickDate(date, now);
        if (bad) return send(res, 400, { ok: false, error: bad });
        row.date = date;
      }
      if (def.note) { const note = String(b.note || '').trim().slice(0, 200); if (note) row.note = note; }
      if (key === 'last_action_4seller' && !ticks.paused_4seller) return send(res, 400, { ok: false, error: 'Tick “4seller paused” first.' });
      ticks[key] = row;
    } else return send(res, 400, { ok: false, error: 'Unknown action.' });
    if (key === 'paused_4seller' && action === 'untick') delete ticks.last_action_4seller;   // the quiet check belongs to that pause
  }
  await setSetting(TICKS_KEY, JSON.stringify(ticks), by);
  return send(res, 200, { ok: true, canWrite, now: now.toISOString(), ...await cutoverState(now) });
}
