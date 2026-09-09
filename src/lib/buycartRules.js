// When a buying request can still be DECIDED, in one place both sides read.
//
// It lived only on the server, so `cart/decide` refused a draft while the screen drew
// the checkboxes, "Approve selected" and "Approve all 3" anyway — a full set of controls
// whose only possible outcome was a red line under them. A button that cannot work is
// worse than no button: it reads as a broken feature rather than as a step that has not
// happened yet, and on a money screen it invites somebody to keep clicking.
//
// Shared the same way `payout.js` is: pure functions in `src/lib`, imported by the
// endpoint AND the screen, so the rule cannot drift into two versions that disagree.

// Before the buyer has sent it, there is nothing to decide — the list is still theirs
// to change. After the cards are out, the approvals are what the money was released
// against, and re-deciding one would leave the spend and the approval describing two
// different things.
export const DECISIONS_NOT_YET = ['draft'];
export const DECISIONS_FROZEN = ['funded', 'receipted', 'audited', 'closed', 'cancelled', 'written_off'];

export const decisionsOpen = (status) =>
  !DECISIONS_NOT_YET.includes(status) && !DECISIONS_FROZEN.includes(status);

/**
 * WHY they are closed, in the words the person in front of the screen needs.
 *
 * The two reasons are not interchangeable: one is "wait", the other is "too late", and
 * an approver who is told the wrong one goes and does the wrong thing about it.
 * Returns null while decisions are open.
 */
export function decisionsClosedBecause(status) {
  if (DECISIONS_NOT_YET.includes(status)) return 'The buyer hasn’t sent this yet — nothing to approve until they do.';
  if (DECISIONS_FROZEN.includes(status)) return 'The money has already gone out against these approvals, so they’re frozen.';
  return null;
}
