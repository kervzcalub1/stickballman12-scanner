// Shoes on SHEIN → "Rejected by SHEIN" (`?tab=rejected`, 2026-11-17, stage 3). The owner: "user should be able to see
// the rejected products based on SHEIN status … so that we can manage to fix it … can a rejected product be fixed and
// resubmitted?" — yes: one row per shoe whose send from THIS page SHEIN refused (in its review, or at its pre-check),
// with SHEIN's own words, when, what was rejected, the sizes, live or never accepted, stock, and ONE button: the real
// next step (`next` from GET /api/shein/listings?rejected=1 — src/lib/sheinRejected.js). Every button previews (reads
// only); Publish again is admin / Connect integrations; the send after a preview is confirmed on the sheet.
// A tab, not a tile: a tile is a STATUS (tile number = its list, the tiles add up to All) — a rejected shoe can be in
// Error, Blocked or even Synced through its other sizes, and this list has its own columns and its own button per row.
// Search and brand are the list's own ?q= / ?brand= (the Shoes tab's, so switching keeps them).
import React, { useEffect, useRef, useState } from 'react';
import { CopyText, RemoteThumb } from '../components/common.jsx';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { plain } from '../lib/sheinWords.js';
import { fmt, when, ActNote, REJECTION_PREVIEW_OPS, NEEDS_PRIV } from '../components/SheinListingsBits.jsx';
import { FilterChips, useSearchBox } from './SheinListingsProducts.jsx';

const plural = (n, w, many = `${w}s`) => `${fmt(n)} ${n === 1 ? w : many}`;
const WHO = { admin_or_connect_integrations: 'an admin (or the Connect integrations privilege)', ph_team: 'anyone on the PH team' };

function RejectedRow({ r, canWrite, active, busy, onAct, onDryRun, onOpen }) {
  const n = r.next || {};
  const where = `rej:${r.productId}`;
  const running = active ? `Job #${active.id} is running — try again when it finishes` : '';
  async function press() {
    if (n.action === 'publish_again') {
      if (await onAct('publish_again', { productIds: [r.productId] }, 'Publish again allowed — check the new preview, then publish.', where)) onDryRun([r.productId], ['publish'], where);
      return;
    }
    const ops = n.action === 'preview_add_sizes' ? undefined : (n.ops || REJECTION_PREVIEW_OPS[n.action] || undefined);
    onDryRun([r.productId], ops, where);
  }
  const blocked = !n.canPress;
  const others = (r.rejections || []).slice(1);
  return (
    <div className="shl-rej" data-rejected={r.productId} data-next={n.action || 'none'}>
      <RemoteThumb src={r.imageUrl} className="ebl-thumb shl-thumb" />
      <div className="shl-rej-main">
        <span className="shl-pname">{r.title || '(no title)'}</span>
        <span className="shl-pmeta">
          {r.style && <CopyText className="shl-mono" text={r.style}>{r.style}</CopyText>}
          {r.vendor && <span>{r.vendor}</span>}
          {r.shopifyUrl && <a className="ebl-link" href={r.shopifyUrl} target="_blank" rel="noreferrer">Shopify ↗</a>}
          {r.live
            ? <span className="ebo-chip ok" title="SHEIN sells this shoe — what it rejected was a later change">Live on SHEIN</span>
            : <span className="ebo-chip warn" title="SHEIN never accepted this shoe — it isn’t for sale on SHEIN">Never accepted by SHEIN</span>}
        </span>
        <span className="shl-rej-what">
          <span className="ebo-chip bad">{r.whatLabel || 'A change'} rejected</span>
          <span className="muted xs">{when(r.at)}{r.jobId ? ` · send #${r.jobId}` : ''}{r.sizes ? ` · ${plural(r.sizes, 'size')}${r.sizeNames?.length ? ` (${r.sizeNames.slice(0, 8).join(', ')}${r.sizeNames.length > 8 ? '…' : ''})` : ''}` : ''}</span>
        </span>
        <span className="shl-rej-reason" data-reason="">SHEIN said: “{r.reason || 'no reason given'}”{r.module ? <span className="muted xs"> · {r.module}</span> : null}</span>
        <span className="muted xs">Stock on Shopify: {plural(r.stock?.pairs || 0, 'pair')} in {fmt(r.stock?.sizesInStock || 0)} of {plural(r.stock?.sizes || 0, 'size')}</span>
        {n.say && <span className="xs shl-rej-say">{n.say}</span>}
        {r.publishAgain && <span className="muted xs">Publish again pressed {when(r.publishAgain.at)}{r.publishAgain.by ? ` by ${r.publishAgain.by}` : ''}.</span>}
        {others.length > 0 && (
          <span className="muted xs">Also rejected: {others.map((o) => `${o.whatLabel || o.what}${o.reason ? ` (“${o.reason}”)` : ''}`).join(' · ')}</span>
        )}
        <ActNote where={where} />
      </div>
      <div className="shl-rej-acts">
        {n.action ? (
          <button type="button" className="btn primary sm" data-rej-next={n.action} disabled={blocked || !!busy || !!active}
            title={blocked ? `${n.say || ''} ${NEEDS_PRIV}.`.trim() : running || `${n.say || ''} The preview reads only — nothing is sent until someone confirms it.`.trim()}
            onClick={press}>{busy === 'preview' || busy === 'publish_again' ? 'Starting…' : n.label}</button>
        ) : null}
        {n.fixFirst === 'photos' && <button type="button" className="btn ghost sm" data-rej-photos="" onClick={() => onOpen(r.productId, 'photos')}>Fix photos</button>}
        <button type="button" className="btn ghost sm" data-rej-details="" onClick={() => onOpen(r.productId)}>Details</button>
        {blocked && n.action && <span className="muted xs shl-rej-who" data-rej-who="">{canWrite ? '' : `Only ${WHO[n.who] || 'an admin'} can press ${n.label}.`}</span>}
      </div>
    </div>
  );
}

export function SheinListingsRejected({ q, setQ, brand, setBrand, brands = [], canWrite, active, busy, onAct, onDryRun, onOpen, onSignOut }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [text, setText] = useSearchBox(q, setQ);
  const seq = useRef(0);
  async function load() {
    const mine = ++seq.current;
    try {
      const r = await api.sheinListingsRejected({ q, brand });
      if (mine === seq.current) { setD(r); setErr(''); }
    } catch (e) { if (e.unauthorized) onSignOut(); else if (mine === seq.current) setErr(plain(e.message)); }
  }
  useEffect(() => { load(); }, [q, brand]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(['shein_listing_products', 'shein_listing_variants', 'shein_listing_job_items'], load, { mount: false });
  const rows = d?.rows || [];
  const chips = [
    q && { key: 'q', label: `Search: “${q}”`, off: () => { setText(''); setQ(''); } },
    brand && { key: 'brand', label: `Brand: ${brand}`, off: () => setBrand('') },
  ].filter(Boolean);
  const clear = () => { setText(''); setQ(''); setBrand(''); };
  const brandList = [...new Set([...brands.map((b) => b.brand), ...rows.map((r) => r.vendor).filter(Boolean)])];

  return (
    <div className="card shl-rejected" data-rejected-view="">
      <h3 className="er-step-title">Rejected by SHEIN</h3>
      <p className="sm shl-rej-lead">These were sent from this page and SHEIN refused them — in its review, or at its pre-check. <b>Yes, each one can be fixed and sent again:</b> fix what SHEIN names (Details has the photos, SHEIN details, category and title), then press the button on its row. It previews the same change again; once someone who can send confirms it, SHEIN reviews it again.</p>
      <p className="muted xs shl-rej-limit">Shoes SHEIN rejected that were sent by another tool (4seller, Seller Center) can’t be listed here — SHEIN’s API doesn’t give us its list of rejected products.</p>
      <div className="ebl-filters shl-filters">
        <input type="search" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, style code, SKU or SHEIN code…" aria-label="Search rejected shoes" />
        <select className="input shl-select" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
          <option value="">All brands</option>
          {brandList.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>
      <FilterChips chips={chips} onClearAll={clear} />
      {err && (
        <div className="shl-state">
          <p className="error sm">Couldn’t load the rejected shoes: {err}</p>
          <button type="button" className="btn ghost sm" onClick={load}>Try again</button>
        </div>
      )}
      {!d && !err && [0, 1, 2].map((i) => <div key={i} className="shl-skel shl-skel-row" />)}
      {d && (
        <p className="muted xs shl-listhead-say" data-list-head="">{rows.length ? `${plural(rows.length, 'shoe')} — newest rejection first.` : ''}</p>
      )}
      {d && !rows.length && (
        <div className="empty-state" data-empty="">
          {chips.length
            ? <>No rejected shoe matches{q ? <> “<b>{q}</b>”</> : ''}{brand ? ` in ${brand}` : ''}.<div className="mt"><button type="button" className="btn ghost sm" onClick={clear}>Clear all filters</button></div></>
            : <>Nothing SHEIN rejected is waiting. When SHEIN refuses something sent from here, it shows up here with SHEIN’s reason and the button that sends it again.</>}
        </div>
      )}
      {rows.map((r) => <RejectedRow key={r.productId} r={r} canWrite={canWrite} active={active} busy={busy} onAct={onAct} onDryRun={onDryRun} onOpen={onOpen} />)}
    </div>
  );
}
