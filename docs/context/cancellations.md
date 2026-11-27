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
  (Stadium Goods) `/kc` (Kicks Crew) — `PLATFORMS[].cmd`. `/alias@Bot` (what a group's "/"
  menu inserts) is the same command (`splitCommand`, pure). **Text after the command is the
  note** on every row it covers (`/ebay wrong size shipped` → `reason`). Three forgiving
  ways in (2026-11-20, `fileFromChat`):
  - **A — caption**: `/alias` as the caption of a photo, or of ONE photo of an album. The
    album's platform AND note are noted (`album:<media_group_id>` in `cancellation_tg_ctx`);
    its other photos wait 1.5 s (`ALBUM_WAIT_MS`), then take them.
  - **B — command first, then the photos**: on for **90 seconds** (`SESSION_SEC`; was 10
    minutes), per PERSON per chat (`chat:<chat id>:<telegram user id>`), **restarted by every
    photo that uses it** (`useCancellationCtx` = read + touch in one UPDATE). The bot answers
    "StockX mode on for 90 s — send your photos" (+ the note when one was typed).
  - **C — photos first, nothing else**: the photo is **READ first** (2026-11-21, "The platform
    without being told" below) — the number may be one of our Shopify orders, or its shape or
    the slip's own words may say whose it is, and then it is recorded with nobody asked. Only
    a photo none of that can place is **held** (`held_at`), nothing recorded, and the bot asks
    ONCE — "2 photos from Karon — I couldn't tell the platform. Which is it?" —
    with a 2-row keyboard (Alias · StockX · eBay · SHEIN / TikTok · Temu · SG · KC,
    `pickerKeyboard`, `cxpick:<platform>`). A tap files those photos on that platform and the
    question **becomes the summary** (edited in place). Sending the command instead of tapping
    (`/alias` typed after, or as the caption of a later photo) files them too. More photos
    before the tap join the same question (its count is updated). See "The picker" below.
  - **typed**: `/alias 206557037 DD1391-100 9.5 - wrong size` (`fileTypedCancellation` +
    `typedDetails`: number, then an optional style code, size, reason; ≥ 6 digits). A size
    is taken after a style code, as `size 9.5` / `US 9.5`, or standing first after the number.
    What tells an order from a note after a command is the **6+ digit number**.
  The named platform beats the reader's guess. Unknown command (`/goat`) → "isn't one of
  the platforms", nothing recorded. `/help` → the how-to.
- **The "/" menu is set by the server at start** (`registerBotCommandsAtStart` in
  `cancellations-worker.js` → `registerBotCommands`: private chats + the cancellations group,
  never the approval groups; production only by default, `TELEGRAM_SET_COMMANDS=on|off`;
  retried 3 times, never fatal). `npm run telegram:webhook -- commands` sets the same list by hand.
- **Photo or file**: `extractImageFile(msg)` (pure) takes the largest size of a compressed
  photo, or an image sent with **"Send as File"** (`document`, `mime_type image/*`) —
  uncompressed, better for small print; kept on the row as `cancellation_photos.as_file`.
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
- The reply (`batchReplyText`, pure). **Laid out 2026-11-26** (owner, after the first live
  batch came back as a wall of text — the same two-line explanation on each of seven missed
  photos, what needed a person at the bottom, no totals): the totals, then what needs someone,
  then what is fine.
  ```
  16 photos · 7 recorded · 2 to check · 7 need a number

  ❌ No order number · Stadium Goods · 7 photos          ← ONE block per marketplace + reason
  Photos 1, 2, 3, 4, 5, 7, 9
  The order number is the barcode, and it can't be read at this size. Send the photo as a File (not compressed), or closer.
  Each is sent back below: reply to it with the number.

  ❌ Not saved · Photo 16
  Could not download the picture (HTTP 500). Send it again.

  ⚠️ Check 2                                             ← across marketplaces, so each says whose
  176889923 · Alias · DQ4071-001 · 9.5 · reads disagreed
  GSU19K45B000Q2R · SHEIN · KJ7895 · 10.5 · adidas Adistar XLG 2.0 Grey… · read as GSUT9K45BO00O2R

  ✅ Alias · 5                                           ← one block per marketplace
  732100455 · HQ7901-602 · 9.5W · Nike V5 RNR Burgundy Crush…

  ↩️ 300000001 already logged as #12 by Karon

  Fix on the page: https://…/cancellations
  ```
  - **It is Telegram HTML** (`parse_mode: 'HTML'` on every sender: the batch reply, the edit of
    the picker into the summary, and `sayHtml` for a typed number's answer). The headings are
    `<b>`, and **every order number is `<code>`: one tap copies it** — it is pasted into a
    marketplace next. No `#` in front (it would be copied too). Whatever came off a label, a
    name or a note goes through `esc`. Messages that carry what a person typed stay plain text.
  - Order number first on every line, then SKU · size · the name cut to 28 characters
    (`orderLine`): long names are what wrapped every line on a phone.
  - The totals line only when there is more than one photo.
  - Longer than Telegram's 4,096 characters: the ✅ rows are what is cut ("…and 65 more, on
    the page") — never a ❌ or ⚠️ line.
  - The tags below ([OK] / [CHECK] / [MISSED]) are still what `rowStatus` returns; the message
    shows them as ✅ / ⚠️ / ❌ blocks.
  `rowStatus(row)` (pure, from the row's stored `flags` + `read_as`):
  - **[OK]** both reads agreed, or the number is one of OUR orders (a matched row carries no
    reader flags), or it was typed.
  - **[CHECK]** `(read as …)` a character was put right to match our order · `(reads
    disagreed)` · `(only one read worked)` · `(a third read decided)` — the new `tie_break`
    flag, set from `byThird` · `(hard to read)` / `(the reader was not sure)` (AI only) ·
    `(number looks too short)` · `(doesn't look like this platform's numbers)`.
  - **[MISSED]** no order number came off that photo, or the photo wasn't saved.
  An Alias number both reads agree on is **[OK]** even though it can't be confirmed against
  our records (most Alias orders aren't in them) — otherwise nearly every Alias line would be
  [CHECK] and the tag would mean nothing.
  The last line (the page: `APP_BASE_URL` + `/cancellations`, or just the words when that
  isn't a public origin) is there only when something is [CHECK] or [MISSED]. One block per
  platform (PLATFORMS order); a number found by its tracking number says so; a photo with
  nothing readable says why when there is one (e.g. the AI reader's error). No platform (only
  after an unanswered question timed out) → a "No platform" block + "Tip: send the platform first".
- **`[ Void Batch ]`** under every summary that recorded rows (`cxvoid`). The batch is found
  by the MESSAGE tapped (`cancellation_photos.reply_message_id`), so the button carries
  nothing. A tap: `voidCancellationBatch` claims `voided_at` (two taps void once), sets every
  live row of those photos to `'rejected'` (= Remove on the page: kept, never listed, the
  number may be recorded again) with `cancellation_events` "removed" by the tapper, and the
  message is rewritten "🚫 VOIDED by Karon — 2 rows removed … What it said: …". Who: whoever
  sent the photos, PH or an admin (the page's Remove rule). **60 minutes** (`VOID_MIN`) —
  later the button is taken off and the tap says to remove on the page (it asks for a reason).
  Already voided / batch unknown → said in a pop-up, button removed.
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

## A photo no number was read off is sent back (2026-11-26)
"Type it: /sg 123456789" fills that person's OLDEST row without a number — right for one missed
photo, a guess for seven (the Stadium Goods slips of 2026-11-25, every barcode missed). So
after the summary, **each photo with a [MISSED] row is sent back on its own** (`sendMissedCopies`
in `sendBatchReply`), as a reply to the photo it is a copy of, captioned
`[MISSED] Photo 2: no order number read (Stadium Goods · DM4044-001 · size 12).` /
`Reply to this message with the order number.`
- The whole photo, not a crop, and every one, not the first few (owner's call). It is the same
  Telegram file (`tg_file_id`; nothing is uploaded again); one that came "as a file" goes back
  with `sendDocument`. A copy that can't be sent is logged, never fatal.
- The copy's message id is kept in the photo's `result` JSON (`ask_message_id`) — **no new
  column, no db:setup**.
- **A text that replies to that copy** (`fileMissedReply`, checked first in `fileFromChat`) fills
  THAT photo's row through `fileTypedCancellation({ fillRowId })`: the number as typed (never
  corrected), the duplicate guard, our orders for the shoe, the row's own platform. Any account
  that may file cancellations can answer (the page lets the same people edit a row). The
  photo already has a number → said, nothing changed; no number in the reply → asked again.
- **A reply that filled the row gets a 👍** (2026-11-26) — on the reply itself (it was taken)
  and on the copy (that photo is done: in a run of copies the bare ones are still waiting).
  👍 rather than a check mark because ✅ is not a reaction Telegram lets a bot set. A refused
  reply (already has a number, no number in it, a duplicate) gets words and no 👍. Best-effort:
  with reactions switched off in the group, the written confirmation still goes out.
- In the group a reply is acted on ONLY when it replies to one of those copies; replies to
  anything else stay chatter and are never answered (not even "connect this chat").
- The typed way (`/sg 123456789` → the oldest open row) still works; the summary no longer
  suggests it.

## The picker (photos with no platform) — what is in memory and what is not
Deploys restart the server mid-shift, so **the state is in the database, not in buffers**:
- **Held photos** = `cancellation_photos.held_at IS NOT NULL` (+ `prompt_message_id` = the
  question they sit behind). Written before Telegram gets its 200, like every photo row.
- **Sessions and album captions** = `cancellation_tg_ctx` (`platform`, `note`, `set_at`).
- **In memory only**: the short wait before asking (`asks`, `askPlatformSoon`:
  `CANCEL_ASK_MS`, default 1.2 s, restarted by each photo, so three photos in three seconds
  get ONE question; serialised per person per chat so two timers can't both ask; the entry
  deletes itself when it fires) and the existing batch map. Losing either costs nothing: see
  the time-out.
- **Every state change is compare-and-set**: a tap releases with `UPDATE … WHERE held_at IS
  NOT NULL … RETURNING` (`releaseHeldCancellationPhotosByPrompt`), so a double tap, two
  people tapping, a tap racing a command or the time-out — one of them files the photos; the
  others get a pop-up ("already logged", "someone picked just before you").
- **Buttons answer for themselves** (`handleCancelTap`): `cxpick` / `cxvoid` are routed before
  the webhook's blanket `answerCallbackQuery`, because a tap can be answered only once and a
  refusal has to say why (`show_alert`). Not connected / supplier / another warehouse
  person's photos / a chat that isn't the cancellations group or a private chat → refused.
- **Nobody taps** (`CANCEL_HOLD_SEC`, default 10 min): the sweep (`expireHeldCancellationPhotos`
  → the normal stuck-photo re-read) files them with NO platform, as every such photo was
  before, and writes the summary into the question. Never lost to an unanswered question.
  (The sweep runs in production only — on a dev server a question waits until answered.)
- **An album whose caption arrives late** (> 1.5 s after its other photos): those photos are
  already held and asked about; the caption's command releases them, into the same batch.
- An album photo that ends up held is taken OUT of the live batch (`cancelBatchDrop`), so the
  batch's reply doesn't mark it answered and hide it from the tap that will file it.

## The platform without being told (2026-11-21)
Measured first (read-only): every channel's orders are in Shopify WITH the marketplace's own
order number, and 13 of the 18 Alias numbers the bot had recorded matched a Shopify order,
each with the full shoe. So a photo with no platform is read, and the platform comes from, in
this order of trust:
1. **The sender** (a command, a caption, the 90 s session) — always wins.
2. **Our own order with that number** — `ebay_orders`, `shein_order_units`, `presell_sales`,
   and now the **Shopify order index** (below): the platform, the confirmed number and the shoe.
3. **The number's shape** (`platformFromNumber`): StockX `12345678-12345678` **or**
   `06-B1P9GP5N4H` (what its Shopify orders carry now — two digits, ten letters/digits, at
   least two letters), eBay `12-34567-89012`, Temu `PO-211-` + 15–19 digits (or the same
   order's line number `211-…`), SHEIN `GS` + 11–15.
4. **What the slip says** (`platformFromText`, words — never logos): "alias" / "GOAT" /
   "Sneakers.com" → Alias (read on 16 of 18 real labels), "STADIUM GOODS" → sg (3 of 3),
   StockX, eBay, Kicks Crew, Temu, TikTok, SHEIN by name. **Only when exactly one is named**
   (a shoe called "Flight Club" names none). Stadium Goods is also known by what only its slip
   prints — "Fulfillment Number" / `SONDSS_…` — since its wordmark did not read on 2 of 11
   real slips. A row whose platform came from here carries the flag `platform_guess`, for the
   record only: **it is not a [CHECK] since 2026-11-25** (a slip that says GOAT is Alias's).
5. **Nothing says** → held, and the buttons ask (`fileCancellationPhoto` returns
   `{ needsPlatform: true }` under `requirePlatform`, nothing recorded; after the tap it is read
   again with the platform as the hint). While more of that person's photos are still being
   read the question waits (`cancelReading`), so it is one question about the ones that need it.

**A number that matches none of our orders** when it should: flag `not_in_shopify` →
**[CHECK] (not found in our orders)**. Only for the platforms the index covers whole (`INDEXED`:
stockx, temu, kc, ebay, shein — not sg, whose slip number isn't in Shopify, not tiktok, seen
on one order only, and **not alias**, below), and only while the index is complete and current
(`shopifyIndexFresh`: first run finished, last run < 30 min ago — never on a dev machine).

**Alias is NOT checked that way (2026-11-25).** Of the first 7 Alias photos read live with no
command, 4 read cleanly — both reads agreed, the number right under "ORDER #", the label
saying alias / GOAT — and matched nothing. A scan of Shopify back to 2026-07-28 (about 8,600
GOAT orders) did not hold them either: **some real Alias orders never reach Shopify** (why is
not known). So "not found" says nothing about an Alias read, and a clean one is [OK]; an
Alias number that IS in the index is still confirmed and still gets its shoe from it.

### What the first live batches showed (2026-11-25, 22 photos in 3 minutes)
Temu 5 of 5 [OK] with no platform given. Alias 3 matched, 4 as above. Stadium Goods 9 slips:
the barcode decoded on none (compressed photos, as measured before) and all were told to
resend as a file — **and four rows were recorded with numbers that were no order's**, fixed:
- The rule for an Alias label's lone 9–10 digit line (`packingLabel` in `ordersFromText`) fired
  on Stadium Goods slips, because they carry a style code too: a misread of the slip's small
  SKU column ("026484 052"), a date, a phone. It now applies only when nothing names another
  marketplace (the sender's command or tap, or the slip's own words) and the slip is not laid
  out with "BRAND:" (Stadium Goods and Temu print it; an Alias label doesn't) — unless the
  label itself says alias / GOAT / Sneakers.com.
- A Stadium Goods order number run together (`FAR02077818`) reads as a style code
  (`FAR02077` + `818`): two slips were recorded with their own order number as the SKU.
  `styleCodeIn` takes that run out of the text before looking for a style code.
- Temu's "PO" read as "P00" (`P00-211-…`) is put back by the Temu rule and no longer taken a
  second time by the "Order ID:" rule.
Checked by replaying every stored read (45 photos, all time) through the new rules: the four
wrong numbers and two wrong SKUs go, no matched number is lost. Reads are one at a time
(~5 s each), so 22 photos took up to 2 minutes to answer.

**When the two reads disagree**, the other reading is looked up too: whichever of the two is
exactly one of our orders is the number (the real Temu slip 3: `…0560 0 904…` / `…0560 9 904…`
— the second is the order). Recorded as that, tagged [OK], with a note.

**Look-alikes folded together** (`canonKey`, `matchOurOrder`'s third step): a long
letters-and-digits number comes back with several look-alikes swapped at once — the real SHEIN
slip read `GSUT9K45BO00O2R` for `GSU19K45B000Q2R`. Folding 0 O Q D → 0 · 1 I L T → 1 · 5 S → 5 ·
8 B → 8 · 2 Z → 2 · 6 G → 6 makes them equal; exactly ONE of our orders that folds the same →
recorded as that order, **[CHECK] (read as …)**. Digits are never folded onto each other, so a
digits-only Alias number is untouched and "never correct digit for digit" still holds. In the
database: `shopify_order_index.numbers_canon`, and `translate(…)` on `shein_order_units`.

### The Shopify order index (`api/_lib/shopify-order-index.js`, table `shopify_order_index`)
Shopify's own search finds a marketplace number only where the connector put it in the order
name or the source identifier — never in an attribute or a note (measured). Where each keeps it:

| Channel (Shopify app) | Platform | The marketplace's number |
|---|---|---|
| StockX | stockx | order name `06-B1P9GP5N4H` (+ attribute `StockX Order Number`) |
| My Store: GOAT | alias | attribute `g_order_number` (`g_platform` goat / flight_club / sneakers_dot_com — all Alias); the name is our own `#33938`, never indexed |
| My Store: SGAPP | sg | attribute `Order Number` = the note (`CK…`, `SH…`, `113-…`) + `Tracking Number` — **not what the slip prints** |
| Temu | temu | source identifier `PO-211-…` (+ line attribute `ORDER_SN`) |
| Kicks Crew | kc | order name `KS2699631` |
| eBay (DPL) | ebay | order name |
| SHEIN (ours / CedCommerce) | shein | source identifier `GS…` |
| TikTok | tiktok | a tag `TikTokOrderID:…` (one order seen) |

So a worker keeps our own copy: every Shopify order **changed** since the cursor (50 a page —
the nested lists cost ~11 points an order and a query may ask for 1,000), `orderIndexRow` (pure)
→ one row per marketplace order: `numbers` (keys), `number_texts` (as printed),
`numbers_canon`, `trackings`, `lines` (style from the title via `styleFromTitle`, size, name).
Our own web store and POIZON are not kept. First run = 30 days (~110 pages, a few minutes, in
runs of 80 pages); then every 5 min (`SHOPIFY_ORDER_INDEX_MIN`); rows older than 75 days are
dropped. **Production only** by default (`SHOPIFY_ORDER_INDEX=on|off`); state in
`app_settings.shopify_order_index_sync`. Read-only on Shopify. `knownOrdersFor` asks it LAST,
so an order we hold first-hand (eBay, SHEIN, pre-sell) is the one a number matches; a database
without the table yet answers "no match", not an error.

### Stadium Goods: the order number is the BARCODE (owner, 2026-11-21)
The slip prints no order number in words — "the number below the barcode is the order number"
(`AMA00386134`, `ETH00380838`: three letters, eight digits). It is in Shopify nowhere, so there
is nothing to check a read against: `decodeSlipBarcode` (`api/_lib/cancelBarcode.js`, zxing)
decodes the bars — exact or nothing — and is tried only on a slip that names Stadium Goods (or
sent with `/sg`) where no number was read.
**Measured limit:** on three real slips at Telegram's photo size (1200 px wide) the barcode is
~200 px wide, ~1.6 px a bar, and does NOT decode (0 of 3), and tesseract read the number under
it wrong on all three. A clean barcode of the same kind decodes down to ~1 px a bar, so the
limit is the photo. When it doesn't decode the row is recorded with the platform, SKU and size
(those read on 3 of 3: `SKU: 151186 003` / `SIZE: 13C`, `slipDetails`) and **no number**, and
the [MISSED] line says to send the photo **as a file** (full phone resolution) or closer.
**Decoding a real full-size photo was never tested** — no such sample existed.

## The shoe: name + SKU + size (`fillDetails`), in this order of trust — never invented
1. **OUR order with that number** (`knownOrdersFor`, one query per source):
   - `ebay_orders` (order_id; `lines[]` title / Shopify SKU / size). The line SKU is OUR
     Shopify SKU, so the style code, size and product title come from its
     `shopify_listing_variants` row; else a style code in the title; else blank.
   - `shein_order_units` (order_no; seller_sku → `shopify_listing_variants`, title).
   - `presell_sales` → `presell_stock` (Alias / StockX pre-sell: sku, size, name).
   - `shopify_order_index` (every other channel, 2026-11-21; `order_match` = shopify, "shoe
     from our Shopify order"): style code from the line title, size, name.
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
A number both reads found = `agreed`; one read only = still recorded, noted. **Except a ONE-
character misread** (`mergeReads`, 2026-11-13: the second read turned `#991138546` into
`#091138546` and one label became two cancellations): a second-read number one character away
from a first-read number the second read did NOT find is the SAME order — one row, flagged, the
note says "Second read said #…". If the second read found both numbers they are two orders
(consecutive numbers on one photo) and both are recorded.
**When the two reads disagree, a THIRD read decides** (`settleWithThird`, 2026-11-15; 3000 px,
plain, as a page): the number two of the three reads saw is recorded (agreed, the losing reading
kept as `other`); a number only one of three saw, within two characters of a number two reads
agree on, is that order misread (`#001177462` / `#991177462` had filed one photo as two) —
unless one read saw both, then they're two orders. Measured in the CI image (Ubuntu, Liberation
Sans): the first read turned `#991…` into `#091…` on 23 of 60 printed labels; with the third read
60/60 came out right. On the real phone photos the first read is still the best single read, so
the order of the reads didn't change. 25 s cap per read step. The
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

## Reported to the platform (2026-11-27)
The one thing a person ticks: **the marketplace has been told to cancel this order.** It
records what someone did — nothing is sent to a platform, and `/msg` / `/msgall` / `/report`
still list every row of the day, ticked or not.
- **On each row**: a tick box "Reported to Alias" (the row's platform). Ticked, it shows who
  and when (EST) beside it, and the row reads as done (green edge, quieter) — still listed.
  Untick to take it back. A row with **no order number has no tick box**: there is nothing
  to report until the number is typed.
- **Filters**: `To report (n)` (has a number, not ticked) and `Reported (n)` — toggles like
  "No order # read", press again to clear; `?reported=no|yes` in the URL.
- **✓ Mark the N shown as reported**: every row on screen that has a number and no tick,
  after a confirmation that lists the first few. For the end of a shift: pick the platform,
  paste its `/msg` list to the marketplace, mark what is shown.
- **Who**: anyone who sees the page (warehouse, PH, admin) — the same people who can edit a row.
- **Where it lives**: `cancellations.submitted_at` / `submitted_by`, read back as
  `reported_at` / `reported_by` (`CX_COLS`). They are the columns the pre-2026-11-12 review
  flow had for "cancelled on the platform", empty on every row since — **no new column, no
  db:setup**. `status` is NOT touched (the old-enum warning below still stands).
  `setCancellationsReported(ids, on, actor)` is compare-and-set (two people ticking at once
  log it once) and writes a `reported` / `unreported` event per row.
- **API**: `POST /api/cancellations/action { id | ids:[…] (≤ 500), action: 'reported' | 'unreported' }`
  → `{ ok, changed:[ids], skipped }`. One row with no number → 400; in a list it is `skipped`.
- **CSV**: two more columns, "Reported to platform (EST)" and "Reported by".

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
`cancellation_events`, `cancellation_tg_ctx` (+ `note` 2026-11-20). `cancellation_photos` +
`as_file`, `held_at`, `prompt_message_id`, `reply_message_id`, `voided_at` (2026-11-20).
**Prod needs `db:setup` BEFORE this code is deployed** — the webhook writes `as_file` /
`held_at` on every photo, so without the columns every photo answers "That wasn't logged".
`shopify_order_index` (2026-11-21; not in LIVE_TABLES — no screen reads it) also needs
`db:setup`; until it runs the lookup just finds nothing there (a missing table is caught) and
the index worker logs an error every 5 minutes.

## Tests
`e2e/cancellations.spec.js`: fake Bot API on :5198 (getFile + the download), fake reader on
:5196 (`CANCEL_AI_URL`, `CANCEL_PHOTOS_IN_DB=1`, `CANCEL_BATCH_QUIET_MS=1500`); each test
picture has its own width so the fake answers each photo apart. Covers the rules, one reply
per batch (separate photos + album), our eBay / SHEIN / pre-sell orders, the one-candidate
correction, the tracking-number match on a rendered FedEx label, the rendered Alias label
(name line read), catalogue names, typed fill-in, duplicate + re-sent update, the restart
sweep (called in the test process against the fake), end of shift, and the page from
Asia/Manila. Run with `E2E_PORT=…` when another suite is running.

Added 2026-11-20 (**written but NOT RUN** — the machine they were written on had no database
or `.env`; run the file before deploying): the question for photos with no platform, the tap,
a second tap, Void Batch (and a second void), the note after a command, an image sent as a
file, photos-then-command, and the unanswered question filed by the sweep. The fake Bot API
now gives each message its own id and keeps `editMessageText` / `answerCallbackQuery` bodies.

Added 2026-11-21: the rules against the text tesseract really read off the sample slips (Temu,
SHEIN, Stadium Goods), `orderIndexRow` against the real Shopify shapes, look-alike folding,
and — with a database — a photo with no platform filed from the index, a Temu number by its
shape, and `not_in_shopify`. **Written without a database; first run is CI.** Checked by hand
on this machine against the seven sample photos and live Shopify (read-only): Temu 3 of 3
[OK] with the shoe (one via the other reading), SHEIN [CHECK] recovered through look-alikes,
Stadium Goods platform + SKU + size and no number; the index sync read 150 live orders and
kept 149. The samples carry customer addresses and are NOT in the repo.

## Not yet / can't be verified locally
- **The text under a Stadium Goods barcode is not used.** tesseract reads it differently from
  one read to the next (`ETHOU384818` / `ETHO0384918` / `ETH00384818` on one slip), and nothing
  in our records can confirm it.
- **Stadium Goods barcodes**: no full-size photo to test with (see above).
- **StockX, Kicks Crew, TikTok, eBay slips**: no sample photos. Their numbers are in the index
  and the StockX shapes come from Shopify, but what their labels print was not seen.
- **SHEIN reads rest on ONE slip**, and its number only came out through the rescue read plus
  look-alike folding — it needs the order to be in `shein_order_units` or the index.
- An order made minutes ago may not be in the index yet (5-minute sync): it is recorded as
  read, tagged [CHECK], not refused.
- The 2026-11-20 flows were never exercised against the real Bot API: check on the first
  real batch that the question's buttons fit four across on the floor's phones, and that the
  group's "/" menu shows the platforms after the next deploy (`[cancellations] bot menu set` in the log).
- No real prod photos were read for this change (prod reads are not allowed): the name-line
  rule and the SHEIN shape rest on the two real Alias labels, the eBay FedEx label PNGs and
  the SHEIN numbers in the docs. Check the first real batch's `ai_raw.text`.
- Alias orders that are NOT pre-sell are not in our tables, so most Alias numbers can't be
  confirmed — they are recorded as read.
- No auto-cancel on any platform; no in-app photo upload (photos come through Telegram).
