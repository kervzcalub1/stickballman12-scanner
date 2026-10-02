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

## Events (Phase 1)
| Key | To | Fires from | |
|---|---|---|---|
| `buy.cards_needed` | `issue_gift_cards` holders | `notifyIssuersIfReady` (notify.js) | required |
| `buy.cards_released` | the buyer (`/buying` for a supplier, `/buy-carts` for staff) | `cart/gift-card.js` `fund` | required |
| `rescale.requested` | warehouse (admins: shown, default off) | `rescale-requests/create.js` | on |
| `account.signup` | DB admins | `auth/signup.js` | required |

Adding an event: a catalogue entry (`key, group, emoji, title, when, who(u), required,
defaultFor?`) + one `alertUsers(key, {…})` call after the write. No migration.

## Not built yet (plan Phase 2/3)
Decision on my line (batched per request), audit result, comments, PO shipped/delivered/
discrepancy, online order delivered, **nudges**, announcements, quiet hours for the PH
night shift, web push.
