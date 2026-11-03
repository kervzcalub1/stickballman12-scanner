// Inventory's "Check Shopify" (docs/context/inventory.md): a button on a SKU row or a
// scanned pair that reads Shopify LIVE and lists what it holds — each product carrying the
// style, every size's quantity and price. Shopify's numbers only; read-only.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { PH_DATETIME } from '../lib/format.js';
import { sizeKey } from '../lib/shopifyCheck.js';

export function ShopifyCheckButton({ sku, size = null, label = 'Check Shopify', className = '' }) {
  const [open, setOpen] = useState(false);
  if (!sku) return null;
  return (
    <>
      <button type="button" className={`btn ghost sm shopchk-btn ${className}`}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title={`Read Shopify live for ${sku}${size ? ` (size ${size})` : ''}`}>🛍 {label}</button>
      {open && <ShopifyCheckModal sku={sku} size={size} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ShopifyCheckModal({ sku, size, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    setBusy(true); setErr('');
    try { setData(await api.shopifyCheck(sku)); } catch (e) { setErr(e.message || 'The Shopify check failed.'); }
    setBusy(false);
  }, [sku]);
  useEffect(() => { run(); }, [run]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const products = data?.products || [];
  const total = products.filter((p) => p.status === 'ACTIVE').reduce((n, p) => n + p.total, 0);
  const mine = size ? sizeKey(size) : null;
  return (
    <div className="modal-overlay" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal shopchk-modal" role="dialog" aria-modal="true" aria-label={`Shopify check for ${sku}`} onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">On Shopify · {sku}</h3>
        {busy && !data && <p className="muted">Reading Shopify…</p>}
        {(err || data?.error) && <p className="shopchk-err">Couldn’t read Shopify: {err || data.error}. This is not a “none on Shopify” — try again.</p>}
        {data && !data.error && (
          <>
            <p className="muted sm">
              Live from Shopify at {PH_DATETIME.format(new Date(data.checkedAt))} EST
              {products.length ? ` · ${total} in stock on active listings` : ''}
            </p>
            {!products.length && <p className="shopchk-none">Shopify holds nothing for {sku} — no product carries it.</p>}
            {products.map((p, i) => (
              <section key={i} className="shopchk-product">
                <div className="shopchk-ptitle">
                  {p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a> : p.title}
                  {p.status && p.status !== 'ACTIVE' && <span className="shopchk-pstatus"> · {p.status.toLowerCase()} (not for sale)</span>}
                  <span className="muted sm"> · {p.total} in stock</span>
                </div>
                <table className="shopchk-table">
                  <thead><tr><th>Size</th><th>Qty</th><th>Price</th></tr></thead>
                  <tbody>
                    {p.sizes.map((z, j) => (
                      <tr key={j} className={`${z.qty > 0 ? '' : 'shopchk-zero'}${mine && sizeKey(z.size) === mine ? ' mine' : ''}`}>
                        <td><b>{z.size}</b></td>
                        <td>{z.qty == null ? '—' : z.qty}</td>
                        <td>{z.price != null ? `$${Number(z.price).toFixed(2)}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" disabled={busy} onClick={run}>{busy ? 'Checking…' : 'Check again'}</button>
          <button type="button" className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
