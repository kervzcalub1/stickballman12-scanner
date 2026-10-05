# Alerts on Telegram — per-person notifications (🔔 panel)

Built 2026-10-03, copied from the team Hub's "Alert Preferences" (the plan and the video
walkthrough: `docs/telegram-alerts-plan.md`). Each person connects **their own** Telegram
and picks which events reach them; the bot DMs them with an **Open in Inventory** link.
Same bot as the approval group (`@stickballman12_bot`) — a private chat is separate.

## Pieces
| Piece | File |
|---|---|
| Catalogue, the one sender `alertUsers`, the events | `api/_lib/alerts.js` |
| HTML DM + URL button, bot @name (`getMe`, cached) | `api/_lib/telegram.js` (`sendAlertMessage`, `getBotUsername`) |
| My settings GET/POST | `api/me/alerts.js` |
| Connect link / Send test / Disconnect | `api/me/telegram.js` |
| `/start <token>` and plain `/start` in a PRIVATE chat | `api/telegram/webhook.js` (`handlePrivate`) |
| Panel (opened by the bell in `TopBar`, `?alerts=1`) | `src/components/AlertsPanel.jsx` |
| Connect banner on a supplier's Buying Requests list | `src/components/TelegramConnectBanner.jsx` |
| DB | `users.telegram_name/_username/_linked_at/_broken_at`, `users.alerts_muted`, `users.alert_prefs` (JSONB opt-outs), `telegram_link_tokens`, `alert_log` — `scripts/db-setup.mjs` |
| SOP | `telegram-alerts` in `src/lib/sop/articles.reference.js` |
| e2e (fake Bot API on :5198) | `e2e/alerts.spec.js` |

## Connect flow
1. Panel → `POST /api/me/telegram {action:'link'}` mints a token (`p…`/`d…` = env, 15 min,
   single use; a new one retires the old) → `https://t.me/<bot>?start=<token>`.
2. The panel opens a blank window **synchronously in the tap** (iOS blocks a window opened
   after an await), then points it at the link → Telegram sends `/start <token>`.
3. Webhook, private chat: a token of the OTHER env is forwarded (`forwardToOtherEnv`, same
   as dev card taps). Otherwise `redeemTelegramLinkToken` spends it (conditional UPDATE),
   refuses a Telegram account already on another user (names them), writes the user row,
   deletes any `telegram_link_requests` row. Bot replies "✅ Connected … as {name}".
4. `users` is in `LIVE_TABLES`, so the panel flips to **Connected as @username** live.

**`telegram_user_id` is also the identity behind group approval taps.** Self-service is
safe because only the signed-in person can mint their token; Check Access's admin link
still works. The env logins (`admin`, `superadmin`) have no users row → panel says
"shared login", `/api/me/telegram` 409s.

**Connect banner (2026-10-06).** A supplier with `request_buying` also gets a "Get updates
on Telegram — Connect Telegram / Not now" strip at the top of Buying Requests
(`BuyCarts.jsx`), because the bell is easy to miss. Same deep-link flow as the panel; it
hides itself on the `users` live event once connected. Hidden when Telegram isn't
configured, for shared logins, and per device after "Not now" (localStorage). A broken
connection brings it back as **Reconnect** with no "Not now". No migration.

## Sending rules (`alertUsers`)
- Never the actor. Then: connected → not `alerts_muted` → event on (required = always on,
  but the master switch still silences it — the Hub's behaviour) → send.
- Every decision → `alert_log` (`sent` / `skipped` + reason / `failed` + Telegram's text).
  "I never got it" = `SELECT * FROM alert_log WHERE user_id = … ORDER BY at DESC`.
- 403 → `telegram_broken_at` set → panel says "Reconnect". A later good send clears it.
- Fire-and-forget after the response (`fireAlert`), like `notify.js`.
- Dev: `[dev]` in the title; a non-https / localhost link goes in the text, because
  Telegram rejects such URL buttons (`BUTTON_URL_INVALID`).
- `alert_prefs` stores only differences from the default; defaults live in the catalogue.

## Events
| Key | To | Fires from | |
|---|---|---|---|
| `buy.cards_needed` | `issue_gift_cards` holders | `notifyIssuersIfReady` (notify.js) | required |
| `buy.cards_released` | the buyer (`/buying` for a supplier, `/buy-carts` for staff) | `cart/gift-card.js` `fund` | required |
| `rescale.requested` | warehouse (admins: shown, default off) | `rescale-requests/create.js` | on |
| `account.signup` | DB admins | `auth/signup.js` | required |
| `buy.line_decided` | the buyer — **batched**, one summary per request | `decideLines` (buycart.js) — screen AND Telegram taps | on |
| `buy.audited` | the buyer | `cart/audit.js` (money / goods) | on |
| `buy.comment` | everyone on the request + buyer (a buyer's first question → approvers) | `cart/comment.js` | on |
| `rescale.audited` | the requester (`rescale_requests.requested_by_id`, new rows only) | `rescale-requests/audit.js` | on |
| `po.shipped` | warehouse + admins — **batched** per order | `po/ship.js` | on |
| `po.delivered` | warehouse (admins: off) — on the TRANSITION | `po/tracking-webhook.js` + `po/track-refresh.js` | on |
| `online.delivered` | warehouse (admins: off) — on the transition, `once` | same two | on |
| `po.discrepancy` | admins (PH: shown, off) — `once` per distinct result | `batches/commit`, `box-commit`, `set-status` | on |
| `po.comment` | everyone on that PO thread + admins | `po/comment.js` | on |
| `buy.list_reopened` | gift card desk — only once the desk is in play (approved / released / cards issued) | `cart/submit.js` (reopen) | on |
| `buy.list_reclosed` | gift card desk — closed AGAIN after a re-open: lines added / removed / changed since `list_reopened_at`, and what that means for the cards | `cart/submit.js` (close) | on |
| `nudge` | whoever the record waits on | `api/nudge.js` | required |

**Links are per reader** (`at(page, query)`): PH lands under `/ph/*`, a supplier on its
portal routes, everyone else on the main app. A fixed path put PH on a page their app
doesn't have (fixed for the Phase 1 gift-card alert too).

**Batching** (`batchAlert`): held `ALERT_BATCH_MS` (60 s; 1.5 s in e2e) after the LAST
event with the same key, in memory — a restart inside the window loses that summary only.
**Once-only**: `alertUsers({ once: true, ref })` skips if `alert_log` already has that
event+ref. Deliveries are detected by reading `deliveryStateBefore()` BEFORE the webhook
writes, so 17TRACK's repeat pushes for a delivered parcel stay quiet.

## Nudges (`POST /api/nudge { kind, id, to, note? }`)
The **server** picks the people from `to` — the browser never sends user ids.
| kind | to | who may |
|---|---|---|
| `cart` | `buyer` · `approvers` · `desk` · `auditors` | anyone who can see it; only staff → buyer; another supplier's request is 404 |
| `rescale` | `warehouse` · `requester` | staff |
| `po` | `supplier` · `warehouse` | staff |
Privilege targets = EXPLICIT holders (admins hold everything implicitly — they're the
fallback only when nobody does). One per sender+record+target per hour (`alert_log`).
Written on the record's trail: buying history (`kind='nudge'`) / PO thread (`system`).
Buttons: `NudgeButton` on the buying request header, PH's open rescale rows, PO detail.

Adding an event: a catalogue entry (`key, group, emoji, title, when, who(u), required,
defaultFor?`) + one `alertUsers(key, {…})` call after the write. No migration.

## Not built yet (plan Phase 3)
Announcements, quiet hours for the PH night shift, web push.
