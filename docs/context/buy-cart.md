# Gift-card buying — approved money out, verified inventory in

Screens: `src/screens/BuyCarts.jsx` (queue) → `src/screens/BuyCart.jsx` (one request),
with `src/components/BuyCartAdd.jsx`, `BuyCartGiftCards.jsx`, `BuyCartReceipt.jsx`.
Endpoints: `api/cart/*` (16). Shared rules: `api/_lib/buycart.js`. Crypto:
`api/_lib/secrets.js`. Receipt parser: `src/lib/receiptParse.js`. Queries: the
`buy_carts` section at the end of `api/_lib/db.js`. Routes: **`/buy-carts`** (staff)
and **`/buying`** on the supplier portal. E2E: `e2e/buy-cart.spec.js`.
SOP: `src/lib/sop/articles.buycart.js`.

## What it is
The written process the floor asked for, made enforceable. A buyer asks for gift
cards, somebody approves what the money may be spent on, a desk releases the cards, a
receipt comes back, and somebody who was not involved checks that the money and the
goods agree. It exists to close one loop: **there must never be a path where a person
requests funds, spends them, and nobody independently verifies what happened.**

**Its back half already existed.** A purchase order's `po_lines` ARE "expected
inventory"; PO reconciliation already compares expected against what physically
arrived; 17TRACK already watches the parcel. So this carries steps 1–7 and then hands
off — the parsed receipt raises a PO, and `buy_carts.po_id` is the seam. Building a
second expected-inventory system beside `po_lines` would have given the company two
answers to "what are we still waiting on", which is worse than none.

```
BUY CART (new)                          PURCHASE ORDER (existing)
1 Request      buyer lists pairs + the buy call
2 Approval     either staff side, per line or bulk
3 Gift cards   issuer records + releases (encrypted)
4 Receipt      buyer uploads — required
5 Parse        paste / PDF / OCR → review table
6 Expected  ─────────────────────────►  po_lines (whole-order manifest)
7 Audit        cards vs receipt vs left  8 Ship + 17TRACK
                                          9 Receive vs manifest
10 CLOSED ◄──────────────────────────────  Reconciled
```

## The naming trap, first
Our `supplier` role is the process's **BUYER** — the person who goes to the shop (and
who also ships us the boxes, which is why they hold that role). The process's "gift
card suppliers" are a **different set of people**, and they are the new `gc_issuer`
role. Nothing user-facing here says "supplier": it says **Buyer** and **Gift card
issuer**. Two roles read as one is how a separation-of-duties control quietly stops
being one.

## Roles — the control, not a convention
| Role | Does | Cannot |
|---|---|---|
| `supplier` (Buyer) | opens the request, spends the cards, sends the receipt | approve anything, issue a card, audit |
| `warehouse` / `ph_team` / admin | approve or turn down lines | — |
| `gc_issuer` (new) | records cards, releases them | approve |
| `auditor` (new) | signs the financial audit, closes the transaction | approve, issue |

Approval is open to warehouse **and** PH **and** admin on purpose: the people who know
whether a pair is worth buying are the floor and the pricing desk, and a buyer standing
in a shop at 11pm waiting on one named account is how a process gets worked around
instead of followed.

**The audit guard cannot be `requireRole`.** That helper auto-admits anything
privileged, which would let the admin who approved a request also sign off the audit of
it — the one control the process says matters most. `requireAuditor` therefore does its
own check (the same shape as `requireSuperadmin`, which had to step outside the helper
for the same reason) and then refuses when the account is the approver.

- **It compares `approved_by_key`, never the id and never the name.** The id alone was
  the first version and it was **broken for the accounts it mattered most for**: the env
  `admin`/`superadmin` have no `users` row, so their id saved as NULL and the check
  silently never fired. `actorKey()` is the row id for a real account and
  `env:<username>` otherwise. A control that is off for its most privileged user is not
  a control.
- `gc_issuer` and `auditor` get their **own Home** (`GC_SECTIONS` in `constants.js`) —
  their job plus Help. The full warehouse home would be a page of cards that answer 403
  when tapped, which reads as a broken app rather than as a role boundary.

## The money
**Funding target = Σ (shelf_price × qty) over APPROVED lines.** The sticker, no
discounts assumed. It over-funds deliberately: a card that comes up short strands a
buyer in a shop, while a leftover balance is money still ours — and step 10 makes us
account for it either way. That last part is a real benefit rather than a consolation:
funding at sticker guarantees a remainder on nearly every request, so "any remaining
gift card balance is accounted for" is a live number every time instead of a box nobody
ticks.

**The one hole, and it is named on screen** (`tillOverrunWarning`). Tax is charged on
top of the sticker, and the discounts that normally swallow it come off the same base.
With a small discount and a high tax rate the till asks for more than the sticker:

```
$150 shelf, 0% off, 8.25% tax   → till wants $162.38, funded $150.00 → $12.38 SHORT
$150 shelf, 30% off, 8.25% tax  → till wants $113.66, funded $150.00 → fine
```

The gift-card panel shows an amber note with the number when the request's own cost
stack makes `(1−store%)(1−promo%)(1+tax%) > 1`. It **warns rather than changing the
figure somebody approved**. The gift-card discount is deliberately excluded from that
factor — that 8% is what *we* save buying the card, not a discount the register gives —
and so is the coupon, which is a flat amount off one transaction and would understate
every line if spread across a request (the same reason batch analysis refuses it).

## The buy call is a SNAPSHOT
Every line stores the verdict as the buyer saw it: call, final cost, best platform,
payout, profit, ROI, both market prices, liquidity, basis, and `quoted_at`. It is never
recomputed. An approver has to be looking at what the buyer was looking at; the market
moving in between is information, not a correction.

- The arithmetic is `src/lib/payout.js` — `calcCostBreakdown`, `calcPayout`,
  `dealVerdict`. Deliberately the same functions the calculator uses, so a cart line and
  a calculator line can never be priced by two code paths that disagree.
- The cost stack is the buyer's **own** payout preset (`payout_presets.supplier_user_id`),
  snapshotted onto `buy_carts.cost_stack` at creation. A preset edited next week must not
  restate what an approver was looking at.
- **A Pass can be added.** The buyer is in the shop and may know something the data
  doesn't; the red chip travels to the approver so the disagreement is visible rather
  than prevented. A tool that refuses to record what someone wants to buy just moves the
  conversation to a chat app where nobody can audit it.
- There is **no unique index on (cart, sku, size)** — a line carries its own shelf price
  and its own verdict, so the same pair seen in two shops at two prices is two true rows.

## Gift cards — the only bearer instruments in this app
`api/_lib/secrets.js`: AES-256-GCM under **`BUY_GC_KEY`** (32 bytes, hex or base64),
stored `v1:<iv>:<tag>:<ct>` so a key rotation stays possible.

- **Fails closed.** No key → pasting a card is refused (503) with a clear message;
  uploads still work. Storing the codes in the clear because an env var wasn't set is
  exactly the outcome the encryption exists to prevent, and it would be invisible until
  it mattered.
- **A code is never in a list payload.** `getBuyCartFull` selects `code_last4` and never
  `code_enc`. Reading one is `cart/gc-reveal`, one card at a time, and it **writes the
  `gc_revealed` event BEFORE it decrypts** — if the reveal fails halfway the record
  still shows somebody asked, which is the question an auditor is trying to answer.
- **Who may reveal:** the issuing desk, and the buyer whose request it is — the buyer
  only once the cards have been *released*, because a code visible before funding is a
  code that could be spent before it was approved.
- Cards are **voided, never deleted**. A card that went out and came back is a thing
  that happened to company money. Voided cards drop out of `gc_total`.
- Card images and the receipt are **proxied** (`api/cart/file.js`), never a bucket URL —
  a photo of a card is as spendable as the digits. Same rule as the courier labels.
  `Cache-Control: private, no-store`, and the client holds an object URL it revokes.

## The receipt
The **file** is evidence and is uploaded first, kept whatever happens next. The **lines**
are a reading of it, and a reading can be wrong, so they land in an **editable table**
and nothing is committed until a person has looked at them.

Three sources, one parser (`src/lib/receiptParse.js`): pasted text, PDF text via pdfjs
(the machinery `manifestImport.js` already uses), and tesseract OCR on a photo. All
three were already dependencies; none costs an API call.

- **The two-line item shape is the normal one.** A till prints the product and its style
  code on one line and the size, quantity and money indented underneath. A style code
  with no money beside it is a *header waiting for its numbers*, held open for the next
  line — and only the next line, never a noise line, which is what stops an unclosed
  header swallowing the `GIFT CARD … 200.00` rows at the bottom.
- **Unit vs total is most of the care.** `2 @ 84.99` states the unit outright; prefer a
  total the till printed over one we multiply. Otherwise take the LAST money token as
  the line total and divide — tills print the extended price last, and dividing a total
  is safe where multiplying a misread unit price is not.
- **Both totals are shown and neither is silently chosen**: what the rows add up to, and
  what the receipt *says*. On a shop receipt they differ by the tax, and that gap is the
  difference between "we read this receipt" and "we read most of it". The **stated**
  total is what the reconciliation runs against — it is what the cards were charged.
- `compareReceiptToApproved` flags `bought_unapproved`, `approved_not_bought` and
  `qty_differs`. Approved and bought are different claims and both are kept; where they
  part is a finding for the audit, not something to tidy away.

## Raising the purchase order (step 6)
`cart/raise-po` creates a **supplier-raised** PO with the receipt lines as a
**whole-order manifest** (`po_box_id` NULL, `manifest_scope='po'`), tagged with the cart
code. Which box a pair ends up in is decided later when the buyer packs; splitting the
receipt across boxes now would be a guess presented as a record.

The lines come off the **receipt**, not off the approved request. What was approved is
what we agreed to spend; the receipt is what actually exists and is coming.

> **Two pre-existing bugs this uncovered and fixed.** `po/ship` and `po/close-box` both
> demanded per-box lines before a box could move — but `po/scan` refuses per-box lines on
> a whole-order-manifest order, so **a Path-C order could never be closed or shipped by
> anybody**. Both now test the order-level list when `manifest_scope='po'`. Every
> cart-raised PO is whole-order scope, so this was blocking on the first run.

## The ten closing conditions
`cartCloseChecks(full)` in `api/_lib/buycart.js`. The screen renders these and
`cart/close` **re-evaluates them server-side** — a gate that lives in the UI is a gate a
stale tab walks through. Each returns `{ key, label, ok, detail }`; `detail` names what
is missing, because a gate that only says no teaches people to route around it.

| # | Condition | Read from |
|---|---|---|
| 1 | Purchase was approved | `approved_at` + ≥1 approved line |
| 2 | Gift cards were issued and recorded | ≥1 live card **and** `gc_total ≥ approved_amount` |
| 3 | Receipt was received | ≥1 `buy_cart_files` of kind `receipt` |
| 4 | Receipt was parsed | ≥1 receipt line + a receipt total |
| 5 | Gift card spending was reconciled | every card has spend **and** remaining, Σ spent = receipt total |
| 6 | Purchased inventory recorded as expected | `po_id` set |
| 7 | Products were shipped | PO status past `draft` |
| 8 | Products were physically received | PO `receiving`/`reconciled`/`closed` |
| 9 | Expected matches received | `getPoReconciliation().summary.clean` **and not** `no_manifest` |
| 10 | Remaining balance accounted for | `balance_remaining` + every card's `remaining` |

- **#5 needs both halves.** Matching totals with blank cards says nothing about *which*
  card the money left; per-card figures that don't sum to the receipt mean something was
  bought this receipt doesn't cover.
- **#9 excludes `no_manifest`.** That is a clean-looking summary with nothing behind it —
  the absence of the comparison, not the result of one.
- **There is no override, by decision.** A genuinely lost receipt leaves a request open
  indefinitely and only a DB edit frees it. That cost was weighed against the escape
  hatch every control like this eventually leaks through, and it can be added later far
  more easily than it could be taken away.

## Statuses
`draft → submitted → approved → funded → receipted → audited → closed`, plus `denied`
and `cancelled`. The cart's own status **follows its lines** rather than being set by
hand: once nothing is pending it is `approved` if anything survived, `denied` if nothing
did. Approvals **freeze** at `funded` — you cannot re-decide a line the money has
already gone out against. Cancelling is only possible before any card exists; after that
there is money to account for and it must be reconciled, not cancelled.

## Trail
`buy_cart_events` — append-only, never edited, never read by a list screen, the same
shape as `po_comments`. Every approval, card, file, reveal, audit and close. Comments
live in the same table (`kind='comment'`) so "ask the buyer what they are buying" — step
one of the process — has somewhere to happen that can be audited later.

## Gotchas
- **`BUY_GC_KEY` must be set on every environment**, or the desk can only upload photos.
- **New tables + two new roles → `db:setup`** on local and prod (`docs/context/deploy.md`).
- `PriceInput` hands its `onChange` the **event**, not the value. Every price box on
  these screens was silently storing an event object at first, and the failure is
  invisible — the field looks like it took the input while everything downstream becomes
  NaN.
- Nothing here touches `items`, so `PH_EXCLUDED_KINDS` and `items.pre_sell` are not in
  play. The PO it raises is an ordinary shipment and follows all the usual rules.
- All timestamps go through the EST helpers (`src/lib/format.js`).
