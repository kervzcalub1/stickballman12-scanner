// POST /api/cancellations/action  { id, action, ... } -> { ok, row }      (PH + admin)
//   verify                       to_review → verified   (refused while a hard flag stands)
//   submitted { platformRef? }   verified  → submitted  (cancelled on the platform)
//   failed    { note }           verified  → to_review, flagged submit_failed, with why
//   reject    { reason }         to_review | verified → rejected (not a real cancellation,
//                                a duplicate photo, the order shipped after all …)
//   reopen                       verified | rejected → to_review
// Every move is a compare-and-set on the status, so two reviewers can't both act on one row.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured, getCancellation, setCancellationStatus } from '../_lib/db.js';
import { flagsFor, blockingFlags, FLAGS } from '../../src/lib/cancellations.js';
import { VIEW_ROLES, canReview, actorOf, idOf, text } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, VIEW_ROLES);
  if (!user) return;
  if (!canReview(user)) return send(res, 403, { ok: false, error: 'Only PH and admin review cancellations.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const id = idOf(b.id);
  if (!id) return send(res, 400, { ok: false, error: 'Which cancellation?' });
  const actor = actorOf(user);
  try {
    const cur = await getCancellation(id);
    if (!cur) return send(res, 404, { ok: false, error: 'That cancellation does not exist.' });
    let row = null;
    if (b.action === 'verify') {
      // The hard checks again, on the fields as they stand. The reader's doubts don't
      // block: verifying is the person saying "I compared it with the photo".
      const flags = flagsFor(cur);
      const hard = blockingFlags(flags);
      if (hard.length) return send(res, 409, { ok: false, error: `Fix this first: ${hard.map((f) => FLAGS[f]).join('; ')}.` });
      row = await setCancellationStatus(id, { to: 'verified', from: ['to_review'], actor, flags });
    } else if (b.action === 'submitted') {
      row = await setCancellationStatus(id, { to: 'submitted', from: ['verified'], actor, platformRef: text(b.platformRef, 80),
        detail: text(b.platformRef, 80) ? `platform ref ${text(b.platformRef, 80)}` : null });
    } else if (b.action === 'failed') {
      const note = text(b.note, 300);
      if (!note) return send(res, 400, { ok: false, error: 'Say what went wrong on the platform.' });
      row = await setCancellationStatus(id, { to: 'to_review', from: ['verified'], actor, detail: `cancel failed: ${note}`,
        flags: [...new Set([...flagsFor(cur), 'submit_failed'])] });
    } else if (b.action === 'reject') {
      const reason = text(b.reason, 300);
      if (!reason) return send(res, 400, { ok: false, error: 'Say why it is rejected.' });
      row = await setCancellationStatus(id, { to: 'rejected', from: ['to_review', 'verified'], actor, rejectedReason: reason, detail: reason });
    } else if (b.action === 'reopen') {
      row = await setCancellationStatus(id, { to: 'to_review', from: ['verified', 'rejected'], actor, flags: flagsFor(cur) });
    } else {
      return send(res, 400, { ok: false, error: 'Unknown action.' });
    }
    if (!row) return send(res, 409, { ok: false, error: 'Someone else changed this row first — refresh and look again.' });
    return send(res, 200, { ok: true, row });
  } catch (e) {
    // Reopening a rejected row whose number has since been logged again.
    if (e.code === '23505') return send(res, 409, { ok: false, error: 'That order number is already logged again on another row.' });
    console.error('[cancellations/action]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save that.' });
  }
}
