// GET /api/shein/listing-log?job=&spu=&trace=&writes=1&limit=200 -> { ok, log }
// Every listing-side SHEIN call (shein_api_log): path, SHEIN's code / msg / traceId, ms, who — and,
// for a WRITE, the exact request and answer. ADMIN ONLY (the raw requests). docs/context/shein-listings.md.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listSheinApiLog } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, []);   // [] = admin / superadmin only
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const qs = new URL(req.url, 'http://x').searchParams;
  const job = qs.get('job') ? Number(qs.get('job')) : null;
  if (job != null && (!Number.isInteger(job) || job < 1)) return send(res, 400, { ok: false, error: 'Which job?' });
  const s = (k, n) => { const v = String(qs.get(k) || '').trim().slice(0, n); return v || null; };
  const limit = Math.max(1, Math.min(2000, Number(qs.get('limit')) || 200));
  return send(res, 200, { ok: true, log: await listSheinApiLog({ job, spu: s('spu', 60), trace: s('trace', 80), writesOnly: qs.get('writes') === '1', limit }) });
}
