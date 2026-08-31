# Pre-printed 1ID stickers ("VIN Project")

An alternative intake mode: instead of printing a label per shoe **during** receiving,
the warehouse prints **blank stickers in bulk ahead of time** and scans one onto each
pair. Screen: `/vin-stock` (`src/screens/VinStock.jsx`). Endpoints: `api/vins/*`.

## Why it exists
The Wi-Fi label printer kept failing — 30–90 minutes lost in a day, staff walking the
warehouse to find a working printer, and pairs getting **shelved un-VIN'd** because the
printer wouldn't cooperate (Aug 18 2026 meeting, against a ~2,000-pair backlog). A
printer must never be able to stop intake. Both methods stay: print-per-shoe when
you're standing at a working printer, raw stickers everywhere else.

## The two series
| | shape | minted |
|---|---|---|
| dated | `SBM-260819-001234` | at intake, from `vin_seq` |
| **roll** | `SBM-R-001234` | ahead of time, from `vin_roll_seq` |

A sticker printed in advance **cannot know the receive date**, so it gets its own
series rather than a fake date. It's also materially shorter, which matters more than
it sounds: staff scan with **phone cameras**, and 12 characters render at **0.34 mm**
bar width on a 1″ label vs **0.26 mm** (10 mil — marginal in warehouse light) for the
17-character dated VIN.

**`api/_lib/vins.js` is the single server-side definition** (`VIN_RE`, `isRollVin`,
`ROLL_VIN_RE`, `duplicateVin`); `src/lib/codes.js` mirrors it for the client. This used
to be **seven** copies of the same literal, and that is precisely how a new series gets
half-adopted — `normalizeItems` NULLs a VIN it doesn't recognise and `insertItems` then
mints a fresh one, so **the shoe leaves the bench wearing a number that isn't on it**.
`api/batches/commit.js` had a line-for-line copy of `normalizeItems` with its own inline
pattern; it now calls the shared one. Caught by `e2e/raw-vin.spec.js`, not by review.

## Data
`vin_stock`: `vin PK · status (available|assigned|void) · run_id · printed_at/by ·
assigned_item_id · assigned_at · voided_by/at`. `assigned_item_id` is deliberately **not**
a FK — an item can be deleted (`deleted_items`), and the sticker still existed.

## Minting and printing
`POST /api/vins/mint {count}` → one `run_id` per batch, numbers from `vin_roll_seq`
(atomic, so two people minting at once can't collide). The screen mints **and opens the
print dialog in one action** — a minted sticker that never got printed is a gap in the
stack nobody can explain later.

**A run is kept as a unit for one reason:** a roll that jams at label 700 of 1,000 has to
be reprintable without minting 1,000 fresh numbers. **Reprint** re-prints only the run's
still-`available` stickers — reprinting one already on a shoe would put a duplicate
number back in the stack.

Label renderer: `kind: 'rawvin'` in `labelPdf.js` — barcode and number, nothing else
(there is no shoe yet), printed as large as the stock allows.

**Void** a torn/lost/misprinted sticker: never reused. Numbering gaps are fine; a number
on two shoes is not. A sticker already **assigned** can't be voided.

## The intake flow
Per-person toggle `prefs.rawVins` (**Preferences → Raw 1ID stickers**), NOT a global
switch: someone at a working printer and someone across the warehouse with a roll are
doing the same job two ways, and neither should flip the other's screen. Applies to
**Receiving, In-Store** (same component) and **Existing Stock**. Never to **rescale** —
there a VIN scan means "this existing pair", the opposite operation.

Two beats: **scan the shoe → scan the sticker**. The scan bar says which beat it's on and
names the pair waiting. `pickStickerSlot` decides which pair the next sticker lands on —
the newest line still short one, matching what the hand is doing — and both `bindSticker`
and the highlighted row read it, so **the screen can never point at a different pair than
the scan hits**.

**Receiving against a PO is one beat, not two** (added 2026-08-20). The manifest checklist
replaces the rapid-scan bar entirely, so raw mode used to block Review with "scan a 1ID
onto the 1 highlighted line" on a screen that had no scanner and no highlight — a dead end
on the flow the stickers are most useful for (PO-100005). Now:

- The shoe is already on the supplier's list, so **ticking a size IS the first beat**; the
  sticky `.po-sticker-bar` above the checklist is the second. A scan there is only ever a
  sticker — a UPC gets told to use **+ Add unexpected**, because a pair that isn't on the
  PO changes the count.
- Sizes are walked in **displayed** (sorted) order, not cart order, so ticking size 9 and
  scanning its sticker can't file that number under the size 8.5 row above it.
- Per row: a `1ID n/m` chip, red while short, and the ONE row the next scan lands on gets
  the blue ring the bar names.
- **The field keeps focus by itself.** A Bluetooth gun types into whatever is focused and
  **ticking a checkbox takes focus away**, so the bar re-arms after every tick, stepper
  press and bind — otherwise the next trigger pull goes nowhere and the field has to be
  tapped once per pair (Brent's recording, 2026-08-20). This is the ONE exception to the
  `hasFinePointer()` rule that says never pull focus on a phone, and it's only safe
  because the field is **`inputMode="none"`** while scanning: DOM focus without iOS
  throwing the software keyboard over half the manifest. **`Type`** flips it to
  `inputMode="text"` and focuses from inside the tap (a focus outside a gesture would set
  focus and suppress the keyboard — see [[ios-keyboard-focus-trap]]); submitting drops
  back to scan mode, because one hand-typed sticker doesn't mean the next one is.
- **Stepping a count down hands the sticker back** (`setSizeQty` trims `vins` to qty) —
  a pair that isn't in the box shouldn't hold a number, and the sticker is still on the roll.
- **`ensureManifestVins` mints nothing** here: it only reserves the shortfall, which is
  zero once every ticked pair wears a sticker.

- **Nothing is minted** in raw mode — the pair's number comes off the sticker. Minting
  one anyway would burn a sequence number per scan and put a second, wrong VIN on the line.
- **A pair with no sticker can't be committed.** `needsSticker` feeds the existing
  `isUnresolved` machinery, so it blocks Review and commit and focuses the row exactly
  like a missing size. Committing without one would write a system-minted VIN matching
  nothing physically on the shoe — the silent failure this mode exists to prevent.
- **Nothing is printed after a raw-mode commit.** Existing Stock skips its post-commit
  print dialog and Receiving/In-Store hide the **Print labels** button (`printItems` is
  built empty in raw mode, decided at commit rather than read live from the toggle):
  the sticker is already on the shoe, and printing those labels would put a *second*
  number on the pair.

## The guards
1. **In this cart already** → refused client-side.
2. **`assigned` / `void`** → refused, naming the shoe it's on where known.
3. **`unknown`** (not in the printed stock) → accepted with a warning — it's a real VIN
   shape, just not one we minted; blocking would strand a legitimately odd sticker.
4. **The check endpoint is unreachable** → **bind anyway** and say so. A warehouse with
   flaky Wi-Fi is the entire reason this mode exists; the one thing it must never do is
   stop intake. Nothing is lost: `items.vin` is `UNIQUE NOT NULL`, so a sticker secretly
   already on another shoe is refused **at commit**, and `duplicateVin` turns that
   constraint violation into a **409 naming the sticker** ("pull it, use a fresh one")
   instead of "Could not save the batch. Please try again.", which retrying can't fix.
5. **`claimVinStock` is a compare-and-swap** (`WHERE status = 'available'`), so two
   people who scanned the same sticker can't both win — same TOCTOU pattern as
   `commitBoxItems`. It runs **after** the insert and is best-effort: `items.vin` is what
   makes a double-assign impossible; `vin_stock` is the bookkeeping that keeps the stock
   count honest. Failing a whole commit because the bookkeeping hiccuped would cost the
   warehouse a scanned box for no integrity gain.

## "Is this sticker used yet?" — Inventory
Scan or type a `SBM-R-…` number into the **Inventory** search box and, when no pair
wears it, the detail view answers from `vin_stock` instead of `No item found for …`.
That reply was wrong on the common case: a sticker still on the roll is the normal
state, not a lookup failure. Four states, each with its own next action —
**Not used yet** (still on the roll) · **In use** (assigned; the pair opens from the
card, or, when it opens nothing, it was **removed** and the number is spent anyway —
`assigned_item_id` is not a FK on purpose) · **Voided** · **Not one of ours** (a real
1ID shape we never printed). Print run and the printed/used/voided dates ride along.

Two things had to change for it: `submit()` routed on a loose `^s[a-z]*-?\d` pattern
that **misses every roll sticker** (it wants a digit straight after the letters, and
`SBM-R-…` has an `R`), so a typed sticker fell through to a text search; and
`/api/vins/check` was `warehouse`-only, while Inventory is a page **PH also reads**.
Both series show the marker in reverse too: a pair whose VIN is a roll number carries
a `1ID · in use` chip next to it, so the sticker's state is legible from either end.

Low-stock warning under 200 unused. Tests: `e2e/raw-vin.spec.js`,
`e2e/po-raw-vin.spec.js` (the PO manifest), `e2e/inventory-sticker-status.spec.js`
(the four states on Inventory).
