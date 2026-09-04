# Failed scans — saying what went wrong, and keeping a record

Screen: the Sold/Shipped scan-out (`src/screens/StatusScanPage.jsx`). Wording:
`src/lib/stickerState.js` (shared with Inventory's sticker card). Endpoint:
`api/items/scan-failure.js` → `scan_failures`. Report query: `scanFailureSummary`.
E2E: `e2e/scan-failures.spec.js`.

## Why this exists
The floor reported that daily scan-out "kept failing" — some scans worked, most didn't.
Nothing in the system could say why. The reason for a failed scan lived in one tab in
one person's browser and died with it, so the answer had to be reconstructed from a
phone video and cross-referenced across four tables. **It should have been one query.**

The cause was ordinary and invisible: a box gets a sticker off the roll, the shoe is
never received against it, and the sticker is real while having no pair behind it. The
app said `No item found for SBM-R-004754.` — true, useless, and the reason people
concluded the software was broken.

## What a failed scan says now
`stickerState()` turns a `/api/vins/check` result into one sentence. Four states:

| State | Banner | What it means |
|---|---|---|
| `available` | *"labelled but never received — send it to Receiving"* | The sticker is real and nothing was ever received against it |
| `void` | *"this sticker was voided"* | Torn/misprinted; relabel the box |
| `assigned` (pair gone) | *"used on a pair that was removed"* | Number is spent; relabel |
| `unknown` | *"not a sticker we printed"* | Right shape, not ours |

**One wording correction worth keeping.** Inventory's version of `available` used to read
*"Still on the roll"*. That is an assumption, and production said it was false 332 times:
those stickers were peeled out of the **middle** of worked rolls and applied to boxes.
Telling somebody holding such a box that the sticker is "still on the roll" teaches them
the app is wrong. What we can state as fact is narrower and more useful — nothing has
ever been received against this number.

## Why it looked random
A roll is peeled in order, so unused numbers should sit at the *end* of a run. They
didn't — they were scattered inside consumed stretches:

```
run 34: 150 printed, 83 used, 55 unused INSIDE the worked stretch, 0 untouched tail
run 25: 250 printed, 190 used, 60 unused inside
run 22: 150 printed, 91 used, 59 unused inside
```

A labelled-and-received box scans; the labelled-but-unreceived box beside it doesn't.
That is the "some work, some don't" the floor was describing, and it is why a spot-test
failed every time.

## `scan_failures`
One row per scan that didn't land: `code`, `reason`, `detail`, `screen`, `user_name`.

- **Not `item_events`** — the whole point is that these scans matched no item, so there
  is nothing to hang an event on.
- **Fire-and-forget, and it must stay that way.** The client never awaits it and the
  endpoint answers 200 even when the insert fails. A warehouse hand must not be stopped
  by the audit trail for the thing that stopped them. Guarded by a test that kills the
  endpoint and asserts the scan still answers.
- `reason` is the sticker's real state (`available`/`void`/`unknown`/`not_a_vin`/…), not
  a generic "not found" — that is what makes *"how often, and to which boxes"* a query.

## The other bug this turned up: minting burns a run per misfire
Fifteen sticker runs in production were minted and never used, each one **3–23 seconds
before** the run that actually got printed:

```
run 4   250 stickers  0 used    11:13:27
run 5   250 stickers  246 used  11:13:36   <- 9 seconds later
run 14  100 stickers  0 used    15:14:05
run 15  500 stickers  466 used  15:14:08   <- 3 seconds later
```

Somebody hits Mint, no labels come out, so they hit Mint again — and the second run
prints while the first becomes a permanent hole in the numbering. ~2,700 numbers.

`VinStock.jsx` now shows an amber banner when the newest run is entirely unused and less
than 30 minutes old, with a **Print run N again** button, and Mint asks for confirmation
before burning fresh numbers on top of it. Reprint was always there — it just wasn't
where the hand goes when nothing comes out of the printer.
