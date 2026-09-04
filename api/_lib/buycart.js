// The gift-card buying process's two hard rules, in one place so no endpoint can be
// the one that forgets: WHO may act at each step, and WHEN a request is finished.
//
// docs/context/buy-cart.md has the whole flow. What lives here is only the part that
// has to be identical everywhere — the screen renders these same ten conditions, and
// `cart/close` re-evaluates them server-side, so a person is never told they can close
// something the server will refuse.
import { send, requireAuth, isPrivileged, blockIfMustChange } from './util.js';
import { getPoReconciliation } from './db.js';

// ---------------------------------------------------------------------------
// Roles — separation of duties
//
// The written process names four jobs and is explicit that the point is independence:
// there must never be a path where one person requests money, spends it, and nobody
// else checks. Two of those jobs are roles the server enforces.
//
//   supplier   the BUYER — asks, then goes to the shop. (The process calls the card
//              releasers "gift card suppliers"; that is a DIFFERENT person. Nothing
//              user-facing here says "supplier" — it says Buyer and Gift card issuer.)
//   admin      the APPROVER — decides what company funds may be spent on.
//   gc_issuer  releases the cards against an approved request.
//   auditor    verifies afterwards that the money and the goods agree.
//
// Approval is open to warehouse + PH + admin as well: those are the people who know
// whether a pair is worth buying, and making a buyer wait on one named account is how
// a process gets worked around at 11pm.
export const CAN_APPROVE = ['warehouse', 'ph_team'];        // + admin/superadmin, auto
export const CAN_ISSUE_CARDS = ['ph_team', 'gc_issuer'];    // + admin/superadmin, auto

/**
 * A stable identity for any actor, DB-backed or not.
 *
 * A real account is its row id; the env admin/superadmin accounts have no row, so they
 * are `env:admin` / `env:superadmin` off the token's username. One string, comparable
 * across both, which is what the separation-of-duties check needs.
 */
export function actorKey(user) {
  const uid = Number(user?.uid);
  if (Number.isInteger(uid) && uid > 0) return String(uid);
  const u = String(user?.username || '').trim().toLowerCase();
  return u ? `env:${u}` : null;
}

/**
 * The audit sign-off cannot use `requireRole`.
 *
 * `requireRole` auto-admits anything privileged, which is correct almost everywhere and
 * exactly wrong here: it would let the admin who approved a request also sign off the
 * audit of that request, which is the single control the process says matters most.
 * So this guard admits `auditor` and admin/superadmin, and THEN refuses when the
 * account is the one that approved — the same shape as `requireSuperadmin`, which
 * likewise had to step outside the helper to exclude admin.
 *
 * The comparison runs on `actorKey`, never on the display name: two people can share a
 * name, and a name can be edited after the fact. It is not the raw user id either —
 * the env admin/superadmin accounts have no `users` row, so their id is NULL and an
 * id comparison quietly passed for exactly the accounts that most need checking.
 */
export function requireAuditor(req, res, cart) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (blockIfMustChange(user, res)) return null;
  if (user.role !== 'auditor' && !isPrivileged(user.role)) {
    send(res, 403, { ok: false, error: 'Only an auditor can sign off the financial audit.' });
    return null;
  }
  // A buyer could never hold this role, so the "someone other than the buyer" rule is
  // already structural. This is the one the roles alone don't cover.
  if (cart && cart.approved_by_key && cart.approved_by_key === actorKey(user)) {
    send(res, 403, {
      ok: false,
      error: 'You approved this request, so you can’t also audit it. It needs a second pair of eyes.',
    });
    return null;
  }
  return user;
}

// A buyer only ever reaches their own request. Staff reach all of them. Scoped on the
// id off the token — a posted buyer id would let one buyer read another's spending.
export function cartVisibleTo(user, cart) {
  if (!cart) return false;
  if (isPrivileged(user.role)) return true;
  if (user.role === 'supplier') return Number(cart.buyer_user_id) === Number(user.uid);
  return true; // staff: warehouse, ph_team, gc_issuer, auditor
}

// ---------------------------------------------------------------------------
// Money
//
// The funding target is the SHELF price of every approved pair — the sticker, with no
// discount assumed. It over-funds on purpose: a gift card that comes up short at the
// till strands a buyer in a shop, while a leftover balance is simply money still ours,
// and step 10 makes us account for it either way.
export const fundingTarget = (cart) => Number(cart?.approved_amount) || 0;

/**
 * The one case where the sticker is NOT enough: tax is charged on top of it, and the
 * discounts that normally swallow that come off the same base. With a small discount
 * and a high tax rate the till asks for more than the shelf price.
 *
 *   $150 shelf, 0% off, 8.25% tax  → till wants $162.38, funded $150.00 → $12.38 short
 *   $150 shelf, 30% off, 8.25% tax → till wants $113.66, funded $150.00 → fine
 *
 * Returns the amount the till could actually ask for when that is MORE than the
 * sticker, else null. The screen shows it as a warning beside the target rather than
 * silently changing the number somebody approved.
 */
export function tillOverrunWarning(cart) {
  const s = cart?.cost_stack || {};
  const f = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  // The gift-card discount is deliberately absent: that is what WE save buying the
  // card, not a discount the register gives. The coupon is absent too — it is a flat
  // amount off one transaction, and spreading it over a whole request would understate
  // every line (the same reason batch analysis refuses to apply it).
  const factor = (1 - f(s.storePct) / 100) * (1 - f(s.promoPct) / 100) * (1 + f(s.taxPct) / 100);
  if (!(factor > 1)) return null;
  const target = fundingTarget(cart);
  if (target <= 0) return null;
  return { factor, amount: Math.round(target * factor * 100) / 100 };
}

const money = (v) => (v == null ? null : Number(v));
const near = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) <= tol;

/**
 * The ten conditions, evaluated against the data rather than against a checklist
 * someone ticks. A transaction is not complete because the cards were spent; it is
 * complete when every one of these is true.
 *
 * 6–9 are answered by the PURCHASE ORDER, because that half of the process already
 * exists and already knows whether the boxes arrived. Re-deriving "did it turn up"
 * here would give the company two answers to one question.
 *
 * Returns `[{ key, label, ok, detail }]` — `detail` names what is still missing, since
 * a gate that only says "no" teaches people to route around it.
 */
export async function cartCloseChecks(full) {
  const c = full;
  const cards = (c.giftCards || []).filter((g) => !g.voided_at);
  const target = fundingTarget(c);
  const receiptTotal = money(c.receipt_total);

  let recon = null;
  if (c.po_id) { try { recon = await getPoReconciliation(c.po_id); } catch { recon = null; } }
  const poStatus = recon?.po?.status || c.po?.status || null;
  const summary = recon?.summary || null;

  const spentSum = cards.reduce((n, g) => n + (Number(g.spent_amount) || 0), 0);
  const everyCardAudited = cards.length > 0 && cards.every((g) => g.spent_amount != null && g.remaining != null);

  const checks = [
    {
      key: 'approved', label: 'Purchase was approved',
      ok: Boolean(c.approved_at) && Number(c.approved_count) > 0,
      detail: c.approved_at ? null : 'No line has been approved yet.',
    },
    {
      key: 'cards_recorded', label: 'Gift cards were issued and recorded',
      ok: cards.length > 0 && target > 0 && Number(c.gc_total) >= target,
      detail: cards.length === 0
        ? 'No gift cards recorded.'
        : Number(c.gc_total) < target
          ? `Cards total $${Number(c.gc_total).toFixed(2)} against $${target.toFixed(2)} approved — $${(target - Number(c.gc_total)).toFixed(2)} short.`
          : null,
    },
    {
      key: 'receipt', label: 'Receipt was received',
      ok: (c.files || []).some((f) => f.kind === 'receipt'),
      detail: 'No receipt has been uploaded.',
    },
    {
      key: 'parsed', label: 'Receipt was parsed',
      ok: (c.receiptLines || []).length > 0 && receiptTotal != null,
      detail: 'The receipt has not been read into lines yet.',
    },
    {
      key: 'spend_reconciled', label: 'Gift card spending was reconciled',
      // Each card's own spend recorded AND the total agreeing with the receipt. Either
      // half alone lets a gap hide: matching totals with blank cards says nothing about
      // WHICH card the money left, and per-card figures that don't sum to the receipt
      // mean something was bought that this receipt doesn't cover.
      ok: everyCardAudited && receiptTotal != null && near(spentSum, receiptTotal),
      detail: !everyCardAudited
        ? 'Not every card has its spend and remaining balance recorded.'
        : receiptTotal == null
          ? 'No receipt total to reconcile against.'
          : !near(spentSum, receiptTotal)
            ? `Cards account for $${spentSum.toFixed(2)} but the receipt says $${receiptTotal.toFixed(2)} — a $${Math.abs(spentSum - receiptTotal).toFixed(2)} gap.`
            : null,
    },
    {
      key: 'expected_recorded', label: 'Purchased inventory was recorded as expected',
      ok: Boolean(c.po_id),
      detail: 'No purchase order has been raised from this receipt.',
    },
    {
      key: 'shipped', label: 'Products were shipped',
      ok: Boolean(poStatus) && ['shipped', 'receiving', 'reconciled', 'closed'].includes(poStatus),
      detail: c.po_id ? 'The order’s boxes have not left the buyer yet.' : 'No purchase order yet.',
    },
    {
      key: 'received', label: 'Products were physically received',
      ok: Boolean(poStatus) && ['receiving', 'reconciled', 'closed'].includes(poStatus),
      detail: c.po_id ? 'Nothing has been scanned in against the order.' : 'No purchase order yet.',
    },
    {
      key: 'matches', label: 'Expected inventory matches received inventory',
      // `no_manifest` is a clean-looking summary with nothing behind it: every unit
      // reads as an overage because nothing was ever declared. That must not pass as a
      // match — it is the absence of the comparison, not the result of one.
      ok: Boolean(summary) && summary.clean && !summary.no_manifest,
      detail: !summary ? 'No reconciliation to read yet.'
        : summary.no_manifest ? 'The order was received blind — nothing was declared to compare against.'
          : `${summary.shortage} short, ${summary.overage} over, ${summary.wrong_size + summary.wrong_sku} mismatched.`,
    },
    {
      key: 'balance', label: 'Any remaining gift card balance is accounted for',
      ok: c.balance_remaining != null && cards.length > 0 && cards.every((g) => g.remaining != null),
      detail: 'The balance left on each card has not been recorded.',
    },
  ];

  return checks.map((k) => ({ ...k, detail: k.ok ? null : k.detail }));
}

export const allChecksPass = (checks) => checks.every((c) => c.ok);
