// /api/receipts/sweep — "Check mailboxes" on the Receipts page (docs/context/receipts.md)
//
//   GET                        -> { ok, configured, last: { at, since, by } | null, nearCap: [...], folders: [...] }
//   POST { since?: 'YYYY-MM-DD' } -> { ok, since, at, resumed }  (202-style: Make runs in the background)
//
// The sweep runs ONLY when somebody presses the button — not on a schedule (owner, 2026-10-08:
// the 15-minute schedule re-read two days of mail in 11 folders every run, ~68k credits a day,
// so it was switched off and every receipt after Oct 6 went unfiled).
//
// Each press asks Make (scenario 6534162, a webhook) for the mail that arrived SINCE the last
// press, minus an hour of overlap — receipts are de-duplicated on message_key, so the overlap
// costs nothing and a mail that landed mid-run isn't lost. A date picks an earlier start for a
// catch-up. Make fetches; our server parses and files (api/receipts/ingest-raw.js).
//
// Make fetches at most SWEEP_CAP emails per folder search, OLDEST first. A busy window can stop
// short of the newest mail — and if the next check then started from the last press, that mail
// was never read again (order T09000000CY7BE8, 2026-10-08: zero receipts filed in three runs).
// So ingest-raw counts what each run handed it per folder (receipt_sweep_folders), and a folder
// that came back near the cap makes the next check start from the newest email it reached.
// The pointer only ever looks back further, never skips ahead; dedupe makes re-reading free.
//
// RECEIPT_SWEEP_HOOK_URL = the scenario's webhook. RECEIPT_INGEST_KEY rides along in the call so
// the scenario can post back without the key ever being pasted into Make.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, getSetting, setSetting, sweepFoldersNearCap, sweepRunFolders } from '../_lib/db.js';
import { estToday } from '../../src/lib/format.js';

const KEY = 'receipt_sweep_last';
const OVERLAP_MS = 60 * 60 * 1000;          // re-read the hour before the last check
const FIRST_RUN_MS = 3 * 24 * 60 * 60 * 1000; // never checked: the last 3 days
const MAX_BACK_DAYS = 60;
const COOLDOWN_MS = 90 * 1000;               // a double-tap must not start two runs
// Make's maxResults on each folder search (scenario 6534162, raised 100 → 300 on 2026-10-10).
// A folder counts as "maybe cut off" a little BELOW the cap: a Yahoo search fetches the whole
// day and Make filters out the earlier hours before posting, so we see fewer than it fetched.
const SWEEP_CAP = Number(process.env.RECEIPT_SWEEP_CAP) || 300;
const NEAR_CAP = Math.max(1, Math.floor(SWEEP_CAP * 0.8));

const hookUrl = () => String(process.env.RECEIPT_SWEEP_HOOK_URL || '').trim();
const configured = () => !!(hookUrl() && String(process.env.RECEIPT_INGEST_KEY || '').trim());

async function readLast() {
  try { const v = await getSetting(KEY); return v ? JSON.parse(v) : null; } catch { return null; }
}

// Midnight EST at the start of a YYYY-MM-DD, as a Date — EST or EDT, whichever that day is.
function estMidnight(ymd) {
  for (const off of ['-05:00', '-04:00']) {
    const d = new Date(`${ymd}T00:00:00${off}`);
    const back = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(d);
    if (back === '00') return d;
  }
  return new Date(`${ymd}T05:00:00Z`);
}

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['warehouse', 'ph_team']); // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  if (req.method === 'GET') {
    const last = await readLast();
    const nearCap = await sweepFoldersNearCap(last?.at, NEAR_CAP).catch(() => []);
    // What the last run handed us, per folder, and what became of it — the only place a run
    // that filed nothing can be explained (Make's history says SUCCESS whatever we answered).
    const folders = await sweepRunFolders(last?.at).catch(() => []);
    return send(res, 200, { ok: true, configured: configured(), last, nearCap, folders });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!configured()) return send(res, 503, { ok: false, error: 'Mailbox checks are not set up on this server (RECEIPT_SWEEP_HOOK_URL).' });

  const body = await getJsonBody(req);
  const now = Date.now();
  const last = await readLast();

  let since;
  let resumed = [];
  if (body.since) {
    const ymd = String(body.since);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? estMidnight(ymd) : null;
    if (!d || ymd > estToday()) return send(res, 400, { ok: false, error: 'Pick a day on or before today.' });
    if (now - d.getTime() > MAX_BACK_DAYS * 86_400_000) return send(res, 400, { ok: false, error: `Go back at most ${MAX_BACK_DAYS} days.` });
    since = d;
  } else {
    since = new Date(last?.at ? Date.parse(last.at) - OVERLAP_MS : now - FIRST_RUN_MS);
    // A folder the last run may have cut off: start from the newest email it reached instead.
    resumed = (await sweepFoldersNearCap(last?.at, NEAR_CAP).catch(() => [])).filter((f) => f.newest);
    for (const f of resumed) {
      const from = Date.parse(f.newest) - OVERLAP_MS;
      if (from < since.getTime()) since = new Date(from);
    }
    const floor = now - MAX_BACK_DAYS * 86_400_000;
    if (since.getTime() < floor) since = new Date(floor);
  }
  // After the date is checked: a bad date is the person's to fix whether or not a run is on.
  if (last?.at && now - Date.parse(last.at) < COOLDOWN_MS) {
    return send(res, 409, { ok: false, error: `${last.by || 'Someone'} started a check a moment ago — receipts are still coming in.` });
  }

  const by = user.name || user.username || '';
  const form = new URLSearchParams({
    since_iso: since.toISOString(),
    since_epoch: String(Math.floor(since.getTime() / 1000)),
    key: String(process.env.RECEIPT_INGEST_KEY).trim(),
    by,
  });
  try {
    const r = await fetch(hookUrl(), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 200);
      console.error('[receipts/sweep] Make answered', r.status, text);
      return send(res, 502, { ok: false, error: `Make didn't start the check (${r.status}${text ? `: ${text}` : ''}).` });
    }
  } catch (e) {
    console.error('[receipts/sweep]', e.message);
    return send(res, 502, { ok: false, error: 'Could not reach Make to start the check.' });
  }
  const at = new Date(now).toISOString();
  await setSetting(KEY, JSON.stringify({ at, since: since.toISOString(), by }), by);
  return send(res, 200, { ok: true, at, since: since.toISOString(), resumed: resumed.map((f) => `${f.mailbox} ${f.folder}`) });
}
