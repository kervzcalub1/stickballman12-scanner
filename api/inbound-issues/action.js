// POST /api/inbound-issues/action  { id, action, ... } -> { ok, row, pair? }
//   PH + admin (the owners of the work):
//     claim                                   open → in progress, you own it
//     assign   { toUid }                      hand it to someone (PH / admin)
//     release                                 back to New, nobody owns it
//     waiting  { supplierRef?, note? }        in progress → waiting on the supplier
//     working                                 waiting → in progress
//     ask_warehouse { task }                  a job for the floor (ship it back, shelve it)
//     resolve  { outcome, refundAmount?, disposition (pair: keep|returned), note? }
//     reopen   { why }                        resolved → in progress
//   Anyone who can see it (warehouse too):
//     note     { text, supplierRef? }         on the trail
//     photos   { photos:[url] }               more pictures
//     warehouse_done { note? }                the floor did the job it was asked
// Every move is a compare-and-set, so two people can't both take one case.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import {
  dbConfigured, getInboundIssue, moveInboundIssue, noteInboundIssue, addInboundIssuePhotos,
  setInboundWarehouseTask, doneInboundWarehouseTask, resolveInboundIssue, reopenInboundIssue, inboundIssueAssignees,
} from '../_lib/db.js';
import { alertInboundIssueAssigned, alertInboundWarehouseTask, alertInboundIssueResolved } from '../_lib/alerts.js';
import { OUTCOMES, MONEY_OUTCOMES, DISPOSITIONS } from '../../src/lib/inboundIssues.js';
import { VIEW_ROLES, canWork, actorOf, uidOf, idOf, text } from './_shared.js';

const WORK = ['claim', 'assign', 'release', 'waiting', 'working', 'ask_warehouse', 'resolve', 'reopen'];
const ANYONE = ['note', 'photos', 'warehouse_done'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, VIEW_ROLES);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const id = idOf(b.id);
  if (!id) return send(res, 400, { ok: false, error: 'Which case?' });
  const action = String(b.action || '');
  if (!WORK.includes(action) && !ANYONE.includes(action)) return send(res, 400, { ok: false, error: 'Unknown action.' });
  if (WORK.includes(action) && !canWork(user))
    return send(res, 403, { ok: false, error: 'The PH team owns inbound issues — ask them to take this one.' });
  const actor = actorOf(user);
  const actorUid = uidOf(user);
  const by = { id: actorUid, name: actor };
  try {
    const cur = await getInboundIssue(id);
    if (!cur) return send(res, 404, { ok: false, error: `Case #${id} does not exist.` });
    let row = null;
    let pair = null;
    if (action === 'claim') {
      // The env logins (admin / superadmin) have no users row to own a case with.
      if (actorUid == null) return send(res, 409, { ok: false, error: 'A shared login can’t own a case — sign in as yourself, or hand it to someone.' });
      row = await moveInboundIssue(id, { action, actor, actorUid });
      if (!row) {
        const now = await getInboundIssue(id);
        return send(res, 409, { ok: false, error: now?.owner ? `${now.owner} already took #${id}.` : 'Someone changed this case first — refresh and look again.' });
      }
    } else if (action === 'assign') {
      const to = (await inboundIssueAssignees()).find((p) => p.id === Number(b.toUid));
      if (!to) return send(res, 400, { ok: false, error: 'Pick someone from the PH team.' });
      row = await moveInboundIssue(id, { action, actor, actorUid, toUid: to.id, toName: to.name, detail: `to ${to.name}` });
      if (row && to.id !== actorUid) alertInboundIssueAssigned(row, to.id, by);
    } else if (action === 'release') {
      row = await moveInboundIssue(id, { action, actor, actorUid, detail: text(b.note, 300) });
    } else if (action === 'waiting') {
      row = await moveInboundIssue(id, { action, actor, actorUid, supplierRef: text(b.supplierRef, 120), detail: text(b.note, 500) });
    } else if (action === 'working') {
      row = await moveInboundIssue(id, { action, actor, actorUid, detail: text(b.note, 500) });
    } else if (action === 'ask_warehouse') {
      const task = text(b.task, 500);
      if (!task) return send(res, 400, { ok: false, error: 'Say what the warehouse should do.' });
      row = await setInboundWarehouseTask(id, { actor, task });
      if (row) alertInboundWarehouseTask(row, by);
    } else if (action === 'resolve') {
      const outcome = String(b.outcome || '');
      if (!OUTCOMES.some(([k]) => k === outcome)) return send(res, 400, { ok: false, error: 'Pick what the supplier did.' });
      let refundAmount = null;
      if (b.refundAmount !== '' && b.refundAmount != null) {
        refundAmount = Number(b.refundAmount);
        if (!Number.isFinite(refundAmount) || refundAmount < 0) return send(res, 400, { ok: false, error: 'The amount must be a number, $0 or more.' });
        refundAmount = Math.round(refundAmount * 100) / 100;
      }
      if (MONEY_OUTCOMES.includes(outcome) && refundAmount == null)
        return send(res, 400, { ok: false, error: 'How much came back? Type the amount.' });
      const disposition = cur.scope === 'pair' ? String(b.disposition || '') : null;
      if (cur.scope === 'pair' && cur.item_id && !DISPOSITIONS.some(([k]) => k === disposition))
        return send(res, 400, { ok: false, error: 'Say what happens to the pair — keep it, or it went back to the supplier.' });
      const out = await resolveInboundIssue(id, { actor, actorUid, outcome, refundAmount, disposition: disposition || null, note: text(b.note, 1000) });
      if (out) {
        row = out.row; pair = out.pair;
        alertInboundIssueResolved(row, pair, by);
      }
    } else if (action === 'reopen') {
      const why = text(b.why, 300);
      if (!why) return send(res, 400, { ok: false, error: 'Say why it is reopened.' });
      row = await reopenInboundIssue(id, { actor, actorUid, why });
    } else if (action === 'note') {
      const t = text(b.text, 1000);
      const supplierRef = text(b.supplierRef, 120);
      if (!t && !supplierRef) return send(res, 400, { ok: false, error: 'Write the note first.' });
      row = await noteInboundIssue(id, { actor, text: t, supplierRef });
    } else if (action === 'photos') {
      row = await addInboundIssuePhotos(id, { actor, photos: b.photos });
    } else if (action === 'warehouse_done') {
      row = await doneInboundWarehouseTask(id, { actor, note: text(b.note, 500) });
    }
    if (!row) return send(res, 409, { ok: false, error: 'Someone changed this case first — refresh and look again.' });
    return send(res, 200, { ok: true, row, pair });
  } catch (e) {
    console.error('[inbound-issues/action]', action, e.message);
    return send(res, 500, { ok: false, error: 'Could not save that.' });
  }
}
