# Order Cancellations (photos on Telegram → recorded → one reply per batch)

Screen `src/screens/Cancellations.jsx` at **`/cancellations`** (warehouse home → Sell & Ship)
and **`/ph/cancellations`** (PH home → Queues & Requests). Added 2026-10-20; reworked
2026-11-12 to the floor's workflow.

## Why
Karon (warehouse) typed every 10–15-digit order number to cancel at the end of the day.
Now anyone on the floor sends the bot the platform command and the **photo(s)**; every order
on them is **recorded** — order number + the shoe (name, SKU, size) — and the bot answers
**once per batch**, as a reply to the first photo, with that list.

**No verification step since 2026-11-12** (owner: "no status, no verification of the
inputted data — just record it"). There is no To review → Verify → Cancelled any more;
nothing here cancels anything on a platform either. The page is the record, filterable by
platform and by the EST day it was sent.

## Sending (warehouse, PH, admin)
- **The cancellations group** (`TELEGRAM_CANCEL_CHAT_ID`, prod: `-5123623236`) or their
  **private chat with the bot**. In the group only a photo or a slash command is acted on
  (`/alias@Bot` works); a bare number typed there is chatter and ignored. Either way the
  sender must have connected Telegram once (🔔 Alerts → Connect Telegram). The chat id IS the
  identity (`telegramSender`: an approved account with that `telegram_user_id`). Unlinked
  chat → "connect this chat first"; supplier → refused.
- **The platform is a command**: `/alias` `/stockx` `/ebay` `/temu` `/tiktok` `/shein` `/sg`
  (Stadium Goods) `/kc` (Kicks Crew) — `PLATFORMS[].cmd`. Three ways:
  - `/alias` as the photo's **caption** (anything after it = the reason). On an album the
    caption rides on ONE photo; its platform is noted for the album (`album:<media_group_id>`)
    and the other photos wait 1.5 s, then pick it up.
  - `/alias` alone, **then the photos** — every photo in the next 10 minutes is Alias
    (`chat:<chat id>:<telegram user id>` in `cancellation_tg_ctx` — per PERSON).
  - **typed**: `/alias 206557037 DD1391-100 9.5 - wrong size` (`fileTypedCancellation` +
    `typedDetails`: number, then an optional style code, size, reason; ≥ 6 digits). A size
    is taken after a style code, as `size 9.5` / `US 9.5`, or standing first after the number.
  The named platform beats the reader's guess. Unknown command (`/goat`) → "isn't one of
  the platforms", nothing recorded. `/help` → the how-to. The "/" menu:
  `npm run telegram:webhook -- commands`.
- **+ Add by hand** on the page for a picture that never made it to Telegram.

## One reply per batch (`api/_lib/cancellations.js`, `api/telegram/webhook.js`)
- The webhook writes the **photo row first** (`cancellation_photos`, with `tg_file_id`,
  `media_group_id`, the named `platform`) BEFORE it answers Telegram 200, then reads in
  `setImmediate`. The row is unique on (tg_chat_id, tg_message_id): a re-sent update finds it
  and stops — nothing recorded or said twice.
- **A batch** = every photo ONE person sends in ONE chat close together — an album
  (Telegram delivers it as separate updates within ~1 s) AND separate photos sent one after
  another (`cancelBatchStart` / `cancelBatchDone`, key `<chat>:<sender>`). Reads run one at a
  time (cancelOcr's queue), so a photo arriving while the batch is still being read joins it.
  Once the last photo is read the batch waits **4 s** (`CANCEL_BATCH_QUIET_MS`; 1.5 s in the
  e2e suite) for another, then sends ONE message with `reply_parameters.message_id` = the
  batch's first photo. Why 4 s: album photos land within ~1 s and someone sending photos one
  by one is 2–3 s apart, while each read is 1–2.5 s — the window only covers the gap after
  the last read; longer only makes everyone wait for the answer.
- The reply (`batchReplyText`, pure):
  ```
  Alias · 2 orders recorded
  1. #206557037 — Nike Free Run 5.0 'Phantom Sail' · CZ1884-010 · size 8.5
  2. #176889923 — no shoe details found

  ⚠️ Photo 3: no order number found — it's kept with the photo. Type it: /alias 123456789 (it fills that photo's row)
  ⚠️ Photo 4: not saved (could not download the picture (HTTP 500)) — send it again.
  ↩️ #300000001 is already logged as #12 by Karon — not added again
  ```
  One block per platform (PLATFORMS order); a number put right shows `(read as …)`, one found
  by its tracking number `(found by its tracking number)`; a photo with nothing readable says
  why when there is one (e.g. the AI reader's error). No platform → a "No platform" block +
  "Tip: send the platform first".
- **"Type it"**: a number typed within 30 minutes on the SAME platform fills that person's
  oldest photo row still without a number (`openUnreadCancellation`) — one row, photo and
  number together — and the bot says "(Filled the photo row #N …)".
- **Restart mid-batch** (`api/_lib/cancellations-worker.js`, every minute, production only;
  `CANCEL_REPLY_WORKER=on|off`): photos still `pending` > 3 min are read again from Telegram
  by their file id (if their rows were already recorded, just marked read); photos read but
  never answered (> 1 min) get one reply per person per chat, under their first photo. The
  reply claims `replied_at` compare-and-set (`claimCancellationPhotoReplies`), so the live
  batcher and the sweep never both answer; a failed send releases the claim for the next
  sweep. Only the last 6 hours. Worst case after a restart the batch is answered in a
  different grouping — never lost, never twice.
- Each batch alerts **`cancel.logged`** once (PH + admin, opt-out in 🔔 Alerts).

## The shoe: name + SKU + size (`fillDetails`), in this order of trust — never invented
1. **OUR order with that number** (`knownOrdersFor`, one query per source):
   - `ebay_orders` (order_id; `lines[]` title / Shopify SKU / size). The line SKU is OUR
     Shopify SKU, so the style code, size and product title come from its
     `shopify_listing_variants` row; else a style code in the title; else blank.
   - `shein_order_units` (order_no; seller_sku → `shopify_listing_variants`, title).
   - `presell_sales` → `presell_stock` (Alias / StockX pre-sell: sku, size, name).
   A match **confirms the number** (`order_match` = ebay | shein | presell, a "✓ our … order"
   chip on the page) and fills the shoe. An order of several pairs → the line the photo's
   SKU / size points at, else every line joined with " + " (`detailsFromOrder`).
   **One-character correction** (`matchOurOrder`): a read number that is exactly one
   OCR slip away from exactly ONE of our orders (same platform when one was named) is
   recorded as that order, with a note "Read as … on the photo; one character off our …
   order …". Only LETTER↔DIGIT slips (0/O, 1/I, 1/L, 5/S, 8/B, 2/Z, 6/G — `confusableKeys`),
   never digit↔digit (1/7, 3/8): most Alias orders are not in our records, so a CORRECT read
   of one could otherwise be "corrected" onto a neighbouring real order — and the wrong order
   cancelled. Two candidates → no guess. Typed numbers are never corrected.
   **No order number on the label but a tracking number** (an eBay FedEx label prints only
   `TRK# 8790 6081 3551`): `trackingFromText` → the eBay order whose fulfilment shipped under
   it (`ebay_orders.fulfillments[].number`) or a pre-sell sale's `tracking_number` → that
   order — checked BEFORE any AI. Exactly one match, else nothing.
2. **The label** (OCR): style code + size, and the name line (`labelProduct`: the line under
   "ITEM", or a line with a quoted colourway — whole lines only, ≥ 3 words; a cut-off
   "ke Air Max 90 A" stays blank). Only when the picture shows ONE order.
3. **Our catalogue by style code** (`catalogueNamesBySku`): `products`, then received
   `items`, then `presell_stock` — no paid lookups, no KicksDB.
`details_from` records which (comma list: ebay, shein, presell, label, typed, catalogue,
edited); the page shows "shoe from …".

## Reading (`api/_lib/cancelOcr.js` first; the AI only with `CANCEL_AI=on`)
tesseract (checked-in `eng.traineddata`) reads the ORIGINAL picture TWICE, prepared two ways
(3600 px sharpened as sparse text; 2400 px plain grey as a page). `ordersFromText` (pure,
tested) picks the numbers out of each text:
- the platform's shape (StockX `12345678-12345678`, eBay `12-34567-89012`), with a stray space
  or an OCR O/I/S/B inside the digits; **SHEIN `GS` + 11-15 letters/digits** (letters kept —
  `GSON8F44T00000N` has both O and 0);
- a number after "Order #" / "Order No." / "Order number" / "Order ID" (same line or the next);
- **an Alias packing label**: a 9-10 digit line of its own (the small "ORDER #" caption doesn't
  read), only on a packing label (a style code, "alias"/"goat", or `/alias` sent). A `/` inside
  that line is a 7 — measured: two of eight preparations of the real 2026-10-20 label read
  176889923 as `1/6889923`;
- never a tracking number (1Z…, 92-95… USPS, any TRK#/TRACKING/UPS line), phone or ZIP.
A number both reads found = `agreed`; one read only = still recorded, noted. 25 s cap. The
read text is kept on the row (`ai_raw.text`) so a miss can become a rule + a test line.
Measured on the real Alias labels of 2026-10-20 (WhatsApp copies, 471 px): order #, SKU, size
right on both reads, ~1 s each; the ITEM name line is too small at that resolution to read
whole (left blank, by the rule above). The eBay FedEx labels (`~/Downloads/eBay label *.png`)
read `TRK# 8790 6081 3551` exactly — that is what the tracking match uses.
**AI — OFF on prod** (owner, 2026-11-10). With `CANCEL_AI=on` (the e2e suite's fake) it is
asked only when tesseract found no number and no tracking match; read twice, disagreement
noted. Out of credit → said plainly ("tell an admin").
- Unreadable / nothing found → still ONE row with the photo, no number — a request is never lost.
- HEIC sent "as a file" → that row + "send it as a photo (not as a file)".
- The same number twice on one picture is recorded once.

## The page
A record list, newest first: platform, **order # (Copy)** or a red **"No order # read — type
it from the photo"** marker (row edged red), shoe name, SKU · size, reason, note, then
`#id · sent by · date/time EST · source · shoe from …`, and the **whole photo** (never
cropped; tap to enlarge).
- **Date** (`periodDays`, pure): Today (default) · Yesterday · Last 7 / 30 days · Pick a day ·
  Date range · All time — **EST days, by the day it was sent** (server:
  `(created_at AT TIME ZONE 'America/New_York')::date`; the page: `estToday()`), checked from a
  Manila browser in the e2e suite.
- **Platform** chips with counts (within the period + search), "No platform" when any;
  **No order # read (n)** filter; search by order # / SKU (also name / sender). URL keeps
  `?period=&from=&to=&platform=&missing=&q=`.
- **CSV** of what's shown (Sent EST, Platform, Order number, Shoe, SKU, Size, Sent by, Reason,
  Details from, Note, ID).
- **✎ Edit / Type the order #** — anyone who sees the page (warehouse, PH, admin). Blank
  shoe fields are filled from our order with that number / the catalogue on save
  (`api/cancellations/save.js` runs `fillDetails`). Duplicate number → 409 "already logged as #N".
- **Remove** — only for a photo that isn't an order (PH / admin, or whoever sent it): kept in
  the database (`status = 'rejected'`, reason in `cancellation_events`), never listed or put
  in a message; the number may be recorded again.

## Old rows / the status column
`status` no longer drives anything. New rows are inserted as `'to_review'` — deliberately not
a new value: the CHECK constraint has one definition, and a value an older `db-setup` doesn't
know would make that script die re-adding its constraint on a rollback or the shared dev DB
(the "old-enum time bomb"). Rows reviewed before 2026-11-12 (`verified`, `submitted`) are
ordinary records now. **`rejected` = removed**: rows a reviewer rejected before stay hidden —
they were judged "not an order to cancel", and bringing them back as live records would
re-list orders someone decided not to cancel. verified_by / submitted_by / platform_ref stay
in the table, unused.

## End of shift: `/msg`, `/msgall`, `/report`
All by ONE EST day (the day the rows were SENT, `listCancellationsForDay`); default today, or
`yesterday` / `2026-10-19` (`dayFrom`; a future or junk date → "Which day?").
- **`/msg`** → a picker, one button per platform with orders that day ("Alias (2)",
  `cxmsg:<platform>:<day>`). A tap answers `Alias\nPlease cancel the following order(s):\n#206557037 - CZ1884-010 size 8.5` (`cancelMessage`).
- **`/msgall`** (also `/msg-all` / `/msg all`) → every platform's block (`cancelMessageAll`).
- **`/report`** → the day's records as `cancellations-<day>.csv` (`sendDayReport`) — removed
  rows are not in it.
- A row with no number / no platform is counted in a "⚠️ Not listed: …" footnote.

## Rules (`src/lib/cancellations.js`, shared by server and page)
`PLATFORMS` (pattern only where known: StockX, eBay); `cleanOrderNo`, `orderKey` (letters +
digits → **duplicate guard**: unique index on `order_key` while `status <> 'rejected'`,
`cancellations_live_key_uq`; a 23505 is answered "already logged as #N"); `flagsFor` (stored
for the record only — nothing blocks on them now); `confusableKeys`, `matchOurOrder`,
`detailsFromOrder`, `styleIn`, `labelProduct`, `trackingFromText`, `typedDetails`,
`orderLine`, `batchReplyText`, `periodDays`, `cancellationsCsv`, `cancelMessage*`.

## API
`GET /api/cancellations/list?from=&to=` (EST days; open when left out) → `{ rows, capped, me }`
(cap 3000, the page says so) · `GET …/get?id=` · `GET …/photo?id=<photo id>` (auth'd; photos
carry customer addresses, never public) · `POST …/save` (no id = add by hand; id = a fix) ·
`POST …/action {id, action:'remove', reason}`.

## Tables (db-setup; in `LIVE_TABLES`)
`cancellations` (one row per ORDER; + `details_from`, `order_match` 2026-11-12),
`cancellation_photos` (one per picture, R2 key or bytes; + `tg_file_id`, `media_group_id`,
`platform`, `result` JSONB = what filing it gave, `replied_at` 2026-11-12),
`cancellation_events`, `cancellation_tg_ctx`. **Prod needs `db:setup`** for the 2026-11-12 columns.

## Tests
`e2e/cancellations.spec.js`: fake Bot API on :5198 (getFile + the download), fake reader on
:5196 (`CANCEL_AI_URL`, `CANCEL_PHOTOS_IN_DB=1`, `CANCEL_BATCH_QUIET_MS=1500`); each test
picture has its own width so the fake answers each photo apart. Covers the rules, one reply
per batch (separate photos + album), our eBay / SHEIN / pre-sell orders, the one-candidate
correction, the tracking-number match on a rendered FedEx label, the rendered Alias label
(name line read), catalogue names, typed fill-in, duplicate + re-sent update, the restart
sweep (called in the test process against the fake), end of shift, and the page from
Asia/Manila. Run with `E2E_PORT=…` when another suite is running.

## Not yet / can't be verified locally
- No real prod photos were read for this change (prod reads are not allowed): the name-line
  rule and the SHEIN shape rest on the two real Alias labels, the eBay FedEx label PNGs and
  the SHEIN numbers in the docs. Check the first real batch's `ai_raw.text`.
- Alias orders that are NOT pre-sell are not in our tables, so most Alias numbers can't be
  confirmed — they are recorded as read.
- No auto-cancel on any platform; no in-app photo upload (photos come through Telegram).
