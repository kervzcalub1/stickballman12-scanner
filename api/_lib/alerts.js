// Alerts — a person's own notifications, as private messages from the bot.
//
// Copied from the team Hub's "Alert Preferences" (2026-10-03, docs/telegram-alerts-plan.md):
// each person connects their OWN Telegram from the Alerts panel, then chooses which
// events reach them. A few events are REQUIRED — somebody is standing in a shop or
// locked out until they're read — and only the master switch silences those.
//
// ONE SENDER (`alertUsers`). Every event goes through it, so the rules hold everywhere:
//   · never the person who did the thing
//   · connected → not muted → event on (or required) → send
//   · every decision is a row in `alert_log`, sent or skipped, with the reason — so
//     "I never got it" is answered from data
//   · a 403 from Telegram (bot blocked, chat deleted, never pressed Start) marks the
//     connection broken; the panel then says "reconnect" instead of going quiet
//
// Like notify.js this runs AFTER the response has gone (`fireAlert`), and it swallows
// everything: an alert that fails costs the person a message, never a request.
import { telegramConfigured, sendAlertMessage } from './telegram.js';
import { alertCandidates, logAlert, setTelegramBroken } from './db.js';

const isAdminRole = (role) => role === 'admin' || role === 'superadmin';
const holds = (u, priv) => isAdminRole(u.role) || (Array.isArray(u.privileges) && u.privileges.includes(priv));

// The catalogue. `who(u)` decides whether the event applies to an account at all — a row
// the person can never receive isn't shown to them. Only events that are actually wired
// are listed: a toggle that controls nothing would be a lie.
export const ALERT_EVENTS = [
  {
    key: 'buy.cards_needed', group: 'Buying', emoji: '🎁', required: true,
    title: 'Gift cards needed',
    when: 'A buying request is approved and waiting for gift cards',
    who: (u) => holds(u, 'issue_gift_cards'),
  },
  {
    key: 'buy.cards_released', group: 'Buying', emoji: '💳', required: true,
    title: 'Gift cards released',
    when: 'The desk releases the gift cards on your buying request',
    who: (u) => u.role !== 'supplier' || holds(u, 'request_buying'),
  },
  {
    key: 'rescale.requested', group: 'Rescale', emoji: '📨', required: false,
    title: 'New rescale request',
    when: 'PH asks the warehouse to recount a SKU',
    who: (u) => u.role === 'warehouse' || isAdminRole(u.role),
    // Admins see the row but start with it off — it's the warehouse's job, not theirs.
    defaultFor: (u) => u.role === 'warehouse',
  },
  {
    key: 'account.signup', group: 'Accounts', emoji: '🔑', required: true,
    title: 'New account waiting',
    when: 'Someone signs up and needs approving',
    who: (u) => isAdminRole(u.role),
  },
];
const EVENT = Object.fromEntries(ALERT_EVENTS.map((e) => [e.key, e]));

const prefsOf = (u) => (u.alert_prefs && typeof u.alert_prefs === 'object' ? u.alert_prefs : {});
const defaultOn = (ev, u) => (ev.defaultFor ? ev.defaultFor(u) : true);

/** Is this event switched on for this account (ignoring the master switch)? */
export function eventOn(ev, u) {
  if (ev.required) return true;
  const p = prefsOf(u);
  return typeof p[ev.key] === 'boolean' ? p[ev.key] : defaultOn(ev, u);
}

/** The panel's rows for one account. */
export function catalogueFor(u) {
  return ALERT_EVENTS.filter((ev) => ev.who(u)).map((ev) => ({
    key: ev.key, group: ev.group, title: ev.title, when: ev.when, required: ev.required, on: eventOn(ev, u),
  }));
}

/**
 * Turn a request's `{ key: bool }` into what is stored: only keys this account can
 * see, never a required one (it can't be off), and only where it differs from the
 * default — so a later change to a default reaches everyone who never touched it.
 */
export function cleanPrefs(u, incoming) {
  const out = { ...prefsOf(u) };
  for (const [k, v] of Object.entries(incoming || {})) {
    const ev = EVENT[k];
    if (!ev || ev.required || !ev.who(u) || typeof v !== 'boolean') continue;
    if (v === defaultOn(ev, u)) delete out[k]; else out[k] = v;
  }
  for (const k of Object.keys(out)) if (!EVENT[k]) delete out[k];
  return out;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const appEnv = () => (process.env.APP_ENV === 'dev' ? 'dev' : 'prod');
const baseUrl = () => String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');

/** The message, the way the Hub's read: emoji + bold title, the record's code, one sentence. */
export function alertHtml({ emoji, title, code = null, body }) {
  return [
    `${emoji} <b>${appEnv() === 'dev' ? '[dev] ' : ''}${esc(title)}</b>`,
    ...(code ? [esc(code)] : []),
    '',
    esc(body),
  ].join('\n');
}

/**
 * Send one event to the accounts `pick(u)` selects (already narrowed to the event's own
 * audience). `path` is a string or `(u) => string`. Returns { sentTo: [names] }.
 */
export async function alertUsers(eventKey, { pick = () => true, actorUid = null, ref = null, code = null, body, path = null }) {
  const ev = EVENT[eventKey];
  if (!ev) throw new Error(`unknown alert event ${eventKey}`);
  const sentTo = [];
  if (!telegramConfigured()) return { sentTo, reason: 'Telegram is not configured' };
  const people = (await alertCandidates()).filter((u) => ev.who(u) && pick(u)
    && !(actorUid != null && String(u.id) === String(actorUid)));
  const html = alertHtml({ emoji: ev.emoji, title: ev.title, code, body });
  // `path` may depend on who reads it (a supplier's app has its own routes).
  const urlFor = (u) => {
    const p = typeof path === 'function' ? path(u) : path;
    return p && baseUrl() ? `${baseUrl()}${p}` : null;
  };
  for (const u of people) {
    const skip = !u.telegram_user_id ? 'not connected'
      : u.alerts_muted ? 'all alerts off'
      : !eventOn(ev, u) ? 'event turned off' : null;
    if (skip) { await logAlert({ userId: u.id, eventKey, ref, status: 'skipped', reason: skip }).catch(() => {}); continue; }
    try {
      await sendAlertMessage(u.telegram_user_id, { html, url: urlFor(u) });
      sentTo.push(u.name || u.username);
      await logAlert({ userId: u.id, eventKey, ref, status: 'sent' }).catch(() => {});
      if (u.telegram_broken_at) await setTelegramBroken(u.id, false).catch(() => {});
    } catch (e) {
      // 403 = this person's chat with the bot is gone (blocked, deleted, never started).
      if (e.status === 403) await setTelegramBroken(u.id, true).catch(() => {});
      await logAlert({ userId: u.id, eventKey, ref, status: 'failed', reason: e.message.slice(0, 300) }).catch(() => {});
      console.error(`[alerts] ${eventKey} → ${u.name || u.username} failed: ${e.message}`);
    }
  }
  return { sentTo };
}

/** Run an alert after the response, never letting it throw into the request. */
export function fireAlert(job) {
  Promise.resolve().then(job).catch((e) => console.error('[alerts]', e.message));
}

// ── The events ────────────────────────────────────────────────────────────────

const ROLE_LABEL = { warehouse: 'Warehouse', ph_team: 'PH team', supplier: 'Supplier', admin: 'Admin' };
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

export function alertSignup({ name, username, role }) {
  fireAlert(() => alertUsers('account.signup', {
    ref: `user:${username}`,
    code: `@${username}`,
    body: `${name} signed up as ${ROLE_LABEL[role] || role} and is waiting for approval.`,
    path: '/access',
  }));
}

export function alertRescaleRequested({ id, sku, name, sizes, reason, by, actorUid }) {
  const list = (sizes || []).map((s) => (Number(s.qty) > 1 ? `${s.size} ×${s.qty}` : s.size)).join(', ');
  fireAlert(() => alertUsers('rescale.requested', {
    actorUid,
    ref: `rescale:${id}`,
    code: sku,
    body: `${by || 'PH'} asked for a recount of ${name ? `${name} — ` : ''}sizes ${list}. Reason: ${reason}.`,
    path: '/rescalereq',
  }));
}

// To the buyer only — the request is theirs.
export function alertCardsReleased(cart, actor) {
  const buyerId = cart?.buyer_user_id;
  if (!buyerId) return;
  fireAlert(() => alertUsers('buy.cards_released', {
    pick: (u) => String(u.id) === String(buyerId),
    actorUid: actor?.uid,
    ref: `cart:${cart.id}`,
    code: cart.cart_code,
    body: `${actor?.name || 'The gift card desk'} released ${money(cart.gc_total)} in gift cards`
      + `${cart.retailer ? ` for ${cart.retailer}` : ''} — you can go ahead and buy.`,
    path: (u) => `${u.role === 'supplier' ? '/buying' : '/buy-carts'}?request=${Number(cart.id)}`,
  }));
}

export { EVENT as ALERT_EVENT_BY_KEY };
