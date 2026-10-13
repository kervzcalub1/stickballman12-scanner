// eBay → Sales report (docs/context/ebay-orders.md). Pick a period (year to date by
// default, a month, last month, or any range) → the statement for it: sales, eBay fees,
// refunds, labels and other charges, net, month by month — with eBay's OWN totals next to
// ours — and three CSVs: sales by order line, every transaction, the monthly summary.
// Admin only (it's the company's money).
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { estToday, estDate, PH_DATETIME } from '../lib/format.js';
import { downloadCSV } from '../lib/csv.js';
import { summarize, salesCsv, transactionsCsv, summaryCsv, TYPE_LABEL, cents } from '../lib/ebayOrders.js';

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const usd = (c) => `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso) => (iso ? `${PH_DATETIME.format(new Date(iso))} EST` : '—');
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthName = (ym) => MONTH.format(new Date(`${ym}-15T12:00:00Z`));

// The period a preset means, as EST days [from, to].
export function periodFor(preset, today, month, custom) {
  const ym = today.slice(0, 7);
  if (preset === 'ytd') return [`${today.slice(0, 4)}-01-01`, today];
  if (preset === 'this_month') return [`${ym}-01`, today];
  if (preset === 'last_month') { const prev = addDays(`${ym}-01`, -1).slice(0, 7); return [`${prev}-01`, monthEnd(prev)]; }
  if (preset === 'last_year') { const y = Number(today.slice(0, 4)) - 1; return [`${y}-01-01`, `${y}-12-31`]; }
  if (preset === 'month' && /^\d{4}-\d{2}$/.test(month || '')) { const end = monthEnd(month); return [`${month}-01`, end > today ? today : end]; }
  if (preset === 'custom') return [custom.from, custom.to];
  return [`${today.slice(0, 4)}-01-01`, today];
}

export function EbaySalesReport({ isAdmin, onSignOut, onConnect }) {
  const today = estToday();
  const [preset, setPreset] = useState('ytd');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [custom, setCustom] = useState({ from: `${today.slice(0, 4)}-01-01`, to: today });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [from, to] = periodFor(preset, today, month, custom);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from || '') && /^\d{4}-\d{2}-\d{2}$/.test(to || '') && from <= to;

  async function load() {
    if (!valid) return;
    setLoading(true); setErr('');
    try { setData(await api.ebaySalesReport(from, to)); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load older orders + money from eBay for this period, then rebuild.
  async function backfill() {
    setSyncing(true); setErr('');
    try {
      await api.ebayOrdersSync(from);
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = (await api.ebayOrders(today, today)).sync;
        if (s?.state !== 'running') { if (s?.state === 'failed') setErr(s.error); break; }
      }
      await load();
    } catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setSyncing(false); }
  }

  const sum = useMemo(() => (data ? summarize(data.transactions) : null), [data]);
  const saleByOrder = useMemo(() => Object.fromEntries((data?.transactions || []).filter((t) => t.transaction_type === 'SALE' && t.order_id).map((t) => [t.order_id, t])), [data]);
  const items = useMemo(() => (data?.orders || []).filter((o) => o.cancel_state !== 'CANCELED').reduce((n, o) => n + (o.lines || []).reduce((m, l) => m + Number(l.qty || 0), 0), 0), [data]);
  const covered = data?.coverage?.from ? estDate(data.coverage.from) : null;
  const gap = data && (!covered || covered > from);
  const name = `eBay ${from} to ${to}`;
  const es = data?.ebaySummary;

  if (!isAdmin) return <div className="card"><p className="muted">The sales report is for admins.</p></div>;
  return (
    <>
      <div className="card">
        <h3 className="er-step-title">Sales report</h3>
        <div className="ebs-period">
          <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Period">
            <option value="ytd">Year to date ({today.slice(0, 4)})</option>
            <option value="this_month">This month</option>
            <option value="last_month">Last month</option>
            <option value="month">Pick a month…</option>
            <option value="last_year">Last year</option>
            <option value="custom">Custom dates…</option>
          </select>
          {preset === 'month' && <input type="month" className="input" value={month} max={today.slice(0, 7)} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />}
          {preset === 'custom' && (
            <>
              <input type="date" className="input" value={custom.from} max={today} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} aria-label="From" />
              <input type="date" className="input" value={custom.to} max={today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} aria-label="To" />
            </>
          )}
          <span className="muted sm">{valid ? `${from} → ${to} (EST)` : 'Pick a from and to date.'}</span>
        </div>
        {err && <div className="error mt">{err}</div>}
        {data && !data.canFinances && (
          <p className="sm mt"><b>Sales & fees need one more eBay permission.</b> {isAdmin && <button type="button" className="btn sm primary" onClick={onConnect}>Connect eBay again</button>}</p>
        )}
        {data && gap && (
          <div className="notice mt">
            {covered ? <>Orders and money are loaded from <b>{covered}</b> on — this period starts earlier.</> : <>Nothing is loaded from eBay yet.</>}
            {' '}<button type="button" className="btn sm" disabled={syncing} onClick={backfill}>{syncing ? 'Loading from eBay…' : `Load from ${from}`}</button>
          </div>
        )}
        {data?.coverage?.financeError && <p className="error xs mt">Last sync couldn’t read the money side: {data.coverage.financeError}</p>}
        {data?.coverage?.lastSync && <p className="muted xs mt">Data as of {when(data.coverage.lastSync)}.</p>}
      </div>

      {loading && !data && <p className="muted">Loading…</p>}
      {sum && (
        <>
          <div className="card">
            <div className="er-stats">
              <div className="er-stat"><b>{fmt(sum.sales)}</b><span>orders sold</span></div>
              <div className="er-stat"><b>{fmt(items)}</b><span>pairs</span></div>
              <div className="er-stat"><b>{usd(sum.gross)}</b><span>gross sales (items + shipping)</span></div>
              <div className="er-stat"><b>{usd(-sum.fees)}</b><span>eBay selling fees</span></div>
              <div className="er-stat"><b>{usd(Object.values(sum.months).reduce((n, m) => n + m.refunds, 0))}</b><span>refunds</span></div>
              <div className="er-stat"><b>{usd(Object.values(sum.months).reduce((n, m) => n + m.other, 0))}</b><span>labels, ads & other</span></div>
              <div className="er-stat ok"><b>{usd(sum.net)}</b><span>net to you</span></div>
            </div>
            <p className="muted xs">From eBay’s money records (Finances API), by the date eBay booked each one. Sales tax eBay collects and remits is never counted as yours. Payouts to the bank aren’t income, so they’re left out.</p>
            <div className="er-actions">
              <button type="button" className="btn primary" disabled={!data.orders.length} onClick={() => downloadCSV(`${name} - sales by order.csv`, salesCsv(data.orders, saleByOrder))}>⬇ Sales by order (CSV)</button>
              <button type="button" className="btn" disabled={!data.transactions.length} onClick={() => downloadCSV(`${name} - statement.csv`, transactionsCsv(data.transactions))}>⬇ Statement — every transaction (CSV)</button>
              <button type="button" className="btn" disabled={!data.transactions.length} onClick={() => downloadCSV(`${name} - monthly summary.csv`, summaryCsv(sum))}>⬇ Monthly summary (CSV)</button>
            </div>
          </div>

          {Object.keys(sum.months).length > 0 && (
            <div className="card">
              <h4>By month</h4>
              <div className="ap-tablewrap">
                <table className="table ebl-table">
                  <thead><tr><th>Month</th><th className="num">Orders</th><th className="num">Gross</th><th className="num">Fees</th><th className="num">Refunds</th><th className="num">Other</th><th className="num">Net</th></tr></thead>
                  <tbody>
                    {Object.keys(sum.months).sort().map((m) => { const x = sum.months[m]; return (
                      <tr key={m}><td>{monthName(m)}</td><td className="num">{fmt(x.sales)}</td><td className="num">{usd(x.gross)}</td><td className="num">{usd(-x.fees)}</td>
                        <td className="num">{usd(x.refunds)}</td><td className="num">{usd(x.other)}</td><td className="num"><b>{usd(x.net)}</b></td></tr>
                    ); })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card">
            <h4>By type</h4>
            <div className="ap-tablewrap">
              <table className="table ebl-table">
                <thead><tr><th>Type</th><th className="num">Count</th><th className="num">Ours</th>{es && <th className="num">eBay’s total</th>}</tr></thead>
                <tbody>
                  {Object.entries(sum.byType).sort((a, b) => b[1].cents - a[1].cents).map(([type, t]) => (
                    <tr key={type}><td>{TYPE_LABEL[type] || type}</td><td className="num">{fmt(t.count)}</td><td className="num">{usd(t.cents)}</td>
                      {es && <td className="num muted">{ebayTotal(es, type)}</td>}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.ebaySummaryError && <p className="muted xs">eBay’s own totals unavailable: {data.ebaySummaryError}</p>}
            {es && <p className="muted xs">“eBay’s total” is eBay’s own summary for the same dates — it should match ours once everything is loaded. eBay groups sales with credits.</p>}
          </div>
        </>
      )}
    </>
  );
}

// eBay's transaction_summary field for a type, signed the way we sign it.
const SUMMARY_FIELD = { SALE: 'credit', CREDIT: 'credit', REFUND: 'refund', SHIPPING_LABEL: 'shippingLabel', NON_SALE_CHARGE: 'nonSaleCharge',
  DISPUTE: 'dispute', ADJUSTMENT: 'adjustment', TRANSFER: 'transfer', WITHDRAWAL: 'withdrawal', LOAN_REPAYMENT: 'loanRepayment', PURCHASE: 'purchase' };
function ebayTotal(es, type) {
  const f = SUMMARY_FIELD[type];
  if (!f || !es[`${f}Amount`]) return '—';
  const c = cents(es[`${f}Amount`]) * (es[`${f}BookingEntry`] === 'DEBIT' ? -1 : 1);
  return `${usd(c)}${type === 'SALE' || type === 'CREDIT' ? ' (sales + credits)' : ''}`;
}
