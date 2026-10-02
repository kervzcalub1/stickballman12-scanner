// POST /api/nudge { kind: 'cart' | 'rescale' | 'po', id, to, note? }  -> { ok, sentTo, notConnected }
//
// A NUDGE — "please look at this" — sent to one group of people about one record, as a
// private Telegram message (api/_lib/alerts.js `sendNudge`; the `nudge` alert is required).
// The SERVER picks the people from `to`; the browser never sends user ids, so a nudge can
// only reach the people a record actually waits on.
//
//   cart     to: buyer | approvers | desk | auditors   (anyone who can see the request;
//                                                       only staff may nudge the buyer)
//   rescale  to: warehouse | requester                  (staff)
//   po       to: supplier | warehouse                   (staff)
//
// One nudge per sender, record and target per hour — a nudge that can be repeated every
// second stops meaning anything. It is also written on the record's own trail (the
// buying request's history / the PO thread), so the nudge is visible to everyone after.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, blockIfMustChange, isPrivileged } from './_lib/util.js';
import { dbConfigured, getBuyCart, getPo, getRescaleRequestById, alertCandidates, alertSentRecently,
  logCartEvent, addPoComment } from './_lib/db.js';
import { cartVisibleTo } from './_lib/buycart.js';
import { telegramConfigured } from './_lib/telegram.js';
import { sendNudge, at } from './_lib/alerts.js';

const COOLDOWN_MIN = 60;
const TARGETS = {
  cart: { buyer: 'the buyer', approvers: 'the approvers', desk: 'the gift card desk', auditors: 'the auditors' },
  rescale: { warehouse: 'the warehouse', requester: 'whoever asked' },
  po: { supplier: 'the supplier', warehouse: 'the warehouse' },
};
const PRIV_FOR = { approvers: 'approve_buying', desk: 'issue_gift_cards', auditors: 'audit_buying' };

// Holders of a privilege, EXPLICITLY — admins hold every privilege implicitly, and a
// nudge to "the approvers" that also lands on every admin is noise. Admins are the
// fallback only when nobody holds it.
function holdersOf(people, priv) {
  const explicit = people.filter((u) => Array.isArray(u.privileges) && u.privileges.includes(priv));
  return explicit.length ? explicit : people.filter((u) => u.role === 'admin');
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (blockIfMustChange(user, res)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!telegramConfigured()) return send(res, 503, { ok: false, error: 'Telegram is not set up on this server.' });

  const body = await getJsonBody(req);
  const kind = String(body.kind || '');
  const id = Number(body.id);
  const to = String(body.to || '');
  const note = String(body.note ?? '').trim().slice(0, 300) || null;
  if (!TARGETS[kind] || !TARGETS[kind][to]) return send(res, 400, { ok: false, error: 'Pick who to nudge.' });
  if (!Number.isInteger(id) || id <= 0) return send(res, 400, { ok: false, error: 'A valid record is required.' });
  const staff = user.role !== 'supplier' || isPrivileged(user.role);

  const people = await alertCandidates();
  let recipients = [];
  let code; let about; let path; let trail = null;

  if (kind === 'cart') {
    const cart = await getBuyCart(id);
    if (!cart || !cartVisibleTo(user, cart)) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (to === 'buyer') {
      if (!staff) return send(res, 403, { ok: false, error: 'Only staff can nudge the buyer.' });
      recipients = people.filter((u) => String(u.id) === String(cart.buyer_user_id));
    } else recipients = holdersOf(people, PRIV_FOR[to]);
    code = cart.cart_code;
    about = `buying request ${cart.cart_code}${cart.retailer ? ` (${cart.retailer})` : ''}`;
    path = at('buying', `request=${id}`);
    trail = (text) => logCartEvent({ cartId: id, kind: 'nudge', body: text, actor: user });
  } else if (kind === 'rescale') {
    if (!staff) return send(res, 403, { ok: false, error: 'You do not have access to this.' });
    const r = await getRescaleRequestById(id);
    if (!r) return send(res, 404, { ok: false, error: 'That rescale request does not exist.' });
    recipients = to === 'warehouse'
      ? people.filter((u) => u.role === 'warehouse')
      : people.filter((u) => String(u.id) === String(r.requested_by_id));
    code = r.sku;
    about = `the rescale request for ${r.name ? `${r.name} (${r.sku})` : r.sku}`;
    path = at('rescale');
  } else {
    if (!staff) return send(res, 403, { ok: false, error: 'You do not have access to this.' });
    const po = await getPo(id);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    recipients = to === 'supplier'
      ? people.filter((u) => String(u.id) === String(po.supplier_user_id))
      : people.filter((u) => u.role === 'warehouse');
    code = po.po_code;
    about = `${po.po_code}${to === 'supplier' ? '' : ` from ${po.supplier_name}`}`;
    path = at('po', `po=${id}`);
    trail = (text) => addPoComment({
      poId: id, kind: 'system', body: text,
      author: { id: Number(user.uid) || null, name: user.name || user.username || '', role: user.role },
    });
  }

  recipients = recipients.filter((u) => String(u.id) !== String(user.uid));
  if (!recipients.length) return send(res, 409, { ok: false, error: `There is nobody to nudge as ${TARGETS[kind][to]} on this.` });

  const ref = `${kind}:${id}:${to}:by:${user.username || user.uid}`;
  if (await alertSentRecently('nudge', ref, COOLDOWN_MIN))
    return send(res, 429, { ok: false, error: `You already nudged ${TARGETS[kind][to]} about this in the last hour.` });

  const ids = recipients.map((u) => u.id);
  const { sentTo } = await sendNudge({ toIds: ids, from: user, code, about, note, path, ref });
  const notConnected = recipients.filter((u) => !u.telegram_user_id || u.alerts_muted).map((u) => u.name || u.username);
  if (trail) {
    await trail(`Nudged ${TARGETS[kind][to]} on Telegram${sentTo.length ? ` (${sentTo.join(', ')})` : ' — nobody connected'}${note ? `: “${note}”` : ''}`)
      .catch((e) => console.warn('[nudge] trail:', e.message));
  }
  return send(res, 200, { ok: true, sentTo, notConnected });
}
