// SHEIN Listings — the dry run → confirm → progress sheet (docs/shein-listings-plan.md Appendix C,
// docs/context/shein-listings.md → "Phase 2"). Not a Modal: a full-height sheet that shows ONE
// server job and follows it live.
//   · a dry run (kind 'preview') while it runs: progress. Then the REVIEW: totals from the job's
//     counts (with the "0 SHEIN writes" proof), one line per product from the server's `summary`,
//     expandable to the plan (our size → SHEIN size, seller SKU, price + where it came from,
//     stock 0; SKUs SHEIN has wrong; skipped sizes with their blocker); the exact request for
//     admins only. Confirm ("Add sizes to N products") carries the dry-run id — admin or Connect
//     integrations only (others see it disabled with the reason).
//   · a send (kind 'run'): the same sheet becomes the job card — progress, per-product status,
//     SHEIN's words verbatim, Retry (no answer), Dry run again (Shopify changed / SHEIN refused),
//     Stop. The job runs on the server: closing the sheet or the tab never stops it.
// Phase 3 ("Update prices & sizes", ops price + edit): one item per product per op, shown next to
// each other with an op tag. A price plan renders SHEIN now → will be, ↑ rises flagged "SHEIN may
// review it", where the price came from, the special price kept; an edit plan renders sizes turned
// back on, SKUs SHEIN has wrong, the title (only on a product we published). After the send, each
// size's price/save answer (sku_codes: approved / in review / refused). Confirm: "Update N products".
// Phase 4 ("Publish new products", op publish, alone): one item per product — the title, the SHEIN
// category path, brand, colour, box, the photos SHEIN will show (converted count), sizes (SHEIN size /
// custom), prices, the quota it uses; a product that can't go yet lists its ✕ checklist lines
// ("Can't publish yet: …"). Proof: "0 SHEIN writes · n photos converted". Confirm "Publish N
// products" (admin / Connect integrations). Sent: In review → Approved, or Rejected with SHEIN's
// reason and "Publish again" (admin / Connect integrations).
// `DryRunView` is the content (also used inline by the Jobs tab's `?job=`); `DryRunSheet` the overlay.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useLive } from '../hooks.js';
import { ProgressBar, RemoteThumb } from './common.jsx';
import { renderBlocker, itemStatus, itemRetryable, itemUnconfirmed, itemCanSendAgain, PRICE_FROM, ITEM_NO_ANSWER, OP_LABEL, OP_SAY, PRICE_CODE, isUpdateOps, isPublishOps, PUBLISH_WORD } from '../lib/sheinListings.js';
import { GROUP_LABEL, BOX_LABEL } from './SheinPublishBits.jsx';
import { cmToIn, gToLb } from '../lib/sheinPublish.js';
import { fmt, money, when, NEEDS_PRIV } from './SheinListingsBits.jsx';

const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const sentAs = (job) => Number(/sent as job #(\d+)/.exec(job?.phase || '')?.[1]) || null;
const AUTO_BY = 'auto (price re-sync)';
const distinct = (list) => new Set(list.map((i) => i.shopify_product_id)).size;

// Phase 3 price plan: SHEIN now → will be, per size. After the send, `codes` = the item's sku_codes.
function PriceTable({ plan, codes }) {
  const prices = plan?.prices || [];
  if (!prices.length) return null;
  const answer = new Map((codes || []).map((c) => [`${c.skuCode}|${c.site || ''}`, c]));
  const find = (x) => answer.get(`${x.skuCode}|${x.site || ''}`) || (codes || []).find((c) => String(c.skuCode) === String(x.skuCode));
  return (
    <table className="shl-rtable shl-plan" data-plan="price">
      <thead><tr><th>Size</th><th className="num">SHEIN now</th><th className="num">Will be</th><th>Where the price came from</th>{codes ? <th>SHEIN</th> : null}</tr></thead>
      <tbody>
        {prices.map((x) => {
          const c = codes ? find(x) : null;
          const st = c ? PRICE_CODE[Number(c.status)] || { label: `status ${c.status}`, chip: 'ebo-chip' } : null;
          return (
            <tr key={`${x.skuCode}|${x.site}`} className="shl-chg" data-size={x.size}>
              <td data-label="Size"><b>{x.size}</b>{x.endsSpecial != null ? <span className="muted xs shl-block">ends the {money(x.endsSpecial)} special</span> : null}{x.capped ? <span className="muted xs shl-block">capped: 15 % a day, never below Shopify</span> : null}</td>
              <td data-label="SHEIN now" className="num"><span className="shl-was">{money(x.from)}</span></td>
              <td data-label="Will be" className="num"><span><b>{money(x.to)}</b>{x.rise
                ? <span className="shl-rise xs shl-block">↑ up — SHEIN may review it</span>
                : <span className="muted xs shl-block">↓ down — applies at once</span>}</span></td>
              <td data-label="Price from"><span className="xs">{PRICE_FROM[x.priceFrom] || x.priceFrom || '—'}</span></td>
              {codes ? <td data-label="SHEIN">{st ? <span><span className={st.chip}>{st.label}</span>{c.reason ? <span className="shl-bad-text xs shl-block">SHEIN said: “{c.reason}”</span> : null}</span> : <span className="muted xs">not answered yet</span>}</td> : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SizesTable({ plan }) {
  const sizes = plan?.sizes || [];
  if (!sizes.length) return null;
  return (
    <table className="shl-rtable shl-plan">
      <thead><tr><th>Our size</th><th>SHEIN size</th><th>Seller SKU</th><th className="num">Price</th><th className="num">Stock</th></tr></thead>
      <tbody>
        {sizes.map((z) => (
          <tr key={z.variantId || z.sku} className="shl-chg">
            <td data-label="Our size"><b>{z.size}</b></td>
            <td data-label="SHEIN size"><span>
              {z.kind === 'custom'
                ? <>✚ <b>{z.sheinSize}</b> <span className="muted xs">custom size{z.isNew ? ' (new — created on SHEIN with this send)' : ' (already in the store)'}</span></>
                : <>✓ <b>{z.sheinSize}</b> <span className="muted xs">{z.customExisting ? 'custom size (already in the store)' : 'SHEIN size'}</span></>}
            </span></td>
            <td data-label="Seller SKU" className="shl-mono">{z.sku}</td>
            <td data-label="Price" className="num"><span><b>{money(z.price)}</b> <span className="muted xs shl-block">{PRICE_FROM[z.priceFrom] || z.priceFrom || ''}</span></span></td>
            <td data-label="Stock" className="num"><span>0 <span className="muted xs shl-block">the live sync sets it after approval</span></span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Phase 4: what a new product would go up as.
const IMG_TYPE = { 1: 'main', 2: 'detail', 5: 'square' };
function PublishPlan({ plan }) {
  const cant = (plan.checklist || []).filter((l) => l.ok === false);
  const sizes = plan.sizes || [];
  const ph = plan.photos || null;
  const imgs = plan.images || [];
  const q = plan.quota;
  return (
    <div data-plan="publish">
      {cant.length > 0 && (
        <div className="shl-d-sec" data-plan="cant">
          <h4 className="shl-h4">Can’t publish yet ({fmt(cant.length)} to fix)</h4>
          {cant.map((l) => (
            <p key={l.key} className="xs" data-line={l.key}><b>{l.label}:</b>{' '}
              {(l.blockers || []).filter((b) => !['note', 'review'].includes(b.level)).map((b, i) => <span key={i}><span className="shl-bad-text">{b.title}</span> {b.fix}{b.sheinSaid ? <span className="shl-shein-said">SHEIN said: “{b.sheinSaid}”</span> : null} </span>)}
            </p>
          ))}
          <p className="muted xs">Fix them in the product’s Details (each line has its button), then dry run again.</p>
        </div>
      )}
      <dl className="shl-facts">
        <dt>Title on SHEIN</dt><dd>{plan.title?.text ? <>“{plan.title.text}” <span className="muted xs">{fmt(plan.title.text.length)}{plan.title.max ? ` of ${fmt(plan.title.max)}` : ''} characters{plan.title.overridden ? ' · shortened for SHEIN by a person' : ''}</span></> : '—'}</dd>
        <dt>Category</dt><dd>{plan.category ? <>{plan.category.path || `#${plan.category.id}`} <span className="muted xs">#{plan.category.id}</span></> : <span className="shl-bad-text">none picked</span>}</dd>
        <dt>Brand</dt><dd>{plan.brand ? <>{plan.brand.name || plan.brand.code} <span className="muted xs">{plan.brand.code}</span></> : <span className="muted">none (allowed in this category)</span>}</dd>
        {plan.skcValue && <><dt>Colour</dt><dd>{plan.skcValue.label}</dd></>}
        {plan.sizeGroup && <><dt>Size group</dt><dd>{GROUP_LABEL[plan.sizeGroup] || plan.sizeGroup}</dd></>}
        {plan.box && <><dt>Box</dt><dd>{cmToIn(plan.box.length)} × {cmToIn(plan.box.width)} × {cmToIn(plan.box.height)} in · {gToLb(plan.box.weight)} lb <span className="muted xs">({BOX_LABEL[plan.box.group] || plan.box.group})</span></dd></>}
        {(plan.attributes || []).length > 0 && <><dt>SHEIN details</dt><dd>{fmt(new Set(plan.attributes.map((a) => a.attribute_id)).size)} set from the product type’s defaults</dd></>}
        {q && <><dt>Publish quota</dt><dd>{q.controlled ? <>uses {fmt(q.uses)} of {fmt(q.available)} left this month</> : 'not limited for the store'}</dd></>}
        {plan.supplierCode && <><dt>Our code on SHEIN</dt><dd className="shl-mono">{plan.supplierCode}</dd></>}
      </dl>
      {(imgs.length > 0 || ph) && (
        <div className="shl-d-sec" data-plan="photos">
          <h4 className="shl-h4">Photos{imgs.length ? ` (${fmt(imgs.length)})` : ''}</h4>
          {imgs.length > 0 && <div className="shl-pthumbs">{imgs.map((x) => <span key={x.image_sort} className="shl-pthumb-w"><RemoteThumb src={x.image_url} className="ebl-thumb shl-pthumb" alt={`${IMG_TYPE[x.image_type] || 'photo'} ${x.image_sort}`} /><span className="muted xs">{IMG_TYPE[x.image_type] || x.image_type}</span></span>)}</div>}
          {ph && <p className="muted xs" data-photos="">{fmt(ph.count)} source photo{ph.count === 1 ? '' : 's'} from {ph.source === 'ph_edited' ? 'the PH edited photos' : 'Shopify'} · {fmt(ph.converted)} converted for SHEIN in this dry run{ph.cached ? ` · ${fmt(ph.cached)} already converted earlier` : ''}. Padded to 1500 × 1500 on white, never cropped.</p>}
        </div>
      )}
      {sizes.length > 0 && (
        <table className="shl-rtable shl-plan" data-plan="sizes">
          <thead><tr><th>Our size</th><th>SHEIN size</th><th>Seller SKU</th><th className="num">Price</th><th className="num">Stock</th></tr></thead>
          <tbody>
            {sizes.map((z) => (
              <tr key={z.variantId || z.sku} className="shl-chg">
                <td data-label="Our size"><b>{z.size}</b></td>
                <td data-label="SHEIN size">{z.kind === 'custom' ? <>✚ <b>{z.sheinSize}</b> <span className="muted xs">Custom size</span></> : <>✓ <b>{z.sheinSize}</b> <span className="muted xs">SHEIN size</span></>}</td>
                <td data-label="Seller SKU" className="shl-mono">{z.sku}</td>
                <td data-label="Price" className="num"><span><b>{money(z.price)}</b> <span className="muted xs shl-block">{PRICE_FROM[z.priceFrom] || z.priceFrom || ''}</span></span></td>
                <td data-label="Stock" className="num"><span>0 <span className="muted xs shl-block">the live sync sets it after approval</span></span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// One product of the dry run / the send.
function ItemRow({ it, kind, isAdmin, canWrite, busy, onRetry, onDryRunAgain, onPublishAgain, onLookAgain, onSendAgain, onlyOne, isUpdate, sameAsAbove }) {
  const [open, setOpen] = useState(onlyOne);
  const isPub = it.op === 'publish';
  const rejected = isPub && kind === 'run' && it.status === 'failed' && (it.blockers || []).some((b) => b.code === 'review_rejected');
  const st0 = itemStatus(kind, it.status);
  const st = isPub ? { ...st0, label: rejected ? 'Rejected' : PUBLISH_WORD[kind === 'run' ? 'run' : 'preview'][it.status] || st0.label } : st0;
  const plan = it.plan || {};
  // a publish plan's blockers are shown as its ✕ checklist lines; only its notes are listed here
  const head = (isPub ? (plan.notes || []) : [...(plan.blockers || []), ...(plan.notes || [])]).map(renderBlocker);
  const skipped = plan.skipped || [];
  const relinks = plan.relinks || [];
  const mallOn = plan.mallOn || [];
  const titleChg = !isPub && plan.title && typeof plan.title === 'object' ? plan.title : null;
  const hasDetail = !!(isPub || plan.sizes?.length || plan.prices?.length || mallOn.length || titleChg || relinks.length || skipped.length || head.length || (isAdmin && it.body));
  // F1: a publish SHEIN didn't confirm is neither "refused" nor retryable — Look again / Send again
  const unconfirmed = kind === 'run' && itemUnconfirmed(it);
  const refused = kind === 'run' && it.status === 'failed' && !itemRetryable(it) && !unconfirmed;
  const noAnswer = kind === 'run' && it.status === 'failed' && !refused && !unconfirmed;
  const say = noAnswer ? ITEM_NO_ANSWER : rejected ? 'SHEIN rejected the new product in its review. Fix what SHEIN says, then an admin presses “Publish again” (it starts a new dry run first).' : (OP_SAY[it.op]?.[it.status] || st.say);
  const title = plan.productTitle || (typeof plan.title === 'string' ? plan.title : isPub ? plan.title?.text : null) || it.spu || it.shopify_product_id;
  const codes = kind === 'run' && it.op === 'price' && Array.isArray(it.sku_codes) && it.sku_codes.length ? it.sku_codes : null;
  return (
    <div className={`shl-ditem e-${st.tone}${sameAsAbove ? ' shl-ditem-cont' : ''}`} data-item={it.id} data-product={it.shopify_product_id} data-op={it.op || undefined}>
      <div className="shl-ditem-head">
        <span className="shl-ditem-name">
          {isUpdate && <span className="shl-optag">{OP_LABEL[it.op] || it.op}</span>}
          {sameAsAbove ? <span className="muted">{title}</span> : <b>{title}</b>}
          {it.spu && !sameAsAbove && <span className="muted xs"> · SHEIN SPU <span className="shl-mono">{it.spu}</span></span>}
        </span>
        <span className={st.chip}>{st.label}</span>
      </div>
      {it.summary && <p className="sm shl-ditem-sum">{it.summary}</p>}
      {kind === 'preview' && it.status === 'done' && plan.reviewOpen && (
        <p className="xs shl-pline violet">SHEIN is reviewing an earlier edit of this shoe. It is sent once that review closes (tried again every 30 min, by itself).</p>
      )}
      {kind === 'run' && say && <p className={`xs shl-pline ${st.tone}`}>{say}</p>}
      {kind === 'run' && it.error && it.status !== 'changed' && (
        <p className={`xs ${it.status === 'failed' ? 'shl-ditem-err' : 'muted shl-ditem-note'}`} data-said="">{refused ? <>SHEIN said: “{it.error}”</> : it.error}{it.trace_id ? <span className="muted"> · trace {it.trace_id}</span> : null}</p>
      )}
      {kind === 'run' && it.status === 'deferred' && it.next_attempt_at && !/try again at/.test(it.error || '') && <p className="muted xs">Next try {when(it.next_attempt_at)}{it.retries ? ` · ${plural(it.retries, 'try', 'tries')} so far` : ''}.</p>}
      {kind === 'run' && it.status === 'in_review' && it.sent_at && <p className="muted xs">Sent {when(it.sent_at)}{it.version ? ` · SHEIN version ${it.version}` : ''}.</p>}
      <div className="shl-ditem-acts">
        {hasDetail && <button type="button" className="shl-caret" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? '▾ Hide what is sent' : '▸ What is sent'}</button>}
        {kind === 'run' && itemRetryable(it) && (
          <button type="button" className="btn xs" disabled={!canWrite || busy} title={canWrite ? 'Send this product again now (it is looked up first, never sent twice)' : NEEDS_PRIV} onClick={() => onRetry(it)}>{it.status === 'deferred' ? 'Try now' : 'Retry'}</button>
        )}
        {unconfirmed && (
          <button type="button" className="btn xs shl-fix" data-act="look-again" disabled={busy} title="Looks for it on SHEIN (read-only) — never sends anything" onClick={() => onLookAgain?.(it)}>Look again</button>
        )}
        {unconfirmed && (
          <button type="button" className="btn xs" data-act="send-again" disabled={!canWrite || busy || !itemCanSendAgain(it)}
            title={!canWrite ? NEEDS_PRIV : itemCanSendAgain(it) ? 'Two looks found nothing on SHEIN — send it again' : 'Unlocks after a second Look again, at least 30 min after the send, finds nothing'}
            onClick={() => onSendAgain?.(it)}>Send again</button>
        )}
        {kind === 'run' && rejected && (
          <button type="button" className="btn xs shl-fix" disabled={!canWrite || busy} title={canWrite ? 'Lets this product go to SHEIN again, then starts a new dry run for you to check (SHEIN may still count the old SKUs)' : NEEDS_PRIV}
            onClick={() => onPublishAgain(it)}>Publish again</button>
        )}
        {kind === 'run' && !rejected && (it.status === 'changed' || refused) && (
          <button type="button" className="btn xs" disabled={busy} onClick={() => onDryRunAgain([it.shopify_product_id])}>Dry run again</button>
        )}
      </div>
      {open && hasDetail && (
        <div className="shl-ditem-body">
          {head.map((b, i) => <p key={i} className="xs"><b>{b.title}</b>{b.fix ? ` ${b.fix}` : ''}{b.sheinSaid ? <span className="shl-shein-said">SHEIN said: “{b.sheinSaid}”</span> : null}</p>)}
          {isPub ? <PublishPlan plan={plan} /> : <SizesTable plan={plan} />}
          <PriceTable plan={plan} codes={codes} />
          {mallOn.length > 0 && (
            <div className="shl-d-sec" data-plan="mall">
              <h4 className="shl-h4">Turned back on ({fmt(mallOn.length)})</h4>
              {mallOn.map((m) => <p key={m.skuCode} className="xs">Size <b>{m.size || '—'}</b>: <span className="shl-was">turned off on SHEIN</span> → will turn back on <span className="muted">(Shopify sells it)</span></p>)}
            </div>
          )}
          {titleChg && (
            <div className="shl-d-sec" data-plan="title">
              <h4 className="shl-h4">Title (we published this product)</h4>
              <p className="xs">Was <span className="shl-was">“{titleChg.from}”</span> → will change to <b>“{titleChg.to}”</b>{titleChg.cut ? <span className="muted"> (cut to SHEIN’s length limit)</span> : null}</p>
            </div>
          )}
          {relinks.length > 0 && (
            <div className="shl-d-sec">
              <h4 className="shl-h4">SKUs SHEIN has wrong (changed in the same send)</h4>
              {relinks.map((l) => <p key={l.skuCode} className="xs">Size {l.size || '—'}: SHEIN has the wrong SKU: <span className="shl-was shl-mono">{l.from || '—'}</span> → will change to <b className="shl-mono">{l.to}</b></p>)}
            </div>
          )}
          {skipped.length > 0 && (
            <div className="shl-d-sec">
              <h4 className="shl-h4">Not sent ({fmt(skipped.length)})</h4>
              {skipped.map((x, i) => { const b = renderBlocker(x.blocker); return <p key={i} className="xs"><b>{x.size || x.sku || '?'}</b> — <span className="shl-bad-text">{b.title}</span> {b.fix}</p>; })}
            </div>
          )}
          {isAdmin && it.body && (
            <details className="shl-raw">
              <summary className="xs">Exact request to SHEIN (admin)</summary>
              <pre className="shl-json">{JSON.stringify(it.body, null, 2)}</pre>
            </details>
          )}
          {isAdmin && it.response && kind === 'run' && (
            <details className="shl-raw">
              <summary className="xs">SHEIN’s answer (admin)</summary>
              <pre className="shl-json">{JSON.stringify(it.response, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export function DryRunView({ jobId, canWrite, isAdmin, onSwitch, onClose, onSignOut, inline = false }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  async function load() {
    try { setD(await api.sheinListingJob(jobId)); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
  }
  useEffect(() => { setD(null); setErr(''); setMsg(''); }, [jobId]);
  const running = ['queued', 'running'].includes(d?.job?.status);
  useLive(['shein_listing_jobs', 'shein_listing_job_items'], load, { every: running ? 3_000 : 60_000 });

  async function act(name, body, after) {
    setBusy(name); setErr(''); setMsg('');
    try {
      const r = await api.sheinListingAction(body);
      after?.(r);
      await load();
    } catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setBusy(''); }
  }
  const j = d?.job;
  const kind = j?.kind === 'run' ? 'run' : 'preview';
  // Worst / most useful first — by PRODUCT (its best-ranked item), so a product's price and edit
  // items sit together; within a product, in seq order.
  const items = useMemo(() => {
    const list = d?.items || [];
    const rank = kind === 'run'
      ? { failed: 0, changed: 1, deferred: 2, sending: 3, pending: 4, in_review: 5, done: 6, skipped: 7 }
      : { done: 0, failed: 1, skipped: 2, pending: 3 };
    const r = (i) => rank[i.status] ?? 9;
    const best = new Map();
    for (const i of list) { const k = i.shopify_product_id; const b = best.get(k); if (!b || r(i) < b.r || (r(i) === b.r && i.seq < b.seq)) best.set(k, { r: r(i), seq: i.seq }); }
    const pr = (i) => best.get(i.shopify_product_id);
    return [...list].sort((a, b) => pr(a).r - pr(b).r || pr(a).seq - pr(b).seq || a.seq - b.seq);
  }, [d, kind]);
  const isUpdate = isUpdateOps(d?.job?.scope?.ops) || items.some((i) => i.op === 'price' || i.op === 'edit');
  const isPublish = isPublishOps(d?.job?.scope?.ops) || items.some((i) => i.op === 'publish');
  // Phase 4: photos converted for SHEIN by this dry run (asset calls — not a listing write), the quota it uses
  const converted = items.reduce((a, i) => a + Number(i.plan?.photos?.converted || 0), 0);
  const quota = items.find((i) => i.status === 'done' && i.plan?.quota)?.plan?.quota || items.find((i) => i.plan?.quota)?.plan?.quota || null;
  const c = j?.counts || {};
  const ic = d?.itemCounts || {};
  const admin = isAdmin || !!d?.isAdmin;
  const confirmable = kind === 'preview' && j?.status === 'awaiting_confirm';
  const n = c.sendable ?? ic.done ?? 0;
  // An update job has one item per product per op: Confirm counts PRODUCTS with something to send.
  const nProducts = distinct(items.filter((i) => i.status === 'done'));
  const runId = kind === 'preview' ? sentAs(j) : null;

  const confirm = () => act('run', { action: 'run', previewJobId: Number(j.id) }, (r) => { if (r?.job?.id) onSwitch?.(r.job.id); });
  const dryAgain = (productIds) => act('preview', { action: 'preview', productIds, ...(isPublish ? { ops: ['publish'] } : isUpdate ? { ops: ['price', 'edit'] } : {}) }, (r) => { if (r?.job?.id) onSwitch?.(r.job.id); });
  // Phase 4: an admin lets a product SHEIN rejected go again — recorded, then a fresh dry run to check
  async function publishAgain(it) {
    setBusy('publish_again'); setErr(''); setMsg('');
    try {
      await api.sheinListingAction({ action: 'publish_again', productIds: [it.shopify_product_id] });
      const r = await api.sheinListingAction({ action: 'preview', productIds: [it.shopify_product_id], ops: ['publish'] });
      if (r?.job?.id) onSwitch?.(r.job.id);
    } catch (e) { if (e.unauthorized) onSignOut(); else setErr(e.message); }
    finally { setBusy(''); }
  }
  const lookAgain = (it) => act('look_again', { action: 'look_again', itemIds: [Number(it.id)] }, (r) => { const x = r?.results?.[0]; setMsg(x?.found ? 'Found on SHEIN — it is in SHEIN’s review now (not sent twice).' : x?.sendAgainOk ? 'Still not on SHEIN after two looks — an admin may Send again.' : 'Not found yet — look again later (a second look, 30 min after the send, unlocks Send again).'); });
  const sendAgain = (it) => act('send_again', { action: 'send_again', itemIds: [Number(it.id)] }, (r) => setMsg(r?.results?.[0]?.sent ? 'Sent again on the server.' : `Not sent: ${r?.results?.[0]?.refused || 'refused'}.`));
  const retry = (it) => act('retry', { action: 'retry', itemIds: [Number(it.id)] }, (r) => setMsg(r?.retried ? 'Sent again on the server — it is looked up first, so it is never sent twice.' : `Not retried: ${r?.refused?.[0]?.why || 'nothing to retry'}.`));
  const retryAll = () => act('retry', { action: 'retry', itemIds: items.filter(itemRetryable).map((i) => Number(i.id)) }, (r) => setMsg(`${plural(r?.retried || 0, 'product')} sent again on the server.`));
  const stop = () => act('stop', { action: 'stop', jobId: Number(j.id) });
  const nRetry = kind === 'run' ? items.filter(itemRetryable).length : 0;
  // the job's own counts are written when the send ends; SHEIN's review answers come later (per item)
  const waitingNow = ['in_review', 'deferred', 'pending', 'sending'].reduce((a, k) => a + Number(ic[k] || 0), 0);

  const body = (
    <>
      {err && <p className="error sm" role="alert">{err}</p>}
      {msg && <p className="ebl-ok sm">{msg}</p>}
      {!d && !err && [0, 1, 2].map((i) => <div key={i} className="shl-skel shl-skel-row" />)}
      {j && (
        <>
          <p className="muted sm shl-dmeta">
            Started {when(j.started_at || j.created_at)}{j.started_by ? ` by ${j.started_by}` : ''}
            {j.confirmed_by && kind === 'run' ? ` · confirmed by ${j.confirmed_by}` : ''}
            {j.preview_job_id ? ` · from dry run #${j.preview_job_id}` : ''}
            {j.finished_at ? ` · ended ${when(j.finished_at)}` : ''}
          </p>
          {(running || j.status === 'interrupted') && (
            <div className="shl-dprog">
              <ProgressBar value={j.total ? j.done / j.total : 0} indeterminate={!j.total}
                label={j.total ? `${fmt(j.done)} of ${plural(j.total, 'product')}${j.current ? ' · now on one' : ''}` : 'Starting…'} />
              <p className="muted xs">{j.phase || j.status}. It runs on the server — closing this or the tab doesn’t stop it.</p>
            </div>
          )}
          {j.status === 'interrupted' && <p className="notice sm">The server restarted mid-job. {kind === 'run' ? 'It carries on by itself on the next tick — nothing is sent twice.' : 'Dry run again to finish it.'}</p>}
          {j.error && <p className="error sm">{j.error}</p>}

          {kind === 'preview' && !running && isPublish && (
            <div className="er-stats shl-dstats" data-stats="publish">
              <div className="er-stat"><b>{fmt(c.products ?? items.length)}</b><span>products checked</span></div>
              <div className="er-stat ok"><b>{fmt(c.publishable ?? 0)}</b><span>ready to publish</span></div>
              <div className="er-stat"><b>{fmt(c.publish_sizes ?? 0)}</b><span>sizes (at stock 0)</span></div>
              <div className={`er-stat${c.skipped ? ' warn' : ''}`}><b>{fmt(c.skipped ?? 0)}</b><span>can’t publish yet (each says why)</span></div>
              <div className="er-stat"><b>{fmt(converted)}</b><span>photos converted for SHEIN</span></div>
              {quota?.controlled && <div className={`er-stat${(c.publishable || 0) > Number(quota.available) ? ' warn' : ''}`} data-quota=""><b>uses {fmt(c.publishable ?? 0)} of {fmt(quota.available)}</b><span>publish quota left this month</span></div>}
            </div>
          )}
          {kind === 'preview' && !running && isUpdate && (
            <>
              <div className="er-stats shl-dstats" data-stats="update">
                <div className="er-stat"><b>{fmt(distinct(items))}</b><span>products checked</span></div>
                <div className="er-stat ok"><b>{fmt(nProducts)}</b><span>products to update</span></div>
                <div className="er-stat"><b>{fmt(c.prices ?? 0)}</b><span>prices to change</span></div>
                <div className={`er-stat${c.price_rises ? ' violet' : ''}`}><b>{fmt(c.price_rises ?? 0)}</b><span>price rises · SHEIN may review them</span></div>
                <div className="er-stat"><b>{fmt(c.sizes_on ?? 0)}</b><span>sizes turned back on</span></div>
                <div className="er-stat"><b>{fmt(c.relinks ?? 0)}</b><span>SKUs SHEIN has wrong, changed</span></div>
                <div className="er-stat"><b>{fmt(c.titles ?? 0)}</b><span>titles</span></div>
                <div className={`er-stat${c.sizes_skipped ? ' warn' : ''}`}><b>{fmt(c.sizes_skipped ?? 0)}</b><span>sizes skipped (each says why)</span></div>
              </div>
            </>
          )}
          {kind === 'preview' && !running && (
            <>
              {!isUpdate && !isPublish && <div className="er-stats shl-dstats">
                <div className="er-stat"><b>{fmt(c.products ?? items.length)}</b><span>products checked</span></div>
                <div className="er-stat ok"><b>{fmt(c.sendable ?? 0)}</b><span>products to send</span></div>
                <div className="er-stat"><b>{fmt(c.sizes ?? 0)}</b><span>sizes to add</span></div>
                <div className="er-stat"><b>{fmt(c.custom_sizes ?? 0)}</b><span>custom sizes{c.new_custom_values ? ` · ${fmt(c.new_custom_values)} new to SHEIN` : ''}</span></div>
                <div className="er-stat"><b>{fmt(c.relinks ?? 0)}</b><span>SKUs SHEIN has wrong, changed</span></div>
                <div className={`er-stat${c.skipped ? ' warn' : ''}`}><b>{fmt(c.skipped ?? 0)}</b><span>products skipped · {plural(c.sizes_skipped ?? 0, 'size')} not sent</span></div>
                {c.review_open > 0 && <div className="er-stat"><b>{fmt(c.review_open)}</b><span>wait for a SHEIN review first</span></div>}
              </div>}
              <p className={`sm shl-proof${c.shein_writes ? ' bad' : ''}`} data-proof="">
                {c.shein_writes ? <><b>{fmt(c.shein_writes)} SHEIN writes</b> — a dry run should never write. Tell an admin.</>
                  : isPublish ? <><b>0 SHEIN writes · {plural(converted, 'photo')} converted</b> — this dry run read SHEIN ({plural(c.shein_calls ?? 0, 'call')}) and only converted photos into SHEIN’s image format. Nothing on SHEIN changed.</>
                    : <><b>0 SHEIN writes</b> — this dry run only read ({plural(c.shein_calls ?? 0, 'SHEIN read')}). Nothing on SHEIN changed.</>}
              </p>
              {runId && <p className="sm">Confirmed — sent as job #{runId}. <button type="button" className="shl-linkbtn" onClick={() => onSwitch?.(runId)}>Open the send →</button></p>}
              {!runId && j.status === 'done' && !n && <p className="muted sm">Nothing to send: every product below says why.</p>}
              {confirmable && j.started_by === AUTO_BY && <p className="sm shl-pline violet">Started by the auto price re-sync — the server sends it by itself at its next check (or confirm it now).</p>}
              {confirmable && isPublish && <p className="muted xs">Each product goes to SHEIN as ONE new listing at stock 0, then SHEIN reviews it (hours to days) — it shows In review until SHEIN approves it, then the live sync sets its stock. Each one uses 1 of the store’s monthly publish quota, and deleting it later doesn’t give that back.</p>}
              {confirmable && !isPublish && (isUpdate
                ? <p className="muted xs">Prices go through SHEIN’s price tool. A size with a live SHEIN special isn’t changed unless you chose to end the special. A cut applies at once; a rise may go to SHEIN’s price review and shows In review until SHEIN approves. Sizes turned back on and SKU changes go in ONE edit per product, then SHEIN reviews it. Stock is never touched — the live sync owns it.</p>
                : <p className="muted xs">New sizes go up at stock 0 in ONE edit per product, then SHEIN reviews each product (hours to days). Approved sizes then get their stock from the live sync. A custom size is store-wide and permanent.</p>)}
            </>
          )}
          {kind === 'run' && (
            <>
              <div className="shl-chiprow">
                {Object.entries(ic).map(([k, v]) => { const s = itemStatus('run', k); return <span key={k} className={s.chip}>{fmt(v)} {s.label.toLowerCase()}</span>; })}
              </div>
              {!running && j.phase && (waitingNow > 0 || !/waiting/i.test(j.phase)) && <p className="sm">{j.phase}</p>}
              <p className="muted xs">{plural(c.shein_writes ?? 0, 'SHEIN write')} · {plural(c.shein_calls ?? 0, 'SHEIN call')} · {isPublish ? 'one new listing per product' : 'one edit per product'}, never sent twice.</p>
            </>
          )}

          <div className="shl-ditems">
            {items.map((it, i) => (
              <ItemRow key={it.id} it={it} kind={kind} isAdmin={admin} canWrite={canWrite} busy={!!busy} onRetry={retry} onDryRunAgain={dryAgain} onlyOne={items.length === 1}
                isUpdate={isUpdate} sameAsAbove={isUpdate && i > 0 && items[i - 1].shopify_product_id === it.shopify_product_id} onPublishAgain={publishAgain} onLookAgain={lookAgain} onSendAgain={sendAgain} />
            ))}
            {!items.length && d && <p className="muted sm">{running ? 'Picking the products…' : 'No products in this job.'}</p>}
          </div>
        </>
      )}
    </>
  );

  const foot = j && (
    <>
      {running && <button type="button" className="btn ghost sm" disabled={!!busy || j.stop_requested} onClick={stop}>{j.stop_requested ? 'Stopping after this product…' : 'Stop after this product'}</button>}
      {kind === 'run' && nRetry > 1 && <button type="button" className="btn ghost sm" disabled={!canWrite || !!busy} title={canWrite ? undefined : NEEDS_PRIV} onClick={retryAll}>Retry all ({fmt(nRetry)})</button>}
      {onClose && <button type="button" className="btn ghost sm" onClick={onClose}>{confirmable ? 'Not now' : 'Close'}</button>}
      {confirmable && (
        <button type="button" className="btn primary sm" data-confirm="" disabled={!canWrite || !!busy || !n}
          title={!canWrite ? NEEDS_PRIV : isPublish ? `Publishes each ready product on SHEIN as ONE new listing, from dry run #${j.id}` : isUpdate ? `Sends the prices and ONE edit per product to SHEIN, from dry run #${j.id}` : `Sends ONE edit per product to SHEIN, from dry run #${j.id}`} onClick={confirm}>
          {busy === 'run' ? 'Starting…' : isPublish ? `Publish ${plural(n, 'product')}` : isUpdate ? `Update ${plural(nProducts, 'product')}` : `Add sizes to ${plural(n, 'product')}`}
        </button>
      )}
    </>
  );

  const heading = j ? `${kind === 'run' ? 'Send to SHEIN' : 'Dry run'} #${j.id}` : 'Loading…';
  const chip = j && <JobWord job={j} waitingNow={d?.itemCounts ? waitingNow : null} />;
  if (inline) {
    return (
      <div className="card shl-dinline">
        <h3 className="er-step-title">{heading} {chip}</h3>
        {body}
        {foot && <div className="er-actions">{foot}</div>}
      </div>
    );
  }
  return (
    <>
      <div className="shl-d-head shl-sheet-head">
        <div className="shl-d-title"><div className="shl-pname">{heading} {chip}</div>
          <div className="muted xs">{kind === 'run' ? (isPublish ? 'Publishing new products on SHEIN' : isUpdate ? 'Updating prices, sizes turned off and wrong SKUs on SHEIN' : 'Adding the missing sizes to shoes already on SHEIN')
            : `${isPublish ? 'Publish new products' : isUpdate ? 'Update prices & sizes' : 'Add missing sizes'} — what WOULD be sent; nothing has gone to SHEIN`}</div></div>
        <button type="button" className="btn ghost sm shl-close" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="shl-d-body">{body}</div>
      {foot && <div className="shl-d-foot">{foot}</div>}
    </>
  );
}

const JOB_WORD = { done: ['ok', 'Done'], running: ['info', 'Running'], queued: ['', 'Queued'], stopped: ['', 'Stopped'], failed: ['bad', 'Failed'], interrupted: ['warn', 'Interrupted'], awaiting_confirm: ['violet', 'Waiting for you'] };
function JobWord({ job, waitingNow = null }) {
  const [cls, word] = JOB_WORD[job.status] || ['', job.status];
  const waiting = job.kind === 'run' && job.status === 'done' && (waitingNow != null ? waitingNow > 0 : (job.counts?.deferred || job.counts?.in_review));
  const w = job.kind === 'preview' && job.status === 'done' && sentAs(job) ? 'Sent' : waiting ? 'Sent · waiting on SHEIN' : word;
  return <span className={`ebo-chip ${waiting ? 'violet' : cls}`.trim()}>{w}</span>;
}

// The overlay. `jobId` can change while it is open (Confirm → the run, Dry run again → a new dry run).
export function DryRunSheet({ jobId, canWrite, isAdmin, onClose, onSignOut }) {
  const [id, setId] = useState(jobId);
  useEffect(() => { setId(jobId); }, [jobId]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <>
      <div className="shl-drawer-bg shl-sheet-bg" onClick={onClose} aria-hidden="true" />
      <aside className="shl-drawer shl-sheet" role="dialog" aria-modal="true" aria-label="Dry run and send">
        <DryRunView jobId={id} canWrite={canWrite} isAdmin={isAdmin} onSwitch={setId} onClose={onClose} onSignOut={onSignOut} />
      </aside>
    </>,
    document.body,
  );
}
