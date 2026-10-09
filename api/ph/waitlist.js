// /api/ph/waitlist — hold pairs out of listing until the market corrects (docs/context/waitlist.md)
//
//   GET                       -> { ok, rows }      everything on hold, one row per SKU + size
//   GET ?format=xlsx          -> .xlsx             the same, as the daily report file
//   GET ?from=&to=            -> pairs WAITLISTED in that EST date range (held or since back)
//   POST { action:'hold', vins, days, note? }  -> { ok, held, skipped, until }
//   POST { action:'release', vins }            -> { ok, released }
//
// Reading is PH + admin (the review is Alex's). Holding and releasing is PH's — the same
// people who list, because a hold is a listing decision.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, setWaitlist, releaseWaitlist, listWaitlist } from '../_lib/db.js';
import { waitlistUntil, waitlistXlsx, waitlistFileName, WAITLIST_DEFAULT_DAYS } from '../../src/lib/waitlist.js';
import { XLSX_MIME } from '../../src/lib/xlsx.js';
import { estToday } from '../../src/lib/format.js';

const MAX_VINS = 2000;
const cleanVins = (v) => (Array.isArray(v) ? v : []).map((x) => String(x || '').trim().toUpperCase()).filter(Boolean).slice(0, MAX_VINS);

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']); // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  if (req.method === 'GET') {
    try {
      const qs = new URL(req.url, 'http://x').searchParams;
      const day = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(qs.get(k) || '') ? qs.get(k) : null);
      const range = { from: day('from'), to: day('to') };
      const rows = await listWaitlist(range);
      if (qs.get('format') === 'xlsx') {
        res.statusCode = 200;
        res.setHeader('Content-Type', XLSX_MIME);
        res.setHeader('Content-Disposition', `attachment; filename="${waitlistFileName(estToday(), range)}"`);
        return res.end(Buffer.from(waitlistXlsx(rows)));
      }
      return send(res, 200, { ok: true, rows });
    } catch (e) {
      console.error('[ph/waitlist] list', e.message);
      return send(res, 500, { ok: false, error: 'Could not load the waitlist.' });
    }
  }

  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Admin reads the waitlist; listing decisions are PH's (superadmin can do both).
  if (user.role !== 'ph_team' && user.role !== 'superadmin')
    return send(res, 403, { ok: false, error: 'Only PH Team can change the waitlist.' });

  const body = await getJsonBody(req);
  const vins = cleanVins(body.vins);
  if (!vins.length) return send(res, 400, { ok: false, error: 'No pairs specified.' });
  const by = user.name || user.username || '';

  try {
    if (body.action === 'hold') {
      const days = Number(body.days) || WAITLIST_DEFAULT_DAYS;
      if (!(days >= 1 && days <= 365)) return send(res, 400, { ok: false, error: 'Hold for 1 to 365 days.' });
      const note = String(body.note || '').trim().slice(0, 500) || null;
      const until = waitlistUntil(days);
      const r = await setWaitlist({ vins, until, note, by });
      if (!r.held.length) {
        return send(res, 409, { ok: false, error: 'None of these pairs can go on the waitlist — they are already listed, sold, or not on New Inventory.' });
      }
      return send(res, 200, { ok: true, held: r.held.length, skipped: r.skipped, until });
    }
    if (body.action === 'release') {
      const rows = await releaseWaitlist({ vins, by });
      return send(res, 200, { ok: true, released: rows.length });
    }
    return send(res, 400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    console.error('[ph/waitlist]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the waitlist.' });
  }
}
