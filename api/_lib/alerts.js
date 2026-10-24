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
import { telegramConfigured, sendAlertMessage, sendAlertDocument } from './telegram.js';
import { alertCandidates, logAlert, setTelegramBroken, alertSentRecently, cartParticipantIds, poParticipantIds,
  getBuyCart, cartListChangesSince } from './db.js';
import { fundingTarget } from './buycart.js';
import { issueHeadline, outcomeLabel, ageFlags, ago, STALE_DAYS } from '../../src/lib/inboundIssues.js';

const isAdminRole = (role) => role === 'admin' || role === 'superadmin';
// Anyone who can raise a buying request: staff, and a supplier switched on for buying.
const canBuy = (u) => u.role !== 'supplier' || (Array.isArray(u.privileges) && u.privileges.includes('request_buying'));
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
  },  {
    key: 'buy.list_reopened', group: 'Buying', emoji: '🔓', required: false,
    title: 'Request re-opened',
    when: 'A buyer re-opens a request the desk is funding — the total may change',
    who: (u) => holds(u, 'issue_gift_cards'),
  },
  {
    key: 'buy.list_reclosed', group: 'Buying', emoji: '🔒', required: false,
    title: 'Request closed again',
    when: 'That request is closed again — what changed, and whether more cards are needed',
    who: (u) => holds(u, 'issue_gift_cards'),
  },
  // ── Phase 2 ──
  {
    key: 'buy.line_decided', group: 'Buying', emoji: '🧾', required: false,
    title: 'Your pairs decided',
    when: 'An approver says yes or no to pairs on your buying request (one message per request)',
    who: canBuy,
  },
  {
    key: 'buy.audited', group: 'Buying', emoji: '🔎', required: false,
    title: 'Your request audited',
    when: 'The money or the shipment on your buying request is signed off',
    who: canBuy,
  },
  {
    key: 'buy.comment', group: 'Buying', emoji: '💬', required: false,
    title: 'Comment on a buying request',
    when: 'Someone writes on a buying request you are part of',
    who: canBuy,
  },
  {
    key: 'rescale.audited', group: 'Rescale', emoji: '✅', required: false,
    title: 'Rescale counted',
    when: 'The warehouse finishes counting a rescale you asked for',
    who: (u) => u.role === 'ph_team' || isAdminRole(u.role),
  },
  {
    key: 'po.shipped', group: 'Purchase orders', emoji: '🚚', required: false,
    title: 'Boxes shipped',
    when: 'A supplier ships boxes on a purchase order',
    who: (u) => u.role === 'warehouse' || isAdminRole(u.role),
  },
  {
    key: 'po.delivered', group: 'Purchase orders', emoji: '📦', required: false,
    title: 'Boxes delivered',
    when: 'Boxes on a purchase order are delivered — ready to receive',
    who: (u) => u.role === 'warehouse' || isAdminRole(u.role),
    defaultFor: (u) => u.role === 'warehouse',
  },
  {
    key: 'po.discrepancy', group: 'Purchase orders', emoji: '⚠️', required: false,
    title: 'Order doesn’t match',
    when: 'A received order is short, over or wrong against its manifest',
    who: (u) => u.role === 'ph_team' || isAdminRole(u.role),
    defaultFor: (u) => isAdminRole(u.role),
  },
  {
    key: 'receiving.dup_tracking', group: 'Purchase orders', emoji: '🔁', required: false,
    title: 'Duplicate tracking number',
    when: 'A package is received under a tracking number we already received',
    who: (u) => u.role === 'warehouse' || isAdminRole(u.role),
    defaultFor: (u) => isAdminRole(u.role),
  },
  {
    key: 'po.comment', group: 'Purchase orders', emoji: '💬', required: false,
    title: 'Comment on a purchase order',
    when: 'Someone writes on the thread of an order you are part of',
    who: (u) => u.role !== 'supplier',
  },
  {
    key: 'online.delivered', group: 'Online orders', emoji: '🛍️', required: false,
    title: 'Online order delivered',
    when: 'An online order is delivered — count it in',
    who: (u) => u.role === 'warehouse' || isAdminRole(u.role),
    defaultFor: (u) => u.role === 'warehouse',
  },
  {
    // Waitlist (waitlist.md). The hold ends by itself on its date; this is the person who
    // lists being told, so a pair held a month doesn't come back to nobody.
    key: 'ph.waitlist_back', group: 'Waitlist', emoji: '⏰', required: false,
    title: 'Back from the waitlist',
    when: 'Pairs held on the waitlist reach their date and are back on New Inventory to list',
    who: (u) => u.role === 'ph_team' || isAdminRole(u.role),
    defaultFor: (u) => u.role === 'ph_team',
  },
  {
    key: 'ph.waitlist_daily', group: 'Waitlist', emoji: '📋', required: false,
    title: 'Daily waitlist report',
    when: 'Everything on the waitlist as an Excel file, at the end of the PH shift — for the review',
    who: (u) => u.role === 'ph_team' || isAdminRole(u.role),
    defaultFor: (u) => isAdminRole(u.role),
  },
  {
    // Order cancellations (cancellations.md): the warehouse sent the bot a photo; the
    // reviewers (PH + admin) check it against the photo and cancel it on the platform.
    key: 'cancel.logged', group: 'Cancellations', emoji: '🛑', required: false,
    title: 'Order to cancel',
    when: 'The warehouse sends an order to cancel — check it and cancel it on the platform',
    who: (u) => u.role === 'ph_team' || isAdminRole(u.role),
  },
  // Inbound issues (inbound-issues.md): a problem found at receiving is a case the PH team
  // owns until it is resolved — the owner's ask was "without my personal involvement".
  {
    key: 'inbound.issue_reported', group: 'Inbound issues', emoji: '⚠️', required: false,
    title: 'Inbound issue reported',
    when: 'The warehouse records a problem with a delivery — damaged, short, wrong or defective pair. Take it and work it with the supplier',
    who: (u) => u.role === 'ph_team' || isAdminRole(u.role),
    defaultFor: (u) => u.role === 'ph_team',
  },
  {
    key: 'inbound.issue_assigned', group: 'Inbound issues', emoji: '👤', required: false,
    title: 'Inbound issue handed to you',
    when: 'Someone hands you an inbound issue case',
    who: (u) => u.role === 'ph_team' || isAdminRole(u.role),
  },
  {
    key: 'inbound.warehouse_task', group: 'Inbound issues', emoji: '📦', required: false,
    title: 'Inbound issue — job for the warehouse',
    when: 'The PH owner of a case asks the floor to do something — ship it back, shelve it',
    who: (u) => u.role === 'warehouse' || isAdminRole(u.role),
    defaultFor: (u) => u.role === 'warehouse',
  },
  {
    key: 'inbound.issue_resolved', group: 'Inbound issues', emoji: '✅', required: false,
    title: 'Inbound issue resolved',
    when: 'A problem you reported is resolved — and what becomes of the pair',
    who: (u) => u.role === 'warehouse' || u.role === 'ph_team' || isAdminRole(u.role),
  },
  {
    key: 'inbound.issue_daily', group: 'Inbound issues', emoji: '🧭', required: false,
    title: 'Daily inbound issues summary',
    when: 'Every morning: open cases, who owns each, and any nobody has taken or that have stopped moving — for the oversight',
    who: (u) => u.role === 'ph_team' || isAdminRole(u.role),
    defaultFor: (u) => isAdminRole(u.role),
  },
  {
    key: 'nudge', group: 'Nudges', emoji: '🔔', required: true,
    title: 'Nudges',
    when: 'Someone nudges you about a request or an order',
    who: () => true,
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
 * audience). `path` is a string or `(u) => string`. `once` + `ref`: never twice for the
 * same record. Returns { sentTo: [names] }.
 */
export async function alertUsers(eventKey, { pick = () => true, actorUid = null, ref = null, code = null, body, path = null, once = false, document = null }) {
  const ev = EVENT[eventKey];
  if (!ev) throw new Error(`unknown alert event ${eventKey}`);
  const sentTo = [];
  if (!telegramConfigured()) return { sentTo, reason: 'Telegram is not configured' };
  // `once`: this exact record has been alerted before (sent or skipped) — say nothing.
  if (once && ref && await alertSentRecently(eventKey, ref)) return { sentTo, reason: 'already sent' };
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
      // `document` ({ filename, content }): the alert IS a file (the daily report) — the
      // text rides as its caption, and the link goes in it since a file has no button.
      if (document) {
        const url = urlFor(u);
        await sendAlertDocument(u.telegram_user_id, { html: url ? `${html}\n\n${url}` : html, ...document });
      } else {
        await sendAlertMessage(u.telegram_user_id, { html, url: urlFor(u) });
      }
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


// WHERE "Open in Inventory" goes depends on who reads it: PH lives under /ph/* and a
// supplier has its own portal routes, so one fixed path lands one of them on a page their
// app doesn't have. Superadmin uses the main app's routes (it enters /ph only by choice).
const ROUTES = {
  buying:    { main: '/buy-carts',     ph: '/ph/gift-card-buying', supplier: '/buying' },
  reconcile: { main: '/reconcile',     ph: '/ph/reconciliation' },
  online:    { main: '/online-orders', ph: '/ph/online-orders' },
  rescale:   { main: '/rescalereq',    ph: '/ph/rescale' },
  inbound:   { main: '/inbound',       ph: '/ph/po-status' },
  access:    { main: '/access' },
  po:        { main: '/inbound',       ph: '/ph/purchase-orders', supplier: '/orders' },
  duptrack:  { main: '/dup-tracking' },
  newinv:    { main: '/report',        ph: '/ph/new-inventory' },
  cancellations: { main: '/cancellations', ph: '/ph/cancellations' },
  inboundissues: { main: '/inbound-issues', ph: '/ph/inbound-issues' },
};
export const at = (page, query = '') => (u) => {
  const r = ROUTES[page];
  const p = (u.role === 'ph_team' && r.ph) || (u.role === 'supplier' && r.supplier) || r.main;
  return `${p}${query ? `?${query}` : ''}`;
};

// ── The events ────────────────────────────────────────────────────────────────

const ROLE_LABEL = { warehouse: 'Warehouse', ph_team: 'PH team', supplier: 'Supplier', admin: 'Admin' };
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

export function alertSignup({ name, username, role }) {
  fireAlert(() => alertUsers('account.signup', {
    ref: `user:${username}`,
    code: `@${username}`,
    body: `${name} signed up as ${ROLE_LABEL[role] || role} and is waiting for approval.`,
    path: at('access'),
  }));
}

export function alertRescaleRequested({ id, sku, name, sizes, reason, by, actorUid }) {
  const list = (sizes || []).map((s) => (Number(s.qty) > 1 ? `${s.size} ×${s.qty}` : s.size)).join(', ');
  fireAlert(() => alertUsers('rescale.requested', {
    actorUid,
    ref: `rescale:${id}`,
    code: sku,
    body: `${by || 'PH'} asked for a recount of ${name ? `${name} — ` : ''}sizes ${list}. Reason: ${reason}.`,
    path: at('rescale'),
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
    path: at('buying', `request=${Number(cart.id)}`),
  }));
}



// ── Phase 2 events ───────────────────────────────────────────────────────────

// BATCHED. A desk deciding twelve lines is one message, not twelve: each event is held
// for ALERT_BATCH_MS after the LAST one with the same key, then sent as one. In memory —
// a restart inside the window loses that one summary, which the screen still shows.
const BATCH_MS = () => Math.max(500, Number(process.env.ALERT_BATCH_MS) || 60_000);
const batches = new Map();
function batchAlert(key, add, flush) {
  let b = batches.get(key);
  if (!b) { b = { data: null, timer: null }; batches.set(key, b); }
  b.data = add(b.data);
  clearTimeout(b.timer);
  b.timer = setTimeout(() => { batches.delete(key); fireAlert(() => flush(b.data)); }, BATCH_MS());
  b.timer.unref?.();
}

const buyerPath = (cartId) => at('buying', `request=${Number(cartId)}`);
const lineLabel = (l) => `${l.sku}${l.size ? ` ${l.size}` : ''}`;
const listOf = (items, max = 8) => (items.length > max ? `${items.slice(0, max).join(', ')} +${items.length - max} more` : items.join(', '));

// The desk said yes / no to pairs on a request → the buyer, one summary per request.
export function alertLinesDecided(cart, lines, actor) {
  if (!cart?.buyer_user_id || !lines?.length) return;
  batchAlert(`decided:${cart.id}`, (d) => {
    const data = d || { cart, byLine: new Map(), actors: new Set(), actorUids: new Set() };
    data.cart = cart;
    for (const l of lines) data.byLine.set(Number(l.id), l);   // the latest decision on a line wins
    data.actors.add(actor?.name || actor?.username || 'An approver');
    if (actor?.uid != null) data.actorUids.add(String(actor.uid));
    return data;
  }, (data) => {
    const all = [...data.byLine.values()];
    const yes = all.filter((l) => l.status === 'approved');
    const no = all.filter((l) => l.status === 'rejected');
    const pairs = yes.reduce((n, l) => n + (Number(l.qty) || 0), 0);
    const body = [
      `${[...data.actors].join(' & ')} decided ${all.length} line${all.length === 1 ? '' : 's'} on ${data.cart.cart_code}.`,
      ...(yes.length ? [`✓ Approved ${pairs} pair${pairs === 1 ? '' : 's'}: ${listOf(yes.map((l) => `${lineLabel(l)} ×${l.qty}`))}`] : []),
      ...(no.length ? [`✕ Turned down: ${listOf(no.map((l) => `${lineLabel(l)}${l.decided_reason ? ` (${l.decided_reason})` : ''}`))}`] : []),
    ].join('\n');
    return alertUsers('buy.line_decided', {
      pick: (u) => String(u.id) === String(data.cart.buyer_user_id) && !data.actorUids.has(String(u.id)),
      ref: `cart:${data.cart.id}`, code: data.cart.cart_code, body, path: buyerPath(data.cart.id),
    });
  });
}

// The auditor signed off the money or the goods → the buyer.
export function alertCartAudited(cart, scope, actor, { spent = null, remaining = null } = {}) {
  if (!cart?.buyer_user_id) return;
  const who = actor?.name || actor?.username || 'The auditor';
  const body = scope === 'goods'
    ? `${who} signed off the shipment on ${cart.cart_code} — what arrived matches the receipt.`
    : `${who} audited the money on ${cart.cart_code}: ${money(spent)} spent, ${money(remaining)} left on the cards.`;
  fireAlert(() => alertUsers('buy.audited', {
    pick: (u) => String(u.id) === String(cart.buyer_user_id),
    actorUid: actor?.uid, ref: `cart:${cart.id}:${scope}`, code: cart.cart_code, body, path: buyerPath(cart.id),
  }));
}

// A comment on a buying request → everyone who has taken part in it, and the buyer. A
// buyer's question nobody has touched yet goes to whoever can approve.
export function alertCartComment(cart, actor, text) {
  fireAlert(async () => {
    const ids = new Set((await cartParticipantIds(cart.id)).map(String));
    if (cart.buyer_user_id) ids.add(String(cart.buyer_user_id));
    const staffInvolved = [...ids].some((id) => id !== String(cart.buyer_user_id) && id !== String(actor?.uid));
    const fromBuyer = String(actor?.uid) === String(cart.buyer_user_id);
    return alertUsers('buy.comment', {
      pick: (u) => ids.has(String(u.id)) || (fromBuyer && !staffInvolved && holds(u, 'approve_buying')),
      actorUid: actor?.uid, ref: `cart:${cart.id}`, code: cart.cart_code,
      body: `${actor?.name || actor?.username || 'Someone'}: “${String(text).slice(0, 600)}”`,
      path: buyerPath(cart.id),
    });
  });
}

const sizesText = (sizes) => (sizes || []).map((s) => (Number(s.qty) === 1 ? s.size : `${s.size} ×${s.qty}`)).join(', ') || '—';

// The warehouse finished a rescale count → whoever asked for it.
export function alertRescaleCounted(row, actor) {
  if (!row?.requested_by_id) return;
  fireAlert(() => alertUsers('rescale.audited', {
    pick: (u) => String(u.id) === String(row.requested_by_id),
    actorUid: actor?.uid, ref: `rescale:${row.id}`, code: row.sku,
    body: `${actor?.name || actor?.username || 'The warehouse'} counted ${row.name ? `${row.name} — ` : ''}`
      + `you reported ${sizesText(row.sizes)}; on the shelf: ${sizesText(row.actual_sizes)}.`,
    path: at('rescale'),
  }));
}

// A supplier shipped boxes → warehouse + admins, one summary per order.
export function alertPoShipped(po, box, actor) {
  batchAlert(`poship:${po.id}`, (d) => {
    const data = d || { po, boxes: new Map(), actorUid: actor?.uid };
    data.boxes.set(Number(box.id), box);
    return data;
  }, (data) => {
    const boxes = [...data.boxes.values()];
    const nums = boxes.map((b) => b.tracking_number).filter(Boolean);
    return alertUsers('po.shipped', {
      actorUid: data.actorUid, ref: `po:${data.po.id}:shipped:${boxes.map((b) => b.id).sort().join(',')}`,
      code: data.po.po_code,
      body: `${data.po.supplier_name} shipped ${boxes.length} box${boxes.length === 1 ? '' : 'es'}`
        + `${nums.length ? ` — tracking ${listOf(nums, 5)}` : ''}.`,
      path: at('inbound'),
    });
  });
}

// A tracking push → anything that just became DELIVERED (not every repeat push).
// `before` is deliveryStateBefore(), read before the webhook wrote the update.
export function alertDeliveries(before, updates, onlineOrders) {
  fireAlert(async () => {
    const key = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const deliveredNow = new Set(updates.filter((u) => u.boxStatus === 'delivered').map((u) => key(u.trackingNumber)));
    if (!deliveredNow.size) return;
    const byPo = new Map();
    for (const b of before.boxes) {
      if (b.status === 'delivered' || !deliveredNow.has(key(b.tracking_number))) continue;
      if (!byPo.has(b.po_id)) byPo.set(b.po_id, []);
      byPo.get(b.po_id).push(b);
    }
    for (const [poId, boxes] of byPo) {
      const p = boxes[0];
      await alertUsers('po.delivered', {
        once: true, ref: `po:${poId}:delivered:${boxes.map((b) => b.id).sort().join(',')}`, code: p.po_code,
        body: `${boxes.length} box${boxes.length === 1 ? '' : 'es'} from ${p.supplier_name} delivered — ready to receive.`,
        path: at('inbound'),
      });
    }
    for (const o of onlineOrders || []) {
      const was = before.tracking.get(key(o.tracking_number));
      if (!deliveredNow.has(key(o.tracking_number)) || /deliver/i.test(String(was || ''))) continue;
      await alertUsers('online.delivered', {
        once: true, ref: `online:${o.id}`, code: `${o.store}${o.order_number ? ` #${o.order_number}` : ''}`,
        body: `Delivered — ${o.pairs} pair${o.pairs === 1 ? '' : 's'} to count in${o.created_by ? ` (ordered by ${o.created_by})` : ''}.`,
        path: at('online'),
      });
    }
  });
}

// Receiving finished and the order doesn't match its manifest → admins (+ PH who opt in).
// Once per distinct result, so the next box on the same order with the same gap is quiet.
export function alertPoDiscrepancy(rc, actor) {
  if (!rc) return;
  // A STORE order (storeOutcomeForIntake): per store, and only once it has landed.
  // e.g. "4 of 15 stores short · 12 pairs · $1,320 owed" + the three biggest.
  if (rc.byStore) {
    const $ = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const head = [
      rc.storesShort ? `${rc.storesShort} of ${rc.storeCount} stores short · ${rc.short} pair${rc.short === 1 ? '' : 's'} · ${$(rc.owed)} owed` : '',
      rc.over ? `${rc.over} over` : '',
      rc.overcharge ? `${$(rc.overcharge)} charged over the list` : '',
      rc.untied ? `${rc.untied} pair${rc.untied === 1 ? '' : 's'} not tied to a store` : '',
    ].filter(Boolean).join(' · ');
    const top = (rc.top || []).map((s) => `${s.name}: ${s.short} short${s.owed != null ? ` (${$(s.owed)})` : ''}`).join('; ');
    fireAlert(() => alertUsers('po.discrepancy', {
      once: true, actorUid: actor?.uid,
      ref: `po:${rc.poId}:store:${rc.short}/${rc.owed}/${rc.over}/${rc.overcharge}/${rc.untied}`,
      code: rc.poCode,
      body: `${rc.supplierName} — ${head}.${top ? ` ${top}.` : ''} Kevin's audit is next.`,
      path: at('inbound', `po=${Number(rc.poId)}`),
    }));
    return;
  }
  const parts = [];
  if (rc.shortage) parts.push(`${rc.shortage} short`);
  if (rc.overage) parts.push(`${rc.overage} over`);
  if (rc.wrongSize) parts.push(`${rc.wrongSize} wrong size`);
  if (rc.wrongSku) parts.push(`${rc.wrongSku} not on the order`);
  fireAlert(() => alertUsers('po.discrepancy', {
    once: true, actorUid: actor?.uid,
    ref: `po:${rc.poId}:rc:${rc.shortage}/${rc.overage}/${rc.wrongSize}/${rc.wrongSku}/${rc.noManifest ? 1 : 0}`,
    code: rc.poCode,
    body: rc.noManifest
      ? `${rc.receivedUnits} unit${rc.receivedUnits === 1 ? '' : 's'} received from ${rc.supplierName} with nothing declared.`
      : `Received ${rc.receivedUnits} of ${rc.expectedUnits} from ${rc.supplierName}: ${parts.join(' · ')}. Someone needs to tell the supplier.`,
    path: at('reconcile', `po=${Number(rc.poId)}`),
  }));
}

// A note on a PO's internal thread → everyone on that thread, and admins.
export function alertPoComment(po, actor, text) {
  fireAlert(async () => {
    const ids = new Set((await poParticipantIds(po.id)).map(String));
    return alertUsers('po.comment', {
      pick: (u) => ids.has(String(u.id)) || isAdminRole(u.role),
      actorUid: actor?.uid, ref: `po:${po.id}`, code: po.po_code,
      body: `${actor?.name || actor?.username || 'Someone'}: “${String(text).slice(0, 600)}”`,
      path: at('reconcile', `po=${Number(po.id)}`),
    });
  });
}

// A NUDGE — one person poking another about one record. Required: it is somebody asking
// you, by name, to look. The caller has already chosen the recipients and checked access.
export async function sendNudge({ toIds, from, code, about, note, path, ref }) {
  const ids = new Set((toIds || []).map(String));
  const who = from?.name || from?.username || 'Someone';
  return alertUsers('nudge', {
    pick: (u) => ids.has(String(u.id)),
    actorUid: from?.uid, ref, code,
    body: `${who} nudged you about ${about}.${note ? `\n“${String(note).slice(0, 300)}”` : ''}`,
    path,
  });
}

// ── The gift card desk and a re-opened list ────────────────────────────────────
//
// The desk funds a TOTAL. A buyer re-opening the list means that total may move — maybe
// after cards have gone out — and closing it again means it has settled, with or without
// changes. Both go to everyone holding issue_gift_cards, but only once the desk is in
// play (approved, released, or cards already issued): a list re-opened before anything was
// approved changes nothing they were about to do, and they hear "Gift cards needed" when
// it's their turn anyway.
const deskInPlay = (cart) => cart && cart.funding_method !== 'company_card'
  && (['approved', 'funded'].includes(cart.status) || Number(cart.gc_total) > 0);

export function alertListReopened(cartId, actor) {
  fireAlert(async () => {
    const cart = await getBuyCart(cartId);
    if (!deskInPlay(cart)) return null;
    const issued = Number(cart.gc_total) || 0;
    return alertUsers('buy.list_reopened', {
      actorUid: actor?.uid, ref: `cart:${cart.id}:reopened:${cart.list_reopened_at ? new Date(cart.list_reopened_at).getTime() : ''}`,
      code: cart.cart_code,
      body: `${cart.buyer_name || 'The buyer'} re-opened ${cart.cart_code} to add more pairs.`
        + (issued > 0 ? `\n${money(issued)} already on cards stays.` : '')
        + '\nHold off on more cards until it is closed again — you will get a message when it is.',
      path: at('buying', `request=${Number(cart.id)}`),
    });
  });
}

export function alertListReclosed(cartId, actor) {
  fireAlert(async () => {
    const cart = await getBuyCart(cartId);
    if (!cart?.list_reopened_at || !deskInPlay(cart)) return null;
    const changes = await cartListChangesSince(cart.id, cart.list_reopened_at);
    const name = (c) => `${c.sku}${c.size ? ` ${c.size}` : ''}`;
    const added = changes.filter((c) => c.kind === 'line_added' && c.sku).map(name);
    const edited = [...new Set(changes.filter((c) => c.kind === 'line_edited' && c.sku).map(name))];
    const removed = changes.filter((c) => c.kind === 'line_removed').map((c) => c.body);
    const target = fundingTarget(cart);
    const issued = Number(cart.gc_total) || 0;
    const owed = Math.round((target - issued) * 100) / 100;
    const pending = Number(cart.pending_count) || 0;
    const what = [
      ...(added.length ? [`added ${added.length}: ${listOf(added, 6)}`] : []),
      ...(removed.length ? [`removed ${removed.length}: ${listOf(removed, 6)}`] : []),
      ...(edited.length ? [`changed ${edited.length}: ${listOf(edited, 6)}`] : []),
    ];
    const next = pending > 0
      ? `${pending} line${pending === 1 ? ' still needs' : 's still need'} approving — you will get “Gift cards needed” with any top-up once they are decided.`
      : owed > 0 ? `${money(owed)} more to issue (${money(target)} approved, ${money(issued)} on cards).`
      : owed < 0 ? `The cards (${money(issued)}) now cover more than is approved (${money(target)}) — ${money(-owed)} over.`
      : `Nothing more to issue — ${money(issued)} on cards covers the ${money(target)} approved.`;
    return alertUsers('buy.list_reclosed', {
      actorUid: actor?.uid, ref: `cart:${cart.id}:reclosed:${new Date(cart.list_reopened_at).getTime()}`,
      code: cart.cart_code,
      body: `${cart.buyer_name || 'The buyer'} closed ${cart.cart_code} again `
        + (what.length ? `— ${what.join('; ')}.` : 'with no changes.')
        + `\n${next}`,
      path: at('buying', `request=${Number(cart.id)}`),
    });
  });
}

export { EVENT as ALERT_EVENT_BY_KEY };

// A package received under a tracking number we had already received (receiving.md,
// "Duplicate tracking numbers"). `d` is the tracking_duplicates row just logged — one
// alert per row, and a row is only ever logged once.
export function alertDuplicateTracking(d, actor) {
  if (!d) return;
  const where = (code, box) => `${code || 'a deleted batch'}${box ? ` box ${box}` : ''}`;
  fireAlert(() => alertUsers('receiving.dup_tracking', {
    once: true, actorUid: actor?.uid, ref: `duptrack:${d.id}`,
    code: d.tracking_number,
    body: `${d.supplier_name || 'A supplier'} sent ${where(d.batch_code, d.box_number)} under the same tracking number as `
      + `${d.same_batch ? `box ${d.prior_box_number || '?'} of the same batch` : where(d.prior_batch_code, d.prior_box_number)}`
      + `${d.prior_supplier && d.prior_supplier !== d.supplier_name ? ` (${d.prior_supplier})` : ''}. Logged — decide whether to follow up.`,
    path: at('duptrack', `d=${Number(d.id)}`),
  }));
}

// ── Waitlist (waitlist.md) ────────────────────────────────────────────────────

// Pairs whose hold just ended — ONE message for the lot, grouped by shoe, from the worker.
export async function alertWaitlistBack(rows) {
  if (!rows?.length) return null;
  const by = new Map();
  for (const r of rows) {
    const k = r.sku || '?';
    const g = by.get(k) || { name: r.name, sizes: [] };
    g.sizes.push(r.size);
    by.set(k, g);
  }
  const lines = [...by.entries()].slice(0, 15).map(([sku, g]) => `• ${sku}${g.name ? ` ${g.name}` : ''} — ${g.sizes.join(', ')}`);
  const more = by.size > 15 ? `\n…and ${by.size - 15} more` : '';
  const pairs = rows.length;
  return alertUsers('ph.waitlist_back', {
    ref: `waitlist-back:${rows.map((r) => r.id).sort((a, b) => a - b).join(',').slice(0, 180)}`,
    code: `${pairs} pair${pairs === 1 ? '' : 's'}`,
    body: `Off the waitlist and back on New Inventory to list — check the market before listing:\n${lines.join('\n')}${more}`,
    path: at('newinv', 'st=pending'),
  });
}

// The daily report: everything on hold as an Excel file (`file` = { filename, content,
// type }). `once` per EST day, so a restart or a second instance can't send it twice.
export async function alertWaitlistDaily({ day, rows, file }) {
  const pairs = rows.reduce((n, r) => n + (Number(r.qty) || 0), 0);
  const skus = new Set(rows.map((r) => r.sku)).size;
  return alertUsers('ph.waitlist_daily', {
    once: true,
    ref: `waitlist-daily:${day}`,
    code: day,
    body: rows.length
      ? `${pairs} pair${pairs === 1 ? '' : 's'} on hold across ${skus} SKU${skus === 1 ? '' : 's'}. The file has each SKU + size, why it was held, when it comes back, and what it would make at today's market.`
      : 'Nothing is on the waitlist today.',
    path: at('newinv', 'st=waitlist'),
    document: rows.length ? file : null,
  });
}

// One message per photo, however many orders were on it.
export function alertCancellationsLogged(rows, by) {
  if (!rows?.length) return;
  const nums = rows.map((r) => r.order_number || 'number unreadable').slice(0, 8).join(', ');
  const flagged = rows.filter((r) => (r.flags || []).length).length;
  fireAlert(() => alertUsers('cancel.logged', {
    actorUid: by?.id ?? null,
    ref: `cancel:${rows[0].id}`,
    code: rows.length === 1 ? `#${rows[0].id}` : `#${rows[0].id}–#${rows[rows.length - 1].id}`,
    body: `${by?.name || 'The warehouse'} sent ${rows.length === 1 ? 'an order' : `${rows.length} orders`} to cancel: ${nums}.`
      + (flagged ? ` ${flagged} need${flagged === 1 ? 's' : ''} a closer look.` : ''),
    path: at('cancellations'),
  }));
}

// ── Inbound issues (inbound-issues.md) ───────────────────────────────────────────────
const issueWhere = (r) => [
  r.supplier ? `from ${r.supplier}` : null,
  r.po_code ? r.po_code : null,
  r.tracking_number ? `tracking ${r.tracking_number}` : null,
  r.batch_code ? `${r.batch_code}${r.box_number != null ? ` box ${r.box_number}` : ''}` : null,
].filter(Boolean).join(' · ');

// One message per receiving submit, however many cases it opened — five creased pairs in
// one box is one ping listing five cases, not five pings.
export function alertInboundIssuesReported(rows, by) {
  if (!rows?.length) return;
  const first = rows[0];
  const lines = rows.slice(0, 10).map((r) => `#${r.id} ${issueHeadline(r)}${(r.photos || []).length ? ` · ${r.photos.length} photo${r.photos.length === 1 ? '' : 's'}` : ''}`);
  const more = rows.length > 10 ? `\n…and ${rows.length - 10} more.` : '';
  fireAlert(() => alertUsers('inbound.issue_reported', {
    actorUid: by?.id ?? null,
    ref: `inbound:${first.id}`,
    code: rows.length === 1 ? `#${first.id}` : `#${first.id}–#${rows[rows.length - 1].id}`,
    body: `${by?.name || 'The warehouse'} reported ${rows.length === 1 ? 'a problem' : `${rows.length} problems`}${issueWhere(first) ? ` (${issueWhere(first)})` : ''}:\n${lines.join('\n')}${more}\n\nOpen it and tap “Take it” — one person owns each case.`,
    path: at('inboundissues', rows.length === 1 ? `id=${first.id}` : 'view=open'),
  }));
}

export function alertInboundIssueAssigned(row, toUid, by) {
  fireAlert(() => alertUsers('inbound.issue_assigned', {
    pick: (u) => String(u.id) === String(toUid),
    actorUid: by?.id ?? null,
    ref: `inbound-assign:${row.id}:${toUid}`,
    code: `#${row.id}`,
    body: `${by?.name || 'Someone'} handed you case #${row.id}: ${issueHeadline(row)}${issueWhere(row) ? ` (${issueWhere(row)})` : ''}.`,
    path: at('inboundissues', `id=${row.id}`),
  }));
}

export function alertInboundWarehouseTask(row, by) {
  fireAlert(() => alertUsers('inbound.warehouse_task', {
    actorUid: by?.id ?? null,
    ref: `inbound-task:${row.id}:${row.warehouse_task_at}`,
    code: `#${row.id}`,
    body: `${by?.name || 'PH'} asks: ${row.warehouse_task}\nCase #${row.id} — ${issueHeadline(row)}${issueWhere(row) ? ` (${issueWhere(row)})` : ''}. Tap “Done” on the case when it is done.`,
    path: at('inboundissues', `id=${row.id}`),
  }));
}

// To the person who reported it: their box is no longer "set aside until someone comes".
export function alertInboundIssueResolved(row, pair, by) {
  if (!row?.reported_by_user_id) return;
  const pairWord = pair?.removed ? ` The pair ${pair.removed} was returned and is off the inventory.`
    : pair?.released ? ` The pair ${pair.released} is back in stock — shelve it.`
    : pair?.stillHeld ? ` The pair ${pair.stillHeld} is still held by another open case.` : '';
  fireAlert(() => alertUsers('inbound.issue_resolved', {
    pick: (u) => String(u.id) === String(row.reported_by_user_id),
    actorUid: by?.id ?? null,
    ref: `inbound-resolved:${row.id}:${row.resolved_at}`,
    code: `#${row.id}`,
    body: `${by?.name || 'PH'} resolved #${row.id} — ${issueHeadline(row)}: ${outcomeLabel(row.outcome)}${row.refund_amount != null ? ` ${money(row.refund_amount)}` : ''}.${pairWord}${row.resolution_note ? `\n${row.resolution_note}` : ''}`,
    path: at('inboundissues', `id=${row.id}`),
  }));
}

// The oversight summary (Genesis): what is open, who owns it, and what is slipping.
export async function alertInboundIssuesDaily({ day, rows, closedYesterday = 0, now = Date.now() }) {
  const unclaimed = rows.filter((r) => ageFlags(r, now).includes('unclaimed'));
  const stale = rows.filter((r) => ageFlags(r, now).includes('stale'));
  const byOwner = new Map();
  for (const r of rows) byOwner.set(r.owner || 'nobody yet', (byOwner.get(r.owner || 'nobody yet') || 0) + 1);
  const owners = [...byOwner.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ');
  const list = (xs) => xs.slice(0, 8).map((r) => `#${r.id} ${issueHeadline(r)} — ${r.owner || 'unclaimed'}, ${ago(r.status === 'open' ? r.created_at : r.last_activity_at, now)}`).join('\n');
  const body = !rows.length
    ? `No open inbound issues.${closedYesterday ? ` ${closedYesterday} resolved yesterday.` : ''}`
    : [
      `${rows.length} open case${rows.length === 1 ? '' : 's'} (${owners}).${closedYesterday ? ` ${closedYesterday} resolved yesterday.` : ''}`,
      unclaimed.length ? `\n⏰ Nobody has taken ${unclaimed.length}:\n${list(unclaimed)}` : '',
      stale.length ? `\n🐢 No update in ${STALE_DAYS}+ days on ${stale.length}:\n${list(stale)}` : '',
    ].filter(Boolean).join('\n');
  return alertUsers('inbound.issue_daily', {
    once: true,
    ref: `inbound-daily:${day}`,
    code: day,
    body,
    path: at('inboundissues', 'view=all'),
  });
}

// The one re-ping: a case still on New after a few hours goes to PH again, ONCE per case
// (`once` on its own ref), so "nobody saw it" can't wait for the next morning's summary.
export async function alertInboundIssueUnclaimed(row) {
  return alertUsers('inbound.issue_reported', {
    once: true,
    ref: `inbound-remind:${row.id}`,
    code: `#${row.id} — still not taken`,
    body: `Nobody has taken #${row.id} yet (reported ${ago(row.created_at)} ago by ${row.reported_by || 'the warehouse'}): ${issueHeadline(row)}${issueWhere(row) ? ` (${issueWhere(row)})` : ''}. Open it and tap “Take it”.`,
    path: at('inboundissues', `id=${row.id}`),
  });
}
