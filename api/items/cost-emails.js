// Costs from the stores' emails (docs/context/costs.md → "Fill from emails").
//   GET  /api/items/cost-emails[?id=N][&rows=1]  -> { ok, configured, run }   (the latest run, or one)
//   POST /api/items/cost-emails { action: 'start', supplier?, from?, to?, sku?, order? } -> { ok, id }
//     sku: only that shoe · order: the order number these pairs came from, when someone knows it
//   POST … { action: 'continue', id }   a run cut off by a restart carries on
//   POST … { action: 'stop', id }       stop a running run (nothing was written)
//   POST … { action: 'apply', id }      fill the blank costs the run found -> { ok, filled }
// The run itself is in api/_lib/cost-emails.js. Same people as the Costs page: admin +
// warehouse + PH. A run only READS until 'apply'; apply fills blanks, never overwrites.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, getCostEmailRun, createCostEmailRun, costEmailRunBusy, setCostEmailRunStatus, touchCostEmailRun } from '../_lib/db.js';
import { runCostEmails, applyCostEmailRun, costEmailsConfigured } from '../_lib/cost-emails.js';

const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const idOf = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const by = user.name || user.username || null;

  try {
    if (req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams;
      const run = await getCostEmailRun(idOf(q.get('id')), { rows: q.get('rows') === '1' });
      return send(res, 200, { ok: true, configured: costEmailsConfigured(), run });
    }
    const body = await getJsonBody(req);
    const action = String(body.action || '');

    if (action === 'start') {
      if (!costEmailsConfigured()) return send(res, 503, { ok: false, error: 'The mailbox search is not set up on this server (MAKE_ORDER_EMAILS_URL).' });
      const busy = await costEmailRunBusy();
      if (busy) return send(res, 409, { ok: false, error: 'A run is already reading the emails. Wait for it to finish, or stop it.' });
      const supplier = String(body.supplier ?? '').trim().slice(0, 200) || null;
      const sku = String(body.sku ?? '').trim().toUpperCase().slice(0, 40) || null;
      const order = String(body.order ?? '').trim().toUpperCase().replace(/^#/, '').slice(0, 40) || null;
      if (sku && sku.replace(/[^A-Z0-9]/g, '').length < 5) return send(res, 400, { ok: false, error: 'That SKU is too short to search for.' });
      if (order && !/^[A-Z0-9-]{5,40}$/.test(order)) return send(res, 400, { ok: false, error: 'That does not look like an order number.' });
      const id = await createCostEmailRun({ supplier, from: ymd(body.from), to: ymd(body.to), by, sku, order });
      runCostEmails(id);   // not awaited: it reports through the run's row
      return send(res, 200, { ok: true, id });
    }

    const id = idOf(body.id);
    if (!id) return send(res, 400, { ok: false, error: 'Which run?' });

    if (action === 'continue') {
      if (!costEmailsConfigured()) return send(res, 503, { ok: false, error: 'The mailbox search is not set up on this server (MAKE_ORDER_EMAILS_URL).' });
      const run = await getCostEmailRun(id);
      if (!run) return send(res, 404, { ok: false, error: 'That run no longer exists.' });
      if (run.status !== 'running' || !run.stalled) return send(res, 409, { ok: false, error: 'That run is not waiting to be continued.' });
      await touchCostEmailRun(id);
      runCostEmails(id);
      return send(res, 200, { ok: true, id });
    }
    if (action === 'stop') {
      const ok = await setCostEmailRunStatus(id, 'running', 'stopped');
      return ok ? send(res, 200, { ok: true }) : send(res, 409, { ok: false, error: 'That run is not running.' });
    }
    if (action === 'apply') {
      const r = await applyCostEmailRun(id, by);
      if (r.error) return send(res, r.status || 409, { ok: false, error: r.error });
      return send(res, 200, { ok: true, filled: r.filled });
    }
    return send(res, 400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    // Before db:setup has created the tables: no run yet, not a broken page.
    if (req.method === 'GET' && /cost_email_runs/.test(e.message)) return send(res, 200, { ok: true, configured: costEmailsConfigured(), run: null, needsSetup: true });
    console.error('[items/cost-emails]', e.message);
    return send(res, 500, { ok: false, error: 'Could not work with the email run.' });
  }
}
