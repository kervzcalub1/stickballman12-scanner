// GET  /api/purchase-emails            -> { ok, emails }                 (mine)
// GET  /api/purchase-emails?all=1      -> { ok, emails, people }         (admin: everyone's, + who can own one)
// POST /api/purchase-emails { action:'add', email, userId? } | { action:'remove', id }
//
// The addresses a buyer orders with (docs/context/receipts.md). A store receipt sent to
// one of them is filed as that person's purchase. Anyone signed in manages their OWN —
// suppliers included, which is the point: we can't see which address a supplier buys
// under unless they tell us. An admin manages anyone's (userId).
// One address belongs to one person; registering one picks up the receipts that already
// arrived to it and that nobody had assigned.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, blockIfMustChange, isPrivileged } from './_lib/util.js';
import { dbConfigured, listPurchaseEmails, addPurchaseEmail, removePurchaseEmail, listApprovedPeople } from './_lib/db.js';

const EMAIL_RE = /^[^\s@]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/;
const ownId = (u) => (Number.isSafeInteger(Number(u?.uid)) && Number(u.uid) > 0 ? Number(u.uid) : null);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (blockIfMustChange(user, res)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const admin = isPrivileged(user.role);
  const me = ownId(user);

  try {
    if (req.method === 'GET') {
      const all = new URL(req.url, 'http://x').searchParams.get('all') === '1';
      if (all && admin) {
        const people = await listApprovedPeople();
        return send(res, 200, { ok: true, emails: await listPurchaseEmails(), people });
      }
      if (!me) return send(res, 200, { ok: true, emails: [], shared: true });
      return send(res, 200, { ok: true, emails: await listPurchaseEmails(me) });
    }

    const b = await getJsonBody(req);
    if (b.action === 'remove') {
      const id = Number(b.id);
      if (!Number.isSafeInteger(id) || id <= 0) return send(res, 400, { ok: false, error: 'Which address?' });
      const gone = await removePurchaseEmail(id, admin ? null : me);
      if (!gone) return send(res, 404, { ok: false, error: 'That address isn’t on your account.' });
      return send(res, 200, { ok: true });
    }
    if (b.action !== 'add') return send(res, 400, { ok: false, error: 'Unknown action.' });
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return send(res, 400, { ok: false, error: 'That doesn’t look like an email address.' });
    const target = admin && b.userId != null ? Number(b.userId) : me;
    if (!target || !Number.isSafeInteger(target)) return send(res, 400, { ok: false, error: 'This login is shared — add the address on a person’s own account.' });
    const out = await addPurchaseEmail(target, email, user.name || user.username || null);
    if (out.conflict) {
      if (out.sameUser) return send(res, 409, { ok: false, error: 'That address is already on this account.' });
      // Who holds it is told to an admin only; a supplier just learns it's taken.
      return send(res, 409, { ok: false, error: admin && out.owner ? `That address is already registered to ${out.owner}.` : 'That address is already registered to another account. Ask an admin if it should be yours.' });
    }
    return send(res, 200, { ok: true, id: out.id, claimed: out.claimed });
  } catch (e) {
    if (/foreign key/i.test(e.message)) return send(res, 400, { ok: false, error: 'That account no longer exists.' });
    console.error('[purchase-emails]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save.' });
  }
}
