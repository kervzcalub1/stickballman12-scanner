// HOW FAST A SIZE SELLS ON THE MARKET — for the approver deciding a buying request
// (docs/context/buy-cart.md "Market sales per size"). Alex asked for what StockX's Sales
// tab shows: how many sold, the average / high / low, and the last few sales.
//
// From Alias (GOAT) recent sales, NOT StockX: the sanctioned StockX API has no sales
// history at all (docs/context/integrations.md), and the gateway that does is off-limits.
// Our own Shopify velocity is a different question (how fast WE sell) and stays where
// it is (`liquidity`).
//
// Best-effort everywhere: null = we couldn't read it, never "no sales".
import { aliasCatalogBySku, aliasRecentSales } from './alias.js';
import { primarySku } from './util.js';
import { PH_DATE } from '../../src/lib/format.js';

const DAY = 86_400_000;
const CATALOG_TTL = 12 * 3600_000;
const SALES_TTL = 10 * 60_000;
const catalogCache = new Map();   // sku → { at, id }
const salesCache = new Map();     // catalogId|size → { at, summary }

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Pure: the Sales-tab summary of a list of sales (newest first). `now` is passed in —
 * a defaulted Date.now() deep in a pure function is how a pinned test goes wrong.
 * `capped` = the API returned its maximum and the oldest is still inside 30 days, so
 * the 30-day count is a floor ("200+"), not the count.
 */
export function summarizeSales(sales, { now, limit = 200 } = {}) {
  const list = (sales || []).filter((s) => s && Number(s.price) > 0 && s.at);
  const t = (s) => new Date(s.at).getTime();
  const in30 = list.filter((s) => now - t(s) <= 30 * DAY);
  const in7 = in30.filter((s) => now - t(s) <= 7 * DAY);
  const prices = in30.map((s) => Number(s.price));
  const oldest = list.length ? list[list.length - 1].at : null;
  return {
    source: 'alias',
    sold_7d: in7.length,
    sold_30d: in30.length,
    capped: list.length >= limit && oldest != null && now - new Date(oldest).getTime() <= 30 * DAY,
    avg_30d: prices.length ? round2(prices.reduce((a, b) => a + b, 0) / prices.length) : null,
    high_30d: prices.length ? Math.max(...prices) : null,
    low_30d: prices.length ? Math.min(...prices) : null,
    // The newest few, whatever their age — a shoe with nothing in 30 days still has a
    // last sale, and "last sold in August" is itself the answer.
    last: list.slice(0, 5).map((s) => ({ at: s.at, price: Number(s.price) })),
    read_at: new Date(now).toISOString(),
  };
}

async function catalogIdFor(sku) {
  const key = primarySku(sku).toUpperCase();
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL) return hit.id;
  const c = await aliasCatalogBySku(key);
  catalogCache.set(key, { at: Date.now(), id: c?.catalogId || null });
  return c?.catalogId || null;
}

/** The summary for one style + size, or null when Alias couldn't answer. */
export async function readMarketSales({ sku, size }) {
  if (!sku || size == null || String(size).trim() === '') return null;
  try {
    const catalogId = await catalogIdFor(sku);
    if (!catalogId) return null;
    const key = `${catalogId}|${String(size).trim().toLowerCase()}`;
    const hit = salesCache.get(key);
    if (hit && Date.now() - hit.at < SALES_TTL) return hit.summary;
    const sales = await aliasRecentSales({ catalogId, size });
    if (!sales) return null;
    const summary = { ...summarizeSales(sales, { now: Date.now() }), catalog_id: catalogId, size: String(size) };
    salesCache.set(key, { at: Date.now(), summary });
    return summary;
  } catch (e) {
    console.warn(`[marketSales] ${sku}/${size} — could not read recent sales:`, e.message);
    return null;
  }
}

/** One line on a Telegram card: "18 sold in 30 days (5 this week) · avg $259 · $236–$326". */
export function salesSentence(s) {
  if (!s) return null;
  const d = (n) => `$${Number(n).toFixed(0)}`;
  if (!s.sold_30d) {
    const last = s.last?.[0];
    return last ? `No sales in 30 days · last ${d(last.price)} on ${PH_DATE.format(new Date(last.at))} EST` : 'No recent sales';
  }
  return `${s.sold_30d}${s.capped ? '+' : ''} sold in 30 days (${s.sold_7d} this week) · avg ${d(s.avg_30d)}`
    + `${s.high_30d !== s.low_30d ? ` · ${d(s.low_30d)}–${d(s.high_30d)}` : ''}`;
}
