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
import { readParcel, readOrder, priceParcel, learnNames, readSkuLines, priceBySku, priceFromOrder, bare } from '../../src/lib/costEmails.js';

const TIMEOUT_MS = 150_000;   // a SKU that is in forty long emails is a 300 KB answer
export const MAX_PARCELS = 1500;
// The SKU route asks the mailbox once per shoe still unpriced: at most this many a run.
export const MAX_SKUS = 200;
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
// READERS: bump when a reader changes what it makes of the SAME email, so what was read the
// old way is asked again instead of trusted for good. 2 (2026-11-26) = Foot Locker / Champs
// lines are for the whole line (÷ pairs) and carry the summary's discount; JD's confirmation.
// An answer from before the number existed is re-read only for the stores it changed.
// 3 (2026-11-26) = JD's "Shipping | Tracking:" line.
export const READERS = 3;
const REREAD_V1 = /^(foot locker|champs sports|kids foot locker|jd sports)$/i;
const current = (data) => Number(data?.v || 1) >= READERS || !REREAD_V1.test(String(data?.store || ''));
async function lookup(key, term, read, ask) {
  const had = await getCostEmailLookup(key);
  if (had && current(had.data)) {
    const fresh = had.data?.state === 'ok' || Date.now() - new Date(had.searched_at).getTime() < MISS_HOURS * 3600_000;
    if (fresh) return had.data;
  }
  let emails;
  try { emails = await ask(term); } catch { emails = await ask(term); }
  const data = { ...read(emails), v: READERS };
  await saveCostEmailLookup(key, data, emails.length);
  return data;
}

// A style code is also in dozens of GOAT / Alias account newsletters, and the search returns
// the OLDEST 60 emails — the receipts never arrived (JH7834: 60 newsletters, 0 receipts). The
// scenario searches for "<text>" in quotes, so closing and re-opening them slips in a Gmail
// operator that leaves those senders out: "JH7834" -from:goat.com "JH7834".
const skuSearch = (k) => `${k}" -from:goat.com "${k}`;

const REASON_ORDER = 'The order’s confirmation email was not found';

/** Work one run through. Resolves when it is done, stopped or failed; never throws. */
export async function runCostEmails(runId, { io = {} } = {}) {
  const ask = io.ask || askMailbox;
  try {
    const run = await getCostEmailRun(runId);
    if (!run || run.status !== 'running') return;
    const pairs = await listCostEmailCandidates({ supplier: run.supplier, from: run.date_from, to: run.date_to, sku: run.sku });
    // A tracking number is the exact way in. A pair without one (under 10 characters) is
    // still in the run: the order number given, or its SKU, may price it below.
    const by = new Map();
    const loose = [];
    for (const p of pairs) {
      if (String(p.trk || '').length < 10) { loose.push(p); continue; }
      if (!by.has(p.trk)) by.set(p.trk, []); by.get(p.trk).push(p);
    }
    const parcels = [...by.entries()].slice(0, MAX_PARCELS);
    await touchCostEmailRun(runId, { total: parcels.length, done: 0 });

    const work = [];
    let done = 0;
    for (const [trk, list] of parcels) {
      let parcel; let order = null;
      try {
        parcel = await lookup(`T:${trk}`, trk, (e) => readParcel(e, trk), ask);
        // The order's own emails have the price when the parcel's does not — and are the only
        // thing to read when the tracking number was found in an email we cannot read (adidas).
        // …and when the parcel's email prints a price but not the order's total (`unsure`): the
        // confirmation says whether a discount came off.
        const needOrder = parcel.order && ((parcel.state === 'ok' && (!parcel.priced || parcel.unsure)) || parcel.state === 'unreadable');
        if (needOrder) order = await lookup(`O:${parcel.order}`, parcel.order, readOrder, ask);
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

    if (loose.length) work.push({ trk: '', list: loose, parcel: { state: 'no_tracking' }, order: null });

    // ── The other two ways in, for what the tracking number did not price ────────────────
    // 1. the order number someone gave (its confirmation), 2. the SKU itself: the store
    // emails that PRINT the code (adidas' receipts). Both are worked out per pair below.
    const first = new Map();
    for (const w of work) {
      const res = w.parcel.state === 'error'
        ? w.list.map((p) => ({ id: p.id, reason: 'The mailbox search failed for this parcel — run it again' }))
        : w.parcel.state === 'no_tracking'
          ? w.list.map((p) => ({ id: p.id, reason: 'No tracking number on the batch' }))
          : w.parcel.state === 'unreadable' && w.order?.state === 'ok'
            // The order is known, the parcel's contents are not: only a line that IS this shoe counts.
            ? w.list.map((p) => { const r = priceFromOrder(p, w.order, { skuNames }); return r.each > 0 ? { id: p.id, ...r, note: 'from the order this tracking number belongs to' } : { id: p.id, reason: r.reason }; })
            : priceParcel(w.list, w.parcel, w.order, skuNames);
      for (const r of res) first.set(Number(r.id), r);
    }
    const open = () => pairs.filter((p) => !(first.get(Number(p.id))?.each > 0));
    if (run.order_number && open().length) {
      let named;
      try { named = await lookup(`O:${run.order_number}`, run.order_number, readOrder, ask); } catch { named = { state: 'error' }; }
      for (const p of open()) {
        const r = priceFromOrder(p, named, { trustSize: !!run.sku, skuNames });
        if (r.each > 0) first.set(Number(p.id), { id: p.id, ...r, store: named.store || null, order: run.order_number });
        else if (!first.get(Number(p.id))?.store) first.set(Number(p.id), { id: p.id, reason: r.reason });
      }
    }
    const skus = [...new Set(open().map((p) => bare(p.sku)).filter((k) => k.length >= 5))].slice(0, MAX_SKUS);
    const skusLeft = new Set(open().map((p) => bare(p.sku))).size - skus.length;
    if (skus.length) await touchCostEmailRun(runId, { total: parcels.length + skus.length });
    for (const k of skus) {
      let lines = [];
      try { lines = (await lookup(`S:${k}`, skuSearch(k), (e) => { const found = readSkuLines(e, k); return { state: found.length ? 'ok' : 'none', lines: found }; }, ask)).lines || []; } catch { lines = null; }
      for (const p of open().filter((x) => bare(x.sku) === k)) {
        if (lines == null) { first.set(Number(p.id), { ...(first.get(Number(p.id)) || {}), id: p.id, reason: 'The mailbox search for this SKU failed — run it again' }); continue; }
        const r = priceBySku({ ...p, supplier: p.supplier_name }, lines);
        const was = first.get(Number(p.id)) || {};
        if (r.each > 0) first.set(Number(p.id), { id: p.id, ...r });
        // A pair the tracking route already explained keeps that reason unless the SKU found prices to choose from.
        else if (/^Bought at/.test(r.reason) || /^No (email|tracking)/.test(was.reason || '')) first.set(Number(p.id), { ...was, id: p.id, reason: /^Bought at/.test(r.reason) ? r.reason : was.reason, store: was.store || r.store });
      }
      done += 1;
      if ((await touchCostEmailRun(runId, { done })) !== 'running') return;
    }

    const rows = [];
    const summary = { v: READERS, pairs: 0, priced: 0, parcels: parcels.length, skus: skus.length, reasons: {}, stores: {}, capped: by.size > MAX_PARCELS || skusLeft > 0 };
    for (const w of work) {
      const res = w.list.map((p) => first.get(Number(p.id)) || { id: p.id, reason: 'Not found' });
      const byId = new Map(res.map((r) => [Number(r.id), r]));
      for (const p of w.list) {
        const r = byId.get(Number(p.id)) || { reason: 'Not found' };
        const store = r.store || w.parcel.store || p.supplier_name || '—';
        summary.pairs += 1;
        summary.stores[store] ||= { pairs: 0, priced: 0 };
        summary.stores[store].pairs += 1;
        if (r.each != null && r.each > 0) { summary.priced += 1; summary.stores[store].priced += 1; }
        else summary.reasons[r.reason || REASON_ORDER] = (summary.reasons[r.reason || REASON_ORDER] || 0) + 1;
        rows.push({
          id: Number(p.id), vin: p.vin, sku: p.sku, size: p.size, name: p.name, batch: p.batch_code, supplier: p.supplier_name,
          trk: w.trk, store: r.store || w.parcel.store || null, order: r.order || w.parcel.order || null,
          each: r.each != null && r.each > 0 ? r.each : null, full: r.full ?? null, how: r.how || null,
          email_name: r.name || null, note: r.note || null, check: r.check === true, reason: r.each != null && r.each > 0 ? null : (r.reason || REASON_ORDER),
        });
      }
    }
    await finishCostEmailRun(runId, { status: 'done', rows, summary });
  } catch (e) {
    console.error('[cost-emails] run', runId, e.message);
    await finishCostEmailRun(runId, { status: 'failed', error: String(e.message || e).slice(0, 300) }).catch(() => {});
  }
}

/** A finished run whose preview came from older readers AND holds a price from a store they changed. */
export const runIsStale = (run) => Number(run?.summary?.v || 1) < READERS
  && Object.entries(run?.summary?.stores || {}).some(([k, v]) => REREAD_V1.test(k) && v?.priced > 0);

/**
 * Write a finished run's prices. Only a pair that STILL has no cost is filled (a cost typed
 * since the preview wins), each with a line in its history naming the store and the order.
 */
export async function applyCostEmailRun(runId, by) {
  const run = await getCostEmailRun(runId, { rows: true });
  if (!run) return { error: 'That run no longer exists.', status: 404 };
  if (run.status !== 'done') return { error: run.status === 'applied' ? 'These prices were already applied.' : 'This run has not finished.' };
  // A preview worked out by older readers must not be saved: 2026-11-26, Foot Locker / Champs
  // lines were read as one pair's price (3 pairs at $420 each) and discounts were missed.
  if (runIsStale(run)) return { error: 'This run was read before a fix to the Foot Locker / Champs / JD Sports prices. Read the emails again, then apply.' };
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
