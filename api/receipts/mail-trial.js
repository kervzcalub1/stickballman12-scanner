// /api/receipts/mail-trial   (admin only)
//   GET                       -> { ok, configured, config?, state, folders, outcomes, compare, missed }
//   POST { action: 'run' }    -> { ok, started }      read the trial mailbox now, in the background
//   POST { action: 'reset' }  -> { ok }               forget positions + rows: the next run starts over
//
// Phase 1 of reading the mailboxes ourselves, without Make (docs/context/receipts.md → "Reading
// the mailboxes ourselves"). api/_lib/mail-fetch.js reads ONE mailbox over IMAP, read-only, and
// records what it would have filed; this shows that next to what Make filed for the same emails.
// Nothing here files a receipt. The mailbox and its app password are environment variables on
// the server — they are not accepted from, or shown to, the caller.
import { getJsonBody, send, applySecurity, rateLimit, requireAdmin } from '../_lib/util.js';
import { dbConfigured, mailTrialReport, resetMailTrial } from '../_lib/db.js';
import { mailTrialConfig, mailTrialState, startMailTrial, compareTrialPair } from '../_lib/mail-fetch.js';

const MAX_LISTED = 100;   // of each kind of finding; the counts are always the whole picture

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireAdmin(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const cfg = mailTrialConfig();

  if (req.method === 'GET') {
    if (!cfg) return send(res, 200, { ok: true, configured: false, state: mailTrialState() });
    try {
      const report = await mailTrialReport(cfg.mailbox);
      const counts = { match: 0, differs: 0, only_ours: 0, only_make: 0 };
      const listed = { differs: [], only_ours: [], only_make: [] };
      for (const p of report.pairs) {
        const { verdict, diffs } = compareTrialPair(p);
        counts[verdict] += 1;
        if (listed[verdict] && listed[verdict].length < MAX_LISTED) {
          listed[verdict].push({
            folder: p.folder, uid: Number(p.uid), received_at: p.received_at, subject: p.subject,
            receipt_id: p.receipt_id ? Number(p.receipt_id) : null,
            store: p.parsed?.store || p.store || null, order_number: p.parsed?.order_number || p.order_number || null, diffs,
          });
        }
      }
      return send(res, 200, {
        ok: true, configured: true,
        config: { provider: cfg.provider, host: cfg.host, mailbox: cfg.mailbox, folders: cfg.folders, days: cfg.days },
        state: mailTrialState(),
        folders: report.folders, outcomes: report.outcomes,
        compare: { counts, ...listed }, missed: report.missed,
      });
    } catch (e) {
      console.error('[receipts/mail-trial]', e.message);
      // The tables are not there until db:setup has run on this server.
      return send(res, 500, { ok: false, error: /does not exist/.test(e.message) ? 'The trial tables are missing: run db:setup on this server.' : 'Could not read the trial.' });
    }
  }

  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const body = await getJsonBody(req);
  if (body.action === 'run') {
    const r = startMailTrial(user.name || user.username || '');
    if (!r.started) return send(res, cfg ? 409 : 503, { ok: false, error: r.why });
    return send(res, 200, { ok: true, started: true });
  }
  if (body.action === 'reset') {
    if (!cfg) return send(res, 503, { ok: false, error: 'The trial mailbox is not set up on this server.' });
    if (mailTrialState().running) return send(res, 409, { ok: false, error: 'A run is reading right now. Reset when it has finished.' });
    await resetMailTrial(cfg.mailbox);
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { ok: false, error: 'action must be "run" or "reset".' });
}
