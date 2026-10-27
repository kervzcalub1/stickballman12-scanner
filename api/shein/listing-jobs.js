// GET /api/shein/listing-jobs?status=&page=1        -> { ok, jobs, active, page }
// GET /api/shein/listing-jobs?id=<n>&page=1&status= -> { ok, job, items (500 a page), itemCounts, page }
// GET /api/shein/listing-jobs?id=<n>&all=1          -> { ok, job, items, truncated, cap }   the CSV: up to 20,000 items (6 a minute per user)
// Items carry `summary` (one line for a person) and `plan` (sizes / relinks / skipped). The raw
// request (`body`) and SHEIN's answer (`response`) are for admins only.
// SHEIN Listings server jobs (docs/context/shein-listings.md). PH + admin, read-only.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listListingJobs, getListingJob, activeListingJob, listListingJobItems, listingItemCounts, markStaleListingJobs } from '../_lib/db.js';
import { listingJobRunning, userThrottle } from '../_lib/shein-listing.js';
import { summarizePlan } from '../../src/lib/sheinListings.js';

const STATUSES = ['queued', 'running', 'awaiting_confirm', 'done', 'stopped', 'failed', 'interrupted'];
const ITEM_STATUSES = ['pending', 'sending', 'sent', 'in_review', 'done', 'skipped', 'deferred', 'changed', 'failed'];
export const ALL_MAX = 20_000;
const jobOut = (j) => (j ? { ...j, lease_owner: undefined } : null);

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  const isAdmin = user.role === 'admin' || user.role === 'superadmin';
  const itemOut = (i) => ({ ...i, body: isAdmin ? i.body : undefined, response: isAdmin ? i.response : undefined, summary: summarizePlan(i.plan) || i.error || null });
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const qs = new URL(req.url, 'http://x').searchParams;
  await markStaleListingJobs();
  const page = Math.max(1, Number(qs.get('page')) || 1);
  if (qs.get('id')) {
    const id = Number(qs.get('id'));
    if (!Number.isInteger(id) || id < 1) return send(res, 400, { ok: false, error: 'Which job?' });
    const job = await getListingJob(id);
    if (!job) return send(res, 404, { ok: false, error: 'No such job.' });
    const status = ITEM_STATUSES.includes(qs.get('status')) ? qs.get('status') : null;
    if (qs.get('all') === '1') {
      // security M1: the CSV is capped (ALL_MAX rows, `truncated` says so) and has its own tighter per-user budget
      const th = userThrottle(user, 'listing_jobs_all', { windowMs: 60_000, max: 6 });
      if (!th.ok) return send(res, 429, { ok: false, error: `Too many full downloads just now — try again in ${th.retryInSec} s.` });
      const rows = await listListingJobItems(id, { limit: ALL_MAX + 1, status });
      return send(res, 200, { ok: true, job: jobOut(job), items: rows.slice(0, ALL_MAX).map(itemOut), truncated: rows.length > ALL_MAX, cap: ALL_MAX, isAdmin });
    }
    const [items, itemCounts] = await Promise.all([listListingJobItems(id, { limit: 500, offset: (page - 1) * 500, status }), listingItemCounts(id)]);
    return send(res, 200, { ok: true, job: jobOut(job), items: items.map(itemOut), itemCounts, page, inThisProcess: listingJobRunning() === id, isAdmin });
  }
  const status = STATUSES.includes(qs.get('status')) ? qs.get('status') : null;
  const [jobs, active] = await Promise.all([listListingJobs({ limit: 30, offset: (page - 1) * 30, status }), activeListingJob()]);
  return send(res, 200, { ok: true, jobs: jobs.map(jobOut), active: jobOut(active), page });
}
