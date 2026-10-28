// GET  /api/shein/links -> { ok, links }   every SHEIN size a person has matched (or decided to delist)
// POST /api/shein/links { links:[{ sheinSku, spu, skc, sheinSize, sellerSkuWas, linkSku|null, decision, source }] } (≤ 300)
// POST /api/shein/links { clear:[sheinSku…] }   forget decisions
// PH + admin. Shared by the whole team, so a match made once is never made twice.
// docs/context/shein-fix.md → "Match screen".
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listSheinLinks, saveSheinLinks, clearSheinLinks, latestListingJob } from '../_lib/db.js';
import { recomputeStored } from '../_lib/shein-listing.js';

// SHEIN Listings reads these decisions (a relink / a size taken off): recount it at once, not at the
// next Re-read. DB only — no SHEIN call.
async function recount() {
  if (!(await latestListingJob('snapshot', 'done').catch(() => null))) return false;
  try { await recomputeStored(); return true; } catch (e) { console.error('[shein-links] recompute', e.message); return false; }
}

const t = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (req.method === 'GET') return send(res, 200, { ok: true, links: await listSheinLinks() });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const b = await getJsonBody(req);
  const by = user.name || user.username || '';
  if (Array.isArray(b.clear)) {
    const ids = b.clear.map((x) => t(x, 60)).filter(Boolean).slice(0, 300);
    await clearSheinLinks(ids);
    return send(res, 200, { ok: true, cleared: ids.length, recomputed: await recount() });
  }
  const links = (Array.isArray(b.links) ? b.links : []).slice(0, 300).map((l) => ({
    shein_sku: t(l.sheinSku, 60), spu: t(l.spu, 60), skc: t(l.skc, 80), shein_size: t(l.sheinSize, 40),
    seller_sku_was: t(l.sellerSkuWas, 60), link_sku: t(l.linkSku, 60),
    decision: l.decision === 'delist' ? 'delist' : 'link', source: ['person', 'rule', 'ai', 'swap'].includes(l.source) ? l.source : 'person',
  })).filter((l) => l.shein_sku && (l.decision === 'delist' || l.link_sku));
  if (!links.length) return send(res, 400, { ok: false, error: 'Nothing to save.' });
  await saveSheinLinks(links, by);
  return send(res, 200, { ok: true, saved: links.length, recomputed: await recount() });
}
