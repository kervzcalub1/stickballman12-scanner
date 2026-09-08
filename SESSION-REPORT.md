# Session report — Fri 5 Sep 2026 (EST)

One fix shipped to production, one large feature parked for testing.

A video came in from the floor showing the daily scan-out failing on every attempt —
that got diagnosed and fixed, and is now live. Alongside it, the gift-card buying
process was built to the written ten-step procedure and then rebuilt around a
correction from Kervy about roles versus privileges; that one waits for local testing.

Four bugs found in total. **Three of them were already live.**

| Branch | State |
|---|---|
| `fix/scan-out-failures` | **MERGED & LIVE** — [PR #189](https://github.com/kervzcalub1/stickballman12-scanner/pull/189). Prod migrated, deploy verified in the bundle |
| `feat/gift-card-buying` | [PR #188](https://github.com/kervzcalub1/stickballman12-scanner/pull/188), CI green, **parked** for local testing next session |

---

# PART ONE — "Scan-out keeps failing"

## What the floor reported
Jadi has been scanning shoes out daily. Some scans work, most don't. Kervy filmed a
live spot-test and every scan tested failed. Two options were on the table: abort the
process, or fix it.

## What was actually happening

**332 boxes are wearing a real 1ID sticker with no pair behind it in the system.**

A box gets a sticker off the roll, the shoe is never received against it, and the
sticker is genuine while pointing at nothing. Scanning it answered:

```
No item found for SBM-R-004754.
```

True, useless, and exactly why people concluded the software was broken.

**The app already knew.** `vin_stock` holds that sticker's real state, and Inventory has
been asking it for months. The scan-out screen — the one used two hundred times a day —
never did.

## Why it looked random

A roll is peeled in order, so unused numbers should sit at the **end** of a run. They
didn't:

| Run | Printed | Used | Unused **inside** the worked stretch | Untouched tail |
|---|---|---|---|---|
| 34 | 150 | 83 | **55** | 0 |
| 25 | 250 | 190 | **60** | 0 |
| 22 | 150 | 91 | **59** | 0 |

Run 34 was worked right through to sticker #150 while 55 in the middle were never bound.
Those were peeled and applied. A labelled-and-received box scans; the labelled-but-
unreceived box beside it doesn't. That is the "some work, some don't", and it is why a
spot-test failed every time.

## What a failed scan says now

| Scanned | Before | Now |
|---|---|---|
| Labelled, never received | `No item found for SBM-R-004754.` | **`SBM-R-004754 — labelled but never received — send it to Receiving.`** |
| Voided sticker | `No item found…` | `this sticker was voided` |
| Not one of ours | `No item found…` | `not a sticker we printed` |
| Manufacturer UPC | *(unchanged)* | `is not a VIN — scan the SBM-… label, not the UPC` |

One wording correction came with it. Inventory's line for an unused sticker read *"Still
on the roll"* — an assumption, and production says it's false 332 times over. Someone
holding such a box, told its sticker is still on the roll, learns the app is wrong. What
we can state as fact is narrower and more useful: nothing was ever received against it.

## The thing that made this expensive

**Nothing about a failed scan was recorded anywhere.** The reason lived in one browser
tab and died with it, so answering "why is it failing" took a phone video, ffmpeg frame
extraction and four tables of inference.

`scan_failures` now takes one row per failure — code, reason, screen, who, when:

```
012345678905   not_a_vin    mark-sold   Jadi   17:47:13
SBM-R-999999   unknown      mark-sold   Jadi   17:47:12
SBM-R-900002   void         mark-sold   Jadi   17:47:11
SBM-R-900001   available    mark-sold   Jadi   17:47:09
```

Fire-and-forget by contract: the client never awaits it, the endpoint answers 200 even
when the insert fails, and a test kills the endpoint and asserts scanning still works.
The audit trail must never be able to stop the thing it is auditing.

## A second bug the same investigation turned up

Fifteen sticker runs were minted **3–23 seconds before** the run that actually got used:

```
run 4   250 stickers  0 used    11:13:27
run 5   250 stickers  246 used  11:13:36   <- 9 seconds later
run 14  100 stickers  0 used    15:14:05
run 15  500 stickers  466 used  15:14:08   <- 3 seconds later
```

Mint, no labels come out, hit Mint again — and the first run becomes a permanent hole in
the numbering. **~2,700 numbers burned.** There's now an amber banner naming the
stranded run with a Print-again button, and Mint confirms before burning fresh numbers
on top of it. Reprint always existed; it just wasn't where the hand goes when nothing
comes out of the printer.

## The work order

The failing boxes are a finite, known list — 332 stickers, written to
`unreceived-stickers.csv`:

```
run 25   60 stickers   SBM-R-004754 … SBM-R-004979
run 22   59 stickers   SBM-R-004251 … SBM-R-004389
run 34   55 stickers   SBM-R-006051 … SBM-R-006199
…14 runs, 332 total
```

Receiving each one clears it permanently.

## On abort vs fix

**Fix, clearly.** Scan-out marked **558 pairs sold successfully**, most recently Sep 3.
The software was working; the feedback was mute on a bounded set of boxes.

## The bigger thing, which is not a bug

The video is three minutes of walking, and that's the number worth raising separately:

- **3,525 of 3,846 received pairs have never been put away**
- the only shelved stock is the **641** from the old-stock count, which stopped Sep 2
- 722 shelves are defined; **45** have anything on them

The system cannot tell Jadi where anything is, because nothing was ever told where it
went. The scan failures are fixed. The hunting is a separate and larger problem.

---

# PART TWO — Gift-card buying (parked, not deployed)

Built to the written ten-step process. **Six of those steps already existed** — a
purchase order's `po_lines` ARE "expected inventory", PO reconciliation already compares
expected against arrived, 17TRACK already watches the parcel. So the cart carries steps
1–7 and hands off: the parsed receipt raises a PO, and `buy_carts.po_id` is the seam.

Walked end to end on live Alias/StockX data — request, approval, $650 in cards against
$559.82 approved, a $606.01 receipt raising PO-103479, six pairs received, an audit
accounting for every card, and a close with all ten conditions green.

## Kervy's correction, and what it exposed

I shipped the three duties — approve, issue cards, audit — as **roles**. That was wrong:
`users.role` is one column, so it made them alternatives to being warehouse or PH, when
the card desk is a PH team member who *also* does that. Rebuilt as `users.privileges`
with checkboxes beside the role dropdown on Check Access.

The rebuild exposed two things the role version had hidden:

- **PH team members couldn't reach the screen at all.** PH has its own app and never
  touches the staff router. Under roles this never came up, because a card issuer wasn't
  PH. The moment the desk became "a PH person who also does this", they had nowhere to go.
- **The separation-of-duties check became load-bearing.** Roles were doing half the work
  for free; now one person can legitimately hold approve *and* audit, so the
  per-transaction check is the only guard left.

## The bug in the control itself

The "you can't audit what you approved" check compared `approved_by_id` — and the env
`admin`/`superadmin` accounts have **no row in `users`**, so their id saved as NULL and
the check silently never fired for the two accounts most likely to do both jobs. A
control that is off for its most privileged user is not a control.

## And two more that were already live

`po/ship` and `po/close-box` both demanded per-box lines, but `po/scan` refuses per-box
lines on a whole-order manifest — so **a Path-C order could never be closed or shipped by
anybody**. Unnoticed because nobody had moved one through the portal.

Also: every price box on the new screens was silently storing an event object.
`PriceInput` hands its `onChange` the event, not the value — no error, just a verdict
panel that never appeared. Caught by browser QA, not the build.

---

# Deployment

**Scan-out fix (#189) — DONE, live on production.**
- `db:setup` ran against prod and added `scan_failures` and nothing else — verified no
  `buy_cart*` tables and no `users.privileges` came with it.
- CI green (6m46s, fresh database), merged, branch deleted.
- Deploy verified in the live bundle: both the new failure wording and the stranded-run
  guard are present on `stickballman12.com`.
- 332 boxes still need receiving; the list is in `unreceived-stickers.csv`.

**Gift-card buying (#188) — next session, after local testing.** Its migration has NOT
been run. When it goes:
```
DATABASE_URL="$PROD_DATABASE_URL" node scripts/db-setup.mjs                 # six tables + users.privileges
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # -> BUY_GC_KEY on Railway
```
Migration first; the code reads tables production doesn't have yet. And note: after that
migration **nobody can approve a buying request until you tick boxes in Check Access** —
admin excepted, so you're never locked out.

# One known issue that is not from either branch

The local suite fails on a **different spec on every full run** — `mobile-qa` once,
`raw-vin` once, then `ph-grid` + `po-edit` + `inventory-rapid-scan` — and every one of
them passes when run alone. `mobile-qa`'s PH-grid note test also fails on unmodified
`main`. That is tests sharing one local database and stepping on each other, not a
product defect, but it makes a full local run untrustworthy as a gate. CI is currently
the reliable signal because it builds a fresh database each time. Worth a separate fix.
