# Buying requests — approved money out, verified inventory in

> **Renamed 2026-09-11.** It was "Gift-card buying", which named the FUNDING and not
> the process — nobody here is buying a gift card. A buyer asks to purchase stock, we
> approve it, the desk funds them with cards to spend in the shop, they ship, we
> receive and reconcile. The cards are step 3 of ten. **Copy only**: the routes
> (`/buy-carts`, `/ph/gift-card-buying`, `/buying`), the tables (`buy_carts`…), the
> handlers (`api/cart/*`) and the `BC-####` codes are all unchanged.

Screens: `src/screens/BuyCarts.jsx` (queue) → `src/screens/BuyCart.jsx` (one request),
with `src/components/BuyCartAdd.jsx`, `BuyCartCosts.jsx`, `BuyCartGiftCards.jsx`,
`BuyCartReceipt.jsx`, `BuyCartPack.jsx`, `BuyCartTasks.jsx`.
Endpoints: `api/cart/*` (21). Shared rules: `api/_lib/buycart.js`. Crypto:
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
3 Funding      gift cards, or a company card charge
4 Receipt      buyer uploads — required
5 Parse        paste / PDF / OCR → review table
6 Pack      ─────────────────────────►  po_lines, ONE MANIFEST PER BOX
                 each pair into one box   (a box holds many pairs)
7a Money audit  cards/charge vs receipt  8 Ship + 17TRACK
7b Goods audit  receipt vs received      9 Receive box by box
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
| `request_buying` | **the buyer's side (2026-09-15)**: see the Buying Requests card on the supplier portal and use `api/cart/*` at all |

- **admin/superadmin hold all four implicitly** (`isPrivileged`), and are never looked up.
- **A `supplier` can hold only `request_buying`.** `setUserPrivileges` and `db:setup`
  both strip the three staff duties from a supplier row (`ARRAY(SELECT … WHERE p =
  'request_buying')`). A buyer with `approve_buying` would sign off their own request,
  which is the single thing this process exists to prevent — so it is enforced in two
  places, not asked politely of the UI.
- **Buying is switched on per supplier, not per role.** Most suppliers only ship boxes.
  `requireBuyerAccess(req, res, user)` (`buycart.js`) sits right after the role check on
  every one of the 15 `api/cart/*` endpoints a supplier can reach (`list`, `get`,
  `create`, `line`, `submit`, `receipt*`, `file*`, `comment`, `pack`, `gc-reveal`,
  `raise-po`): staff and admin pass straight through, a supplier is looked up fresh and
  answers **403 "Buying requests aren't switched on for your account"** without it. The
  supplier portal draws the card, and serves `/buying`, only for `hasPriv(user,
  'request_buying')` (a typed `/buying` lands on home). Check Access offers a supplier
  exactly that one checkbox (`BUYER_PRIVILEGES`) and staff the other three
  (`STAFF_PRIVILEGES`); `hasAnyPriv` — what draws the staff Home card — counts staff
  duties only. Guarded by the last test in `e2e/buy-cart.spec.js`.
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
- **warehouse / admin** — Home → *Buying Requests* (`/buy-carts`), drawn only for a
  holder.
- **PH team** — PH home → *Buying Requests* (`/ph/gift-card-buying`). PH has its own app
  and never touches the staff router, so it needs its own route; without one a PH member
  ticked for gift cards had nowhere to go, which is the exact case the model exists for.
- **buyer** — supplier portal → *Buying Requests* (`/buying`).

## The money
**Funding target = Σ (shelf_price × qty) over APPROVED lines, PLUS the sales tax on the
request's cost stack** — `buy_carts.funding_target`, recomputed by `recalcCartMoney` with
every change to the lines, the cards *or the stack* (`setBuyCartCostStack` now calls it).
`approved_amount` stays the sticker sum (what was approved); `fundingTarget(cart)` in
`buycart.js` reads the taxed figure and every consumer — the gift-card release check, the
`cards_recorded` closing condition, the panel, the Telegram summary — goes through it.

**Why the tax went in (2026-09-16).** The target was the sticker alone, with an amber
"till overrun" warning beside it. On a full-price purchase that meant every request came
up short by exactly the tax — $400 of cards against a $422.18 receipt — and the audit
then had a gap to explain on every one. The warning is gone; the number it warned about
IS the target. Still no discount assumed: it over-funds deliberately on a discounted
purchase, because a card that comes up short strands a buyer in a shop while a leftover
balance is money still ours, and step 10 accounts for it either way.

- `cart/get` adds `fundingTaxPct` for anyone who can read the stack (`canSeeBuyCall`);
  the buyer's copy carries `funding_target` (the number their cards will hold) and
  `null` for the rate, since the stack is redacted for them.
- The strip reads **Approved $390.00 · To fund $422.18 incl. 8.25% tax**; the gift-card
  panel says *against $422.18 to fund ($390.00 approved + 8.25% tax)*; the 409 on release
  names both.
- `db:setup` backfills `funding_target` for existing rows. **Needs `db:setup`.**

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

## Telegram approvals via Make.com (2026-09-11)
The desk approves from a Telegram group instead of the screen. Our half is the two ends;
Make.com is the middle. Full build guide, including the Make module wiring and the
Gemini question: the **Telegram Approval Loop** artifact.

### What our system does
- **Every payload carries `env: "dev" | "prod"`** (`notifyEnv`, off `APP_ENV`, which
  `vite.config.js` pins to `dev` and Railway never sets). Dev and prod share one bot, group
  and webhook; Make appends the env to each button's `callback_data` and posts the tap to
  the dev tunnel or to `stickballman12.com` accordingly. Missing = prod.
- **Out:** `api/_lib/notify.js` POSTs one event per line to `MAKE_WEBHOOK_URL`. Fired by
  the BUYER's add only (a desk adding on their behalf is data entry, not a question), and
  fired **after** the market read so the card carries the buy call rather than "not
  priced". Fire-and-forget with a 10s timeout — a Make outage must cost a buyer standing
  in a shop nothing.
- **Photo:** `GET /api/cart/shoe-photo?fileId=…`, header `x-api-key: $BUYING_API_KEY`.
  Key-gated and login-free, the `api/listing/ebay.js` pattern — a scenario cannot hold a
  session, and handing Make somebody's login would make every approval look like theirs.
- The payload carries a ready-written **`caption`**, deliberately: a card that says BUY
  while the screen says Pass, because a scenario was edited, is the failure worth a field.
  Four labelled blocks, blank-line separated — on a phone in a group chat a wall of
  dot-separated values is one long line to squint at, and the order is the order an
  approver decides in: what it is, what it costs, what it earns, what we already hold,
  then the paperwork.
- The **shoe's name leads**, on its own line above the style code. A code identifies the
  pair for whoever is holding it and for nobody else; an approver reading a group chat
  knows the name. It is dropped entirely when we have none, so a card never opens blank.

```
Air Jordan 1 Retro High OG 'Chicago'
CW2288-111
Size: 9
Shelf $50.00 · costs us $63.05/unit

Payout Engine Result:
Decision: BUY
Profit: $61.39
Alias: $137.00 ask · 98.9% ROI
StockX: $93.00 ask · 34.9% ROI

Inventory:
None of this size on hand (6 in other sizes).

BC-2400
Supplier: E2E Buyer
Store: E2E Store
```

  Two degradations that matter: an **unpriced** line replaces the three Decision lines
  with *"Not priced — no Alias or StockX market for this size right now"* rather than
  printing an empty verdict ("we didn't look" and "we looked and it's bad" are different
  answers), and **`costs us` is read off the line, not the call** — what a pair costs is
  its shelf price through the cost stack, which exists whether or not the market
  answered.

  **One line per platform we hold a price for**, carrying its LOWEST ASK and its ROI — a
  line with only an Alias market shows one, so it is not a fixed two-line block. The ask
  is there because nobody can sanity-check a percentage against a shoe they know, and
  everybody can check a price.

  **The WINNING platform leads**, because `Decision` and `Profit` above are its numbers.
  Sorting on ROI alone would have put the loser on the top line: `dealVerdict` does not
  simply take the biggest ROI — a slow seller can lose to a smaller, faster margin. The stored snapshot keeps
  only the WINNER, which is enough to make a call and not enough to judge one: two
  platforms agreeing and two disagreeing are different decisions. Both are re-derived
  through `calcPayout`, the same function the calculator and the screen run, so they
  cannot drift from either; `call.platforms` carries the money per platform. `Profit:` is
  the winner's and is deliberately not repeated beside its own ROI.

### Request-level events on the same webhook (2026-09-16)
`notifyRequestEvent(cartId, event)` posts `buying_request_closed` / `buying_request_reopened`
to the same `MAKE_WEBHOOK_URL` — `{ event, sent_at, request:{ id, code, buyer, retailer,
purpose, status, line_count, pending_count, approved_count, rejected_count,
approved_amount, funding_target, gc_total }, caption }`, no `line`, no `photo`, no
`decide`. Make scenario 6231985 routes on `event`: the line event (or a missing field)
takes the photo card + buttons; these two take a plain `sendMessage` with the caption
verbatim (**no parse mode — keep the caption plain text**); anything else is dropped
silently. The caption is built here for the same reason the line card's is:

```
BC-2400 — Test Supplier closed the request
7 pairs asked · 4 approved · 2 still waiting · 1 turned down
Approved $390.00 + 8.25% tax = $422.18 to fund
Store: Champs
```

Fire-and-forget after the write, logged either way, and a blank URL refuses out loud
like the line card. The desk funds a TOTAL: a closed list is a total that is now final,
a re-opened one is a total about to move — possibly after cards went out.

### `kind='shoe'` and nothing else
A static key plus a numeric id is enumerable. That is a fair trade for photographs of
shoes; it is not one for the other two things in `buy_cart_files`, which are keyed by the
same sequence one integer away. **A gift card image is a bearer instrument** and a receipt
is somebody's financial record — both answer **404** to a perfectly valid key, and the
kind is read off the ROW rather than taken from the query string so a caller cannot widen
what they may read by asking differently.

### In: a Telegram tap becomes a decision
`POST /api/cart/telegram-decide`, header `x-api-key`. Make posts this when somebody
presses a button on the card.

**The first tap captures its own id.** Nobody can read their own numeric Telegram id off
their phone, and an admin cannot link an account they cannot identify — so refusing with
"go and find your id" was a dead end for both of them. An unlinked tap is still REFUSED
(a decision has to name a person), but the number and the Telegram display name land in
`telegram_link_requests`, and Check Access offers them as a **"Link to…"** picker above
the account table. Linking clears the row; the next tap goes through.

The display name is untrusted and only ever shown to an admin choosing which account a
row is — a Telegram name is changeable at will. The **id** is the identity.

**Also linkable by hand on Check Access** — a Telegram column beside the privilege checkboxes,
`decision: 'telegram'` on `api/admin/review.js`. A blank value unlinks; a **buyer can
never be linked** (a linked supplier is one tap from looking like an approver in the
group); two accounts cannot share an id, because ambiguous attribution is the one thing
this map exists to prevent. `@userinfobot` in Telegram gives somebody their number, and
the refusal below names it too.

**A button is not an identity, and that is the whole endpoint.** Everyone in the group can
press one, and the API key proves only that the request came from the scenario — never
who tapped. So the decision is recorded against `users.telegram_user_id`, and an
unrecognised Telegram account is **refused** rather than recorded against nobody. Checked
here rather than in Make: a control living in a scenario is a control anyone with the Make
login can edit.

- The privilege is re-read from the database on the call, like every other privileged act
  — revoking `approve_buying` this morning stops them this morning, Telegram included.
- **The key alone approves nothing.** A linked account without the privilege is refused
  and NAMED, so the group sees who cannot rather than being told "no".
- `qty` is accepted as a bare number (what `callback_data` can carry for one line) or as
  the `{ lineId: n }` map the screen sends. Both front doors run the same
  `decideLines` — two decide paths that drift would let a tap record something the screen
  would have refused, and the screen is where the audit gets read.
- **An approve still needs a quantity**, so Approve cannot be one button. Use quantity
  buttons: `approve:<lineId>:2`. A reject needs none.
- The response carries a worded **`outcome`** (*"Alex approved · 3 pairs"*) and a
  **`reaction`** (👍 approve / 👎 reject) for `setMessageReaction`, so Make can stamp the
  card and EDIT the original message.

  Both are decided server-side for the same reason the caption is: what the group SEES
  and what the ledger RECORDS must be one decision. A scenario picking its own emoji can
  put a thumbs-up on a rejection, and people believe the emoji — it is the thing you can
  read from across a warehouse without opening anything. A group where every decision leaves a live button behind is
  a group where somebody taps yesterday's.
- A repeated tap answers **409**, not a second decision — Telegram redelivers a callback
  that is not answered fast enough, so this is the ordinary case rather than an edge one.
  **The guard is in the UPDATE's WHERE clause, never a read-then-write:** two callbacks
  racing both read the line as `pending` and both committed, and real data carried the
  same approval twice under the same name. Pinned by a test that fires both taps with
  `Promise.all` and asserts one 200, one 409, and exactly ONE `line_approved` event.

Guarded by six tests in `e2e/buy-cart.spec.js` § "a Telegram tap is a decision".

### ENV — all three, or it fails quietly
| Var | Unset means |
|---|---|
| `MAKE_WEBHOOK_URL` | no card is ever sent — but the server now LOGS a line saying so. It used to return in silence, which is not distinguishable from a send that worked (see below). |
| `BUYING_API_KEY` | the photo endpoint answers 503. **Generate a fresh one per environment.** |
| `APP_BASE_URL` | **`photo.url` is `null`** — the card goes out with no picture and no error anywhere. This is the one that fails silently; the other two announce themselves. |

`APP_BASE_URL` is the absolute origin, no trailing slash (`https://app.example.com`).

**Keeping the e2e suite out of the group.** The suite builds real requests and deletes
them, and a buyer's add POSTs a card — so every local run put approval cards in front of
the desk for pairs nobody is buying, and tapping one afterwards answered *"that buying
request does not exist"* because teardown had removed it. It is stopped by
`playwright.config.js` blanking `MAKE_WEBHOOK_URL` for the server it starts, the same way
`TRACKING_API_KEY` is blanked for 17TRACK.

**Not by a guard on `APP_ENV`** — that was tried and reverted the same hour. 17TRACK can
use that flag because nobody registers parcels by hand from a dev server; this feature is
*exercised* from one, by a person, and `vite.config.js` forces `APP_ENV=dev`. So the guard
swallowed every real card from `npm run dev` while returning silently, which looked
exactly like Make dropping them — two rounds of debugging the wrong half of the system.
**A control that cannot tell a test run from a person doing their job is an outage with a
rationale.** Every send and every refusal now logs (`[notify] BC-#### SKU/size → Make 200`),
because "we never sent" and "we sent and it was dropped" are different problems and used
to look identical from here.

**`npm run mobile:tunnel` now sets it for you.** The tunnel is opened BEFORE the server
so the hostname can be passed in — it could never be set afterwards, which is why a
preview used to emit `http://localhost:5173` as `photo.url`. That is worse than sending
none: Make's HTTP module sits in front of `sendPhoto`, so an unfetchable link killed the
whole scenario and **no card appeared at all**. `notify.js` now refuses to emit a
localhost origin and says why in `photo.unavailable`.

## The floor's actual workflow (2026-09-11)

### Adding a pair IS asking about it — and the list stays open until the buyer closes it (2026-09-16)
There is no "send for approval" for a buyer. `cart/line` marks the request `submitted`
on their add (`askBuyCart`) and posts the Telegram card — a trip that ends with the buyer
remembering to press Send is a trip where the first pair sat unasked for an hour, and by
then it has usually gone.

What the buyer presses at the end of the trip is **Close the request** (`cart/submit`,
same route name; `closeBuyCartList` → `buy_carts.list_closed_at` / `list_closed_by`).
It carries the old send's checks — a purpose, a store, ≥1 line, a photo per SKU — and
it is what lets the gift-card desk act: **no card can be recorded against a list still
growing** (`cardsIssuable` in `src/lib/buycartRules.js` = list closed AND status
approved/funded AND no pending line; `cardsRefusedBecause` is the 409 text and the
panel's note). The group is told (`buying_request_closed`, below).

- **Adds are allowed while the list is open** on `draft` / `submitted` / `approved` /
  `denied` / **`funded`** (`buyerCanAdd`). `funded` is new: a buyer who finds the cards
  short, or one more pair on the way out, **re-opens** the list (`{ reopen:true }`,
  `reopenBuyCartList`, `list_reopened_at`) and adds. The cards already issued are never
  touched; the new lines raise the target once approved, and the desk records a **top-up
  card** after the buyer closes the list again. The group is told
  (`buying_request_reopened`). Re-opening stops at `receipted` — the purchase has
  happened; anything else is a new request (`reopenRefusedBecause`).
- **Decisions on a funded request are pending-only** (`decisionsPendingOnly`,
  `DECISIONS_PENDING_ONLY = funded/receipted/audited`): the approvals the cards went out
  against are frozen, overrides included — `decideBuyCartLines({ pendingOnly })` filters
  the targets in the query — while a pair added since can be approved or turned down.
  The cart's status stays `funded` (the settle `WHERE status IN (submitted, approved,
  denied)` leaves it alone). The no-decide note says which.
- **Removing a line** (`cart/line { remove }`): only a **pending** one, ever. The buyer
  may withdraw their own pending pair while the list is open (the × on the row); a desk
  with a cost privilege may remove a pending line too; a decided line is part of an
  approval and answers 409 by name. The old "Pull it back" (withdraw to draft) is gone
  with the send button — `withdrawBuyCart` / `submitBuyCart` were deleted.
- A desk adding a line on somebody's behalf is data entry, not a question — it leaves
  the status alone, and a draft stays a draft (no decisions) until the buyer either adds
  a pair themselves or closes the list, which moves `draft → submitted`.
- Adding to a fully-decided request pulls it **back to `submitted`** (below `funded`).
- **The photo is checked on the add**, because for a buyer the add is the close.
- **Screen:** `ListChip` beside the status — *Buyer still adding* (amber) or *List
  closed*; the queue rows carry the same. The buyer sees the add form for as long as
  `buyerCanAdd`, a *Close the request* button (disabled with no lines), and after
  closing a note + *Re-open to add more* (a `FormModal` that says the desk is told and
  the cards stay). The gift-card panel appears only once `cardsIssuable` or cards exist.
  The milestone bar keeps an `approved` request with an open list at *Waiting for
  approval* — the desk cannot fund it yet. `carts_to_fund` counts `approved` **and**
  list closed, so a request still being added to is not on the desk's pile.
- **Lines are ordered by shoe, in the order each shoe was first asked about, sizes small
  to large** (`getBuyCartFull`: `ORDER BY min(id) per sku, numeric part of size, size,
  id`). A 9 added an hour after the 8 and the 10 lands between them.
- **`db:setup` one-shot backfill** (`app_settings.migr_buy_carts_list_closed`): every
  request already past `draft` is stamped closed, so nothing already approved is
  refused a card. Guarded by the marker because under the new flow a `submitted` row
  with a NULL `list_closed_at` is a buyer still adding, and a re-run would close it
  under them. **Needs `db:setup`.**

Tested in `buy-cart.spec.js` → "the list stays open until the buyer closes it".

### Several sizes in one ask
The size chips multi-select. One press creates one line per size, sent in sequence — each
add re-reads the market server-side, and forty at once would be forty simultaneous Alias
calls off one button.

**One price for the run, with exceptions.** `Price on the shelf` is what every selected
size costs, which is the ordinary case and stays one field. Pick a second size and a
per-size row appears beside each one; **blank means the shelf price**, and the placeholder
shows the figure a blank box will actually send — a row reading `$0.00` next to a size is
the kind of thing somebody "fixes" by typing a zero. Deselecting a size drops its override
with it, so a price typed for one shoe cannot come back on the next.

It is done BEFORE the add, not after, and that is the whole reason it lives in the form:
**adding a line posts a Telegram card with the price written into its caption.** Re-pricing
afterwards would leave the group holding a card that quotes a number the request no longer
carries, and the group is where the decision gets made. A price that is wrong after
sending is a remove-and-re-add (the × on a pending row), not an edit.

### The cost stack is the desk's too (2026-09-11)
It moved the same way the buy call did, and for the same reason: **the stack is what turns
a shelf price into a profit, so it is the basis on which a request gets approved or turned
down.** The party being judged does not read the ruling before asking.

This reverses the earlier "the buyer writes it first" rule. That argument was good as far
as it went — the buyer is the one reading the tax off the register — and it missed what
the stack is FOR.

- `canWriteCosts` refuses a supplier outright; `redactCartForViewer` sends them
  `cost_stack: null`, and `cart/get` drops the till-overrun warning with it (a number
  computed from rates they cannot see).
- **`final_cost` joined `CALL_FIELDS`.** It was deliberately excluded while the stack was
  the buyer's own; once the stack moved, what a pair "lands at" was derived entirely from
  figures they cannot see, and showing it would hand them the stack one subtraction away.
  The buyer's table has no *Lands at* column and no cost card at all — read-only chips
  would be a row of empty boxes explaining an arithmetic they cannot see.
- **The buyer keeps the shelf price.** It is the one figure they stated.

### Two guards that read `!== 'receipt'` and should not have
Both swept in the new shoe photos and treated them as gift cards:
`cart/file-sign` / `cart/file-attach` demanded `issue_gift_cards` to upload one, and
`cart/file` answered *"These cards have not been released to you yet"* when the buyer
opened **their own photo** on an unfunded request. All three now key on
`kind === 'gift_card'` specifically.

The written process and what the floor does had drifted apart. Reconciled against a
whiteboard: **supplier hunts → sends size, price and a PHOTO → Alex/JK approve → Alex/JK
set the quantity**, and *sometimes Alex overrides JK's decision*. The gift-card funding
step is unchanged; only who says what moved.

### The buyer states no quantity
`buy_cart_lines.qty` is **nullable and NULL until a line is approved**. The buyer is
standing in a shop reporting what they FOUND — this shoe, this size, this ticket price —
and how many to buy is the decision being asked for, not part of the question.

- `cart/line` writes `qty = null` on every add, whoever adds it.
- `cart/decide` takes `qty` (a `{ lineId: n }` map) and `qtyAll` (for approve-all), and
  **refuses an approve with no number, naming the pairs**: *"Say how many to buy: 2 lines
  have no quantity (IO8116-600 size 10, IO8116-600 size 8)."* Defaulting to 1 was the
  tempting version and it is exactly the number that would get funded if nobody looked.
- A **reject needs no quantity** — there is nothing to buy, and a rejection also CLEARS
  one. Turning down a line that had been approved for 2 used to leave `qty = 2` sitting
  beside "Rejected", which reads as *buy two of something nobody approved* on the row a
  person checks before spending. What the refusal reversed survives as `overrode_qty`.
  (Every downstream reader — the funding total, the receipt match, the pack list —
  filters on `status = 'approved'`, so the stale number was never spendable. It was
  worse than that: it was wrong in the place people read.)
- `lineOut` no longer coerces `qty` to 0. `Number(null) || 0` printed "×0" on screen and,
  worse, made "does this have a quantity" look answered when it is the question.
- The funding target is unchanged — shelf × qty over approved lines — and now every
  approved line has a quantity a person chose.

### One approver can override another
`overrode_by` / `overrode_status` / `overrode_qty` on the line. A decided line can be
re-decided while `decisionsOpen` (so never after the cards are out), and the row keeps
what it replaced: the screen reads **"JK said approved ×3 — overridden"** under Alex's
decision.

The floor says this happens, and a system that refuses it just moves the conversation
somewhere nobody can audit. What it must never do is let the last write present itself as
the only one. **No hierarchy is coded** — Alex does not outrank JK in the schema, because
that puts people's names in the source and breaks the day someone leaves. Re-deciding to
the same status AND the same quantity is a no-op, so pressing approve-all twice does not
invent a history of reversals.

### Every shoe needs a photo, keyed by SKU
`buy_cart_files` gains `kind='shoe'` and a nullable `sku`. `cart/submit` refuses while any
style code on the request has no photo, naming them.

**Per SKU, not per line.** A buyer sending a 7, an 8 and a 9 of one shoe photographs it
once and all three lines show the same shots — photographing it three times is work nobody
does twice. The approver is deciding on something they cannot see, in a shop they are not
standing in, off a style code four characters from a different shoe.

- Uploading one is open on the same terms as a receipt (the buyer's own evidence). The
  `issue_gift_cards` guard now keys on `kind === 'gift_card'` specifically — it used to be
  `!== 'receipt'`, which would have locked the buyer out of their own photo.
- The bytes are **proxied** like every other file here; `ShoeShots` fetches with the
  session token, makes an object URL and revokes it on unmount. It has **three** states —
  loading, loaded, *failed* — because a thumbnail stuck on "photo…" reads as a slow
  network, so nobody reports it and the approver quietly decides without it.
- The key pattern in `cart/file-attach` admits `shoe-` as well; leaving it out made every
  attach answer "Invalid file key".

> **Testing note.** `newRequest` seeds a shoe photo per SKU and STAMPS the submit rather
> than posting it — `cart/submit` is capped at 30/min and this helper runs forty-odd
> times, so going through the endpoint 429'd unrelated tests at the end of a run. The
> tests that are actually about sending call it directly.

## The buy call is the APPROVER's (2026-09-11)
`canSeeBuyCall` / `redactCartForViewer` / `redactLineForViewer` in `api/_lib/buycart.js`.

A line's call — the BUY/WATCH/PASS verdict, the profit, the ROI, the payout and the
Alias/StockX prices behind them — is what the approver is judging. The buyer is the
party being judged. Knowing a pair reads as $60 profit is knowing exactly how much room
there is to argue; knowing it reads as a Pass before you have asked is knowing not to
ask honestly. **The buyer is not blind about the market in general** — the supplier
portal carries the Payout Calculator scoped to their own preset. What is withheld is
OUR call on THEIR request.

Two separate guarantees, and only one of them is about visibility:

| | Enforced where |
|---|---|
| A buyer never **sees** the call | `cart/get` (and every other endpoint returning a cart) strips it from the lines **and from the event trail**; `cart/price-line` answers 403 |
| A buyer never **writes** it either | `cart/line` ignores any call a supplier posts and reads the market itself |

The second one was a hole before it was a visibility question. `BuyCartAdd` used to fetch
Alias and StockX **in the buyer's browser**, compute the verdict, show it, and POST it —
so the party requesting the money supplied the figures justifying its release. A crafted
request could arrive reading "buy, $180 profit" with no market behind it at all. Staff
still post their own screen's snapshot (the calculator is the only place those numbers
are derived); a supplier's is discarded.

- **The trail is redacted, not deleted.** `line_priced` becomes *"Priced. The figures are
  on the approver's copy of this request."* and `line_added` loses its trailing
  `— buy`. A record that vanishes for one reader is worse than one that is brief: the
  buyer can still see that the market was read against their request, and when.
- **`final_cost` is NOT part of the call.** It is the buyer's own shelf price run
  through a cost stack they can read and edit on the same screen — hiding an arithmetic
  result from its own inputs would be theatre. "Lands at" stays on their table, and is
  derived server-side so it is true even when the market cannot be read at all.
- **Redaction is applied at every endpoint that returns a cart**, including the ones a
  supplier cannot reach today. It is a no-op for staff, so it costs nothing, and a
  privilege that changes later cannot open a hole nobody re-audited.
- The buyer's screen loses the Buy call column, the call panel and the verdict on *Add a
  pair*; rows only expand for them once the stock panel has something in it, because a
  row that opens onto an empty box reads as a bug.
- **`canPrice` is `mayDecide || canAudit`**, mirroring the server's `canWriteCosts`.
  It used to be `canCost`, which is the *cost stack's* rule and wrong twice here: true
  for a buyer, and gated on `canDecide`, which is closed on a draft — so an approver
  looking at an unpriced line before it was sent in had no way to price it while the
  endpoint would happily have accepted it.

### Pricing happens AFTER the response, not during it
`priceInBackground` in `api/cart/line.js`. A buyer's add returns immediately with
`final_cost` only; the market read and the call land on the row a few seconds later,
logged with **no actor** so the trail reads as system-generated rather than crediting
the buyer with a call they may not make.

**Measured: 16,034 ms → 246 ms.** Alias runs ~16s on an ordinary day and 20–45s on a bad
one, and pricing inline made *Add to request* hang for all of it — the difference between
a tool you use on a shop floor and one you stop using. Nothing is lost by deferring it:
the buyer is not allowed to see the call, and the approver reads the line minutes or
hours later. If it fails the line simply stays unpriced, which is an ordinary state with
a way back (*Price it*) and the same one a timed-out quote has always left.

It is also the same **single** upstream read, moved rather than added — tapping a size
used to block on a quote, so a buyer trying three sizes and adding one spent three calls
and now spends one.

> **Testing note.** `newRequest`'s lines are added by STAFF by default (`linesBy`),
> because a buyer-authored line now costs one real Alias/StockX call; at thirty-odd tests
> that is minutes of suite time and an outage away from red. The buyer-authored path has
> its own test and pays for one call there.

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

## What we already hold (2026-09-10)
`api/cart/stock.js` · `stockOnHandBySizeForSku` in `db.js` · `StockPanel` in
`BuyCart.jsx` · **What do we already hold?** above the lines.

The request answered what a pair costs and what it would sell for, and said nothing
about the six already on our own shelves. An approver reading a healthy ROI had no way
to see that PH is still trying to move last month's, so the same shoe got bought again —
and the buy call, which is about the *market*, would go on saying BUY every time.

**It loads with the request for the desk** — anyone holding approve or audit, on a request
that is not closed/cancelled/written off. It was a deliberate press because it calls
Shopify, and that was the wrong call: the one moment the figure decides anything is while
somebody is looking at pending lines, and a number you have to go and fetch is one that
gets skipped on the busy days when over-buying actually happens. It stays a press for a
buyer (they are not the one deciding), and *Recheck what we hold* re-reads it.

Bounded: once per opened request, Shopify cached ten minutes per style, our own half one
indexed query. Every line is read at once because an approver scanning twelve of them
wants to spot the one we are about to buy a third of.

**The basis is Shopify plus what is not yet listed**, and the two halves must not
overlap:

| Half | Why it is the authority for it |
|---|---|
| **Shopify** for pairs we have LISTED | every channel lands there (`shopify.md`), so a pair that sold this morning is already off its count while our own `items` row reads in-stock until somebody scans it out |
| **Our own `synced_shopify = false` units** | Shopify cannot see these at all — still being priced, no-box, in-store, existing stock, held pre-sell — and reports zero for them, correctly |

So the seam is **`synced_shopify`**, and `we_hold = shopify.qty + ours.not_listed`. Our
own count of *listed* pairs is deliberately **not** added: it is the same shelf Shopify
already counted, and adding it tells an approver we hold ten when we hold five, which
turns down a buy we wanted.

- **`pre_sold` is reported beside the count, never inside it.** "We hold 6" and "we hold
  6, 2 of them spoken for" lead to opposite decisions (`pre-sell.md`).
- **The no-box / in-store / pre-sell tags are subsets of the not-listed half**, not
  additions to it, and the copy says "of them" — the first draft read as double.
- **`kind='boxes'` is excluded outright**: an empty shoe box is not a pair
  (`empty-boxes.md`).
- **Sizes match on an exact trimmed label**, the same rule the advisor's breakdown uses.
  `7.5` and `7.5W` are different shoes on different feet.
- **A Shopify outage is never a zero.** The basis flips to `our_records_only`, the panel
  says which, and the figure becomes our own `on_hand` — never a half-count printed as a
  whole one.
- **The gap is a finding.** Our records saying 8 listed while Shopify shows 0 means ~8
  sold and never scanned out, and the panel says so rather than folding it into the sum.
- **A line with no size gets `we_hold: null`**, not 0 — "we hold none of that size" and
  "this line has no size" are different answers and only one argues for buying.

The row chip goes **amber only when we already hold at least as many as are being asked
for**. Any-stock-is-amber made a single spare pair look like a reason to stop.

Readable by anyone who can read the request, the buyer included — a buyer standing in
the shop is the one person who can still decide not to pick it up, and suppliers can
already ask the advisor the same question (`SUPPLIER_TOOLS`). It is Shopify's belief
plus our own records and the panel says so out loud: **not a physical count**.

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
### Attaching it and reading it are two different permissions
- **Anyone who can reach the request may ATTACH one** — the buyer on their own request,
  and PH / warehouse / admin on any of them (`cart/file-sign`, `cart/file-attach`,
  `canUpload` on `BuyCartReceipt`). It is evidence, it usually needs doing from a phone
  by whoever has the paper, and a request that waits because the one person with the
  button is asleep in another timezone is the problem this process exists to solve.
- **Stating what it SAYS stays gated** (`cart/receipt`, `canEdit`): the buyer, either
  desk, or the auditor. That total is what the whole reconciliation runs against and
  those lines are what the purchase order is raised from — it is a claim about money.
- Somebody who may attach but not commit gets **no review table** after the upload. A
  filled-in form with no button reads as broken rather than as "not your step".
- A **card image** is still the issuing desk's alone — crossing them would let anyone add
  "gift cards" nobody issued, a line in the ledger with no money behind it.
- All three file endpoints refuse a `closed` / `cancelled` / `written_off` request.

### Removing a file
`api/cart/file-delete.js`. Almost always a wrong file — the shot before the one in focus,
a different request's receipt — and leaving those on the record makes "1 file on file"
mean nothing.

- **The record of the removal outlives the file.** `file_removed` is written with the name
  and the actor BEFORE the object is deleted, the same ordering `gc-reveal` follows: write
  that somebody acted, then act.
- **Who:** whoever uploaded it, or a buying desk. Being able to read the ledger is not the
  same as being able to edit it.
- Refused on a `closed` / `cancelled` / `written_off` request — nothing may be pulled out
  from under a reconciliation already signed off against it.
- The ROW must not survive a half-failure; a bucket object that outlives its row is
  litter, a row that outlives its object is a broken download button.

### Reading a photo: the vision model first, tesseract behind it
`api/cart/receipt-read.js`. A phone photo of a receipt is not OCR-able — measured on a
real one at ~132 DPI, tesseract returned **nothing**. The same image through
`gpt-5.4-mini` returned **all ten lines, nineteen pairs, $1,395**, and correctly took the
Net Price over the ticket price on every discounted row. ~$0.0024 a receipt at 1,555
input / 270 output tokens.

- **A PDF never goes to the model.** Its text is already there; paying to look at a
  picture of text we can extract would spend money to lose accuracy.
- **Server-side.** The key never reaches the browser and the image is pulled from OUR
  bucket rather than posted up a second time by the phone. Downscaled to 1500px and
  EXIF-rotated first — image tokens are what the call costs, and a receipt needs nothing
  like camera resolution to be legible.
- **Tesseract is the fallback, not a dead end.** No key, a timeout, a refusal → the
  reader that needs no network and no budget, which sometimes still works.
- Rate limited to 12/min (tighter than the upload — this one costs money per call), and
  every read writes `receipt_ai_read` to the trail **including whether it agreed with the
  receipt's own totals**.

#### The closing checklist shows what is LEFT
Outstanding conditions render at full strength and completed ones recede — it was the
other way round, so the list drew the eye to the work already behind you. Within each
group the outstanding ones sort first, each condition's `detail` sits on its own line
under it (run together they read as one sentence), and each group carries its own
progress bar: the two halves are answerable weeks apart, so a single overall figure hides
which of them is actually holding the request open.

#### The model is a reader, not a decider
It fails differently, and that is the whole design. Tesseract garbles visibly
(`fussssonn 12.8`); a vision model returns a well-formed row with a plausible style code
and a plausible price. **On a money screen a plausible wrong number is the worst possible
output** — it looks exactly like a right one.

So the receipt checks itself (`src/lib/receiptCheck.js`), on arithmetic off the paper
rather than trust in the model:

| Check | Catches |
|---|---|
| rows sum vs the printed **subtotal** | an invented line, or a missed one |
| quantities sum vs **Items Sold** | a misread quantity column — which leaves the money looking reasonable while misstating every unit price on the line |
| subtotal + tax vs the **stated total** | weakest, and last: plenty of tills print no tax line |

A receipt that prints no totals is reported as **unverifiable** rather than passing —
"we couldn't check this" and "this checks out" must never look the same. And a clean read
says so out loud: silence and success reading identically is what stops people looking.

### OCR needs the receipt to fill the frame
A phone photo of a receipt lying on a desk is a narrow strip of grey-on-grey text in a
big frame of wood grain — tesseract measured the one that prompted this at **~132 DPI**
and read *nothing* from it. `sharpenForOcr` (canvas, no new dependency: grey-scale, 3×
upscale, threshold toward black and white) recovered several rows from the same photo.
Measured against the same image and parser, not assumed.

It is not a cure. That photo still yielded 4 of 10 lines with wrong quantities, so:
**rows with no stated total is treated as a half-read** and says so, because half a
receipt looks like it worked and none does not. The empty-result message names the actual
fix — retake it with the receipt filling the frame, or paste the text.

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
- **A DISCOUNTING till prints the ticket price on the item row and what was actually
  charged two lines below it.** The Athlete's Foot shape is
  `IM4613-400 8   3   405.00` / `Discount -285.00` / `Net Price 120.00`, and read at face
  value it stated **$3,320 of spend against a real $1,395**. `Net Price` now amends the
  row it follows (within 3 lines, so a stray one at the foot cannot rewrite an item from
  the top), and `Discount` is skipped without ending that reach.
- **The COLUMNAR row shape**: style code, size, quantity and money in unlabelled columns.
  The bare `3` was being dropped, so three pairs read as one at $405 each. `COLUMNAR_RE`
  is anchored to the whole remainder of the line on purpose — an unanchored bare integer
  would start being read as a quantity anywhere, and a quantity read wrong misstates every
  unit price on the receipt.
- **The receipt's THREE figures are kept, not one.** `receipt_subtotal` + `receipt_tax`
  beside `receipt_total` (**needs `db:setup`**). The review footer asks for all three in
  the order the till prints them and checks them against each other live — `subtotal +
  tax = total`, and the rows against the subtotal. It used to ask for the total alone and
  then GUESS at the gap ("usually the tax"); now that is arithmetic. Blank stays absent,
  never 0 — a stored zero would read as "the shop charged no tax".
  **`balance_remaining` is worked out against the TOTAL**, because that is what the cards
  were charged.
- **Both totals are shown and neither is silently chosen**: what the rows add up to, and
  what the receipt *says*. On a shop receipt they differ by the tax, and that gap is the
  difference between "we read this receipt" and "we read most of it". The **stated**
  total is what the reconciliation runs against — it is what the cards were charged.
- **Every row a reader produced is ticked by a person before it saves (2026-09-16).**
  `unchecked()` marks each machine row `ok:false` (paste, PDF, OCR/AI, email alike); a row
  added by hand is `ok:true` by construction. Rows tint amber while pending and green
  once ticked (`.bc-row-tick`, `.bc-row-pending` / `.bc-row-ok`); **Save is disabled
  until all are ticked** and says how many remain. Editing a field does NOT tick the row
  — somebody who fixed the size may not have looked at the price beside it. The totals
  check catches a wrong sum; it cannot catch an 8 read as a 9, which is what the tick
  is for. `ok` never leaves the browser.
- **Something visibly happens while a read runs.** `ReadProgress` (`.bc-readprog` — NOT
  `.bc-progress`, which is the milestone strip; fifth class-collision near miss) shows a
  bar under the email form / files header: real percent for OCR, elapsed-time against
  an expected duration otherwise (email 18 s, AI 9 s), capped at 95% so it never sits
  at "done" — the result replaces it. The suite covers the ticks
  (`buy-cart.spec.js` → "ticked by a person").
- `source` accepts `email` (server whitelist + the `buy_cart_receipt_lines_source_check`
  constraint — **needs `db:setup`**); before that an email-read line was saved as `manual`.
- `compareReceiptToApproved` flags `bought_unapproved`, `approved_not_bought` and
  `qty_differs`. Approved and bought are different claims and both are kept; where they
  part is a finding for the audit, not something to tidy away.

## The receipt found by its number (2026-09-15)
`api/cart/receipt-email.js` · **`MAKE_RECEIPT_PARSER_URL`** · Make scenario 6282792
"Receipt parser — API → email (Gmail+Yahoo) → JSON", built in the `Make.com Stickballman12`
project (parser source: `~/Make.com Stickballman12/receipt-parser/parser.js`).

The receipt is already in a mailbox — the shop emailed it the moment the buyer paid.
So the receipt card asks for the **order / transaction number** first: the server POSTs
`{transaction_id}` to the scenario, Make searches the ordering mailboxes (Gmail **All
Mail** full-text, and eight Yahoo IMAP folders in parallel through a helper scenario,
6283660), parses Champs / Foot Locker / Kids Foot Locker / Nike in-store / adidas
receipts, enriches with the catalogue (Nike UPC → StockX style id; adidas via our own
`sku-lookup`), and answers **synchronously** (~15 s; Make's ceiling is 40 s, our timeout
45 s). ~28 Make operations a call.

- **A fourth source into the same review table.** Rows come back in the `receipt-read`
  shape (`sku` = style id, falling back to the store code — never a UPC), `source:
  'email'`, and `checkReceiptRead` runs against the email's OWN printed `totals`
  (subtotal/tax/total/item count, `null` when not printed — never computed). The review
  step does not relax because the reading came from the shop itself.
- **The email is filed as the receipt.** Its plain text (`email.text`, ≤64 KB) is
  written to `buy-carts/<code>/receipt-<ts>.txt` through `addBuyCartFile`, which is what
  stamps `receipt_at` — "a receipt was received" stays a closing condition on an
  attached file the auditor can open, whichever way it arrived. Filing failure is a
  warning, not a refusal: the lines still come back and the buyer can attach a screenshot.
- **Which email was read is shown** (subject · from · date in EST · the Yahoo folder it
  was in · "filed as the receipt") above the rows. A short numeric id can substring-match an unrelated email on
  Yahoo (a tracking number); the scenario then answers 200 with `store: null` and no
  items, which the screen reports as "found an email but nothing on it read as a
  purchased item" rather than as an empty table.
- **Answers:** `{found:false}` (scenario 404) → "no email with that number", still 200
  from us; a scenario fault/timeout → 502/504 "try again or upload"; unconfigured → 503,
  **after** the access checks, so a stranger gets 403 either way. Same guards as
  `receipt-read` (buyer-scoped supplier, `requireBuyerAccess`, 12/min, finished requests
  refused). Every call writes `receipt_email_read` to the trail — found or not, with the
  check verdict and the scenario's `warnings`.
- **Standing caveats on the Make side:** Gmail is `orderemail@stickballman12llc.com`
  (re-authorised 2026-09-15, token to 2027-03). Yahoo is Alex's account, and IMAP
  searches ONE folder per call with no folder listing, so the folders are a **fixed
  list** — `YAHOO_FOLDERS` at the top of the Code module in 6282792: Inbox, Champs
  Sports, Footlocker, Finishline, Jd sports folder, Dick's Sporting Goods, Orders,
  Purchased for Supplier. **A new Yahoo folder has to be added there** (a missing one
  yields nothing, never an error; each adds ~4.5 s to its chunk and 1 op). Merchants
  outside the five parsed return 200 with no items.
- The suite runs with the URL blanked (`playwright.config.js`) — a real run would search
  the real mailboxes. `e2e/buy-cart.spec.js` covers the payload mapping and the gates.

## The receipt becomes the order (2026-09-11)
`cart/raise-po` writes every receipt line onto the purchase order as an **order-level
list** (`po_lines` with no box) and sets `manifest_scope='order+box'`; the buyer then
packs, and each box gets its own list. Two lists, two authors, two jobs — the full rule,
including the three-way split of the gap, is in `purchase-orders.md`.

**What changed and why.** The order used to be raised empty, so it expected nothing until
the buyer packed — and a pair they never boxed was not short, it was invisible. Since the
cart already knows what was bought the moment the receipt is read, the order can say what
it is owed from that moment too.

- **`entered_by` is `Number(uid) || null`.** It is a `users(id)` FK and the env
  admin/superadmin have a non-numeric uid; writing a name there is the bigint cast that
  has taken PO comments down before. The on-behalf flag is stamped either way.
- **The till price rides along** as `unit_cost`, so a shortage has a value without anybody
  looking anything up.
- **A receipt line with no SKU is now REFUSED at `cart/receipt`**, not dropped. It used to
  be silently filtered out at save time, which was survivable while the receipt was only a
  pick list — and is not now, because those lines become the order's account of what it is
  owed. A row discarded quietly is a pair nothing ever expects, counts short, or chases.
  A shop till frequently prints no style code, so this is the common case, and the person
  is looking at the review table at exactly that moment. `raise-po` keeps the same check as
  a backstop for rows written before this.

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

## Packing — the receipt is the pick list, not the manifest
*(`api/cart/pack.js`, `BuyCartPack.jsx`, `getCartPackState`)*

`cart/raise-po` used to write the whole receipt onto the order as one order-level list
(`manifest_scope='po'`). It now raises the order **empty**, on the ordinary per-box
scope, and the buyer packs.

**Why.** A whole-order manifest can tell the warehouse what the PURCHASE contained. It
can never tell them what THIS CARTON should contain, so a short box was only ever
discoverable as a short order — "one pair short" instead of "**box 2 is one 8.5W
short**", which is the difference between a claim against the buyer and a search of the
warehouse. And the receipt genuinely cannot produce a per-box manifest: when it is
parsed the shoes are still in the buyer's car and no box has been filled. Splitting it
across boxes then was a guess presented as a record.

- **A box holds many pairs.** Its manifest is SKU + size + a pair count, the sheet we
  already print for every supplier box. The rule is not one pair per box; it is that
  **every pair belongs to exactly one box**, so the box counts sum to the receipt.
- **The write is `addPoScan`** — the same call the supplier scan-out portal makes,
  deliberately, so the printed manifest, close-and-seal and per-box receive differences
  come free instead of being rebuilt.
- **What `cart/pack` adds is the receipt as a CEILING.** A pack screen that let a buyer
  type any SKU would build a second, independently-typed list that can quietly disagree
  with what the money bought. Nothing may be packed that the receipt does not have, and
  never more of it; the refusal names the pair it was looking for, because on a shop
  floor the answer is usually a mistyped size.
- A negative `qty` takes a pair back out. Packing the wrong size into the wrong box is
  the likeliest mistake on this screen, and a correction that needs a desk is one that
  gets skipped in favour of shipping it wrong. Only a box still `pending` can be edited —
  a closed box's manifest is the sheet already taped inside it.
- **Unpacked is not the same as unexpected, and that is the trap.** Under per-box scope
  reconciliation counts only lines on labels that SHIPPED, so a pair bought and never
  packed is absent from the arithmetic rather than short in it — the order would receive
  and reconcile perfectly clean while the shoe is nowhere. Two guards close it:
  `expected_recorded` fails while `pack.unpacked > 0`, and **`po/ship` refuses the last
  unshipped box** while anything is loose (earlier boxes may still ship — what is
  refused is closing the door on unpacked stock).

### The milestone bar (2026-09-12)
*(`src/lib/buycartMilestones.js`, `src/components/BuyCartProgress.jsx`, `e2e/buy-cart-milestones.spec.js`)*

A courier-page row of ten dots at the top of every request, under the header: **Purchase
request · Waiting for approval · Waiting for gift card · Waiting for receipt · Sorting /
packing · Waiting for manifest · Waiting for labels · Shipping · Delivered · Audited.**
Behind = green, current = blue, ahead = grey; a denied/cancelled/written-off request stops
on its dot in red. Desktop shows every label; under 900px the labels drop and a caption
says "Step 7 of 10 · Waiting for labels".

**The stop is DERIVED, evaluated from the end backwards** — the status column can't say it
(`receipted` covers "receipt just landed" through "every box sealed"), and the back half
lives on the order and its boxes. `milestoneFor(cart)`, pure, no clock:

| stop | evidence |
|---|---|
| Audited (complete) | `status = 'closed'` |
| Audited | `goods_audited_at`, or PO `reconciled`/`closed` |
| Delivered | PO `receiving`, or every real box `delivered` |
| Shipping | PO `shipped`, any box `shipped`/`in_transit`, or **every box has a tracking number** (labels answered) |
| Waiting for labels | `po.labels_requested_at`, or every pair packed AND every box closed |
| Waiting for manifest | every pair packed, a box still open (closing a box prints its manifest) |
| Sorting / packing | `receipted`/`audited`, or `po_id` set |
| Waiting for receipt / gift card / approval / request | `funded` / `approved` / `submitted` / `draft` |

Replacement boxes (`kind='replacement'`) are ignored — a reship is not "did the shipment
arrive". `denied` pins to "Waiting for approval"; `cancelled`/`written_off` stop wherever
the evidence had reached.

### The handoff: what happens when every pair is boxed (2026-09-12)
"Every pair on the receipt is in a box. The order can ship." used to be the last thing the
panel said, and it was a dead end. The next steps — ask for labels, print each box's
manifest, seal, ship — live on the ORDER's screen (the supplier's Outbound Shipments, PH's
Purchase Orders, the warehouse's Reconciliation), and nothing on the request led there; the
buyer had to know to go Home → Outbound Shipments and find the order. `Order PO-…` in the
money strip was plain text.

Now, the moment `pack.unpacked === 0` on an open order, `BuyCartPack` shows a handoff block:
- **Ask for labels** — `api.poRequestLabels(pack.poId)`, the SAME `po/request-labels` the
  supplier portal calls (its precondition, something declared on the boxes, is exactly what
  packing just did). Gated by `canAskLabels` = role ∈ supplier · ph_team · admin ·
  superadmin, the set the endpoint accepts, so the button never leads to a 403. The
  approver (a warehouse hand with a privilege) sees the state but not the button — labels
  are the order's business.
- Once asked: "Labels requested … print each box's manifest from the order and seal it
  while you wait", with **Cancel the label request** (the order page's wording). Once every
  box carries a tracking number: "print, seal, ship". `cart/get`'s `po` summary now carries
  `labels_requested_at` for this.
- **Open the order PO-… →** — `poHref(user, poId)` in `src/lib/poLink.js` picks the shell
  off the ROLE (supplier → `/orders?po=`, ph_team → `/ph/purchase-orders?po=`, else
  `/reconcile?po=`). A plain `<a href>`: the token lives in sessionStorage, so the full
  navigation keeps the session, and it works identically from all three shells. The
  supplier portal learned to honour `?po=` (`SupplierApp`: read on arrival, written on open,
  cleared on ← Shipments). `Order PO-…` is the same link on the request page and in both
  list layouts.

Deliberately a button + link, NOT a redirect: the request page is the one screen both
sides look at, and the buyer may still want the receipt and money in front of them. The
PO is not created here — `Start packing this shipment` raised it, before packing began.
Covered at the end of the pack test in `e2e/buy-cart.spec.js`.

## Two audits, not one
Step 7 is **7a money** (`scope:'money'`) and **7b goods** (`scope:'goods'`) on the same
endpoint, stamped into `audited_*` and `goods_audited_*`.

They answer different questions from different evidence at different times: the money is
answerable the day the receipt lands, the goods not until the boxes are in the building,
which may be weeks. One signature for both would hold every request open for the length
of a shipment — and a control people wait weeks to satisfy is one they start working
around. Both take `requireAuditPrivilege`, so the approver still cannot sign off either.

**7b exists because three lists have to agree and only two were ever compared:**

| Comparison | Where |
|---|---|
| Receipt → manifest | guarded live at the pack step |
| Manifest → received | `getPoReconciliation` — the one we already ran |
| **Receipt → received** | `receipt_vs_received` — new; reconciliation checks the buyer's own account of what they packed, this one takes nobody's word |

**"Record the audit does nothing" (2026-09-16).** It did: the save went through and the
panel re-rendered the same boxes with the same numbers, so nothing moved and the button
read as dead. The panel now prints *Recorded by … at … EST* with a note that a gap
stays on the record (and where in the checklist it is holding the request open), a
"Saved" line under the button, and the button reads *Record it again*. A gap is a
finding, not a blocker — `spend_reconciled` is what refuses the close over it.

## The closing conditions are now twelve, in two groups
`cartCloseChecks` tags each with `scope`. The count **moves with the funding route** — a
card-funded request has no cards to reconcile — so never assert on a number.

New since the ten: `receipt_vs_received`, `exceptions` (no open case), and
`expected_recorded` now also requires everything packed. `cards_recorded` /
`spend_reconciled` / `balance` swap to `charge_recorded` / `charge_reconciled` on the
company-card route.

## Open cases — the exception path
*(`buy_cart_tasks`, `api/cart/task.js`, `BuyCartTasks.jsx`)*

**One table for follow-ups AND return cases**, not two. The rule is a single sentence —
every open item has an **owner, a next action, a due date and evidence** — and two
mechanisms that each half-satisfy it is how a queue ends up with two answers to "what is
outstanding". A return case is that same row with the extra facts: which pairs, cost at
risk, holder, and the **retailer's own final return date** (`return_by`), kept apart from
our internal `due_date` because ours can be moved and theirs cannot.

- **Owner + due date are REQUIRED** at 400. An item with neither is a hope, not a task.
- **Returned is not refunded.** `status='resolved'` on a return stamps
  `refund_verified_at`; the parcel going back proves the retailer has the shoes, not that
  the money came home. `written_off` is the honest alternative and reads differently.
- Closing needs a `resolution` in words — a case closed with no account of how records
  that somebody ticked a box.
- An open case fails the `exceptions` condition, so a request cannot close over the top
  of money still out.

## Two funding routes
`buy_carts.funding_method` — `gift_card` (the default, and every existing row) or
`company_card` with `card_reference` + `card_authorized`. Set on `cart/control`, and
**frozen once money has moved**: re-labelling a funded request would silently re-point
every closing condition at evidence nobody gathered.

**Recording the charge IS the release.** A gift-card request reaches `funded` when the
desk hands the cards over; a card-funded one has no cards to hand over, so `cart/control`
funds it when a reference and an amount above zero are both recorded on an `approved`
request. Without that it stayed at `approved` forever — and every step after it is gated
on `funded`, so the receipt could never be uploaded, read or reconciled. **The route was
a dead end from the step after the one that created it**, and only an end-to-end test
found it. A reference with no amount is not an authorisation and funds nothing.

Cards are objects with balances; a charge is a reference on a statement. Asking either
question of the other proves nothing — which is why everything keyed on `gc_total` read
every card-funded purchase as unfunded forever. `cart/audit` refuses the card-balance
audit on a card-funded request rather than writing an empty one over the top.

## Custody
`holder`, `holder_location`, `ship_by` (a DATE — a ship-by is a day on a calendar, and
compared against `estToday()`). Between the till and the courier these are company shoes
sitting in somebody's flat, and nothing recorded whose. The ship-by is what turns "he
still hasn't sent it" from a memory into a date somebody can be asked about.

## Written off — the third ending
`status='written_off'` + `write_off_reason` (required, ≥10 chars),
`POST cart/close { writeOff:true }` behind the same auditor guard as closing.

**Not a force-close.** There was no way out of a request that can never be completed, so
the only options were leaving it open forever or faking a clean close — and the pressure
an unclosable request creates is pressure to record a false "received" or "refunded".
This is a documented management decision: its own status, a required reason, a name
against it, and a word that reads differently from `closed` everywhere it is shown.

## A control never exists for an act the server will refuse
`src/lib/buycartRules.js` — `decisionsOpen(status)` and `decisionsClosedBecause(status)`,
imported by **both** `api/cart/decide.js` and `src/screens/BuyCart.jsx`, the same way
`payout.js` is shared so a cart line and a calculator line can't be priced by two code
paths that disagree.

The rule lived only on the server, so a **draft** drew the checkboxes, *Approve selected*
and *Approve all 3* — a full set of controls whose only possible outcome was the red line
`The buyer has not sent this request yet.` A button that cannot work is worse than no
button: it reads as a broken feature rather than as a step that hasn't happened, and on a
money screen it invites somebody to keep clicking.

- **The two "not now"s are different and are said differently.** *Not yet* (`draft` — the
  buyer hasn't sent it) is "wait"; *frozen* (`funded` onward — the money went out against
  these approvals) is "too late". An approver told the wrong one goes and does the wrong
  thing about it.
- **Correcting a line is gated on the PRIVILEGE, not the decision window** (`mayDecide`,
  not `canDecide`). A misread shelf ticket stays fixable through draft / submitted /
  approved — draft is the state where the typo is most likely still there, and gating the
  ✎ on the decision window would have taken it away exactly there.

## Filtering the queue by buyer
`/buy-carts` takes `?buyer=<user id>`, filtered **server-side** in `listBuyCarts` and
persisted in the URL like the other filtered lists.

- **Server-side because the list is capped at 100.** Narrowing the loaded page in the
  browser would show a fraction of somebody's requests and read as though that were all
  of them.
- **`buyerUserId` (the scope) and `buyerId` (the filter) are different arguments** on
  purpose. Folding them into one is how a filter becomes a way to read another buyer's
  spending; the scope is ANDed in and always wins, and `cart/list` drops `?buyer=`
  outright for a buyer rather than merely hiding the control.
- **The dropdown's options come from `listBuyCartBuyers()`, not from the loaded page** —
  otherwise anyone whose requests had all scrolled past the cap would be missing from the
  filter meant to find them. Each option shows the **live** count, not the total: a buyer
  with 40 closed requests and nothing outstanding should not read as the busiest person
  on a queue screen.
- **The username disambiguates a shared display name.** Two live accounts are both called
  "Test Supplier"; two identical options is a filter a person cannot use correctly even
  though the value behind each is right. Shown only when the name is actually duplicated.
- It says **Buyer**, never "supplier" — see the naming trap above.

## Statuses
`draft → submitted → approved → funded → receipted → audited → closed`, plus `denied`,
`cancelled` and `written_off`. The cart's own status **follows its lines** rather than being set by
hand: once nothing is pending it is `approved` if anything survived, `denied` if nothing
did. Approvals **freeze** at `funded` — you cannot re-decide a line the money has
already gone out against — but a line added after a re-open is pending on a funded
request and can still be decided. **`list_closed_at` is a second axis**, not a status:
whether the buyer is still adding (see the floor workflow). Cancelling is only possible
before any card exists; after that there is money to account for and it must be
reconciled, not cancelled.

## Deleting a request (2026-09-16)
`POST /api/cart/delete { cartId, reason }` → `deleteBuyCart`. Distinct from **Cancel**
(keeps the row, says why): delete removes the cart and everything under it (lines,
cards, files + their bucket objects, receipt lines, tasks, trail — all `ON DELETE
CASCADE`) after archiving the whole thing as ONE JSON row in **`deleted_buy_carts`**
(`cart_json` = `getBuyCartFull` + the full trail + file metadata; card codes are never in
it — `code_enc` is stripped, `code_last4` survives). Needs **`db:setup`** (new table).
- **Who:** anyone who can reach the request — the buyer on their own, any staff on any —
  **until money is on it.** Once a gift card has been issued (`gc_total > 0` or any
  `buy_cart_gift_cards` row, voided included — a voided card still went out), only
  someone with **`approve_buying`** (or admin) may delete it. The buyer gets a 403 that
  names the approver; the issuing/auditing desks get the same 403. The button on the
  request page is disabled with that sentence as its title; the server is the rule.
- A request that **raised a purchase order** is refused (409): the order is the
  supplier's shipment and has its own delete (`po/delete`, refused while a batch is
  linked) — that is where the decision belongs.
- Bucket objects are deleted AFTER the rows, best effort: a leftover object is a cost,
  a missing one under a live row would be a bug. 20/min, like Remove pairs.
- Tested in `buy-cart.spec.js` → "can be deleted by whoever can reach it".

## Trail
`buy_cart_events` — append-only, never edited, never read by a list screen, the same
shape as `po_comments`. Every approval, card, file, reveal, audit and close. Comments
live in the same table (`kind='comment'`) so "ask the buyer what they are buying" — step
one of the process — has somewhere to happen that can be audited later.

## Gotchas
- **`BUY_GC_KEY` must be set on every environment**, or the desk can only upload photos.
- **`buy_cart_tasks` + eleven `buy_carts` columns (funding, custody, goods audit,
  write-off) → `db:setup`** on local and prod, on top of the original tables.
- **`list_closed_at` / `list_closed_by` / `list_reopened_at` / `funding_target` + the
  one-shot list backfill → `db:setup`** (2026-09-16).
- **`cart/create` is rate limited to 30 a minute and the e2e suite sits exactly on it.**
  Adding one more request-creating test pushed two unrelated tests at the end of the run
  into a 429, which surfaced as `Cannot read properties of undefined` and pointed at the
  wrong thing entirely. `newRequest` now reports the status; a test that only needs a
  fixture seeds it with SQL rather than spending a create.
- **Never assert on a COUNT of closing conditions.** It moves with the funding route.
  The old e2e test asserted ten and broke the moment a card-funded request asked a
  different question; it now asserts on the `scope` split and the keys.
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
