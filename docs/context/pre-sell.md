# Pre-sell (sold before it landed)

Some shipments are already spoken for before they arrive. Those pairs must **not**
be listed to II or the stores — offering them would sell a pair that belongs to
somebody else's order. But not every unit on such a shipment is covered: the
overage is ordinary stock and does need pricing and listing.

So a pre-sell shipment is received exactly like any other, then held out of the PH
listing worklist until **the warehouse** says, size by size, how many are actually
sold. What is left over is released — and lands on the existing **Rescale Stock**
worklist, which already means "priced and pushed to the stores".

**Who does what.** The warehouse owns the whole pre-sell page: they hold the
shipment, so they are the ones who know which pairs an order covers. PH's job
starts *after* release — the freed pairs appear on Rescale Stock and PH lists them
to II and the platforms. PH has no Pre-sell page and cannot mark a pair sold.

## The flag

- **`batches.pre_sell`** and **`items.pre_sell`** (both `BOOLEAN NOT NULL DEFAULT
  false`), plus `items_pre_sell_idx ON items (batch_id, sku, size) WHERE pre_sell`.
- The batch flag records what the shipment *was*; the item flag is what every query
  reads. They are set together at commit — `insertItems` copies the batch's value
  onto each unit — because a unit's pre-sell state has to be able to end
  independently of its batch's (see **Release**, which clears only the item flag).
- Set at intake. Nothing else in Receiving changes: same scan, same review, same
  boxes. It is a checkbox next to the tracking field
  (`.presell-field` in `src/screens/Receiving.jsx`), carried on the commit body as
  `batch.preSell` through `createBatch` / `createOpenBatch` / `box-commit`.
- **`batches.pre_sell_scope`** — `'all'` | `'some'` | NULL (not a pre-sell shipment).

## All of it, or only some (2026-09-23)

**What went wrong.** Nine boxes, fifteen SKUs, **one** of them actually sold before it
landed — and all fifteen came out held, invisible to PH. The checkbox asked about the
*shipment*, `insertItems` copied that one answer onto every unit, and in a multi-box
batch `box-commit` re-read `batches.pre_sell` for boxes 2..9 and stamped everything that
landed in them too. Nothing on any screen said how many shoes were being held.

**The question now has two halves.** Ticking *Pre-sell shipment* opens a second,
unanswered question — *Is **all** of this shipment pre-sold?* — with the same shape and
the same reasoning as the manifest Yes/No beside it: **nothing is pre-selected**, and
`goStep2` refuses to move on until it is answered. The old checkbox silently meant "all
of it", which is exactly the assumption that did the damage.
- **All of it** → today's behaviour, unchanged. Every pair is held.
- **Only some** → the batch keeps `pre_sell = true` (it *was* a pre-sell shipment, and the
  chips and this page are keyed on that), and each **cart row** carries a **Pre-sell**
  toggle beside the Box / No box and GOAT-only controls it already had. It is a property
  of the shoe, like those two — not a mode you are in.

**Why not two scanning passes.** The floor's own proposal was to scan the pre-sell pairs
first and the rest after, per box. That adds a second sticky mode on top of "Scanning as:
With box / No box" (four combinations), makes somebody sort every carton into two piles
before scanning — nine times — against the one rule rapid scan is built on, and still
leaves a pair scanned in the wrong pass looking identical on screen. The chip needs no
sort, no mode and no order, and it is visible on the row for the rest of the session.

**The count is stated, twice.** `.presell-tally` on the Items step and again on Review:
*"1 of 15 shoes marked pre-sell"*. Fifteen of fifteen held, when one was meant to be, is
what nobody could see last time.

**Half an answer is refused.** "Only some" with nothing marked is not a shipment with no
pre-sell in it — committing it would list somebody else's pairs. `goStep3` blocks it on
the single-box path and `api/batches/commit.js` refuses it at the door (400). A **box** of
a multi-box shipment may legitimately hold none: eight of the nine did.

**Where the scope is read, and why it is on the batch.** `box-commit` has no header to
read — it re-reads the batch row for every box. `preSellAll = batch.pre_sell === true &&
batch.pre_sell_scope !== 'some'` is what stops box 7 holding its own contents. A **NULL**
scope therefore has to mean *all*: that is what every batch received before this existed
carries, and it must keep behaving the way it was received.

**`normalizeItems` reads the two as an OR** (`preSellAll === true || it.preSell === true`),
so the shipment answer and the line answer can never fight. The option was renamed from
`preSell` to `preSellAll`; it is passed by all three intake paths.

**Both directions are correctable, and the second one matters more.** Over-holding is
visible and merely annoying — fifteen shoes sitting on this page. **Under**-holding is
invisible and expensive: an unmarked pair reaches PH, gets listed, and can be sold to a
second buyer while the first order still stands. So the Pre-sell page carries both
corrections — see **Freeing and holding** below.

## What the flag holds back

`pre_sell` is a **second, parallel exclusion to `PH_EXCLUDED_KINDS`** — same idea,
different axis (a *kind* of batch vs. a state a unit can leave). It is guarded at
the same places, and for the same reason: guarding the New Inventory query alone is
never enough.

| Where | Guard |
|---|---|
| `phListItems` (both branches) | `AND NOT i.pre_sell` |
| PH pending-count badges | `ph_managed` = kind-check **AND** `NOT it.pre_sell` |
| `recomputeUnlistedPrices` | `AND NOT items.pre_sell` |
| `getItemsForGiRefresh` | `AND NOT i.pre_sell` |

A pre-sell unit is therefore invisible to PH's New Inventory, contributes to no
listing badge, and is never priced by a GI refresh — while staying perfectly
ordinary everywhere else (Inventory, shelving, labels, locations, costs, the PO).

The pending-counts query also returns **`presell_pending`** — pre-sell units not yet
`sold`/`shipped` — which badges the PH home card.

## The chip (`src/components/PreSellChip.jsx`)

One component, four states, shown anywhere a batch, box or unit is on screen —
because the flag changes what may be done with the stock, and someone standing over
a shelf has no other way to tell. **Only the unusual state is chipped**; chipping
every ordinary shipment teaches people to stop reading chips.

| State | Reads | Keyed on |
|---|---|---|
| held | **Pre-sell** | `items.pre_sell` |
| part held | **N pre-sell** | some units of a group held |
| spoken for | **Pre-sold** | `status = 'pre_sold'` |
| released | **Was pre-sell** | `batches.pre_sell` with no unit still held |

**Why the fourth exists.** `items.pre_sell` is the unit's *current* state and release
clears it, so a freed pair is indistinguishable from ordinary restock the moment it
lands on Rescale Stock — and "why does half this shipment never appear?" becomes
unanswerable. `batches.pre_sell` is what the shipment **was** and never changes, so
it is carried as **`from_pre_sell`** on `queryItems` and both branches of
`phListItems`, and grouped as `wasPreSell` / `wasPreSellCount` in `src/lib/ph.js`.

Where the live chip **replaces** the sync badges (a held pair has no sync state worth
showing), the released chip sits **beside** them and is styled quiet, not amber: the
pair is ordinary stock again and its badges mean something. On the PH grid it only
ever appears on released pairs — a held one is invisible to every PH surface by
design, so there is no row to chip.

⚠️ These queries are JS template literals. **No backticks in their SQL comments** —
one closes the string and the whole module fails to parse.

## The Pre-sell page (`/presell`, `src/screens/PreSell.jsx`)

Warehouse (admin auto-allowed), in the warehouse app — a card in **Receiving
Shipment Orders**, plus a Needs-attention tile keyed on `presell_pending`. Rows are
grouped shipment → shoe → size
(`listPreSellGroups`), each showing **arrived / sold / remains**. Each **shoe** header
carries **Not pre-sell** and each shipment carries **＋ Hold another shoe** — the two
corrections, see *Freeing and holding*. Both confirm through `<Modal>` rather than
`window.confirm`, which can't be styled and reads badly on a phone.

Two ways to say a pair is spoken for, both ending in status **`pre_sold`**:

1. **Type the count** per size → `POST /api/presell/mark-sold`
   `{batchId, sku, size, qty}` → `setPreSellSold`. The units are interchangeable
   (same shoe, same size, not yet shelved), so it takes the **oldest ids first**
   for determinism rather than making anyone choose a VIN. **Lowering the number
   hands units back** (→ `needs_shelf`) — a pre-sale that falls through is normal.
2. **Scan a 1ID / VIN** → same endpoint with `{vin}` → `markPreSoldByVin`. Names the
   pair instead of letting the system pick. Rejects a VIN that isn't on a pre-sell
   shipment, or is already `pre_sold`/`sold`/`shipped`, each with its own message.

**`pre_sold`, not `sold`.** The pair is still on our floor and hasn't shipped;
`sold` is terminal and cascades. It reaches `sold`/`shipped` through the normal
scan-out when it actually leaves. Claiming it early would strand the unit if the
order collapsed.

## Freeing and holding (was "Release → listing")

**Free the remaining** → `POST /api/presell/release` → `releasePreSell` clears `pre_sell`
and stamps **`items.presell_freed_at = now()`** on every unit of that batch that is
**not** `pre_sold`/`sold`/`shipped`/`missing`/`issue`, and logs a `note` event.

**They land on NEW INVENTORY (changed 2026-09-23), not Rescale Stock.** Freed pairs are
what they always were — ordinary arrivals that were held back for a while — so
`restock_pending` is left false and PH picks them up on the tab that means "new stock to
price and list". Release used to set `restock_pending` instead, for exactly one reason:
New Inventory is filtered by date, and a pair freed weeks after it arrived fell outside
the window PH looks at, so it would have been seen by nobody.

**That reason is now fixed at the source.** `phListItems`' receiving branch selects,
filters and orders on `coalesce(i.presell_freed_at, i.created_at)`: a freed pair is dated
by **the day it was freed**, which is the day it became PH's work. The Rescale tab already
takes exactly this reading of its own `rescaled` event, for the same reason. Ordinary
stock has a NULL `presell_freed_at` and is unaffected.

**Nothing moves under PH's feet.** Units released *before* this change keep
`restock_pending = true` and stay on Rescale Stock exactly where they were left. The
change applies to what is freed from now on.

**One worklist still owns the pair.** The receiving branch keeps
`AND (${kind} IS NULL OR NOT i.restock_pending)`, so the old released units stay on
Rescale and the new ones stay on New Inventory — never both. Two lists claiming the same
pair is how it gets listed twice, or left because each side assumed the other had it.

**Units already `pre_sold` are left alone** — they keep `pre_sell = true` and stay on the
Pre-sell page. This is why `phListItems` tests the *item* flag: freeing part of a batch
leaves the rest held.

### The two corrections

Pre-sell is declared per shoe now, so it can be got wrong in both directions. Both fixes
live on the Pre-sell page, and both are warehouse-only.

| | Where | Does |
|---|---|---|
| **Not pre-sell** | the ✎-style button on each **shoe header** | `POST /api/presell/release { batchId, sku, reason: 'not_presell' }` — frees that one shoe. Whole-batch release could free the fourteen marked in error only by freeing the one that is genuinely spoken for with them. |
| **＋ Hold another shoe** | the shipment's actions | `POST /api/presell/hold { batchId, sku }` → `holdPreSell` — puts a missed shoe back. `GET /api/presell/hold?batchId=` (`listBatchShoes`) lists the shipment's shoes with held/free counts, so the picker offers them by name rather than asking anyone to type a style code. |

`reason` is recorded in the unit's event text: *"Not pre-sell after all — marked in error
at receiving"* vs *"Released from pre-sell — free to list"*. Two different stories about
the same pair, and the first one is the warehouse correcting itself.

`holdPreSell` refuses `sold`/`shipped`/`missing`/`issue` units — a pair that has left is
not ours to hold, and claiming it now would say something false about a closed sale. It
clears `presell_freed_at` with the hold, so a re-held pair is dated by its arrival again
if it is later freed for real.

## Endpoints

| Route | Who | Does |
|---|---|---|
| `GET /api/presell/list` | warehouse (admin auto) | `listPreSellGroups` |
| `POST /api/presell/mark-sold` | warehouse (admin auto) | count path or VIN path |
| `POST /api/presell/release` | warehouse (admin auto) | `releasePreSell` — whole batch, or one `sku` (optionally one `size`) |
| `GET /api/presell/hold?batchId=` | warehouse (admin auto) | `listBatchShoes` — the shipment's shoes, held/free |
| `POST /api/presell/hold` | warehouse (admin auto) | `holdPreSell` — put a missed shoe back |

All of them use `requireRole`, which auto-allows admin. **PH gets 403 on every one** —
guarded by `e2e/presell.spec.js`, because "PH can still see the rows" and "PH can
declare a pair sold" are different failures and only the second one matters.

## Where you can see the flag

A shipment-wide state that only appeared on its own page would be invisible to
anyone actually handling the stock, so `PreSellChip` (`src/components/PreSellChip.jsx`)
is rendered in four places:

| Where | What it reads | Query that carries it |
|---|---|---|
| Batches list rows (Open, Recent, Search) | `b.pre_sell` | `listBatches`, `searchBatches`, `listOpenBatches` |
| Batch detail header | `b.pre_sell` | `getBatchWithBoxes` (`b.*`) |
| **Each box card** inside a batch | `b.pre_sell` | same — a box is what somebody has open in front of them, and the header is scrolled away by then |
| Receiving → Recent | `b.pre_sell` | `listBatches` |
| Inventory rows | `g.pre_sell` / `g.preSellMixed` | `queryItems` (`i.pre_sell`) |

Only the unusual state gets a chip — unlike `PoKindChip`, where every order is
either shoes or boxes so a missing chip would be ambiguous. Here nearly every
shipment is ordinary, and chipping all of them is noise.

**Inventory needs a rollup, not the raw column.** `groupPhRows` builds a group with
`{...r}` from the *first* row and keys on `sku|status`, so one pre-sell batch's
unreleased pairs can share a group with ordinary stock of the same SKU — the chip
would then depend on row order. It is counted instead: `pre_sell` is all-units-true,
`preSellMixed`/`preSellCount` carry the partial case, and the chip has a dashed
"N pre-sell" variant. In Inventory the chip *replaces* `SyncBadges` (a pre-sell pair
is deliberately listed nowhere, so four greyed badges say nothing), the same call
`IntakeChip` makes for in-store and existing stock.

## Tests

`e2e/presell.spec.js` — 13 tests. The original seven: the flag lands on every unit;
**the multi-box path inherits it** (that path reads `pre_sell` off the batch row, not its
own request body, so the single-shot test does not cover it); **PH is refused** on
mark-sold and release; a pre-sell batch stays off PH New Inventory and out of its badges;
the count path and the scan path both reach `pre_sold`; lowering a count hands units back;
freeing moves only the remainder (now onto **New Inventory**). Six more for part pre-sell:
- only the **marked** shoes are held, and the unmarked ones are PH's work at once;
- **"only some" with nothing marked is a 400**, not a shipment filed as ordinary stock;
- **the nine-box bug**: box 2 of a part pre-sell shipment does not hold its own contents;
- a **NULL scope still holds everything**, so batches received before this keep behaving;
- **both corrections**: one shoe freed on its own (leaving the really-sold one held, with
  "marked in error" on its history), then put back — and PH 403s on the hold;
- **a freed pair is dated by the day it was freed**: a shipment aged 30 days, freed today,
  appears on *today's* New Inventory and not on the window it arrived in. That date is the
  whole reason freed pairs can go to New Inventory at all.

## Gotchas

- `useEffect(load, [])` where `load` returns a promise crashes the page with
  `TypeError: destroy is not a function` — React reads an effect's return value as
  its cleanup. Wrap it: `useEffect(() => { load(); }, [])`.
- Adding a new PH-facing query means adding `NOT pre_sell` to it, exactly as it
  means adding the `PH_EXCLUDED_KINDS` check (`docs/context/ph-excluded-kinds` /
  `in-store.md`).
- A new `NavIcon` name that isn't in `PATHS` **silently falls back to the magnifier** —
  `presell` has its own bookmark glyph in `src/components/NavIcons.jsx`.
- The chip borrowed `.no-track-check`'s look at first, which is the class
  `e2e/receiving-no-tracking.spec.js` selects the no-tracking checkbox by; two
  elements then matched and the spec failed in strict mode. Share styling by adding
  to a CSS selector list, never by reusing a class e2e keys on.
- Needs `db:setup` (`batches.pre_sell`, `batches.pre_sell_scope` + its CHECK,
  `items.pre_sell`, `items.presell_freed_at`, the partial index).
- **A backtick in a SQL comment inside `db.js` closes the template literal** and the whole
  module fails to parse. The `presell_freed_at` comment in `phListItems` was written with
  one around a column name and took the server down on the spot.
- The per-shoe chip is a property of the CART ROW, so it belongs in the **merge keys**
  (`x.preSell === item.preSell`, beside `withBox` and `goatOnly`) in both places a scan
  can merge into an existing line. Without it, scanning an unmarked pair of a shoe you had
  marked would silently fold the two together and hold — or free — the wrong pairs.
