// Costs from the stores' emails — the run (docs/context/costs.md → "Fill from emails").
//
// For every parcel with pairs that have no cost: ask the order mailbox for the emails that
// carry its tracking number (Make scenario 7082222, the same one online orders use), read
// which order it is and what is in it, ask for the order's confirmation when the price is
// not in the parcel's own email, and work out what each pair was PAID (after the store's
// discount, before any gift card). Nothing is written to a pair here: the result is a
// preview on the run, and `applyCostEmailRun` fills blank costs when a person says so.
//
// One run at a time, in this process (a long task belongs on the server, not in a tab). It
// touches the run after every parcel; a run not touched for 3 minutes was cut off by a
// restart and can be continued — what it already asked the mailbox is remembered.
import {
  listCostEmailCandidates, getCostEmailLookup, saveCostEmailLookup, getCostEmailRun, touchCostEmailRun,
  finishCostEmailRun, markCostEmailRunApplied, fillItemsCost,
} from './db.js';
import { splitOrderEmails } from './online-order-shipments.js';
import { readParcel, readOrder, priceParcel, learnNames } from '../../src/lib/costEmails.js';

const TIMEOUT_MS = 60_000;
export const MAX_PARCELS = 1500;
// A miss is asked again after a day (the email may not have arrived yet); a hit is kept.
const MISS_HOURS = 24;

const hookUrl = () => String(process.env.MAKE_ORDER_EMAILS_URL || '').trim();
export const costEmailsConfigured = () => { try { return new URL(hookUrl()).protocol === 'https:'; } catch { return false; } };

async function askMailbox(term) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(hookUrl(), { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: term }) });
    const text = await r.text();
    if (!r.ok || !text.includes('@@SUBJECT@@')) throw new Error(`the mailbox search answered ${r.status}`);
    return splitOrderEmails(text);
  } finally { clearTimeout(timer); }
}

// What a tracking number ('T:') or an order number ('O:') reads as — from memory when it
// was asked before, else from the mailbox (two tries: Make drops the odd request).
async function lookup(key, term, read, ask) {
  const had = await getCostEmailLookup(key);
  if (had) {
    const fresh = had.data?.state === 'ok' || Date.now() - new Date(had.searched_at).getTime() < MISS_HOURS * 3600_000;
    if (fresh) return had.data;
  }
  let emails;
  try { emails = await ask(term); } catch { emails = await ask(term); }
  const data = read(emails);
  await saveCostEmailLookup(key, data, emails.length);
  return data;
}

const REASON_ORDER = 'The order’s confirmation email was not found';

/** Work one run through. Resolves when it is done, stopped or failed; never throws. */
export async function runCostEmails(runId, { io = {} } = {}) {
  const ask = io.ask || askMailbox;
  try {
    const run = await getCostEmailRun(runId);
    if (!run || run.status !== 'running') return;
    const pairs = await listCostEmailCandidates({ supplier: run.supplier, from: run.date_from, to: run.date_to });
    const by = new Map();
    for (const p of pairs) { if (!by.has(p.trk)) by.set(p.trk, []); by.get(p.trk).push(p); }
    const parcels = [...by.entries()].slice(0, MAX_PARCELS);
    await touchCostEmailRun(runId, { total: parcels.length, done: 0 });

    const work = [];
    let done = 0;
    for (const [trk, list] of parcels) {
      let parcel; let order = null;
      try {
        parcel = await lookup(`T:${trk}`, trk, (e) => readParcel(e, trk), ask);
        if (parcel.state === 'ok' && !parcel.priced && parcel.order) order = await lookup(`O:${parcel.order}`, parcel.order, readOrder, ask);
      } catch (e) {
        parcel = { state: 'error', error: e.message };
      }
      work.push({ trk, list, parcel, order });
      done += 1;
      // The touch is also how a Stop reaches the loop.
      if ((await touchCostEmailRun(runId, { done })) !== 'running') return;
    }

    // What each store calls a shoe, learned from the parcels that hold one shoe — it settles
    // the parcels that hold two of the same size.
    const skuNames = new Map();
    for (const w of work) learnNames(skuNames, w.list, w.parcel);

    const rows = [];
    const summary = { pairs: 0, priced: 0, parcels: parcels.length, reasons: {}, stores: {}, capped: by.size > MAX_PARCELS };
    for (const w of work) {
      const res = w.parcel.state === 'error'
        ? w.list.map((p) => ({ id: p.id, reason: 'The mailbox search failed for this parcel — run it again' }))
        : priceParcel(w.list, w.parcel, w.order, skuNames);
      const byId = new Map(res.map((r) => [Number(r.id), r]));
      for (const p of w.list) {
        const r = byId.get(Number(p.id)) || { reason: 'Not found' };
        const store = w.parcel.store || p.supplier_name || '—';
        summary.pairs += 1;
        summary.stores[store] ||= { pairs: 0, priced: 0 };
        summary.stores[store].pairs += 1;
        if (r.each != null && r.each > 0) { summary.priced += 1; summary.stores[store].priced += 1; }
        else summary.reasons[r.reason || REASON_ORDER] = (summary.reasons[r.reason || REASON_ORDER] || 0) + 1;
        rows.push({
          id: Number(p.id), vin: p.vin, sku: p.sku, size: p.size, name: p.name, batch: p.batch_code, supplier: p.supplier_name,
          trk: w.trk, store: w.parcel.store || null, order: w.parcel.order || null,
          each: r.each != null && r.each > 0 ? r.each : null, full: r.full ?? null, how: r.how || null,
          email_name: r.name || null, note: r.note || null, reason: r.each != null && r.each > 0 ? null : (r.reason || REASON_ORDER),
        });
      }
    }
    await finishCostEmailRun(runId, { status: 'done', rows, summary });
  } catch (e) {
    console.error('[cost-emails] run', runId, e.message);
    await finishCostEmailRun(runId, { status: 'failed', error: String(e.message || e).slice(0, 300) }).catch(() => {});
  }
}

/**
 * Write a finished run's prices. Only a pair that STILL has no cost is filled (a cost typed
 * since the preview wins), each with a line in its history naming the store and the order.
 */
export async function applyCostEmailRun(runId, by) {
  const run = await getCostEmailRun(runId, { rows: true });
  if (!run) return { error: 'That run no longer exists.', status: 404 };
  if (run.status !== 'done') return { error: run.status === 'applied' ? 'These prices were already applied.' : 'This run has not finished.' };
  const groups = new Map();
  for (const r of run.rows || []) {
    if (!(r.each > 0)) continue;
    const k = `${r.each}|${r.store || ''}|${r.order || ''}|${r.note || ''}`;
    if (!groups.has(k)) groups.set(k, { ids: [], row: r });
    groups.get(k).ids.push(Number(r.id));
  }
  let filled = 0;
  for (const g of groups.values()) {
    const r = g.row;
    const text = `Cost $${Number(r.each).toFixed(2)} from the ${r.store || 'store'} email${r.order ? `, order ${r.order}` : ''}: the price paid`
      + `${r.full != null && r.full > r.each ? ` (listed $${Number(r.full).toFixed(2)}, after the store’s discount)` : ''}${r.note ? ` — ${r.note}` : ''}`;
    filled += await fillItemsCost(g.ids, r.each, r.each, text, by);
  }
  await markCostEmailRunApplied(runId, by, filled);
  return { ok: true, filled };
}
