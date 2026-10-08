# Waitlist — hold a shoe off listing until the market corrects

Built 2026-10-09 from the "SKU Pricing and Sales Strategy Review" call (Alex + Kirby).
The case: **DZ2628-110 size 8W** — cost $75.99, one $70 ask on StockX with the next ask
at $133 and recent sales $74–$162. Listing into that ask loses money. Waiting for the one
$70 pair to sell and coming in behind it doesn't. Alex's words: "create a tool that delays
the listing for, like, a month, so she could post it when the market fixes itself". And on
the reminder: "don't involve me, I'll forget". So the release is **automatic**, and the
person who lists is told on Telegram.

The owner's broader rule from the same call frames when to use it: **sell fast by
default**. Turn off the losing platform when the other one is green, and accept a small
loss on old or slow stock. The waitlist is for a shoe where **one cheap ask** has dragged
a normally good market under water for now. It's not a way to avoid every loss.

## How a hold works
- **`items.waitlist_until`** (TIMESTAMPTZ) **is** the hold. While it's in the future the pair
  is held. Once it passes, the pair is back. Nothing has to run for the release to happen.
  Also stored: `waitlisted_at`, `waitlisted_by`, `waitlist_note` (the reason, which goes on
  the daily report) and `waitlist_alerted_at` (the Telegram heads-up went). Partial index
  `items_waitlist_idx`. `scripts/db-setup.mjs`.
- The date is **the start of an EST day** (`waitlistUntil` in `src/lib/waitlist.js`, EST/EDT
  aware). "Back on Nov 8" means the pair is on Nov 8's list. It doesn't reappear at 7pm on
  Nov 7 because someone counted 30 × 24 h from the button press.
- **Who can be held** (`setWaitlist`): New Inventory pairs that are still with us, aren't on
  any store yet (II/AL/SX/SH all off), and aren't pre-sell, on the Rescale worklist,
  `PH_EXCLUDED_KINDS`, no-box, sold, shipped, missing or issue. Holding a pair that's already
  live would mean nothing, because the listing is still up. A hold on a pair already held
  replaces its date (that's how you extend one).
- **Release now** (`releaseWaitlist`) moves the date to `now()` rather than clearing it, so who
  held it and why survive in the history. It also sets `waitlist_alerted_at`: the person
  releasing it is looking at it, so the heads-up would only be noise.
- History: `item_events` `waitlisted` {until, note} and `waitlist_released` {early | auto}.
  Labels are in `src/lib/history.js`.

## Where the hold is enforced — a THIRD parallel exclusion
Same places as `pre_sell` and `PH_EXCLUDED_KINDS`, and for the same reason: guarding one
query is never enough. Held = `waitlist_until > now()`.

| Where | Guard |
|---|---|
| `phListItems` (receiving / report branch) | returns held pairs **with `waitlisted`** so the grid can file them under ⏸ Waitlist; they're shown **whatever the date range** (a hold since last month is still held) |
| `phListItems` (rescale branch) | `waitlist_until IS NULL OR <= now()` |
| `pendingCounts` → `ph_managed` | same, so held pairs don't inflate the listing badges |
| `recomputeUnlistedPrices`, `getItemsForGiRefresh` | same, priced when it comes back |
| `phUpdateGroup` (the grid's Save) | same: a stale tab can't tick a held pair as listed |

**Dated by its return.** A pair back from the waitlist is dated on New Inventory by the day
it came back (`greatest(waitlist_until, presell_freed_at / created_at)`), the same reading
pre-sell release takes. Held a month, it would otherwise come back outside the date window
PH is looking at, and nobody would see it.

## On screen (New Inventory, `src/screens/PHTeam.jsx`)
- **⏸ Waitlist tab** — a fifth bucket after ⟳ Rescale (`PH_TABS`, `phTabOf` in `src/lib/ph.js`;
  held outranks everything else). **Rule 5 of `groupPhSized`**: held pairs keep their own row
  (`|#|W` in the key). Holding size 8 must not drag 9 and 10 off the to-list rows, and a
  row belongs to one tab.
- **⏸ Waitlist…** on a Pending row (PH + superadmin, `kind === 'receiving'`) →
  `src/components/WaitlistModal.jsx`. You pick which **sizes** (all by default; the loss is
  usually one size), and how long: 7 / 14 days, **1 month (default)** or 2 months. The
  reason is prefilled from the best-platform chip when it shows a loss.
- A held row: teal chip **⏸ Back 11/07/26 · 30d** (who held it and why are in the tooltip),
  no Edit, and **▶ Release now**. Admins see it read-only.
- **⬇ Waitlist CSV** beside the tabs: everything on hold, any date.

## The daily report + "back from the waitlist" (`api/_lib/waitlist-worker.js`)
- **CSV** = `waitlistCsv` (`src/lib/waitlist.js`), one row per SKU + size: qty, cost, GI,
  final price, the **cached** Alias/StockX asks (`platform_quotes`, ≤12 h, never an upstream
  call), the best platform and profit/pr at those asks, held on / by / back on / days left,
  reason, supplier, batch, VINs. The download button and the Telegram file are the same file.
- **Worker** (`server.mjs` starts it): every 5 min it claims pairs whose date has passed
  (`claimWaitlistReturns` — one UPDATE … RETURNING, so nothing is announced twice) and
  sends **`ph.waitlist_back`** (one message for the lot). Once a day from **18:00 EST** (end of
  the PH night shift; `WAITLIST_REPORT_HOUR_EST` overrides) it sends **`ph.waitlist_daily`**
  as a **CSV file** (`sendAlertDocument`, multipart `sendDocument`), `once` per EST day. An
  empty waitlist sends nothing.
- **Runs on Railway's production environment only** (`RAILWAY_ENVIRONMENT_NAME`, which
  Railway sets itself). Dev and prod share one bot, and a laptop must never DM real people.
  `WAITLIST_WORKER=on|off` overrides. `npm run dev` never starts it.
- Alert defaults (🔔 panel, group "Waitlist"): *Back from the waitlist* is on for PH and off
  for admins. *Daily waitlist report* is on for admins and off for PH. Each person can flip
  either.

## API — `api/ph/waitlist.js`
`GET` → `{ rows }` · `GET ?format=csv` → the file · `POST {action:'hold', vins, days, note}` →
`{ held, skipped, until }` (409 when none could be held) · `POST {action:'release', vins}`.
Reading: PH + admin. Changing: PH + superadmin.

## Tests
`e2e/ph-waitlist.spec.js` — hold one size (tab, chip, no Edit), a held pair isn't saved as
listed, list + CSV + admin can't change it, the date passing brings it back (claimed once),
Release now.

## Not built
- A **price floor** / auto-reprice behind the lowest ask (Alex's "put it at $132 and we're
  next in line"). The waitlist is the manual half of that.
- Putting lines on the waitlist **automatically** when the chip shows a loss. It's a
  judgment call (the rule is "sell fast" first), so PH decides, with the loss prefilled
  as the reason.
