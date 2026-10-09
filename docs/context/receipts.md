# Email receipts — every store receipt in our mailboxes, filed by where and who

Built 2026-10-06 (task passed from JK to Kervy: "Foot Locker receipt parser and organized
receipt storage"). Screen `src/screens/Receipts.jsx` at **`/receipts`** (staff home →
In-Store Mode) and **`/ph/receipts`** (PH home → Purchase Orders). E2E: `e2e/receipts.spec.js`.

## Why
Receipts reach us by email, and finding one meant asking the buyer or searching the
mailbox by order number (`cart/receipt-email`, buy-cart.md). The ask: file them
**automatically** as they arrive — spam included, because some land there — and say
**where** each purchase was made (store, address, city, state, ZIP) and **who** made it,
so Council's buys can be told from Joey's, without Joey sending his receipts in by hand.

## The two halves — "Check mailboxes" (2026-10-08)
**The sweep runs only when someone presses the button** on the Receipts page. There's no
schedule (owner's call). The first version, every 15 min, re-read two days of mail in 11
folders and ran the parser **inside Make** for each one: ~710 credits a run, ~68k a day.
It was switched off after one run on Oct 6, so **every receipt after Oct 6 went unfiled**
until this shipped (a Nike Factory Store receipt, order T09000000CY7BE8, was the report).

**Make (the fetcher)** — scenario **6534162** (Cherry's team 523971), now *"Receipt check —
on demand"*: webhook **2911453** → router → Gmail `[Gmail]/All Mail` and `[Gmail]/Spam`
(`after:<since_epoch>`, exact) · each Yahoo folder (IMAP `since` is a whole day, then a
filter on the exact time) → **POST the raw email** (form fields) to
`/api/receipts/ingest-raw` with `x-api-key: {{1.key}}`. **No code module and no stored
secret**: the key comes in with each request from our server. Built by
`~/Make.com Stickballman12/receipt-parser/build-check-blueprint.js`. The old blueprint
(with its code modules) is backed up next to it, `sweep-6534162-backup-2026-10-08.json`
(0600, it holds the old pasted key).

**The button** (`MailboxCheck` in `src/screens/Receipts.jsx` → `api/receipts/sweep.js`):
- Looks back to **the last check minus an hour** (overlap is free, since receipts dedupe on
  `message_key`). Never checked → the last 3 days. **"From a date…"** looks back to
  midnight EST of a chosen day (≤60 days) for a catch-up.
- **Make caps each folder search at 300 emails, OLDEST first** (6534162, raised from 100 on
  2026-10-10). A busy window can stop before the newest mail, and since the next check
  started from the last *press*, that mail was never read again. That's how order
  **T09000000CY7BE8** (Nike, Oct 8) went missing: three checks, zero receipts filed. Now
  `ingest-raw` counts every email it's handed, receipt or not, per mailbox + folder for the
  current run (**`receipt_sweep_folders`**: run_at = `receipt_sweep_last.at`, fetched, newest
  date). A folder that came back with **≥ 80 % of the cap** (`RECEIPT_SWEEP_CAP`, default 300;
  80 % because Yahoo fetches the whole day and Make drops the earlier hours before posting)
  makes the next check start from **its newest email − 1 h** instead (`resumed` in the reply;
  the page says "may have stopped early in …"). A new run resets the count. The start only
  ever moves *back*; dedupe makes re-reading free. Not a callback from Make: ingest-raw
  already sees every email a run touched.
  **Blind spot: Yahoo.** IMAP `since` is a whole day, so Make fetches the day and POSTs
  only the hours after the last check. A Yahoo folder that hit its cap can look quiet to
  us (5 posted of 300 fetched). So the Yahoo search's cap is raised to **800** instead,
  which makes truncation unlikely rather than detectable. Inbox and Bulk are the busy ones.
  Make bills per email actually returned, not per cap, so 800 costs nothing extra on a
  normal day (a whole 4-day check was ~560 ops in total). **Cost lever:** every press
  re-fetches Yahoo's whole current day, so five presses a day read that day five times.
  Fewer, wider checks are cheaper than many narrow ones.
- **What each run did, per folder:** `receipt_sweep_folders.outcomes` tallies what ingest-raw
  answered (`filed` / `duplicate` / `skipped:<why>` / `error`), and `empty_bodies` counts emails
  that arrived with neither text nor html, which points at Make's mapping, not the parser.
  `GET /api/receipts/sweep` returns them as `folders`. The page prints "Last check read N emails:
  X filed, Y already filed, Z not receipts" (per-folder detail in the tooltip). Make's run
  history says SUCCESS whatever we answered, so this line is where a run that filed nothing
  gets explained.
- Make's POST steps have **`handleErrors` on** (2026-10-10). Before, a 4xx/5xx from us read as
  SUCCESS in the run history.
- A second press within 90 s → 409 (a double-tap mustn't start two runs).
- Last check in `app_settings.receipt_sweep_last` ({at, since, by}), so "Last checked …
  by …" shows live. Receipts appear in the list as they're filed (`email_receipts` is
  live), so the button only says the check started.
- Staff who see Receipts (warehouse, PH, admin). Hidden when `RECEIPT_SWEEP_HOOK_URL`
  isn't set.

**Parsing on our server** — `api/_lib/receipt-parser/parser.make.js` is a byte-for-byte copy
of the Make parser (`~/Make.com Stickballman12/receipt-parser/parser.js`, which the
order-number lookup 6282792 still runs in Make). It's a function body, not a module, so
`index.js` wraps it the way its own tests do. **`npm run receipts:sync-parser`** copies it
over after the parser changes. Its lookups still run from here: Nike UPC → StockX proxy;
Champs / Foot Locker names → the Make Gemini helper 6286830, which still costs Make
credits per new name.

`POST /api/receipts/ingest-raw` (form: mailbox, folder, from, subject, date, text, html,
to, cc, delivered_to, original_to, message_id; ≤4 MB) → parse → not a receipt =
`{skipped}` · else the same normaliser + `ingestEmailReceipt` as `/ingest`
(`api/_lib/receipt-ingest.js`).

### Before — the scheduled sweep (2026-10-06, retired)
The original design, kept for the record: a scheduled Make scenario parsed each email in a
code module and POSTed the parsed body to `/api/receipts/ingest`, which still exists and
still works.
- `parser.js` emits `store_location`, `recipients` (`headersList`; `original_to` =
  X-Forwarded-To / X-Original-To / Resent-To, else the forwarded block's `To:`),
  `order_number`, `message_key` = `mailbox|folder|<Message-ID>`. Marketing / shipping →
  `post:false`. Yahoo `Bulk` is in `YAHOO_FOLDERS`, and Gmail Spam needs its own search
  (it's not in All Mail).

**App (the filer)** — this repo:
- `POST /api/receipts/ingest` (`x-api-key: RECEIPT_INGEST_KEY`, compared in constant time;
  unset → 503). Body = the contract in the endpoint's header comment. It only ever ADDS:
  `message_key` (mailbox + folder + Message-ID) is unique, so the sweep's overlapping
  windows re-send harmlessly (`duplicate: true`). Unknown money stays NULL, never 0.
- `email_receipts` — the receipt: mailbox/folder, from, subject, recipients (as sent) +
  `recipient_addrs` (every address, lower-cased — what buyers match on), store + location,
  order number, totals, items (JSONB, same shape as the lookup: `final_price` = LINE total),
  parser warnings, the email text, buyer (`buyer_user_id`, `buyer_source` email|manual).
- `user_purchase_emails` — the addresses a buyer orders with. **One address, one person**
  (unique on lower(email)).

## Who bought it
The store emails the receipt to the address on the order. A receipt is filed under the
person who registered ANY of its recipient addresses — to, cc, delivered-to, or the
**original recipient of a forward** (a buyer who forwards their receipts to the order
mailbox is matched by their own address).
- **Suppliers add their own** on their Buying Requests page (`PurchaseEmails`, mode
  'mine') — we can't know which address a supplier buys under unless they say. Staff can
  too (same endpoint, own account). Shared env logins can't own one.
- **Admins manage everyone's** from the Receipts page → "Purchase emails" (mode 'all').
  A taken address answers 409; an admin is told whose, a supplier only that it's taken.
- **Registering an address claims the receipts that already arrived to it** — only ones
  nobody assigned. A person's assignment is never overwritten.
- Removing an address stops future matches; filed receipts keep their buyer.
- **Admin assigns by hand** on a receipt (`POST /api/receipts/assign`) when nothing matched
  or it matched wrongly → `buyer_source = 'manual'`.
- Council vs Joey **by state / store**: the location is stored and filterable; the rule
  itself waits on Jemiah / Jared (asked 2026-10-07). Until then, the buyer comes from the
  registered addresses or an admin.

## The page
Chips per buyer (count + total; "Unassigned" is one of them), filters for store, state,
EST date range and search (order #, store, city, email). Rows: received (EST, a **spam**
tag when it came from a spam folder), store + city/state/ZIP, order #, buyer, pairs, total,
and the **buying request** it belongs to. That link is found at READ time: a request's
emailed receipt is filed as `Email receipt <order>.txt` (cart/receipt-email), so a receipt
the sweep filed first still links once the buyer attaches it. Detail: location, recipients,
items, totals, parser notes, the email text. Staff only (`warehouse`, `ph_team`, admin);
suppliers get 403 — they register addresses, they don't browse the mailbox.

## Env
`RECEIPT_INGEST_KEY` — any long random string; the same value goes in the Make scenario
(pasted by a person, never sent through chat). Local `.env` has one for the suite.

## Not yet
- The Council/Joey state rule (waiting on the answer).
- A supplier's view of their own filed receipts.
- Auto-attaching a filed receipt to its buying request (today it links; the request's own
  receipt step is unchanged).
