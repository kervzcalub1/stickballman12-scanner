# Telegram alerts — personal notifications through the bot (PLAN — Phase 1 + 2 BUILT 2026-10-03, see docs/context/alerts.md)

Source: a 2m35s screen recording (WhatsApp video, 2026-10-03) of the team's **Stickballman12
Hub** (the Lovable task app at `stickballman12-hub.lovable.app`) showing how a person connects
their phone to notifications through a Telegram bot. This plan copies that idea into the
Inventory app, built on the bot and the Bot API code we already run.

---

## 1. What the video shows, step by step

| t | Screen | What happens |
|---|---|---|
| 0:00 | Phone home screen | "Open the Stickballman12 app — installed, or in the browser, both work." |
| 0:38 | Hub home | Top bar icons: **+ · chat · 🔔 bell · shield · theme · ⚙ gear · avatar**. |
| 0:44 | ⚙ gear dropdown | **Settings & Alerts** → `Settings` · `My Profile` · **`Alert Preferences`**. |
| 0:49 | **Notification Settings** page | Heading "PREFERENCES / Notification Settings — Choose which notifications you receive in the app." Three pill tabs: Settings · My Profile · **Alert Preferences** (active). |
| 0:54 | The toggle list (top → bottom) | 1. **All notifications** — "Turn this off to stop every notification, including required ones and push alerts on your devices." (master switch) <br>2. **Push notifications on this device** — "Get alerts even when the app is closed. Enable this on each device you use. On iPhone, add the app to your Home Screen first." <br>3. **Telegram alerts** card — "Get your notifications (nudges, assignments, reviews, mentions) as private messages from @StickballNotifyBot." + **[Connect Telegram]** button <br>4. One row per event, each with a title, a one-line "when…" description and a toggle. |
| 0:59 | Required rows | Some rows read "**(required)**", their toggle greyed and locked ON. Footer: "Required categories (Changes Requested, Reviewer Assigned, Task Overdue, Announcements) always remain enabled." |
| 1:07 | Taps **Connect Telegram** | Browser goes to `about:blank` for a beat, then the **Telegram app opens** on the bot chat. |
| 1:21 | Telegram, bot chat "Stickballman12 Notifications" | `/start` is sent **automatically**; bot replies: **"✅ Connected to Stickballman12 Hub as James Klien Caluyong. You'll receive task assignments, nudges and other alerts here."** Pressing it again just repeats the same confirmation (idempotent). |
| 1:36 | Earlier messages in that chat | **"📣 Test alert — Telegram notifications are working."** + button **[Open in Hub ↗]** <br>**"🔔 Reminder: Build Foot Locker receipt parser and organized receipt storage workflow / T-1204 / Alex sent a test reminder about T-1204."** + **[Open in Hub ↗]** |
| 1:48 | Taps Open in Hub | Telegram's "Open Link" confirm: `https://stickballman12-hub.lovable.app/tasks/T-1204` → Cancel / Open. The link goes **straight to that record**. |
| 2:05 | Back in the app | Toast: **"Tap Start in Telegram to finish connecting."** The Telegram card now reads **"Connected. Your notifications are also sent privately by @StickballNotifyBot."** with **[Send test]** and **[Disconnect]**. |
| 2:14 | Closing advice | "Tailor your notifications. I recommend all on… you can even turn Push notifications on this device **off — it's redundant now**." |

Full event list seen in the Hub (for reference — these are its task events, not ours):
Task assigned to me · Added as assignee · Task reassigned · Task submitted for review ·
Reviewer assigned (req) · Changes requested (req) · Task approved · Task completed · Task
reopened · Task cancelled · Task overdue (req) · Due date changed · Mentions · Replies to my
comments · Checklist assigned · Next step assigned · File attached · Reminders / nudges ·
Announcements (req).

**The five ideas worth copying:**
1. **One-tap self-service linking** — a deep link that opens Telegram and sends `/start` for you; the bot answers with your name. No admin step, no hunting for a numeric id.
2. **Per-person, per-event preferences**, with a few **required** events that can't be turned off, and a master off-switch.
3. **Every message is actionable** — emoji + title, the record's code, one sentence, and an **Open in …** button that lands on that exact record.
4. **Send test / Disconnect** in the app; the app shows **Connected** without a refresh.
5. **Nudges** — a person can poke someone about a specific record, delivered as a DM.

---

## 2. What we already have (so this is mostly wiring, not new infrastructure)

| Already built | Where | Reuse |
|---|---|---|
| Our own bot, `@stickballman12_bot`, called directly via the Bot API (sequential queue, 429 retry) | `api/_lib/telegram.js` (`tg`, `enqueue`, `sendDirect`) | Same bot — a private chat is separate from the approval group. |
| `users.telegram_user_id` (BIGINT, unique) | `scripts/db-setup.mjs:101` | This IS "connected". Today an admin sets it on **Check Access**. |
| `telegram_link_requests` — captures the id of an unlinked account that tapped a card | db-setup | Keep for the group taps; the new flow makes it mostly unnecessary. |
| One private DM already live: `notifyIssuersIfReady` (#241) tells `issue_gift_cards` holders a request is waiting for cards | `api/_lib/notify.js:414` | Becomes the first event in the catalogue (and required). |
| Webhook `POST /api/telegram/webhook` with secret header; **dev cards forwarded to the dev server** | `api/telegram/webhook.js` | Add a private-chat `/start` handler. Today it **ignores private chats**, which is why #241's open item "optional 'you're set' /start reply" is still open — this plan closes it. |
| Live updates — `users` is in `LIVE_TABLES` | `scripts/db-setup.mjs:1799` | The Alerts page flips to "Connected" by itself the moment the bot links the account. |
| `?query` deep links for records (`/buy-carts?request=…`, open PO, etc.) | `src/lib/urlstate.js` | The target of every **Open in Inventory** button. |
| e2e fake Telegram on :5198 (`TELEGRAM_API_BASE`) | `playwright.config.js` | Test linking + sends without touching the real bot. |

---

## 3. The design for Inventory

### 3.1 Linking (the "Connect Telegram" button)

1. Signed-in user taps **Connect Telegram** → `POST /api/me/telegram/link` creates a
   **single-use token** (random 24 chars, `[A-Za-z0-9_-]`, Telegram's `start` payload limit is
   64), stored with `user_id`, `env`, `expires_at = now()+15 min`. Response: the deep link
   `https://t.me/stickballman12_bot?start=<p|d><token>` (first char = env, so prod can forward a
   dev link to the dev server exactly like dev card taps today).
2. The app opens the link (`window.location` on mobile → Telegram app; desktop → Telegram
   Desktop/web) and shows the hint **"Tap Start in Telegram to finish connecting."**
3. Telegram sends `/start <token>` to our webhook from the **private chat**. The new handler:
   - token valid, unused, unexpired → `users.telegram_user_id = from.id`, token marked used,
     reply **"✅ Connected to Stickballman12 Inventory as {full name}. You'll get your alerts here."**
   - that Telegram account is already linked to **another** user → refuse:
     "This Telegram account is already connected to {other name}. Ask an admin." (unique index
     would throw anyway — say it in words).
   - token expired/used → "That link has expired — tap Connect Telegram in the app again."
   - plain `/start` (no token) → if linked: "You're connected as {name}." (the video's repeat
     behaviour); if not: "Open Inventory → Alerts → Connect Telegram to link this chat."
4. The Alerts page re-reads on the `users` live event → **Connected as @username** + Send test +
   Disconnect. (Show the Telegram @username/name we linked, so a wrong account is visible.)
5. **Disconnect** clears `telegram_user_id` (and says goodbye in the chat). **Send test** sends
   "📣 Test alert — Telegram alerts are working." with an Open button.
6. Check Access keeps its admin link/unlink for people who can't do it themselves.

**Security note — this changes who can set `telegram_user_id`.** Today that id is the
*identity* behind every approval tap in the group (`decideFromTelegram`). Self-service linking
is safe because only the signed-in person can mint their own token, but a forwarded/leaked
link could attach someone else's Telegram to your account for 15 minutes. Mitigations: single
use, 15-min expiry, the bot reply and the app both name who got linked, an `item`-style event
row on every link/unlink, and a `security-auditor` pass before shipping. Linking grants no
power — taps are still checked against the user's own role/privileges.

### 3.2 Preferences (the "Alert Preferences" page)

- New screen **`src/screens/Alerts.jsx`** at `/alerts`, for **every role** (warehouse, PH,
  admin, supplier). Entry point: an **"Alerts"** button beside *Sign out* in `TopBar`
  (we have no gear menu, and `Settings.jsx` is admin-only app settings — don't mix them).
  A bell icon with a dot when Telegram isn't connected is a nice touch, optional.
- Layout copies the video: master **All alerts** toggle → **Telegram** card (Connect / Connected
  + Send test + Disconnect) → grouped event rows (title, "when…" line, toggle) → footer naming
  the required ones.
- **Rows are role/privilege-scoped** (the SOP rule): a warehouse account never sees gift-card
  rows; a supplier sees only what applies to their own orders/requests.
- Storage: `users.alerts_muted BOOLEAN NOT NULL DEFAULT false` + `users.alert_prefs JSONB NOT
  NULL DEFAULT '{}'` (key → false only for opt-outs). **Defaults live in code** — a missing key
  means the event's default — so adding a new event needs no migration.
- The catalogue (`api/_lib/alerts.js`): `{ key, group, title, when, roles/privileges, default,
  required }`, served by `GET /api/me/alerts` together with the user's state, saved by
  `POST /api/me/alerts` (rejects turning off a required one).
- **"Push notifications on this device": NOT in v1.** We have no service worker / PWA
  manifest, iOS needs Home-Screen install, and the person in the video calls it redundant once
  Telegram is on. Revisit only if someone has no Telegram.

### 3.3 The event catalogue (v1 proposal — every source is an existing write)

Rule for all: **never alert the person who did the thing.**

| Group | Key | Who gets it | Fires from | Default |
|---|---|---|---|---|
| Buying | `buy.cards_needed` | `issue_gift_cards` holders | `notifyIssuersIfReady` (exists) | **required** |
| Buying | `buy.line_decided` | the buyer | `cart/decide.js` + `telegramDecide.js` — **batched per request** (see 3.4) | on |
| Buying | `buy.cards_ready` | the buyer | `cart/gift-card.js` when issued cards cover the target | **required** |
| Buying | `buy.request_closed` / `reopened` | approvers | `notifyRequestEvent` (exists, group-only today) | off (they see the group) |
| Buying | `buy.audited` | the buyer | `cart/audit.js` — result + any gap | on |
| Buying | `buy.comment` | buyer ↔ desk on that request | `cart/comment.js` | on |
| Rescale | `rescale.requested` | warehouse | `rescale-requests/create.js` | on |
| Rescale | `rescale.audited` | the requester (PH) | `rescale-requests/audit.js` — reported vs actual | on |
| POs | `po.shipped` | admin + warehouse | `po/ship.js` | on |
| POs | `po.delivered` | warehouse | `po/tracking-webhook.js` on Delivered — one message per EST day listing the boxes | on |
| POs | `po.discrepancy` | admin | reconciliation shows short/over | on |
| POs | `po.comment` | the supplier ↔ our side on that PO | `po/comment.js` | on |
| Online orders | `online.delivered` | warehouse | tracking says delivered → "Expected" | on |
| Accounts | `account.signup` | admins | `auth/signup.js` | **required** |
| Nudges | `nudge` | the person nudged | new "Nudge" button (3.5) | **required** |
| Announcements | `announcement` | everyone | admin broadcast (phase 3) | **required** |

### 3.4 Delivery rules

- **One sender**: `alertUser(userId, eventKey, { title, code, body, path })` in
  `api/_lib/alerts.js` checks: Telegram configured → user linked → not muted (unless required)
  → event on → not the actor → sends. Fire-and-forget after the response, swallowing errors,
  exactly like `notify.js` ("it must never make anyone wait").
- **Message format** (copies the video): `{emoji} <b>{title}</b>` / `{code}` (BC-2923, PO-…,
  RR-…) / one sentence with names, pairs and money / inline button **[Open in Inventory ↗]**
  → `APP_BASE_URL + path`. HTML parse mode with escaping (a stray `<` in a store name must not
  break the send). Times in **EST**, labelled.
- **Dev**: `[dev]` prefix (exists). Telegram rejects `localhost`/plain-http URL buttons
  (`BUTTON_URL_INVALID`) — on dev with no https `APP_BASE_URL`, send the link as text instead.
- **Batching**: a desk deciding 12 lines must not be 12 DMs. `buy.line_decided` waits ~60 s
  after the last decision on that request, then sends one summary ("Alex approved 9 of 12 on
  BC-2931 · 3 turned down"). Same idea for `po.delivered` (daily roll-up).
- **A log, so "I never got it" has an answer** (the `scan_failures` principle): table
  `alert_log (id, user_id, event_key, ref, status sent|skipped|failed, reason, at)`. Skips are
  logged with the reason (muted, event off, not linked).
- **403 from Telegram** ("bot was blocked by the user" / never pressed Start) → mark the link
  broken (`users.telegram_broken_at`) and the Alerts page says **"Telegram stopped accepting
  messages — reconnect"** instead of a silent failure.
- e2e: the fake Telegram on :5198 records sends; assert link → test → event → disconnect.
  **The suite must never post to the real bot** (existing rule in `notify.js`).

### 3.5 Nudges (phase 2)

A **Nudge on Telegram** button on records that wait on a person — a buying request (to the
buyer, or to the gift-card desk), a rescale request (to warehouse), an open PO (to the
supplier). Optional one-line note. Message: "🔔 Reminder: {record title} / {code} / {sender}
nudged you about {code}: {note}" + Open button. Rate-limit one nudge per sender per record per
hour; logged on the record's event trail so the nudge is visible in history.

---

## 4. Build phases

**Phase 1 — linking + the page + 4 events (the useful core)**
1. `db-setup.mjs`: `telegram_link_tokens`, `users.alerts_muted`, `users.alert_prefs`,
   `users.telegram_broken_at`, `alert_log` (+ add `alert_log` to `LIVE_TABLES` only if a screen
   reads it). **Run `db:setup` on local and prod before the code ships.**
2. `api/_lib/alerts.js` (catalogue + `alertUser`), `api/me/alerts.js` (GET/POST),
   `api/me/telegram-link.js`, `-test.js`, `-disconnect.js`.
3. Webhook: private-chat `/start [token]`, dev-token forwarding.
4. `src/screens/Alerts.jsx` + route + TopBar button; mobile layout first (390 px).
5. Move `notifyIssuersIfReady` onto `alertUser`; add `buy.cards_ready`, `rescale.requested`,
   `account.signup`.
6. SOP article "Get alerts on Telegram" (`src/lib/sop/…`) — the video's walkthrough, for
   every role; `docs/context/` page `alerts.md` + a line in CLAUDE.md's context map.

**Phase 2** — the rest of the table in 3.3, batching, nudges, 403 → "reconnect".

**Phase 3 (only if asked)** — announcements, quiet hours (the PH team works a night shift
from Manila — a 2 pm EST alert is 2 am there), web push.

---

## 5. Decisions for the owner

1. **Self-service linking OK?** It replaces the admin-only link on Check Access as the normal
   path (admin link stays). Recommended: yes.
2. **Which events are required** — proposed: gift cards needed, gift cards ready, new signup,
   nudges, announcements.
3. **Same bot** (`@stickballman12_bot`) for DMs and the approval group, or a separate
   "notifications" bot like the Hub's `@StickballNotifyBot`? Recommended: same bot — one token,
   one webhook, and people have already pressed Start on it for #241.
4. **Suppliers** — do they get Telegram alerts about their own POs/requests in v1?
5. **Quiet hours** for the PH night shift — needed in v1 or later?
