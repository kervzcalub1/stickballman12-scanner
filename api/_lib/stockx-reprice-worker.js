// StockX Reprice — the worker that SENDS queued price changes (docs/context/stockx-reprice.md).
//
// Every 5 s: up to 10 `queued` rows → PATCH /selling/listings/{id} (price only) → `sent` with
// StockX's operation id; then up to 25 `sent` rows → read the operation: SUCCEEDED → `done` (and
// the listing's stored ask follows), FAILED → `failed` with StockX's reason; still pending after
// 10 min → read the listing itself and judge by its amount. A 429 stops the pass (the shared
// queue in stockx.js already waits and retries). Rows live in the database, so a run picks up
// where it left off after a restart. Every StockX call here is on the one shared pace.
//
// ON wherever StockX is configured, OFF with STOCKX_REPRICE_WORKER=off — the test server sets
// that, because dev and prod share ONE StockX account and a test must never change a live price.
// Two environments never double-send: each only works the rows in its own database.
import { nextStockxEdits, markStockxEdit, setStockxListingAmount } from './db.js';
import { stockxConfigured, stockxUpdateListing, stockxListingOperation, stockxGetListing, stockxError } from './stockx.js';

const EVERY_MS = 5000;
const STUCK_MS = 10 * 60_000;
let busy = false;
let started = false;
const tooMany = (r) => r?.status === 429 || /too many/i.test(String(stockxError(r)));

async function sendQueued() {
  for (const e of await nextStockxEdits('queued', 10)) {
    const r = await stockxUpdateListing(e.listing_id, Number(e.new_amount));
    if (tooMany(r)) return;
    if (!r.ok) { await markStockxEdit(e.id, { status: 'failed', error: stockxError(r) }); continue; }
    await markStockxEdit(e.id, { status: 'sent', operationId: r.data?.operationId || null });
  }
}

async function confirmSent() {
  for (const e of await nextStockxEdits('sent', 25)) {
    const stuck = e.sent_at && Date.now() - new Date(e.sent_at).getTime() > STUCK_MS;
    if (e.operation_id && !stuck) {
      const op = await stockxListingOperation(e.listing_id, e.operation_id);
      if (tooMany(op)) return;
      const st = op.ok ? op.data?.operationStatus : null;
      if (st === 'PENDING' || (!op.ok && !stuck)) continue;
      if (st === 'FAILED') { await markStockxEdit(e.id, { status: 'failed', error: op.data?.error || 'StockX refused the change.' }); continue; }
      if (st === 'SUCCEEDED') { await markStockxEdit(e.id, { status: 'done' }); await setStockxListingAmount(e.listing_id, e.new_amount); continue; }
    }
    // No operation id, or StockX never answered: the listing itself is the truth.
    const l = await stockxGetListing(e.listing_id);
    if (tooMany(l)) return;
    const amt = Number(l.data?.amount);
    if (l.ok && amt === Number(e.new_amount)) { await markStockxEdit(e.id, { status: 'done' }); await setStockxListingAmount(e.listing_id, e.new_amount); }
    else if (stuck) await markStockxEdit(e.id, { status: 'failed', error: l.ok ? `StockX still shows $${l.data?.amount}` : stockxError(l) });
  }
}

export async function stockxRepriceTick() {
  if (busy) return;
  busy = true;
  try { await sendQueued(); await confirmSent(); }
  catch (e) { console.error('[stockx-reprice]', e.message); }
  finally { busy = false; }
}

export function startStockxRepriceWorker() {
  if (started) return;
  if (String(process.env.STOCKX_REPRICE_WORKER || '').toLowerCase() === 'off') { console.log('[stockx-reprice] worker off (STOCKX_REPRICE_WORKER=off)'); return; }
  if (!stockxConfigured()) { console.log('[stockx-reprice] StockX not configured — worker idle'); return; }
  started = true;
  setInterval(stockxRepriceTick, EVERY_MS).unref?.();
  console.log('[stockx-reprice] worker on');
}
