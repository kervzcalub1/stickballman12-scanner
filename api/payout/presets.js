// GET    /api/payout/presets                      -> { ok, presets:[…] }
// POST   /api/payout/presets  { preset }          -> { ok, preset }   (create/update)
// POST   /api/payout/presets  { deleteId }        -> { ok, deleted }
//
// Supplier presets for the Payout Calculator: the fixed cost stack a given supplier
// buys at — tip fee, shipping (box swap + labour), sales tax, gift-card discount, and
// the rest of the register percentages. Applying one fills the Store cost step in a
// tap instead of four typed numbers on a phone in a shop.
//
// **Shared, not per device.** The rest of the calculator's rates live in
// `prefs.payoutRates` (localStorage) because they're per store trip. A supplier's tip
// fee is different in kind: it's a fact about the supplier, so the buyer on the floor
// and whoever checks the maths later must be reading the same one.
//
// Roles match api/payout/quote.js — warehouse + PH (admin/superadmin auto-allowed) —
// including for writes. Gating edits to admin would mean the person who just agreed a
// new tip fee with a supplier, standing in the store, can't record it; and a preset
// references nothing and saves nothing, so a bad one costs a retype.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listPayoutPresets, savePayoutPreset, deletePayoutPreset } from '../_lib/db.js';

const MAX_NAME = 60;
const MAX_NOTE = 200;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET' && req.method !== 'POST')
    return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']); // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  if (req.method === 'GET') {
    try {
      return send(res, 200, { ok: true, presets: await listPayoutPresets() });
    } catch (e) {
      console.error('[payout/presets]', e.message);
      return send(res, 500, { ok: false, error: 'Could not load supplier presets.' });
    }
  }

  const body = await getJsonBody(req);
  const who = user.name || user.username || null;

  if (body.deleteId != null) {
    try {
      const deleted = await deletePayoutPreset(Number(body.deleteId));
      if (!deleted) return send(res, 404, { ok: false, error: 'That supplier is already gone.' });
      return send(res, 200, { ok: true, deleted });
    } catch (e) {
      console.error('[payout/presets:delete]', e.message);
      return send(res, 500, { ok: false, error: 'Could not delete that supplier.' });
    }
  }

  const p = body.preset || {};
  const name = String(p.name ?? '').trim();
  if (!name) return send(res, 400, { ok: false, error: 'Give the supplier a name.' });
  if (name.length > MAX_NAME) return send(res, 400, { ok: false, error: 'That name is too long.' });

  // Every field is a plain non-negative number. A negative tax or a 300% gift card is a
  // typo, and it would come back as a buy call — reject it here rather than let the
  // arithmetic run on it.
  const nums = ['tipAmt', 'shippingAmt', 'taxPct', 'giftPct', 'storePct', 'promoPct', 'cashbackPct'];
  const clean = { id: p.id ? Number(p.id) : null, name, note: String(p.note ?? '').slice(0, MAX_NOTE) };
  for (const k of nums) {
    const raw = String(p[k] ?? '').trim();
    const v = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(v) || v < 0) return send(res, 400, { ok: false, error: `“${k}” must be a positive number.` });
    if (k.endsWith('Pct') && v > 100) return send(res, 400, { ok: false, error: 'Percentages can’t be over 100.' });
    clean[k] = v;
  }

  try {
    const preset = await savePayoutPreset(clean, who);
    if (!preset) return send(res, 404, { ok: false, error: 'That supplier no longer exists.' });
    return send(res, 200, { ok: true, preset });
  } catch (e) {
    if (e.duplicate) return send(res, 409, { ok: false, error: e.message });
    console.error('[payout/presets:save]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save that supplier.' });
  }
}
