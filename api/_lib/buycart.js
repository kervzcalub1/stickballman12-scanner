// The gift-card buying process's two hard rules, in one place so no endpoint can be
// the one that forgets: WHO may act at each step, and WHEN a request is finished.
//
// docs/context/buy-cart.md has the whole flow. What lives here is only the part that
// has to be identical everywhere — the screen renders these same ten conditions, and
// `cart/close` re-evaluates them server-side, so a person is never told they can close
// something the server will refuse.
import { send, requireAuth, isPrivileged, blockIfMustChange } from './util.js';
import { getPoReconciliation, userHasPrivilege, decideBuyCartLines, linesAwaitingQty } from './db.js';
import { calcCostBreakdown, calcPayout, dealVerdict, DEFAULT_FEE_PCT } from '../../src/lib/payout.js';
import { decisionsOpen, decisionsClosedBecause } from '../../src/lib/buycartRules.js';

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
// The BUYER (`supplier`) can hold none of those three — db-setup strips any that are
// set. A buyer with `approve_buying` would approve their own request, which is the
// single thing this process exists to prevent.
//
//   request_buying    the BUYER'S side: raise a request and be funded for it
//
// This one is the opposite way round: it is the only privilege a supplier CAN hold,
// and the only way a supplier reaches the process at all. Not every supplier buys for
// the company — most only ship us boxes — so the buying screens are switched on per
// account rather than handed to the whole role. Without it a supplier's portal simply
// has no Buying Requests card, and every `api/cart/*` call answers 403.
export const PRIVILEGES = [
  { key: 'approve_buying', label: 'Approve buying requests' },
  { key: 'issue_gift_cards', label: 'Issue gift cards' },
  { key: 'audit_buying', label: 'Audit + close transactions' },
  { key: 'request_buying', label: 'Raise buying requests' },
];
export const PRIVILEGE_KEYS = PRIVILEGES.map((p) => p.key);
// What a supplier may hold — everything else is stripped (setUserPrivileges, db:setup).
export const BUYER_PRIVILEGE_KEYS = ['request_buying'];

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
  // A buyer never holds a staff duty, whatever a stale row might say — only its own.
  if (user.role === 'supplier' && !BUYER_PRIVILEGE_KEYS.includes(priv)) return false;
  const uid = Number(user.uid);
  if (!Number.isInteger(uid) || uid <= 0) return false;
  return userHasPrivilege(uid, priv);
}

/**
 * The buyer's gate. Every `api/cart/*` endpoint a supplier can reach calls this right
 * after its role check: a supplier without `request_buying` is refused, read fresh from
 * the database like every other privilege, so switching a buyer off takes effect on
 * their next call rather than their next sign-in. Staff and admin pass straight through —
 * their gates are the three duties above, per action.
 *
 * Returns true, or false after answering 403.
 */
export async function requireBuyerAccess(req, res, user) {
  if (!user) return false;
  if (user.role !== 'supplier' || isPrivileged(user.role)) return true;
  if (await hasPrivilege(user, 'request_buying')) return true;
  send(res, 403, { ok: false, error: 'Buying requests aren’t switched on for your account. Ask an admin to enable “Raise buying requests”.' });
  return false;
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

// ---------------------------------------------------------------------------
// The cost stack, and who is allowed to write it
//
// A request's stack is snapshotted from the BUYER'S payout preset when it is opened.
// Buyers do not manage their own presets — an admin does — so a buyer who has never had
// one produces a request where every pair "lands at" exactly its shelf price, no payout
// clears any threshold, and no buy call can be made at all. That is not a rare edge: it
// is what every new buyer looks like on their first request.
//
// So the desk that is being asked to release money can write the stack itself. It is
// deliberately NOT the buyer's to edit after the fact — the buyer states what the
// sticker says, and the company states what the sticker actually costs it.
export const COST_FIELDS = [
  { key: 'storePct', label: 'Store discount', unit: '%' },
  { key: 'promoPct', label: 'Promo / birthday', unit: '%' },
  { key: 'giftPct', label: 'Gift card', unit: '%' },
  { key: 'cashbackPct', label: 'Cashback', unit: '%' },
  { key: 'taxPct', label: 'Sales tax', unit: '%' },
  { key: 'tipAmt', label: 'Tip', unit: '$' },
  { key: 'shippingAmt', label: 'Shipping', unit: '$' },
];

const rate = (v) => {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
};

/**
 * A posted stack, cleaned to exactly the seven fields the arithmetic reads.
 *
 * A blank box means zero here, not "leave whatever was there": the stack is stated as a
 * whole, so a rate someone cleared has to actually clear. `presetName` survives only as
 * provenance — it says where the numbers originally came from, and a hand-edited stack
 * stops claiming to be a preset.
 */
export function normaliseCostStack(raw = {}, previous = null) {
  const out = {};
  for (const f of COST_FIELDS) out[f.key] = Math.min(rate(raw[f.key]), f.unit === '%' ? 100 : 100000);
  const changed = COST_FIELDS.some((f) => rate(previous?.[f.key]) !== out[f.key]);
  if (previous?.presetName && !changed) out.presetName = previous.presetName;
  return out;
}

/** "Sales tax 0% → 8.25% · Shipping $0.00 → $12.00", or null when nothing moved. */
export function describeCostChange(before, after) {
  const bits = [];
  for (const f of COST_FIELDS) {
    const a = rate(before?.[f.key]); const b = rate(after?.[f.key]);
    if (a === b) continue;
    bits.push(f.unit === '%'
      ? `${f.label} ${a}% → ${b}%`
      : `${f.label} $${a.toFixed(2)} → $${b.toFixed(2)}`);
  }
  return bits.length ? bits.join(' · ') : null;
}

/**
 * Re-derive one line's landed cost and buy call against a cost stack.
 *
 * **This is the one place the snapshot rule bends, and only on purpose.** A line's call
 * is normally frozen so an approver sees exactly what the buyer saw; the market moving
 * in between is information, not a correction. But when somebody deliberately edits the
 * COST side, the frozen number is no longer describing anything real — it was computed
 * against rates that have just been declared wrong.
 *
 * What is emphatically NOT refreshed is the market: `alias_price` / `stockx_price` /
 * `liquidity` are re-used exactly as captured, so the call still answers "at the prices
 * the buyer was looking at", and every edit lands in `buy_cart_events` with the before
 * and after. Same functions as the calculator and the same `with_you` basis the buyer's
 * screen used, so a cart line and a calculator line can never be priced by two code
 * paths that disagree.
 *
 * Returns null for a line with no usable shelf price — nothing to recompute from.
 */
export function repriceLine(line, stack) {
  const shelf = Number(line?.shelf_price);
  if (!(shelf > 0)) return null;
  const r2 = (n) => Math.round(Number(n) * 100) / 100;
  const cost = calcCostBreakdown({ ...(stack || {}), shelfPrice: shelf });
  const alias = Number(line.alias_price) > 0 ? Number(line.alias_price) : null;
  const stockx = Number(line.stockx_price) > 0 ? Number(line.stockx_price) : null;
  const payouts = [
    ...(alias ? [calcPayout('alias', alias, cost.finalCost, DEFAULT_FEE_PCT.alias)] : []),
    ...(stockx ? [calcPayout('stockx', stockx, cost.finalCost, DEFAULT_FEE_PCT.stockx)] : []),
  ];
  const v = dealVerdict(payouts, cost.finalCost, line.liquidity || '');
  return {
    id: Number(line.id),
    finalCost: r2(cost.finalCost),
    // No market price means no call — and a null verdict, never a 'pass'. "We didn't
    // look" and "we looked and it's bad" are different answers to an approver.
    verdict: v ? v.call : null,
    bestPlatform: v ? v.best.platform : null,
    bestPayout: v ? r2(v.best.payout) : null,
    profit: v ? r2(v.best.profit) : null,
    roi: v ? r2(v.best.roi) : null,
  };
}

/**
 * Can this request's SHELF PRICES still be edited?
 *
 * They freeze at `funded`, and that is the same freeze approvals get. `approved_amount`
 * is what the gift cards were issued against, so editing a shelf price afterwards would
 * retroactively change the target the money was already released to cover — the receipt
 * is where what was actually paid gets recorded from then on.
 *
 * The cost stack is NOT frozen here: it never moves the funding target (that is shelf ×
 * qty), only what the pair lands at, so an auditor can still state the true cost of a
 * transaction they are closing out.
 */
export const shelfPricesEditable = (cart) =>
  ['draft', 'submitted', 'approved'].includes(cart?.status);
export const costStackEditable = (cart) =>
  !['closed', 'cancelled'].includes(cart?.status);

/** Holds either of the two desk privileges — the people who may write the cost side. */
export async function hasCostPrivilege(user) {
  if (await hasPrivilege(user, 'approve_buying')) return true;
  return hasPrivilege(user, 'audit_buying');
}

/**
 * Who may write the cost stack: the BUYER whose request it is, or either desk.
 *
 * The buyer first, because they are the only person in the room with the information —
 * they are standing in the shop reading the tax off the register and the discount off
 * the sign, and the desk is not. Leaving it desk-only made "the supplier didn't enter
 * the costs" true of every request ever raised, since a buyer has no preset of their own
 * to enter them into.
 *
 * What keeps that safe is not withholding the box, it is that **the desk can overwrite
 * anything the buyer typed and every version is named in `buy_cart_events`**. A cost
 * stack a buyer set favourably is visible as theirs, beside the number the approver
 * replaced it with. The one thing they still cannot move is the SHELF price once the
 * cards are out (`shelfPricesEditable`) — that is what the money was released against.
 *
 * A buyer only ever reaches their own request; staff with neither privilege reach none.
 */
export async function canWriteCosts(user, cart) {
  if (!user || !cart) return false;
  // NOT THE BUYER, as of 2026-09-11. They wrote it first for a while, and the argument
  // was good — they are the one standing in the shop reading the tax off the register.
  // What that missed is what the stack IS: the thing that turns a shelf price into a
  // profit, and therefore the basis on which the request gets approved or turned down.
  // That makes it the same kind of number as the buy call, and it belongs on the same
  // side of the table (`canSeeBuyCall`). The buyer states one figure — what the ticket
  // says — and the desk decides what it means.
  if (user.role === 'supplier' && !isPrivileged(user.role)) return false;
  return hasCostPrivilege(user);
}

// ---------------------------------------------------------------------------
// ONE decision path, two front doors
//
// A decision can arrive from the screen (`cart/decide`, a signed-in approver) or from a
// Telegram button (`cart/telegram-decide`, Make.com holding an API key). They must reach
// the same code: two decide paths that drift would eventually let a tap record something
// the screen would have refused, and the screen is where the audit gets read.
//
// So this holds everything between "who is asking" and "write it down" — the window
// check, the quantity rule, and the words each refusal uses.
export async function decideLines({ cart, action, lineIds, all, qtyById, qtyAll, reason, actor }) {
  // The same predicate the screen draws its buttons from. Before the buyer sends it there
  // is nothing to decide; once the cards are out the approvals are what the money was
  // released against.
  if (!decisionsOpen(cart.status)) return { error: decisionsClosedBecause(cart.status), code: 409 };

  if (!all && (!Array.isArray(lineIds) || !lineIds.length))
    return { error: 'Pick at least one line, or use approve-all.', code: 400 };

  // HOW MANY is part of approving. Refused BY NAME rather than defaulted to one: a line
  // approved without a number is a line the funding total would value at whatever
  // happened to be in the column, and "we approved one of those" is not a thing anybody
  // said. A rejection needs no quantity — there is nothing to buy.
  if (action === 'approve') {
    const missing = await linesAwaitingQty(cart.id, all ? null : lineIds, qtyById, qtyAll);
    if (missing.length)
      return {
        code: 400,
        error: `Say how many to buy: ${missing.length} line${missing.length === 1 ? ' has' : 's have'} no quantity (${missing.slice(0, 3).map((l) => `${l.sku}${l.size ? ` size ${l.size}` : ''}`).join(', ')}${missing.length > 3 ? '…' : ''}).`,
      };
  }

  const out = await decideBuyCartLines({
    cartId: cart.id, lineIds: all ? null : lineIds, action,
    reason: String(reason ?? '').trim().slice(0, 500) || null,
    actor, qtyById, qtyAll,
  });
  if (!out.decided)
    return { error: 'Nothing was still awaiting a decision — someone may have got there first.', code: 409 };
  return out;
}

// ---------------------------------------------------------------------------
// The buy call is OURS, not the buyer's
//
// A line's call — the BUY/WATCH/PASS verdict, the profit and ROI, the payout and the
// Alias/StockX prices it was computed from — is what the approver is judging. The buyer
// is the party being judged, and the person asking for the money should not be able to
// read the number that decides whether they get it: knowing a pair reads as a $60
// profit is knowing exactly how much room there is to argue, and knowing it reads as a
// Pass before you have asked is knowing not to bother asking honestly.
//
// The buyer is not left blind about the market in general — the supplier portal carries
// the Payout Calculator, scoped to their own preset. What is withheld is OUR call on
// THEIR request.
//
// This has to be a server rule and not a hidden column. Three things follow from it and
// all three are enforced rather than styled away:
//   · `cart/get` strips the call from a supplier's copy of a request, and from the
//     event trail, which used to print the verdict in plain words.
//   · `cart/price-line` refuses a supplier — writing a call you cannot read is not a
//     thing to allow, and the response hands back live market prices.
//   · `cart/line` IGNORES any call a supplier posts and reads the market itself. The
//     buyer's browser used to compute the verdict and send it, which meant the party
//     requesting the money supplied the figures justifying it. That was a hole in the
//     control before it was a visibility question.
export const canSeeBuyCall = (user) => !!user && (user.role !== 'supplier' || isPrivileged(user.role));

// The fields that ARE the call. `final_cost` IS among them now: it used to be excluded
// on the grounds that it was the buyer's own shelf price run through a stack they could
// read and edit — and once the stack moved to the desk (`canWriteCosts`), what a pair
// "lands at" became a number derived entirely from figures the buyer cannot see. Showing
// it would hand them our cost structure one subtraction at a time.
const CALL_FIELDS = [
  'verdict', 'profit', 'roi', 'best_platform', 'best_payout',
  'alias_price', 'stockx_price', 'liquidity', 'final_cost',
];

// The trail says a line was priced and by whom, but not to what. A record that
// disappears for one reader is worse than one that is brief: the buyer can still see
// that somebody re-read the market against their request, and when.
const CALL_EVENT_BODY = {
  line_priced: 'Priced. The figures are on the approver’s copy of this request.',
};

/**
 * One LINE, as a supplier may see it. A no-op for everybody else.
 *
 * Endpoints hand a line straight back after adding or editing it, and that copy has to
 * be redacted for the same reason the request is — otherwise the call arrives in the
 * response to the very act of adding the pair.
 */
export function redactLineForViewer(line, user) {
  if (!line || canSeeBuyCall(user)) return line;
  const out = { ...line };
  for (const f of CALL_FIELDS) out[f] = null;
  return out;
}

/**
 * One request, as a supplier may see it. A no-op for everybody else.
 *
 * Applied at the read boundary rather than in each query, so a new caller of
 * `getBuyCartFull` cannot forget it.
 */
export function redactCartForViewer(cart, user) {
  if (!cart || canSeeBuyCall(user)) return cart;
  return {
    ...cart,
    // The stack itself, not just what it produces. Discounts, cashback and the tip we
    // pay are how the company buys — a supplier who can read them can price against them.
    cost_stack: null,
    lines: (cart.lines || []).map((l) => {
      const out = { ...l };
      for (const f of CALL_FIELDS) out[f] = null;
      return out;
    }),
    events: (cart.events || []).map((e) => {
      if (CALL_EVENT_BODY[e.kind]) return { ...e, body: CALL_EVENT_BODY[e.kind] };
      // `line_added` used to end "— buy". The verdict was never the point of that line
      // (it says what was added, and for how much); it is stripped rather than the whole
      // entry being replaced.
      if (e.kind === 'line_added' && typeof e.body === 'string')
        return { ...e, body: e.body.replace(/\s+—\s+(buy|watch|pass)\s*$/i, '') };
      return e;
    }),
  };
}

/**
 * The closing conditions, evaluated against the data rather than against a checklist
 * someone ticks. A transaction is not complete because the money was spent; it is
 * complete when every one of these is true.
 *
 * They come in TWO GROUPS, and that split is the point rather than a presentation
 * choice. The MONEY conditions are answerable the day the receipt lands; the GOODS
 * conditions cannot be answered until the boxes are physically in the warehouse, which
 * may be weeks later. One sign-off covering both would hold the money open for the
 * length of a shipment, and a control people have to wait weeks to satisfy is a control
 * they start working around.
 *
 * The goods half is answered by the PURCHASE ORDER, because that side already exists
 * and already knows whether the boxes arrived. Re-deriving "did it turn up" here would
 * give the company two answers to one question.
 *
 * Returns `[{ key, scope, label, ok, detail }]` — `detail` names what is still missing,
 * since a gate that only says "no" teaches people to route around it.
 */
export async function cartCloseChecks(full) {
  const c = full;
  const byCard = (c.funding_method || 'gift_card') !== 'company_card';
  const cards = (c.giftCards || []).filter((g) => !g.voided_at);
  const target = fundingTarget(c);
  const receiptTotal = money(c.receipt_total);
  const pack = c.pack || null;
  const openTasks = (c.tasks || []).filter((t) => t.status === 'open');

  let recon = null;
  if (c.po_id) { try { recon = await getPoReconciliation(c.po_id); } catch { recon = null; } }
  const poStatus = recon?.po?.status || c.po?.status || null;
  const summary = recon?.summary || null;

  const spentSum = cards.reduce((n, g) => n + (Number(g.spent_amount) || 0), 0);
  const everyCardAudited = cards.length > 0 && cards.every((g) => g.spent_amount != null && g.remaining != null);
  const authorized = money(c.card_authorized);

  const checks = [
    {
      key: 'approved', scope: 'money', label: 'Purchase was approved',
      ok: Boolean(c.approved_at) && Number(c.approved_count) > 0,
      detail: c.approved_at ? null : 'No line has been approved yet.',
    },
    // The funding condition asks the same question of both routes — "was the money that
    // left authorised, and is it recorded?" — but it cannot ask it the same way. A gift
    // card is an object with a balance; a company card charge is a reference on a
    // statement. Reading `gc_total` on a card-funded request would have reported every
    // one of them as unfunded forever.
    byCard
      ? {
        key: 'cards_recorded', scope: 'money', label: 'Gift cards were issued and recorded',
        ok: cards.length > 0 && target > 0 && Number(c.gc_total) >= target,
        detail: cards.length === 0
          ? 'No gift cards recorded.'
          : Number(c.gc_total) < target
            ? `Cards total $${Number(c.gc_total).toFixed(2)} against $${target.toFixed(2)} approved — $${(target - Number(c.gc_total)).toFixed(2)} short.`
            : null,
      }
      : {
        key: 'charge_recorded', scope: 'money', label: 'Company card charge was authorised and recorded',
        ok: Boolean(c.card_reference) && authorized != null && authorized > 0,
        detail: !c.card_reference
          ? 'No payment reference recorded — a charge nobody can trace to a statement line is not evidence.'
          : 'No authorised amount recorded.',
      },
    {
      key: 'receipt', scope: 'money', label: 'Receipt was received',
      ok: (c.files || []).some((f) => f.kind === 'receipt'),
      detail: 'No receipt has been uploaded.',
    },
    {
      key: 'parsed', scope: 'money', label: 'Receipt was parsed',
      ok: (c.receiptLines || []).length > 0 && receiptTotal != null,
      detail: 'The receipt has not been read into lines yet.',
    },
    byCard
      ? {
        key: 'spend_reconciled', scope: 'money', label: 'Gift card spending was reconciled',
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
      }
      : {
        key: 'charge_reconciled', scope: 'money', label: 'Card charge matches the receipt',
        // An authorised amount that does not equal what the till took is the same class
        // of finding as a card gap, and it is the only thing standing between an
        // approved limit and an unapproved purchase on the same card.
        ok: authorized != null && receiptTotal != null && near(authorized, receiptTotal),
        detail: authorized == null ? 'No authorised charge recorded.'
          : receiptTotal == null ? 'No receipt total to reconcile against.'
            : `Authorised $${authorized.toFixed(2)} against a receipt of $${receiptTotal.toFixed(2)} — a $${Math.abs(authorized - receiptTotal).toFixed(2)} gap.`,
      },
    {
      key: 'expected_recorded', scope: 'goods', label: 'Purchased inventory was recorded as expected',
      // Raising the order is only half of it now that the manifest is per box. A pair
      // that was bought and never packed into a label is not counted as expected by the
      // reconciliation at all — so without this the order can ship, receive and
      // reconcile perfectly clean while the shoe is nowhere.
      ok: Boolean(c.po_id) && Boolean(pack) && pack.totalQty > 0 && pack.unpacked === 0 && pack.overPacked === 0,
      detail: !c.po_id ? 'No purchase order has been raised from this receipt.'
        : !pack || pack.totalQty === 0 ? 'The receipt has not been read into lines yet.'
          : pack.overPacked > 0 ? `${pack.overPacked} more unit${pack.overPacked === 1 ? '' : 's'} packed than the receipt covers.`
            : `${pack.unpacked} of ${pack.totalQty} receipt unit${pack.totalQty === 1 ? '' : 's'} not packed into a box yet.`,
    },
    {
      key: 'shipped', scope: 'goods', label: 'Products were shipped',
      ok: Boolean(poStatus) && ['shipped', 'receiving', 'reconciled', 'closed'].includes(poStatus),
      detail: c.po_id ? 'The order’s boxes have not left the buyer yet.' : 'No purchase order yet.',
    },
    {
      key: 'received', scope: 'goods', label: 'Products were physically received',
      ok: Boolean(poStatus) && ['receiving', 'reconciled', 'closed'].includes(poStatus),
      detail: c.po_id ? 'Nothing has been scanned in against the order.' : 'No purchase order yet.',
    },
    {
      key: 'matches', scope: 'goods', label: 'Each box matches what was packed into it',
      // `no_manifest` is a clean-looking summary with nothing behind it: every unit
      // reads as an overage because nothing was ever declared. That must not pass as a
      // match — it is the absence of the comparison, not the result of one.
      ok: Boolean(summary) && summary.clean && !summary.no_manifest,
      detail: !summary ? 'No reconciliation to read yet.'
        : summary.no_manifest ? 'The order was received blind — nothing was declared to compare against.'
          : `${summary.shortage} short, ${summary.overage} over, ${summary.wrong_size + summary.wrong_sku} mismatched.`,
    },
    {
      key: 'receipt_vs_received', scope: 'goods', label: 'What was received matches what was bought',
      // The third leg, and the only one that closes the loop. Reconciliation compares
      // the MANIFEST against what arrived; the manifest is the buyer's own account of
      // what they packed. Comparing the RECEIPT against what arrived is the comparison
      // that does not take the buyer's word for anything.
      ok: Boolean(summary) && pack != null && pack.totalQty > 0
        && summary.received_units === pack.totalQty,
      detail: !summary ? 'Nothing has been received yet.'
        : !pack || pack.totalQty === 0 ? 'The receipt has not been read into lines yet.'
          : `The receipt says ${pack.totalQty} pair${pack.totalQty === 1 ? '' : 's'}; ${summary.received_units} arrived — a gap of ${Math.abs(pack.totalQty - summary.received_units)}.`,
    },
    {
      key: 'balance', scope: 'money',
      label: byCard ? 'Any remaining gift card balance is accounted for' : 'Any unspent authorised amount is accounted for',
      ok: byCard
        ? (c.balance_remaining != null && cards.length > 0 && cards.every((g) => g.remaining != null))
        : c.balance_remaining != null,
      detail: byCard ? 'The balance left on each card has not been recorded.'
        : 'The difference between what was authorised and what was spent has not been recorded.',
    },
    {
      key: 'exceptions', scope: 'goods', label: 'Every open case was resolved',
      // The deck's rule, and the reason a return case is a row rather than a note: an
      // update is not completion, and a promise is not a refund. A request cannot close
      // over the top of a case that is still costing the company money.
      ok: openTasks.length === 0,
      detail: `${openTasks.length} still open: ${openTasks.slice(0, 3).map((t) => t.title).join('; ')}${openTasks.length > 3 ? '…' : ''}`,
    },
  ];

  return checks.map((k) => ({ ...k, detail: k.ok ? null : k.detail }));
}

export const allChecksPass = (checks) => checks.every((c) => c.ok);
