// The gift-card buying process's two hard rules, in one place so no endpoint can be
// the one that forgets: WHO may act at each step, and WHEN a request is finished.
//
// docs/context/buy-cart.md has the whole flow. What lives here is only the part that
// has to be identical everywhere — the screen renders these same ten conditions, and
// `cart/close` re-evaluates them server-side, so a person is never told they can close
// something the server will refuse.
import { send, requireAuth, isPrivileged, blockIfMustChange } from './util.js';
import { getPoReconciliation, userHasPrivilege } from './db.js';

// ---------------------------------------------------------------------------
// Privileges — separation of duties
//
// The written process names three duties and is explicit that the point is
// independence: there must never be a path where one person requests money, spends
// it, and nobody else checks.
//
// These are PRIVILEGES, not roles, and that distinction is the whole design. They were
// briefly modelled as roles, which forced them to be alternatives to being warehouse or
// PH — but the person who releases cards is a PH team member who also does that, and
// the auditor is an admin who also does that. `users.role` is one column and holds a
// job title; `users.privileges` is a set of permissions on top of it.
//
//   approve_buying    decide what company funds may be spent on
//   issue_gift_cards  record and release cards against an approved request
//   audit_buying      account for the spend and close a transaction out
//
// The BUYER (`supplier`) can hold none of them — db-setup strips any that are set. A
// buyer with `approve_buying` would approve their own request, which is the single
// thing this process exists to prevent.
export const PRIVILEGES = [
  { key: 'approve_buying', label: 'Approve buying requests' },
  { key: 'issue_gift_cards', label: 'Issue gift cards' },
  { key: 'audit_buying', label: 'Audit + close transactions' },
];
export const PRIVILEGE_KEYS = PRIVILEGES.map((p) => p.key);

/**
 * Does this account hold a privilege, RIGHT NOW?
 *
 * Read from the database on every call rather than off the signed token, and that is a
 * deliberate divergence from how the rest of the app authorises. The role rides in the
 * token because a job title does not change mid-shift; a permission over company money
 * does, and revocation that waits for the next sign-in is not revocation — an account
 * you untick this morning would keep spending until it happened to sign out.
 *
 * The cost is one small indexed read on a handful of low-traffic endpoints.
 *
 * admin/superadmin hold all three implicitly and are never looked up.
 */
export async function hasPrivilege(user, priv) {
  if (!user) return false;
  if (isPrivileged(user.role)) return true;
  // A buyer never holds one, whatever a stale row might say.
  if (user.role === 'supplier') return false;
  const uid = Number(user.uid);
  if (!Number.isInteger(uid) || uid <= 0) return false;
  return userHasPrivilege(uid, priv);
}

/**
 * Guard for a privileged action. Returns the user, or null after answering 403.
 *
 * `requireRole` is no use here: it decides on the job title, and every one of these
 * actions is open to more than one job title and closed to most people who hold it.
 */
export async function requirePrivilege(req, res, priv, what) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (blockIfMustChange(user, res)) return null;
  if (!(await hasPrivilege(user, priv))) {
    send(res, 403, {
      ok: false,
      error: what || `You do not have the “${(PRIVILEGES.find((p) => p.key === priv) || {}).label || priv}” privilege.`,
    });
    return null;
  }
  return user;
}

/**
 * The audit sign-off — the one control the process says matters most.
 *
 * Holding `audit_buying` is not enough on its own, and under the privilege model that
 * matters MORE than it did under roles: one person can now legitimately hold both
 * approve and audit, so "a different role" is no longer any guarantee at all. The only
 * thing standing between a person and signing off their own approval is this check.
 *
 * It compares `actorKey`, never the display name (two people can share one, and a name
 * can be edited afterwards) and never the raw user id — the env admin/superadmin have
 * no `users` row, so their id is NULL and an id comparison quietly passed for exactly
 * the accounts that most needed checking.
 */
export async function requireAuditPrivilege(req, res, cart) {
  const user = await requirePrivilege(req, res, 'audit_buying',
    'Only somebody with the audit privilege can sign off a transaction.');
  if (!user) return null;
  if (cart && cart.approved_by_key && cart.approved_by_key === actorKey(user)) {
    send(res, 403, {
      ok: false,
      error: 'You approved this request, so you can’t also audit it. It needs a second pair of eyes.',
    });
    return null;
  }
  return user;
}

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

// A buyer only ever reaches their own request. Staff reach all of them. Scoped on the
// id off the token — a posted buyer id would let one buyer read another's spending.
export function cartVisibleTo(user, cart) {
  if (!cart) return false;
  if (isPrivileged(user.role)) return true;
  if (user.role === 'supplier') return Number(cart.buyer_user_id) === Number(user.uid);
  return true; // any staff account can READ a request; what they may DO is a privilege
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
