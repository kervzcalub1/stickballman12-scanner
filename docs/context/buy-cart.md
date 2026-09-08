# Gift-card buying — approved money out, verified inventory in

Screens: `src/screens/BuyCarts.jsx` (queue) → `src/screens/BuyCart.jsx` (one request),
with `src/components/BuyCartAdd.jsx`, `BuyCartCosts.jsx`, `BuyCartGiftCards.jsx`,
`BuyCartReceipt.jsx`.
Endpoints: `api/cart/*` (18). Shared rules: `api/_lib/buycart.js`. Crypto:
`api/_lib/secrets.js`. Receipt parser: `src/lib/receiptParse.js`. Queries: the
`buy_carts` section at the end of `api/_lib/db.js`. Routes: **`/buy-carts`** (warehouse/admin),
**`/ph/gift-card-buying`** (PH) and **`/buying`** on the supplier portal. E2E: `e2e/buy-cart.spec.js`.
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
who also ships us the boxes, which is why they hold that role). The process's "gift card
suppliers" are a **different set of people**: whoever holds `issue_gift_cards`. Nothing
user-facing here says "supplier" for either — it says **Buyer** and **Gift card desk**.
Two different people read as one is how a separation-of-duties control quietly stops
being one.

## Privileges — the control, not a convention

The three staff-side duties are **privileges, not roles**, and that distinction is the
design. They shipped briefly as roles and it was wrong: `users.role` is a single column,
so making them roles forced them to be *alternatives* to being warehouse or PH. In
reality the card desk is a PH team member who also does that, and the auditor is an
admin who also does that. A job title and a permission are different things.

`users.privileges TEXT[]`, set from **Check Access** as checkboxes beside the role
dropdown (`api/admin/review.js`, `decision:'privileges'` — the whole set at once, so
unticking is as ordinary as ticking).

| Privilege | Lets you |
|---|---|
| `approve_buying` | decide what company funds may be spent on; raise the PO; cancel |
| `issue_gift_cards` | record cards, release them, upload card images, read a code |
| `audit_buying` | record the spend and close a transaction out |

- **admin/superadmin hold all three implicitly** (`isPrivileged`), and are never looked up.
- **A `supplier` can hold none.** `setUserPrivileges` and `db:setup` both strip them. A
  buyer with `approve_buying` would sign off their own request, which is the single
  thing this process exists to prevent — so it is enforced in two places, not asked
  politely of the UI.
- **Any staff account can READ a request.** What they may *do* is the gated part.
  Hiding the ledger from the floor would make the process opaque without making it safer.

### Read fresh, every time
`hasPrivilege` queries the database on every privileged call. That is a deliberate
divergence from the rest of the app, which trusts the signed token and never looks a
user up.

A role rides in the token because a job title does not change mid-shift. **A permission
over company money does**, and revocation that waits for the next sign-in is not
revocation — an account you untick this morning would keep spending until it happened to
sign out, which could be days. The cost is one small indexed read on a handful of
low-traffic endpoints. Guarded by an e2e test that revokes a privilege underneath a live
token and asserts the next call is refused.

`login.js` still puts `privileges` in the **client** payload, for drawing cards and
buttons only. Nothing trusts it. A stale list costs a button that answers 403 — which is
also what an already-signed-in user sees until they sign in again after this ships.

### The audit sign-off still needs its own guard
`requireAuditPrivilege` = `audit_buying` **plus** "not the account that approved this
request". Under the privilege model that second half matters *more* than it did under
roles: one person can now legitimately hold both approve and audit, so "a different
role" is no longer any guarantee at all. Check Access says so out loud when someone
holds both.

- **It compares `actorKey`, never the raw id.** The id alone was the first version and it
  was **broken for the accounts it mattered most for**: the env `admin`/`superadmin` have
  no `users` row, so their id saved as NULL and the check silently never fired.
  `actorKey()` is the row id for a real account and `env:<username>` otherwise. A control
  that is off for its most privileged user is not a control.

### Where each holder finds it
- **warehouse / admin** — Home → *Gift Card Buying* (`/buy-carts`), drawn only for a
  holder.
- **PH team** — PH home → *Gift Card Buying* (`/ph/gift-card-buying`). PH has its own app
  and never touches the staff router, so it needs its own route; without one a PH member
  ticked for gift cards had nowhere to go, which is the exact case the model exists for.
- **buyer** — supplier portal → *Buying Requests* (`/buying`).

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

## The cost stack — and who may write it
A request's stack is snapshotted from the **buyer's** payout preset when it is opened
(`payout_presets.supplier_user_id` → `buy_carts.cost_stack`). Buyers do not manage their
own presets — an admin does — so **a buyer who has never been given one opens a request
with no stack at all**: every pair "lands at" exactly its sticker, no payout clears a
threshold, and the Call column is blank on every line. That is not an edge case, it is
what every new buyer's first request looks like.

So it can be stated by hand — `api/cart/costs.js`, `BuyCartCosts.jsx`, the **What a pair
costs us** card above the lines.

- **The BUYER writes it first, and either desk can overwrite it** (`canWriteCosts`). The
  buyer is the only person in the room with the information: they are standing in the
  shop reading the tax off the register and the discount off the sign, and the desk is
  not. Desk-only was the first version and it was wrong — it made "the supplier didn't
  enter the costs" true of *every* request ever raised, because a buyer has no preset of
  their own to enter them into.
- **What makes that safe is the trail, not the lock.** A buyer could set a flattering
  stack; the approver can overwrite it, and `buy_cart_events` holds both versions under
  the names that set them, so a favourable number is visible *as the buyer's* beside what
  the approver replaced it with. The thing a buyer still cannot move is the **shelf
  price** once the cards are out — that is what the money was released against.
- **A buyer reaches only their own request** (`cartVisibleTo`, re-checked in
  `canWriteCosts` on `buyer_user_id`). Staff holding neither privilege can read the stack
  and not write it; the privilege is read from the DB on every call, as everywhere else
  here.
- **The seven fields are the calculator's** (`COST_FIELDS`): store %, promo %, gift
  card %, cashback %, tax %, tip $, shipping $. A blank box is **zero**, not "leave what
  was there" — the stack is stated as a whole, so a rate somebody clears has to clear.
  `presetName` survives only while the numbers do: a hand-edited stack stops claiming to
  be a preset.
- **The chip IS the field.** Tap a rate and its value becomes an input in place; Enter
  saves, Esc leaves it, leaving the box commits it. A rate gets corrected one at a time
  far more often than seven at a time — somebody reads the receipt and the tax is 6%, not
  8.25% — and opening a seven-box form to change one number is a form you then have to
  re-read before you can trust you only changed the one. *Edit all seven* is still there
  for stating a whole stack from nothing.
  - The inline input is **16px**, unlike every other chip on the screen: under that, iOS
    Safari zooms the page and it can't be undone one-handed.
  - **Enter and blur both commit, so it must survive being asked twice.** Enter disables
    the input while it saves, and disabling a focused element BLURS it — straight into a
    second identical write. Guarded by a `useRef`, not by the `busy` state: the blur
    arrives during React's commit, before any re-rendered handler could see it.
  - The chip is a `<button>` only for someone who may write it — the buyer on their own
    request, or a desk — and a plain `<span>` for everyone else, rather than a control
    that answers 403.
- **Saving re-prices every line**, pending ones included — a pending line is exactly the
  one an approver is about to judge. `repriceLine` re-derives `final_cost`, `verdict`,
  `best_platform`, `best_payout`, `profit`, `roi`.
- **The funding target does not move.** It is shelf × qty over approved lines; a discount
  we hope for is not money the cards can be short by.
- **It is not frozen by `funded`** — an auditor still has to be able to state what a
  transaction they are closing actually cost. Only `closed`/`cancelled` stops it.

### Correcting a line after it was sent in
*(This half is desk-only — unlike the cost stack above.)*
A misread shelf ticket used to mean pulling the whole request back and rebuilding it to
fix one number, which in practice meant approving it wrong instead. `cart/line`'s
**patch** branch now takes size / qty / shelf price from a cost-privilege holder while
the request is `draft`, `submitted` or `approved` (the buyer still only in `draft`), and
re-prices the line when the shelf price moved.

**Shelf prices freeze at `funded`** — the same freeze approvals get, and for the same
reason: `approved_amount` is the target the gift cards were issued against, and moving it
afterwards would rewrite what the money was released to cover. From there the **receipt**
records what was actually paid.

Both writes land in `buy_cart_events` (`costs_edited`, `line_edited`) with the
before-and-after in words — "Store discount 0% → 20% · Sales tax 0% → 8.25% — 1 line
re-priced". A record that says something changed and not what it used to be is not a
record of anything. **No schema change**: `cost_stack` is already JSONB and the event
`kind` column is free text.

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
- **The snapshot bends in exactly one place**: an edit to the COST side (above) re-derives
  the call, because the frozen number was computed against rates that have just been
  declared wrong. The MARKET half — `alias_price`, `stockx_price`, `liquidity`,
  `quoted_at` — is never refreshed, so the call still answers "at the prices the buyer was
  looking at".
- **No market price means NO call, never a Pass.** "We didn't look" and "we looked and
  it's bad" are different answers to somebody deciding whether to spend, and the line
  renders *Not priced* rather than an empty chip.

### Showing the working, and pricing a line that never got one
**A line opens.** Clicking a row expands the Payout Calculator's own verdict card for
that pair — chip, "lands at … a pair", profit / ROI / platform, the risk band, the
calculator's sentence, and the Alias and StockX prices it was computed from with the date
they were quoted. A chip on its own is a number nobody can check, and the same call read
on the request and on the calculator must not look like two tools' opinions.

- The **numbers** come off the stored snapshot; only the **prose** (note, risk, spread) is
  re-derived, by `lineCall` in `BuyCartAdd.jsx`, from the same inputs the server used. One
  source of truth for anything a person decides on.
- `best_platform` stores the KEY. Print it raw and the row reads "via alias" beside a
  calculator saying "via Alias".

**`cart/price-line` re-reads the market for one pair.** The snapshot rule assumes there
*is* a call — a pair added while api.alias.org was running 20–45s TTFB stored no market
price, reads *Not priced* forever, and there was no way back short of deleting the line
and re-adding it, while the same SKU prices fine an hour later.

- Same people as the cost stack (`canWriteCosts`): the buyer on their own request, or
  either desk. Pricing writes the number an approval is judged on.
- **Explicit and named, never automatic.** `line_priced` carries the prices it found and
  what the call was before — an approver who re-prices has chosen to look at today's
  market instead of the buyer's, and the record says so. The button says as much.
- **Finding nothing is not an error, and must not be written as one.** Both sources empty
  answers 200 with `priced:false` and a sentence; writing two more zeros is what created
  the problem this endpoint exists to undo.
- **An inexact StockX match needs CORROBORATION.** `stockxProductForSku` falls back to
  the first search result when no product carries the style code, flagged `exact:false`.
  The calculator shows that to a person; here it would be *stored* as the call an approval
  is judged on — probed with `ZZ0000-999` and it came back a confident **"$264, BUY"** off
  a Nike Vomero. But refusing every inexact hit throws away real prices, because StockX's
  styleId formatting often differs from the code on the box (`IO8116-600` is inexact and is
  the right shoe). So Alias decides: **Alias priced it too** → the code is a real shoe and
  there is a second opinion beside it, use the hit and say "matched by name" in the trail;
  **Alias found nothing** → nothing says the code exists, refuse, and name the shoe it
  nearly used so the buyer can check what they typed.
- Basis is kept (`line.basis` → `consigned`), so a re-price cannot quietly switch which
  question was asked.
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

## The screens (2026-09-07)

**No `window.prompt` anywhere in this flow.** Six of them were doing real work on the
money screens, and a native prompt is the wrong tool three ways: it can't be styled, it
can't hold two questions at once, and it can't validate — a blank purpose or an empty
reason reached the server looking exactly like a real one. `FormModal`
(`src/components/common.jsx`) replaces all six: a floating modal with labelled fields,
required-checking, and the failure held *inside* the modal with the text still in the box.

- **Starting a request asks both questions at once.** As two chained prompts, answering
  "what are you buying" and then cancelling "which store" threw the first answer away
  with nothing on screen to say it had happened.
- **It is deliberately not auto-focused.** On iOS Safari a programmatic `focus()` sets DOM
  focus but suppresses the keyboard, and the people using this are standing in a shop on a
  phone. See the same rule on Receiving.
- **The submit handler calls the API directly rather than through `act()`.** `act` catches
  its own errors into page state and never throws, so a modal built on it would close on
  failure and bin the typed reason.
- Inputs are **15px**: iOS Safari zooms the whole page when a focused field is under 16px,
  and a zoomed page inside a modal can't be undone one-handed.

**The list is cards under 768px.** The queue table is nine columns; sideways it is
unreadable and it drags the document with it. The phone rendering is not the table with
columns dropped — it is ordered the way a buyer reads it: which request, where it has got
to, what it is for, then the money.

⚠️ **The list card classes are `bc-list-card…`, NOT `bc-card…`.** `bc-cards` was already
the gift-card section on the *detail* screen (`<section className="card bc-cards">`), so
a `.bc-cards { display: none }` written for the list hid every gift card on desktop —
"Show code" vanished and only the e2e test noticed, because `toContainText` reads hidden
text happily while a click on it times out.

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
- **New tables + a `users.privileges` column → `db:setup`** on local and prod
  (`docs/context/deploy.md`). The migration also folds anyone who held the short-lived
  `gc_issuer` / `auditor` roles back onto a real job title with the matching privilege.
- `PriceInput` hands its `onChange` the **event**, not the value. Every price box on
  these screens was silently storing an event object at first, and the failure is
  invisible — the field looks like it took the input while everything downstream becomes
  NaN.
- **`Number(null)` is 0, and a stored zero is a claim.** `cart/line` used
  `Number.isFinite(Number(l.profit))` to decide whether a field was present, so every line
  added without a market price stored `profit = 0, roi = 0` and rendered "$0.00 · 0.0% via
  —" — a priced pair worth nothing, rather than a pair nobody priced. Absent has to stay
  absent (`num()` / `money()` at the top of the file).
- **`.table` had no CSS rule anywhere.** All four tables here shipped against a class that
  did not exist, so they rendered as bare browser tables — no cell padding, no row rules,
  headings jammed together until "Call" and "Status" read as one column called "Call
  Status". Defined now in the buy-cart block of `styles.css`, alongside a `.num` class for
  the money columns.
- Nothing here touches `items`, so `PH_EXCLUDED_KINDS` and `items.pre_sell` are not in
  play. The PO it raises is an ordinary shipment and follows all the usual rules.
- All timestamps go through the EST helpers (`src/lib/format.js`).
