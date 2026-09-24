// When a buying request can still be DECIDED, and when the buyer can still ADD to it —
// in one place both sides read.
//
// It lived only on the server, so `cart/decide` refused a draft while the screen drew
// the checkboxes, "Approve selected" and "Approve all 3" anyway — a full set of controls
// whose only possible outcome was a red line under them. A button that cannot work is
// worse than no button: it reads as a broken feature rather than as a step that has not
// happened yet, and on a money screen it invites somebody to keep clicking.
//
// Shared the same way `payout.js` is: pure functions in `src/lib`, imported by the
// endpoint AND the screen, so the rule cannot drift into two versions that disagree.

// Before the buyer has asked about anything, there is nothing to decide. After the
// request is finished there is nothing left to decide either.
export const DECISIONS_NOT_YET = ['draft'];
export const DECISIONS_FROZEN = ['closed', 'cancelled', 'written_off'];
// Once the cards are out, the approvals they were issued against are what the money was
// released for, and re-deciding one would leave the spend and the approval describing
// two different things. But a pair the buyer added AFTER re-opening the list is still a
// question — so on these statuses only PENDING lines can be decided, and nothing can be
// overridden. The server filters the targets; the screen only ever offers pending lines.
export const DECISIONS_PENDING_ONLY = ['funded', 'receipted', 'audited'];

export const decisionsOpen = (status) =>
  !DECISIONS_NOT_YET.includes(status) && !DECISIONS_FROZEN.includes(status);

export const decisionsPendingOnly = (status) => DECISIONS_PENDING_ONLY.includes(status);

/**
 * WHY they are closed, in the words the person in front of the screen needs.
 *
 * The two reasons are not interchangeable: one is "wait", the other is "too late", and
 * an approver who is told the wrong one goes and does the wrong thing about it.
 * Returns null while decisions are open.
 */
export function decisionsClosedBecause(status) {
  if (DECISIONS_NOT_YET.includes(status)) return 'The buyer hasn’t asked about anything yet — nothing to approve until they add a pair.';
  if (DECISIONS_FROZEN.includes(status)) return 'This request is finished, so its approvals are frozen.';
  return null;
}

// ---------------------------------------------------------------------------
// The buyer's LIST: open until they close it.
//
// A buyer works a shop for an hour and asks about pairs as they find them; each add is
// its own question to the desk. "Close the request" says the list is complete — that is
// when the gift-card desk may fund it. The list can be re-opened (the group is told)
// right up until the receipt is in; from there the purchase has happened and anything
// else is a new request.

// Statuses on which the buyer may still be adding, or may re-open to add.
export const LIST_ADDABLE = ['draft', 'submitted', 'approved', 'denied', 'funded'];

export const listOpen = (cart) => !!cart && !cart.list_closed_at;

/** May the buyer add a pair right now? Open list, and the request has not moved past funding. */
export const buyerCanAdd = (cart) => listOpen(cart) && LIST_ADDABLE.includes(cart?.status);

/** May the buyer close the list? Same window, and there has to be something on it. */
export const buyerCanClose = (cart) => listOpen(cart) && LIST_ADDABLE.includes(cart?.status) && Number(cart?.line_count) > 0;

/** May the buyer re-open a closed list? Until the receipt is in. */
export const buyerCanReopen = (cart) => !!cart?.list_closed_at && ['submitted', 'approved', 'denied', 'funded'].includes(cart?.status);

/** Why a closed list cannot be re-opened, or null. */
export function reopenRefusedBecause(cart) {
  if (!cart?.list_closed_at) return null;
  if (buyerCanReopen(cart)) return null;
  if (['receipted', 'audited', 'closed'].includes(cart.status)) return 'The receipt is already in — open a new request for anything else.';
  return 'This request is finished.';
}

/**
 * May the gift-card desk record a card against this request? The list has to be closed
 * — a card issued against a list still growing is a card issued against an unknown
 * total — and every line decided, so the target is the final one.
 *
 * Still open once the receipt is in and after the money audit (2026-09-23). A receipt
 * the recorded cards don't cover — $400 of cards against a $422.18 till — means a card
 * was spent that nobody recorded, and with the desk locked out the only way to close
 * the request was to misstate a card's spend. Recording it adds a card with no spend
 * yet, which re-opens "Gift card spending was reconciled" until the auditor records it.
 */
export const CARDS_RECORDABLE = ['approved', 'funded', 'receipted', 'audited'];
export const cardsIssuable = (cart) =>
  !!cart?.list_closed_at && CARDS_RECORDABLE.includes(cart?.status) && Number(cart?.pending_count) === 0;

/** A card recorded now is one the buyer already SPENT, not one being handed over. */
export const cardsAfterPurchase = (cart) => ['receipted', 'audited'].includes(cart?.status);

/** Why cards cannot be recorded yet, in words for the desk. Null when they can. */
export function cardsRefusedBecause(cart) {
  if (cardsIssuable(cart)) return null;
  if (['closed', 'cancelled', 'written_off'].includes(cart?.status)) return 'This request is finished.';
  if (!CARDS_RECORDABLE.includes(cart?.status)) {
    return cart?.status === 'submitted' || cart?.status === 'draft'
      ? 'This request has not been approved yet — no approval, no gift cards.'
      : 'Gift cards can only go against an approved request.';
  }
  if (!cart?.list_closed_at) return 'The buyer is still adding to this request — cards wait until they close it.';
  if (Number(cart?.pending_count) > 0) return `${cart.pending_count} line${Number(cart.pending_count) === 1 ? ' is' : 's are'} still waiting for a decision — cards wait until every line is decided.`;
  return 'Gift cards can only go against an approved request.';
}

/**
 * The one sentence at the top of a request: whose turn it is, and — when it is the
 * viewer's — what to do and where on the page to do it.
 *
 * Every role used to open a request and hunt. The buyer's receipt box sat halfway down
 * under the lines and the cards; the approver's buttons were at the foot of the table;
 * the auditor scrolled past packing to find the audit. The status chip named the column
 * value, the dots named the stop, and neither said "this is yours".
 *
 * `who` = { isBuyer, canDecide, canIssue, canAudit } — the same draw-flags the screen
 * already computes. `target` names a section id (`bc-sec-<target>`) to scroll to; it is
 * null when the thing to press is in the header.
 *
 * Returns { mine, text, action?, target? } or null for a request with nothing to say.
 */
export function nextStep(cart, who) {
  if (!cart) return null;
  const { isBuyer, canDecide, canIssue, canAudit } = who;
  const buyer = cart.buyer_name || 'the buyer';
  const pending = Number(cart.pending_count) || 0;
  const pairs = (n) => `${n} pair${n === 1 ? '' : 's'}`;
  const checks = cart.checks || [];
  const goodsDone = checks.filter((c) => c.scope === 'goods').every((c) => c.ok);
  const allDone = checks.length > 0 && checks.every((c) => c.ok);
  const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

  switch (cart.status) {
    case 'draft':
      return isBuyer
        ? { mine: true, text: 'Add each pair as you find it — the approver sees them as you go.', action: 'Add a pair', target: 'add' }
        : { mine: false, text: `Waiting on ${buyer} to add the first pair.` };
    case 'submitted':
    case 'approved':
    case 'denied': {
      if (pending > 0) {
        if (canDecide) return { mine: true, text: `${pairs(pending)} waiting for your decision.`, action: 'Decide', target: 'lines' };
        if (isBuyer) return { mine: false, text: `Waiting on an approver — ${pairs(pending)} to decide. Keep adding, then close the request when you are done.` };
        return { mine: false, text: `Waiting on an approver — ${pairs(pending)} to decide.` };
      }
      if (listOpen(cart)) {
        return isBuyer
          ? { mine: true, text: 'Everything so far is decided. Found it all? Close the request so the desk can fund the cards.', action: null, target: null }
          : { mine: false, text: `Everything so far is decided. Waiting on ${buyer} to close the list — cards wait until then.` };
      }
      if (cart.status === 'denied') return { mine: false, text: 'Turned down. Anything else is a new request.' };
      if (canIssue) return { mine: true, text: `Record the gift cards — ${money(cart.funding_target || cart.approved_amount)} to fund.`, action: 'Record cards', target: 'cards' };
      return { mine: false, text: 'Waiting on the gift card desk to release the cards.' };
    }
    case 'funded':
      return isBuyer
        ? { mine: true, text: 'Cards are out. After the till, upload the receipt — it is required.', action: 'Add the receipt', target: 'receipt' }
        : { mine: false, text: `Waiting on ${buyer}'s receipt.` };
    case 'receipted':
    case 'audited': {
      // Two halves run side by side here — the money (the auditor) and the goods (the
      // buyer packing, then the boxes landing). Say the viewer's half first.
      if (canAudit && cart.status === 'receipted') {
        return { mine: true, text: 'Record the financial audit — what each card was spent, and what is left on it.', action: 'Audit', target: 'audit' };
      }
      if (!cart.po_id) {
        return isBuyer || canDecide
          ? { mine: true, text: 'Receipt is in. Start packing: every pair on the receipt goes into a box.', action: null, target: null }
          : { mine: false, text: `Waiting on ${buyer} to start packing the shipment.` };
      }
      const pack = cart.pack;
      if (pack && pack.unpacked > 0) {
        return isBuyer
          ? { mine: true, text: `${pairs(pack.unpacked)} on the receipt not in a box yet.`, action: 'Pack', target: 'pack' }
          : { mine: false, text: `Waiting on ${buyer} to pack ${pairs(pack.unpacked)}.` };
      }
      if (canAudit && allDone) return { mine: true, text: 'Every condition is met. Close it out.', action: null, target: null };
      if (canAudit && goodsDone && !cart.goods_audited_at) {
        return { mine: true, text: 'The boxes are in and match. Sign off the shipment.', action: 'Sign off', target: 'goods' };
      }
      const open = checks.filter((c) => !c.ok);
      return { mine: false, text: open.length ? `Waiting on: ${open[0].label.toLowerCase()}${open.length > 1 ? ` (+${open.length - 1} more)` : ''}.` : 'Waiting on the shipment.' , target: 'checks', action: 'See what' };
    }
    case 'closed':
      return { mine: false, text: 'Closed — the money and the goods both reconciled.' };
    case 'written_off':
      return { mine: false, text: 'Written off.' };
    case 'cancelled':
      return { mine: false, text: 'Cancelled before any money moved.' };
    default:
      return null;
  }
}
