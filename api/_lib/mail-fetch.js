// Reading a mailbox ourselves, over IMAP — the TRIAL (docs/context/receipts.md → "Reading the
// mailboxes ourselves", Phase 1).
//
// Make fetches the receipt mail today and posts it to ingest-raw. This does the same fetch from
// our own server, for ONE mailbox, and records what it WOULD have filed (mail_trial_messages)
// next to what Make really filed (email_receipts). **Nothing is filed, moved, flagged or
// deleted**: every folder is opened read-only and the result goes to the trial tables only.
// When the two sides agree, the mailbox can be switched over (a later phase).
//
// What is different from Make, on purpose:
//   · a POSITION per folder, not a date window. IMAP numbers every message in a folder (UID);
//     we keep the last one read and ask for "everything after it". No 300/800 cap, no overlap
//     hour, and none of Yahoo's "since means the whole day".
//   · the lookups are off (parseReceiptEmail lookups:false): Make has read this mail too, and
//     a second round of style-code lookups would cost credits to learn nothing.
//
// The mailbox is named by environment variables, set on the server by hand — the password is
// never typed into the app, stored in the database, logged, or sent to a browser:
//   MAIL_TRIAL_USER      the login (the full address)
//   MAIL_TRIAL_PASS      an APP PASSWORD made for this, not the account's own password
//   MAIL_TRIAL_PROVIDER  yahoo (default) · gmail · icloud · aol     — or MAIL_TRIAL_HOST
//   MAIL_TRIAL_MAILBOX   the name Make sends as `mailbox` (default: MAIL_TRIAL_USER). It is part
//                        of every receipt's key, so it must match or nothing will pair up.
//   MAIL_TRIAL_FOLDERS   comma-separated, spelled as Make sends them (default: per provider)
//   MAIL_TRIAL_DAYS      how far back the FIRST run of a folder looks (default 3)
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { dbConfigured, getMailTrialFolder, setMailTrialPosition, noteMailTrialFolderError, saveMailTrialMessage } from './db.js';
import { rawMessageKey, normalizeReceiptBody } from './receipt-ingest.js';
import { parseReceiptEmail } from './receipt-parser/index.js';

const PROVIDERS = {
  yahoo: {
    host: 'imap.mail.yahoo.com',
    // The list Make searches (YAHOO_FOLDERS in the parser). Yahoo's spam folder is "Bulk".
    folders: ['Inbox', 'Bulk', 'Champs Sports', 'Footlocker', 'Finishline', 'Jd sports folder', "Dick's Sporting Goods", 'Orders', 'Purchased for Supplier'],
  },
  aol: { host: 'imap.aol.com', folders: ['Inbox', 'Bulk'] },
  gmail: { host: 'imap.gmail.com', folders: ['[Gmail]/All Mail', '[Gmail]/Spam'] },
  icloud: { host: 'imap.mail.me.com', folders: ['INBOX', 'Junk'] },
};
const MAX_BYTES = 4 * 1024 * 1024;   // ingest-raw's limit: anything larger is not a receipt
const MAX_PER_FOLDER = 1500;         // one run reads at most this many per folder; the next carries on
const env = (k) => String(process.env[k] || '').trim();

/** The trial mailbox, or null when it is not set up. Never includes the password. */
export function mailTrialConfig() {
  const user = env('MAIL_TRIAL_USER');
  if (!user || !env('MAIL_TRIAL_PASS')) return null;
  const provider = (env('MAIL_TRIAL_PROVIDER') || 'yahoo').toLowerCase();
  const known = PROVIDERS[provider];
  const host = env('MAIL_TRIAL_HOST') || known?.host;
  if (!host) return null;
  const folders = env('MAIL_TRIAL_FOLDERS') ? env('MAIL_TRIAL_FOLDERS').split(',').map((f) => f.trim()).filter(Boolean) : (known?.folders || ['INBOX']);
  const days = Math.min(60, Math.max(1, Number(env('MAIL_TRIAL_DAYS')) || 3));
  return { provider, host, user, mailbox: env('MAIL_TRIAL_MAILBOX') || user, folders, days };
}

// An address header as text. mailparser hands back { text, value:[{address,name}] }, an array
// of those (a header that appears twice), or a plain string.
function headerText(v) {
  if (!v) return '';
  if (Array.isArray(v)) return v.map(headerText).filter(Boolean).join(', ');
  if (typeof v === 'string') return v;
  if (typeof v.text === 'string') return v.text;
  if (Array.isArray(v.value)) return v.value.map((a) => a?.address || '').filter(Boolean).join(', ');
  return '';
}

/**
 * A raw message (RFC 822 bytes) → the twelve fields ingest-raw takes from Make. Exported for the
 * tests: this decoding is the one part of the trial that has to match Make's.
 */
export async function emailFromSource(source, { mailbox, folder, fallbackDate } = {}) {
  const m = await simpleParser(source, { skipImageLinks: true, skipTextLinks: true });
  const h = (name) => headerText(m.headers.get(name));
  const date = m.date || fallbackDate || null;
  const clean = (v) => String(v ?? '').replace(/\u0000/g, '');
  return {
    mailbox: clean(mailbox),
    folder: clean(folder),
    from: clean(headerText(m.from)),
    subject: clean(m.subject),
    date: date ? new Date(date).toISOString() : '',
    text: clean(m.text),
    html: clean(m.html || ''),
    to: clean(headerText(m.to)),
    cc: clean(headerText(m.cc)),
    delivered_to: clean(h('delivered-to') || h('x-delivered-to')),
    // Left empty when no header says so: the parser then reads the forwarded block's "To:".
    original_to: clean(h('x-forwarded-to') || h('x-original-to') || h('resent-to')),
    message_id: clean(m.messageId),
  };
}

/** One email → what the trial records about it. Never throws. */
async function readOne(email) {
  const base = { messageKey: rawMessageKey(email), receivedAt: email.date || null, from: email.from.slice(0, 300), subject: email.subject.slice(0, 500) };
  try {
    const out = await parseReceiptEmail(email, { lookups: false });
    if (!out?.post) return { ...base, outcome: `skipped:${out?.skip || 'not_a_receipt'}` };
    const r = normalizeReceiptBody(out.parsed);
    if (!r) return { ...base, outcome: 'skipped:no_message_key' };
    return { ...base, messageKey: r.message_key, outcome: 'receipt', parsed: r };
  } catch (e) {
    return { ...base, outcome: 'error', error: String(e?.message || e).slice(0, 300) };
  }
}

// Exported for the tests, which hand it a stand-in for the IMAP client.
export async function readFolder(client, cfg, folder, progress) {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const uidvalidity = Number(client.mailbox.uidValidity);
    const pos = await getMailTrialFolder(cfg.mailbox, folder);
    let last = pos && pos.uidvalidity === uidvalidity ? pos.lastUid : null;
    if (last === null) {
      // First run (or the folder was rebuilt and its numbers mean nothing now): start at the
      // oldest message of the last N days. IMAP's SINCE is by whole day, so this reaches a
      // little further back than N × 24 h, which is the safe side.
      const since = new Date(Date.now() - cfg.days * 86_400_000);
      const uids = (await client.search({ since }, { uid: true })) || [];
      last = uids.length ? Math.min(...uids) - 1 : Number(client.mailbox.uidNext) - 1;
      await setMailTrialPosition({ mailbox: cfg.mailbox, folder, uidvalidity, lastUid: last });
    }

    // The list first, the bodies after: IMAP cannot run a second command inside a FETCH stream.
    // "N:*" always answers with the newest message even when N is past it — hence the filter.
    const list = [];
    for await (const msg of client.fetch(`${last + 1}:*`, { uid: true, size: true, internalDate: true }, { uid: true })) {
      if (msg.uid > last) list.push({ uid: msg.uid, size: msg.size || 0, internalDate: msg.internalDate || null });
    }
    list.sort((a, b) => a.uid - b.uid);
    const batch = list.slice(0, MAX_PER_FOLDER);
    progress.folders[folder] = { waiting: list.length, read: 0, receipts: 0 };

    for (const item of batch) {
      let row;
      if (item.size > MAX_BYTES) {
        row = { outcome: 'too_big', receivedAt: item.internalDate };
      } else {
        try {
          const msg = await client.fetchOne(String(item.uid), { source: true }, { uid: true });
          if (!msg?.source) throw new Error('The server returned no message body');
          const email = await emailFromSource(msg.source, { mailbox: cfg.mailbox, folder, fallbackDate: item.internalDate });
          row = await readOne(email);
        } catch (e) {
          row = { outcome: 'error', error: String(e?.message || e).slice(0, 300), receivedAt: item.internalDate };
        }
      }
      await saveMailTrialMessage({ mailbox: cfg.mailbox, folder, uid: item.uid, size: item.size, ...row });
      // After EVERY message: a restart mid-folder carries on at the next one, reads none twice.
      await setMailTrialPosition({ mailbox: cfg.mailbox, folder, uidvalidity, lastUid: item.uid, added: 1 });
      progress.folders[folder].read += 1;
      if (row.outcome === 'receipt') progress.folders[folder].receipts += 1;
      progress.read += 1;
    }
    if (!batch.length) await setMailTrialPosition({ mailbox: cfg.mailbox, folder, uidvalidity, lastUid: last });
    progress.folders[folder].waiting = list.length - batch.length;
  } finally {
    lock.release();
  }
}

// One run at a time, in this process. `state` is what the page polls.
let state = { running: false };
export const mailTrialState = () => state;

async function run(cfg, by) {
  const progress = { running: true, by, startedAt: new Date().toISOString(), read: 0, folders: {}, folder: null, error: null };
  state = progress;
  const client = new ImapFlow({
    host: cfg.host, port: 993, secure: true,
    auth: { user: cfg.user, pass: env('MAIL_TRIAL_PASS') },
    logger: false,                      // its log lines carry the login exchange
    socketTimeout: 120_000,
  });
  // A dropped connection raises 'error' on the client; unhandled, that would stop the server.
  client.on('error', (e) => { progress.error = progress.error || String(e?.message || e).slice(0, 200); });
  try {
    await client.connect();
    for (const folder of cfg.folders) {
      progress.folder = folder;
      try {
        await readFolder(client, cfg, folder, progress);
      } catch (e) {
        const msg = String(e?.responseText || e?.message || e).slice(0, 300);
        progress.folders[folder] = { ...(progress.folders[folder] || {}), error: msg };
        await noteMailTrialFolderError({ mailbox: cfg.mailbox, folder, error: msg }).catch(() => {});
        if (!client.usable) throw e;    // the connection is gone: the remaining folders cannot be read
      }
    }
  } catch (e) {
    // A refused login lands here. The server's own words (never our password) are kept.
    progress.error = String(e?.responseText || e?.message || e).slice(0, 300);
    console.error('[mail-trial]', progress.error);
  } finally {
    await client.logout().catch(() => {});
    progress.running = false;
    progress.folder = null;
    progress.finishedAt = new Date().toISOString();
  }
}

/** Start a run in the background. → { started } | { started:false, why } */
export function startMailTrial(by) {
  if (!dbConfigured()) return { started: false, why: 'Database is not configured.' };
  const cfg = mailTrialConfig();
  if (!cfg) return { started: false, why: 'The trial mailbox is not set up on this server (MAIL_TRIAL_USER / MAIL_TRIAL_PASS).' };
  if (state.running) return { started: false, why: `${state.by || 'Someone'} started a run that is still reading.` };
  run(cfg, by).catch((e) => console.error('[mail-trial]', e.message));
  return { started: true };
}

// ---- the comparison: our reading next to Make's --------------------------------------------
const cents = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100));
const norm = (v) => String(v ?? '').trim().toLowerCase();

/** One row of mailTrialReport().pairs → { verdict, diffs }. Pure. */
export function compareTrialPair(p) {
  const ours = p.outcome === 'receipt' ? p.parsed || {} : null;
  const filed = !!p.receipt_id;
  if (ours && !filed) return { verdict: 'only_ours', diffs: [] };          // Make has not filed it (yet, or at all)
  if (!ours && filed) return { verdict: 'only_make', diffs: [`we read it as ${p.outcome}`] };
  const diffs = [];
  const same = (label, a, b) => { if (a !== b) diffs.push(`${label}: ours ${JSON.stringify(a)} · Make ${JSON.stringify(b)}`); };
  same('store', norm(ours.store), norm(p.store));
  same('order #', norm(ours.order_number), norm(p.order_number));
  const dollars = (c) => (c === null ? null : (c / 100).toFixed(2));
  for (const k of ['subtotal', 'tax', 'shipping', 'total']) same(k, dollars(cents(ours[k])), dollars(cents(p[k])));
  same('store #', norm(ours.store_number), norm(p.store_number));
  same('zip', norm(ours.zip), norm(p.zip));
  const oi = Array.isArray(ours.items) ? ours.items : [];
  const mi = Array.isArray(p.items) ? p.items : [];
  same('pairs', oi.reduce((n, it) => n + (Number(it.qty) || 1), 0), mi.reduce((n, it) => n + (Number(it.qty) || 1), 0));
  // Prices and UPCs come off the receipt itself. Names, sizes and style codes are left out: a
  // lookup can rewrite them on Make's side, and ours ran with the lookups off.
  const prices = (items) => items.map((it) => cents(it.final_price)).sort((a, b) => a - b).join(',');
  same('prices', prices(oi), prices(mi));
  const upcs = (items) => items.map((it) => norm(it.upc)).filter(Boolean).sort().join(',');
  same('UPCs', upcs(oi), upcs(mi));
  const addrs = (list) => [...new Set((list || []).map(norm).filter(Boolean))].sort().join(',');
  same('recipients', addrs(ours.recipient_addrs), addrs(p.recipient_addrs));
  return { verdict: diffs.length ? 'differs' : 'match', diffs };
}
