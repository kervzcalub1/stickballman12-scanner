# Order Cancellations (photo on Telegram → read → PH verifies → cancelled)

Screen `src/screens/Cancellations.jsx` at **`/cancellations`** (warehouse home → Sell & Ship)
and **`/ph/cancellations`** (PH home → Queues & Requests). Added 2026-10-20.

## Why
Karon (warehouse) typed every 10–15-digit order number to cancel at the end of the day.
Now anyone on the floor sends a **photo** to the bot; the numbers are read for them, and
the reviewers (PH + admin, e.g. Kervy and Nikki) check each one before cancelling it on
the platform. Human verification stays: nothing here cancels anything by itself.

## Sending one (warehouse, PH, admin)
- **The cancellations group** (`TELEGRAM_CANCEL_CHAT_ID`, prod: `-5123623236`) or their
  **private chat with the bot**. In the group only a photo or a slash command is acted on
  (`/alias@Bot` works); a bare number typed there is chatter and ignored. Either way the
  sender must have connected Telegram once (🔔 Alerts → Connect Telegram). The chat id IS the identity (`telegramSender`: an approved
  account with that `telegram_user_id`). Unlinked chat → "connect this chat first";
  supplier → refused.
- **The platform is a command** (owner, 2026-10-20): `/alias` `/stockx` `/ebay` `/temu`
  `/tiktok` `/shein` `/sg` (Stadium Goods) `/kc` (Kicks Crew) — `PLATFORMS[].cmd`. Three ways:
  - `/alias` as the photo's **caption** (anything after it = the reason). On an album the
    caption rides on ONE photo; its platform is noted for the album (`album:<media_group_id>`)
    and the other photos wait 1.5 s, then pick it up.
  - `/alias` alone, **then the photos** — every photo in the next 10 minutes is Alias
    (`chat:<chat id>:<telegram user id>` in `cancellation_tg_ctx` — per PERSON, so two
    people in the group don't take each other's platform; the bot confirms).
  - **typed**: `/stockx 12345678-12345678 - wrong size` (`fileTypedCancellation`; ≥ 6 digits).
  The named platform beats the reader's guess, and is told to the reader so it looks for
  that platform's number. Unknown command (`/goat`) → "isn't one of the platforms", nothing
  filed. `/help` → the how-to. No platform at all → the reader's guess (else flagged
  `no_platform`) plus a tip. The "/" menu: `npm run telegram:webhook -- commands`
  (`setMyCommands`: private chats + the cancellations group, never the approval group).
- The bot answers in the chat: what it logged (`#id platform · number`), what's flagged,
  duplicates ("already logged as #12 by Karon — not added twice").
- **+ Add by hand** on the page for a picture that never made it to Telegram.

## End of shift: `/msg`, `/msgall`, `/report` (2026-10-20)
All by ONE **EST day** — the day the rows were SENT (`created_at AT TIME ZONE
'America/New_York'`, `listCancellationsForDay`); default today, or `yesterday` /
`2026-10-19` after the command (`dayFrom`; a future or junk date → "Which day?").
- **`/msg`** → a picker: one button per platform with orders that day, "Alias (2)"
  (`callback_data cxmsg:<platform>:<day>`, handled before the approval-group check; only
  in the cancellations group / a private chat, only for a connected filer). A tap answers:
  ```
  Alias
  Please cancel the following order(s):
  #206557037 - CZ1884-010 size 8.5
  ```
  (`cancelMessage`; "US M 8.5" prints as "size 8.5").
- **`/msgall`** (also typed `/msg-all` / `/msg all` — Telegram commands can't hold a dash)
  → every platform's block, in `PLATFORMS` order (`cancelMessageAll`).
- **`/report`** → the day's rows as `cancellations-<day>.csv` (`sendDayReport`, the page's
  `cancellationsCsv`), rejected rows included — it's the record.
- Rejected rows are never in a message. A row with no number / no platform is counted in a
  "⚠️ Not listed: …" footnote, so the message never silently drops an order.
- Any status that isn't rejected is listed (to review, verified, cancelled): the message is
  what the warehouse asks the platform for, whether or not PH has verified it yet.
- `npm run telegram:webhook -- commands` puts `/msg /msgall /report` in the "/" menu.

## Reading (`api/_lib/cancellations.js`)
Webhook (`api/telegram/webhook.js` → `handleCancellation`) answers Telegram first and does
the work after (`setImmediate`): `getFile` → download → `shrinkImage` (sharp, 1600 px JPEG)
→ stored (R2 `cancellations/<photo id>.jpg`, else bytes in `cancellation_photos.bytes`) →
**read TWICE** with `gpt-5.4-mini` (`CANCEL_AI_MODEL` / `RECEIPT_AI_MODEL`; strict JSON
schema): the second read is told to go character by character (`readTwice`).
- **Why twice**: on a blurred test photo the reader returned a WRONG digit at 0.88
  confidence with nothing "unclear". Its own confidence is not a check; two independent
  reads that disagree are. Disagreement → `reads_disagree` + note "Second read said …".
  One read failed → `unchecked`.
- The prompt excludes tracking numbers (1Z…, 9400…), SKUs, phones and prices — verified
  on a packing slip that also shows a UPS tracking number.
- **Unreadable / no order / reader down → still ONE row with the photo**, flagged
  `unreadable`, so a reviewer types the number off the picture. A request is never lost.
- Telegram re-sends an update it didn't get a 200 for: `cancellation_photos` is unique on
  (tg_chat_id, tg_message_id), so a re-send files nothing.
- Each new batch alerts **`cancel.logged`** (PH + admin, opt-out in 🔔 Alerts).

## Rules (`src/lib/cancellations.js`, shared by server and page)
- Platforms (`PLATFORMS`): Alias, StockX, eBay, Temu, TikTok Shop, SHEIN, Stadium Goods (`sg`),
  Kicks Crew (`kc`). Number **shape**
  checked only where we know it: StockX `12345678-12345678`, eBay `12-34567-89012` →
  else flag `format`. An unknown shape is never "wrong".
- `cleanOrderNo` (trim, upper, drop `#` and inner spaces); `orderKey` = letters+digits →
  **duplicate guard**: unique index on `order_key` while `status <> 'rejected'`
  (`cancellations_live_key_uq`); a 23505 is answered as "already logged as #N".
- Flags: **hard** (block Verify) `unreadable`, `no_number`, `short_number`, `no_platform`;
  **look closely** `format`, `low_confidence` (< 0.95), `unclear` (only a doubt about the
  order number / platform — a blurred SKU doesn't count), `reads_disagree`,
  `unchecked`, `submit_failed`. A reviewer's edit recomputes the flags from the fields and
  drops the reader's doubts — the edit is the look at the photo.

## Reviewing (PH + admin; the warehouse sees the list read-only and can add by hand)
Tabs: **To review → To cancel (verified) → Cancelled**, plus Rejected and All. Open work
always shows whatever its age; the period trims the finished tabs.
- To review: edit inline next to the **whole photo** (never cropped — a crop hid the
  number; tap to enlarge) → **✓ Verify** (refused while a hard flag stands) or Reject (why).
- To cancel: **Copy** per row, and **one copy button per platform** (numbers one per line)
  → cancel on the platform → **Cancelled on X ✓** (optional confirmation / case #) or
  **Couldn't cancel** (why → back to review, flagged `submit_failed`).
- Every move is compare-and-set on status (`setCancellationStatus`); `cancellation_events`
  keeps who did what. CSV export of the shown rows.

## API
`GET /api/cancellations/list?view=review|verified|submitted|rejected|all&days=` ·
`GET …/get?id=` · `GET …/photo?id=<photo id>` (auth'd; photos carry customer addresses,
never public) · `POST …/save` (no id = add by hand; id = reviewer correction, to_review
only) · `POST …/action {id, action: verify|submitted|failed|reject|reopen}`.

## Tables (db-setup; in `LIVE_TABLES`)
`cancellations` (one row per ORDER), `cancellation_photos` (one per picture, R2 key or
bytes), `cancellation_events`, `cancellation_tg_ctx` (the last-named platform per chat /
album, read for 10 minutes).

Verified on a real Alias label (2026-10-20 photo): order # 206557037 read right on every
pass, with or without `/alias`, and the UPS tracking number above it ignored. SKU "CZ1884
010" is stored as `CZ1884-010` (`cleanSku`).

## Tests
`e2e/cancellations.spec.js`: fake Bot API on :5198 (also serves getFile + the download),
fake reader on :5196 (`CANCEL_AI_URL`, `CANCEL_PHOTOS_IN_DB=1` in playwright.config) — the
suite never spends OpenAI money or writes to R2.

## Not yet
- No auto-cancel on any platform (by design — human verification first). eBay/StockX
  cancel APIs exist and could be the next step for verified rows.
- No in-app photo upload (JSON body cap 256 KB); photos come through Telegram.
- No cross-check against our own orders (`ebay_orders`, `presell_sales`) to confirm the
  number exists — a strong next check.
