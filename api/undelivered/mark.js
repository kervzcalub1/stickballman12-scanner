// POST /api/undelivered/mark  { number, on:'YYYY-MM-DD', note? }  -> { ok }
// POST /api/undelivered/mark  { number, undo:true }                -> { ok }
//
// 17TRACK can sit on "No update yet" for a parcel the courier's own page shows delivered.
// Whoever checked the courier's page marks it delivered here: it reads Delivered on every
// screen, leaves the Undelivered list, and their name + the delivery day are recorded.
// Undo puts every row back the way it was (markTrackingDelivered / unmarkTrackingDelivered).
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured, markTrackingDelivered, unmarkTrackingDelivered } from '../_lib/db.js';
import { stopTracking } from '../_lib/tracking.js';
import { estToday } from '../../src/lib/format.js';
import { actorOf, realDate } from '../online-orders/_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const number = String(b.number || '').trim().slice(0, 64);
  if (!/[A-Za-z0-9]{6,}/.test(number.replace(/[^A-Za-z0-9]/g, '')))
    return send(res, 400, { ok: false, error: 'Which tracking number?' });

  try {
    if (b.undo) {
      const r = await unmarkTrackingDelivered(number);
      if (r.error) return send(res, 409, { ok: false, error: 'That number is not marked delivered by hand.' });
      return send(res, 200, { ok: true });
    }
    const on = realDate(b.on);
    if (!on) return send(res, 400, { ok: false, error: 'Delivered on: pick the day the courier says it was delivered.' });
    if (on > estToday()) return send(res, 400, { ok: false, error: 'Delivered on cannot be in the future.' });
    const note = String(b.note || '').trim().slice(0, 300) || null;
    const r = await markTrackingDelivered(number, { by: actorOf(user), on, note });
    if (r.error === 'already') return send(res, 409, { ok: false, error: 'This number is already marked delivered.' });
    if (r.error) return send(res, 404, { ok: false, error: 'That tracking number is not on any PO or online order.' });
    // A delivered parcel won't change again; stop spending 17TRACK quota on it (best-effort).
    if (r.registered) stopTracking([r.trackingNumber]).catch((e) => console.warn('[undelivered/mark] stoptrack:', e.message));
    return send(res, 200, { ok: true, boxes: r.boxes, online: r.online });
  } catch (e) {
    console.error('[undelivered/mark]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save that.' });
  }
}
