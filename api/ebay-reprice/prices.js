// POST /api/ebay-reprice/prices { jobs: [{ sku, size }] }  (≤ 25)
//   -> { ok, results: [{ sku, size, status, valueCents?, rank?, label?, name?, error? }] }
// PH team (admin auto-allowed). The browser drives the run in batches, keeps the cache
// and the progress; this only answers one batch. See api/_lib/ebay-reprice.js for what
// each status means — `error` is the only retryable one.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { priceStyleSize } from '../_lib/ebay-reprice.js';

const MAX_JOBS = 25;
const CONCURRENCY = 4;   // per batch; the browser sends one batch at a time

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 90 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!process.env.ALIAS_API_KEY) return send(res, 500, { ok: false, error: 'Server is missing the Alias API key.' });

  const b = await getJsonBody(req);
  const jobs = (Array.isArray(b.jobs) ? b.jobs : [])
    .map((j) => ({ sku: String(j?.sku ?? '').trim().slice(0, 60), size: String(j?.size ?? '').trim().slice(0, 12) }))
    .filter((j) => j.sku && j.size);
  if (!jobs.length) return send(res, 400, { ok: false, error: 'No style + size pairs to price.' });
  if (jobs.length > MAX_JOBS) return send(res, 400, { ok: false, error: `At most ${MAX_JOBS} per call.` });

  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await priceStyleSize(jobs[i].sku, jobs[i].size);
    }
  }));
  return send(res, 200, { ok: true, results });
}
