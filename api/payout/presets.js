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
//
// **A SUPPLIER may READ, and only their own** (2026-08-26). A supplier account signing
// in gets the Payout Calculator, and the preset it fills from must be theirs alone —
// Andrew sees Andrew. Two rules hold that line:
//   · The scope keys on `supplier_user_id`, never on the preset's name. Names drift;
//     the failure mode of a name match is one supplier reading another's cost stack.
//   · **Writes stay staff-only.** A supplier's cost stack is an input to OUR buy calls,
//     so letting the supplier raise their own tip fee would let them move the verdict.
//     They get a read-only chip; changing it is a conversation with the floor.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listPayoutPresets, savePayoutPreset, deletePayoutPreset, listSupplierUsers } from '../_lib/db.js';

const MAX_NAME = 60;
const MAX_NOTE = 200;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET' && req.method !== 'POST')
    return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team', 'supplier']); // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  // A supplier reads their own row and nothing else. `isPrivileged` is deliberately NOT
  // consulted here: role 'supplier' is never privileged, and an admin account is not
  // scoped to a supplier id.
  const isSupplier = user.role === 'supplier';
  // Fail CLOSED on a uid that isn't a real row id. A NaN would reach the query as
  // `supplier_user_id = NaN` — an error at best, and the wrong kind of surprise on an
  // endpoint whose whole job here is "yours and nobody else's".
  const uid = Number(user.uid);
  const supplierScope = isSupplier ? (Number.isInteger(uid) && uid > 0 ? uid : -1) : null;

  if (req.method === 'GET') {
    try {
      const presets = await listPayoutPresets(
        supplierScope != null ? { supplierUserId: supplierScope } : {},
      );
      return send(res, 200, { ok: true, presets });
    } catch (e) {
      console.error('[payout/presets]', e.message);
      return send(res, 500, { ok: false, error: 'Could not load supplier presets.' });
    }
  }

  // Every write below is staff-only — see the note at the top of the file.
  if (isSupplier)
    return send(res, 403, { ok: false, error: 'Ask the Stickballman12 team to change your cost stack.' });

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

  // The linked supplier ACCOUNT decides who can read this stack, so it's checked
  // against the real list rather than trusted: an id that isn't an approved supplier
  // would either fail the FK or, worse, quietly attach the stack to a staff account.
  let supplierUserId = null;
  if (p.supplierUserId != null && String(p.supplierUserId).trim() !== '') {
    supplierUserId = Number(p.supplierUserId);
    if (!Number.isInteger(supplierUserId) || supplierUserId <= 0)
      return send(res, 400, { ok: false, error: 'That supplier account is not valid.' });
    const known = await listSupplierUsers();
    if (!known.some((u) => Number(u.id) === supplierUserId))
      return send(res, 400, { ok: false, error: 'That supplier account is not valid.' });
  }

  // Every field is a plain non-negative number. A negative tax or a 300% gift card is a
  // typo, and it would come back as a buy call — reject it here rather than let the
  // arithmetic run on it.
  const nums = ['tipAmt', 'shippingAmt', 'taxPct', 'giftPct', 'storePct', 'promoPct', 'cashbackPct'];
  const clean = { id: p.id ? Number(p.id) : null, name, note: String(p.note ?? '').slice(0, MAX_NOTE), supplierUserId };
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
