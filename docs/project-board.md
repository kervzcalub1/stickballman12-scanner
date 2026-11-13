# Stickballman12 — Project board

The one list of every project: what is live, what is half-built, what is waiting on you.
Kept by the **project-manager** agent. Finished work moves to "Live", it is never deleted.

**Last updated:** 2026-11-14 (EST) — first version, built from git, GitHub, Railway (names only),
the docs and the memory notes.
**Live on Railway:** `main = 8237520` (#417), deploy SUCCESS. Open PRs: **#394** only.

How to read a row: **Status** is one of Idea · Planned · Building · In QA · Ready to deploy ·
Merged — needs db:setup · Live · Shelved. "Checked" means I confirmed it in git / GitHub / Railway
today; anything taken only from older notes says "(from notes)".

---

## 1. Waiting on you (owner decisions)

Most important first. Each has my recommendation.

| # | Decision | Why it matters | My recommendation |
|---|---|---|---|
| 1 | **Lost Package Tracker: deploy when QA passes?** | Built today, not committed. New tables, so prod `db:setup` is part of the deploy. EasyPost charges per tracker, and every "Re-check" pays again. | Say **"deploy"** once both QA agents are green. devops-release runs it (commit → PR → CI → prod db:setup → merge). Run the first real month once, then decide how often to re-check (monthly, not daily). |
| 2 | **eBay Sync: start going live?** | Test mode since Nov 8 (no live writes). The plan's handover needs 7 clean days, so it is due about **Nov 15**. DPL is still overwriting our eBay reprices (measured Nov 8: 810 of 1,597 back at Shopify's price). | Open eBay → Sync and read the handover checklist. If it is all green, turn **Stock** live alone and watch 2–3 days. Untick DPL's **Sync Price Changes** only on the day **Price** goes live, never before. |
| 3 | **BC-19: two pairs bought without approval, audited anyway** (IV6058-500 11W, HQ2529-500 13) | The app already flags "bought, not approved", but **Mark audited does not stop it**. The audit is meant to be the control. | Raise it with the team (your call). Then a small build: Mark audited asks for a written reason when there is a bought-not-approved pair, and the reason is kept. Brief: backend-engineer + frontend-engineer, `docs/context/buy-cart.md` (`compareReceiptToApproved`). |
| 4 | **Two small receiving fixes, offered and not built** | (a) Receipt matcher treats **15.5** and **15.5W** as different sizes, so a correct receipt shows false gaps. (b) Receiving **"Nothing found" name field** breaks after the first letter (found Nov 12; the SOP tells staff to work around it). The floor hits both. | Say **go** on both as one small PR. Same notation rule as PO reconciliation's `7.5W` fix. frontend-engineer for (b), backend-engineer for (a), qa-tester before deploy. |
| 5 | **Clean-up go** | #394 (Railway console `npm`) open since Nov 10. 366 merged branches on GitHub, 31 merged, clean worktrees on disk. | Say **"deploy #394"** and **"delete merged branches + worktrees"**. devops-release does it. List is in section 5. |
| 6 | SHEIN prices still on hold (since Nov 6) | 45 of 48 prices in the last dry run came from the Shopify fallback (no fresh market price), moves of −50 % to +160 %. | Keep holding until `platform_quotes` has fresh market prices for those shoes; then one dry run you look at. shein-project-lead owns it. |
| 7 | SHEIN clean-up list (from notes, Nov 6–11; not re-checked) | 35 products rejected by SHEIN for photos/titles; HQ8717 still refused; 324 sizes need a person; 9 shoes' seller-SKU swaps (#383 two-step never run live); stop 4seller from its own login; delete Shopify order #31114. | Do the one-shoe photo pilot first (Choose photos → Publish again), then decide the rest in one sitting. |
| 8 | Inbound Issues: 4 open questions (from Oct 25) | Who gets the ping (all PH or a privilege), post to the PO thread, re-ping hours, box label. | Defaults are running. Confirm or change in one reply. |
| 9 | Store orders (Joey): open questions (from Oct 25) | Tax % per store, card statement CSV import, and others in `docs/store-orders-plan.md`. | Decide tax % per store first; it changes Kevin's audit numbers. |
| 10 | PO sweep (from Nov 9) | PO-100044/45 look like duplicate drafts of PO-100082; PO-100021 ↔ B-100361 and PO-100001 unconfirmed; 9 POs delivered with no receipt (100041, 100065, 100069, 100080, 100095, 100019, 100111, 100113, 100116); empty batches B-102128–102134. | Warehouse checks the 9 first; delete the 2 drafts and empty batches after. |
| 11 | Glued stickers / short box (from Nov 9) | Item 16034 stored as `SBM-R-022956197626451467` (rename to `SBM-R-022956` waits on your go); items 7522, 15554 same problem; PO-100107 box 2 short one JS3514 10; 1ID print run 116 never used. | Go on the rename; warehouse reads the other two stickers off the pairs. |
| 12 | Small buying questions | SKU search: all tabs by default? part or exact SKU? "Waiting on an answer" open or shut by default? Ranges in "take all except 8-9"? | Defaults are fine (current tab, part match, open, no ranges). Only change if the floor asks. |
| 13 | Old stash `stash@{0}` (store-orders-entry WIP, Nov 3) | Unfinished work from before store orders shipped. | Drop it; store orders shipped without it. Look once before dropping. |
| 14 | Abandoned: **Inventory "Bulk · check all"** (PR #245, closed Oct 8, never merged) | Branch still exists. | Drop it unless the floor still asks for "scan 100+ VINs then check". |

Things I could not verify and you may already have done: OpenAI credit on the prod key; the
Shopify **product-edit** webhook (`PRODUCTS_UPDATE`) actually registered; Shopify Listings showing
"Last full check"; the 17TRACK quota; `ctornabe7` locked out or not.

---

## 2. In flight

| Project | Status | Where | Waiting on you | Risk | Next step | Last touched | Links |
|---|---|---|---|---|---|---|---|
| **Lost Package Tracker** — website version of the Python "Lost Package Tracker v1.1.0": upload the month's Order Updates sheet → Lost / Delivered / Cancelled / Refunded, then ask FedEx/EasyPost about the lost ones on the server | **In QA** (desktop + mobile QA agents running) | worktree `/Users/kervz/sbm-lost-pkg`, branch `feat/lost-package-tracker` off `8237520`; **not committed, not pushed** (14 changed + 8 new files) | Deploy go (section 1 #1) | New tables → **prod db:setup on deploy**. EasyPost bills per tracker. Remove the QA leftover `e2e/zz-mobile-qa.tmp.spec.js` before commit. New table must be in `LIVE_TABLES` (doc says `lost_pkg_runs` is). | QA report → fixes → devops-release | 2026-11-14 | `docs/context/lost-packages.md` (in the worktree). Keys `EASYPOST_API_KEY`, `FEDEX_CLIENT_ID`, `FEDEX_CLIENT_SECRET` are set on Railway (names checked) |
| **Railway console npm** | **Ready to deploy** | PR #394, branch `fix/railway-console-npm`, worktree `.claude/worktrees/console-path` | "deploy it" | Low; no schema | devops-release merges | 2026-11-10 | `docs/context/deploy.md` |
| **Home help screenshot** | Building (stale) | branch `chore/sop-home-shot`, worktree `.claude/worktrees/home-layout`, uncommitted `home.png` + `shots.json` | — | The picture matches #413, but #415/#416 changed the home again | Re-run `npm run sop:shots` on current main, then commit | 2026-11-13 | `docs/context/sop.md` |

---

## 3. Live, with follow-ups

### Shipped this week (checked in git / GitHub)

| Project | Status | Where | Follow-ups | Last touched |
|---|---|---|---|---|
| Home: hover help popup + "Show descriptions" switch on the first heading | Live | #415 (`a88b3f8`), #416 (`aa2f4e0`) | Help screenshot stale (above) | merged 2026-11-13 ~12:10 and 1:38 PM EST per GitHub (the session calls it Nov 14) |
| Deploy agent owns every deploy + hook | Live | #415 (`e8a2795`) | `project-manager` agent file is **not committed yet** (`.claude/agents/project-manager.md` untracked) — commit it with this board | 2026-11-13 |
| Buying request: "Approved shoes" list | Live | #417 (`8237520`) | none known | 2026-11-13 |
| Pre-sell Listings → 🕘 History | Live, db:setup done | #414 (`48883ae`) | Open the tab once and check the "rebuilt" older entries (never seen on real data) | 2026-11-13 |
| Buying: approved total, qty after cards, on-hand for every SKU, "(From BC-x)", SKU search | Live | #408 #410 #411 #412 | Questions in section 1 #12 | 2026-11-12 |
| Batch page: edit boxes expected | Live | #409 | — | 2026-11-12 |
| Home regrouped by job | Live | #413 | — | 2026-11-12 |

### Ongoing projects

| Project | Status | Where | Open follow-ups | Risk | Last touched | Links |
|---|---|---|---|---|---|---|
| **Buying requests** (gift-card buying) | Live | many PRs, latest #417 | BC-19 (section 1 #3). Order T0K000000DKPTDE: read the email in, fix 3 rows, find ≥ $230.45 of unrecorded cards (from notes). Card ending 5572 recorded $400, picture says $200. Real barcode scan from the supplier PDF and a real Cardwell ZIP never tested. Card images: any warehouse/PH login might fetch one by URL (`api/cart/file.js`, read in code, not tested) — ask security-auditor. | Money control | 2026-11-13 | `docs/context/buy-cart.md`; memory `buying-*`, `gift-card-*` |
| **Email receipts** | Live | — | 15.5 vs 15.5W (section 1 #4). "Read this email" never run on a real stored file. | False gaps on audits | 2026-11-14 | `docs/context/receipts.md` |
| **eBay Sync** (our own DPL, listings only) | Live in **Test mode** | #385–#387, prod db:setup done | Go-live (section 1 #2). Delete the unused eBay Dev Dashboard app "eBay via Stickballman12.com". 14 titles over 80 characters. 4 shipped eBay orders never reached Shopify (DPL "Not Synced"). | Two writers on one field | 2026-11-08 | `docs/ebay-sync-plan.md`, `docs/context/ebay-sync.md`, `docs/context/dpl.md` |
| eBay Listings / Reprice / locks / orphans | Live | #348 #349 #358 #359 | Press "Pull listings from eBay" and check the 25 SKU-less listings now show sizes. DPL overwrites reprices until eBay Sync Price is live. | — | 2026-11-04 | `docs/context/ebay-listings.md`, `ebay-api-reprice.md` |
| DPL photo fix (manual task) | Done for now | — | KI7175, HQ3031-003 titles too long; 2 products not found in II; IM6670-202 count (II 13 vs DPL 10); Long Jump code | — | 2026-11-08 | memory `dpl-photo-fix-task` |
| **SHEIN** (one page: listings, live stock sync, orders, reprice) | Live | #337–#343, #377–#387, #397–#400 | Section 1 #6 and #7. First real SHEIN sale: check the 10-second order check and orders-at-sale. SHEIN API budget at a 30-min re-read unmeasured (fallback `SHEIN_LISTING_EVERY_MIN=120`). 7 SHEIN sales not off Shopify (from notes). | Oversell if a sale is missed | 2026-11-11 | `docs/context/shein-*.md`, `docs/shein-listings-plan.md` |
| StockX Listings reprice | Live | #350 | Check prod "no cost" count (if high, StockX codes don't match our SKUs) | Floor price wrong without cost | 2026-11-03 | `docs/context/stockx-reprice.md` |
| Listings kept fresh by the server | Live | #393 | Confirm "Last full check" on Shopify Listings; confirm `PRODUCTS_UPDATE` webhook registered | Product edits arrive 30 min late | 2026-11-10 | memory `listings-kept-fresh-by-server` |
| Order Cancellations | Live, AI off | #391 #404 | Send one real batch of photos and check the bot's reply. eBay FedEx labels carry no order number (tracking → eBay order lookup not built). | — | 2026-11-12 | `docs/context/cancellations.md` |
| Purchase Orders: label files, CSV, whole-order scan | Live | #403–#407 | Team uploads their real CSV (should read 77 shoes / 260 pairs / $10,972.61). One supplier scans a whole order with a gun on an iPhone. | — | 2026-11-12 | `docs/context/purchase-orders.md` |
| Deleted POs archive | Live | #352 | Railway Postgres backup is the only source for the 12 recovered POs' full lines | — | 2026-11-03 | memory `deleted-pos-archive` |
| Store orders (Joey, Kevin's audit) | Live | #304–#312, #320 | Section 1 #9 | Mis-billing | 2026-10-25 | `docs/store-orders-plan.md` |
| Pick list | Live | #402 | Never printed on the real thermal printer; 2 layout choices unconfirmed | — | 2026-11-12 | memory `pick-list` |
| Inbound Issues | Live | #323 | Section 1 #8 | — | 2026-10-25 | `docs/context/inbound-issues.md` |
| Box swap | Live | #347 #353 #354 #357 | Not built: "box swap" chip on PO reconcile; send Brent the SOP | — | 2026-11-04 | `docs/context/no-box.md` |
| Pre-sell Listings / Fulfilment | Live | many | Prod logs said `[presell-fulfill] 53 orders could not be read` (Alias 404) — offered, no answer | Orders not followed to shipping | 2026-11-13 | `docs/context/presell-*.md` |
| Waitlist | Live | #264 #265 #268 | Not built: price floor / auto-reprice; SOP for Nikki | — | 2026-10-09 | `docs/context/waitlist.md` |
| Costs: per-shoe cost, platform profit phase 1, Cost lookup | Live | #193, platform-projection, #395 | Cost lookup: add in-store buys + saved item cost? Later phases of the cost plan not built (section 4). | Most pairs still have no cost | 2026-11-11 | `docs/context/costs.md`, `payout-calculator.md` |
| My Scans / Stock Check | Live | #361 #392 #396 | PH: also see in-store / existing / empty-box pairs? | — | 2026-11-11 | memory `stock-check` |
| KicksCrew (their app, not ours) | Checked Nov 10 | — | Ask KicksCrew how their app picks products, to add the 99 missing styles and list the 31 unlisted ones. Rotate the KC API secret if the login is shared. | ~270 sizes not on KC | 2026-11-10 | memory `kickscrew-sync-compare` |
| eBay top-sneakers sheet | Done | Google Sheet | 4 SKUs still "Not found" | — | 2026-11-11 | memory `ebay-top-sneakers-sheet` |
| Receiving | Live | — | Name-field bug (section 1 #4); "saved" message shows the VIN range backwards | Floor slowdown | 2026-11-12 | `docs/context/receiving.md` |
| SOPs (PDF) | Local only, by design | repo root, untracked | Read the two new ones (receiving, supplier pack & ship); printed buying SOPs may have old gift-card wording; send Brent his SOP, Alex the Stock Check how-to | — | 2026-11-12 | memory `sop-*` |

---

## 4. Planned / ideas / shelved

| Project | Status | Plan | Notes |
|---|---|---|---|
| Listings Hub (list/delist/price/qty everywhere from here) | Planned; phase 1 (eBay Listings) and eBay Sync shipped | `docs/listings-hub-plan.md` (**uncommitted, only in the main checkout**) | eBay Sync is effectively phase 2 |
| Virtual Stock (sell first, buy locally) | **Shelved** Sep 25 | `docs/virtual-stock-plan.md` (**uncommitted**) | Don't build unless asked; never call it "Pre-sell" |
| Cost & platform profit, later phases (purchase log by tracking, real fee table per channel) | Planned, draft | `docs/cost-and-platform-profit-plan.md` (**uncommitted**, still says "nothing built" — phase 1 did ship) | Waiting on your review |
| Warehouse count (whole-warehouse rescale) | Planned, nothing built | artifact in memory `warehouse-count-plan` | Blocked on: where the unplaced pairs physically sit (walk-through first) |
| Inventory audit master plan (Oct 6) | Planned, nothing built | artifact in memory `inventory-audit-master-plan` | "Fix first": stop Existing Stock auto-marking pairs listed; idle-stock alert; scan-out gap |
| UPS-native tracking | Idea, waiting on your team | memory `ups-native-tracking` | UPS only, so not a full replacement |
| Apparel pricing | Deliberately not built | memory `apparel-in-inventory` | — |
| gzip on API responses | Idea, offered | memory `ph-list-silent-cap` | A month of PH data is ~4 MB, re-read live |
| Inventory "Bulk · check all" | Abandoned (PR #245 closed) | branch `feat/inventory-bulk-check` | Section 1 #14 |

---

## 5. Ops hygiene

**Prod db:setup owed:** none known for merged work (notes say each was run). **Lost Package
Tracker will owe one on deploy.** I could not read the prod schema to double-check.

**Branches (checked):**
- GitHub: 376 branches, **366 already merged** — safe to delete once you say so. Blocked today:
  `feat/home-popup`, `feat/buying-approved-list` (also `feat/home-card-sub`, merged).
- Not merged: `fix/railway-console-npm` (#394, open), `feat/inventory-bulk-check` (#245, closed).
  Seven Aug branches (`feat/inbound-eta`, `inbound-home`, `po-tracking-search`, `rescale-request-edit`,
  `rescale-tab`, `sku-codes-and-manifest-prices`, `fix/advisor-est-clock-and-business-scope`) show
  one commit not on main, but their PRs (#157–#161, #190, #191) all merged — leftovers, safe to delete.
- Local: 257 branches, 255 merged, plus 9 `worktree-agent-*` branches.

**Worktrees (checked):** 36. Only `sbm-lost-pkg` is live work — **don't touch**.
- Merged, clean, removable: `/Users/kervz/sbm-home-sub`, `/Users/kervz/sbm-bc-approved`,
  `/Users/kervz/sbm-telegram` (from Sept), and 28 under `.claude/worktrees/` (agent-a523…, audit-cards,
  buying-andrew, buying-nov6, cancel-check, dropoff, ebay-sync, expected, feat-per-shoe-cost, gc-cardwell,
  gc-files, gc-merchant, inbound-issues, listings-auto, my-inbounds, photo-required, presell-cost,
  receipt-remove, request-cost, shein-delist, shein-fast, shein-one-page, shein-orders, shein-review,
  shein-shoe-attrs, size-required, take-all-except, webhook-log).
- Keep until settled: `console-path` (#394), `home-layout` (uncommitted screenshot), `sop-shots`
  (one untracked capture script).

**Main checkout `/Users/kervz/Stickballman12` (checked):** sits on the merged branch
`fix/telegram-button-already-recorded` (Nov 4), **167 commits behind main**, with 19 modified files.
Most of those edits are old copies of work that later shipped another way (#388 PO link, the 25-SKU
note that #408 replaced). Files that exist **only here** and would be lost by a reset:
`docs/listings-hub-plan.md`, `docs/virtual-stock-plan.md`, `docs/cost-and-platform-profit-plan.md`,
`.claude/agents/project-manager.md`, `INVENTORY-SYSTEM-OVERVIEW.md`, three `migrate-*.sql`, the SOP PDFs.
Recommendation: commit the three plan docs + the agent file (with this board) from a branch off
`origin/main`, then switch the checkout to `main`. **Never `git checkout -- .` here.**
Stashes: `stash@{0}` store-orders-entry WIP (section 1 #13), `stash@{1}` SHEIN Listings backup
from Oct 27 (merged since, can go).

**Local database (from the session, names checked):** `stickballman` is now a **copy of production**
(real people, orders, gift-card records). `stickballman_old_20261114` = the old local DB.
`stickballman_prod` = an older copy, origin unknown. Risk: dev and prod share one Telegram bot and the
marketplace accounts — before `npm run dev` on real data, confirm the prod-only workers stay off
locally. Drop `stickballman_prod` once nobody knows why it exists.

**Env on Railway (names only, checked):** `EASYPOST_API_KEY`, `FEDEX_CLIENT_ID`,
`FEDEX_CLIENT_SECRET`, `OPENAI_API_KEY`, `SHEIN_APP_ID`, `SHEIN_APP_SECRET`,
`SHOPIFY_WEBHOOK_SECRET`, `RECEIPT_SWEEP_HOOK_URL` are present. Whether the OpenAI key has credit:
unknown.

**Docs out of date (for docs-maintainer):**
- `CLAUDE.md` SHEIN row and `docs/shein-listings-plan.md` still say "not merged"; it is live since #337.
- `docs/shelf-location-system-plan.md` and `docs/po-scanout-plan.md` say "not started"; both shipped.
- `docs/store-orders-plan.md` says "complete once E merges"; E merged.
- `SESSION-REPORT.md` was last written for Nov 12; Nov 13–14 work isn't in it yet.
- Memory index is over its size limit (215 lines, the tail is cut off when loaded) — trim it.
- Stray `app_settings.ebay_trading_budget` row on prod (harmless).
