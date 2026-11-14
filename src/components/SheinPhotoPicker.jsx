// SHEIN Listings → "Choose photos" (2026-11-11): the photos a publish would send to SHEIN, in order,
// each with Leave out / Put back. SHEIN rejects photos with text, a logo or a store name on them
// ("The image contains watermark information", "promotional information") and promises like fast
// delivery ("false service promises") — every PH-branded photo is one. Saved per product
// (`publish_choices photoSkip`, our records only); the next preview / publish never sends a left-out photo.
// 2026-11-14 — which set SHEIN gets: CLEAN (the brand tool's cutouts of the shoe, flattened on white, no
// text — the default whenever the style has them), PH edited (branded; the spec / welcome slides never
// go), or Shopify's. "Find clean photos" looks for the cutouts of a shoe branded before they were recorded.
// Reads GET ?photos= (Shopify live + our DB), never SHEIN.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { RemoteThumb, ImageZoomModal } from './common.jsx';
import { fmt } from './SheinListingsBits.jsx';
import { plain } from '../lib/sheinWords.js';
import { ANGLE_LABEL } from '../lib/sheinCleanPhotos.js';

const SOURCES = [
  { key: 'clean', label: 'Clean', hint: 'the shoe on white, no text — what SHEIN wants' },
  { key: 'ph_edited', label: 'PH edited', hint: 'branded (brick wall, name, logo) — SHEIN usually rejects these' },
  { key: 'shopify', label: 'Shopify', hint: 'Shopify’s photos as they are' },
];

export function SheinPhotoPicker({ productId, onSaved, onSignOut, lede = null }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [zoom, setZoom] = useState(-1);
  async function load() {
    try { setD(await api.sheinListingPhotos(productId)); setErr(''); }
    catch (e) { if (e.unauthorized) onSignOut?.(); else setErr(plain(e.message)); }
  }
  useEffect(() => { setD(null); setMsg(''); load(); }, [productId]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <p className="error xs" role="alert">{err} <button type="button" className="btn ghost xs" onClick={load}>Try again</button></p>;
  if (!d) return <div className="shl-skel shl-skel-row" aria-label="Reading the photos…" />;

  const clean = d.clean || [];
  const byKey = { clean, ph_edited: d.ph, shopify: d.shopify };
  const list = byKey[d.source] || d.shopify;
  const skip = [...new Set([...clean, ...d.ph, ...d.shopify].filter((x) => x.skipped).map((x) => x.key).concat((d.stale || []).map((x) => x.key)))];
  const kept = list.filter((x) => !x.skipped).length;
  const slidesIn = d.shopify.filter((x) => x.phCopy?.slide && !x.skipped);
  const brandedIn = d.source === 'ph_edited' ? kept : d.source === 'shopify' ? d.shopify.filter((x) => x.phCopy && !x.skipped).length : 0;

  async function act(body, say) {
    setBusy(true); setMsg('');
    try {
      await api.sheinListingAction({ action: 'publish_choices', productId, ...body });
      await load(); setMsg(say); onSaved?.(say);
    } catch (e) { if (e.unauthorized) onSignOut?.(); else setMsg(`Not saved: ${plain(e.message)}`); }
    setBusy(false);
  }
  const save = (next, say) => act({ photoSkip: [...new Set(next)] }, say);
  const toggle = (x, i) => (x.skipped
    ? save(skip.filter((k) => k !== x.key), `Photo ${i + 1} put back.`)
    : save([...skip, x.key], `Photo ${i + 1} left out — SHEIN won’t get it.`));
  const pick = (src) => act({ photoSource: src }, src === 'clean' ? 'SHEIN gets the clean photos — checked again by the next preview.'
    : src === 'ph_edited' ? 'SHEIN gets the PH edited photos (without the spec and welcome slides).' : 'SHEIN gets Shopify’s photos.');
  async function findClean() {
    setBusy(true); setMsg('');
    try {
      const r = await api.sheinListingAction({ action: 'find_clean_photos', productId });
      await load();
      const say = r.found ? `Found ${fmt(r.found)} clean photo${r.found === 1 ? '' : 's'} for ${r.style}${r.recorded < r.found ? ` (${fmt(r.found - r.recorded)} already on file)` : ''}.`
        : r.cutouts ? `${fmt(r.cutouts)} cut-out${r.cutouts === 1 ? '' : 's'} on file for ${r.style}, but none matched its branded photos — brand it again in the Image Finder.`
          : `No cut-outs on file for ${r.style} — brand it in the Image Finder (Upload records the clean photos).`;
      setMsg(say); if (r.recorded) onSaved?.(say);
    } catch (e) { if (e.unauthorized) onSignOut?.(); else setMsg(`Not found: ${plain(e.message)}`); }
    setBusy(false);
  }
  const counts = { clean: clean.length, ph_edited: d.ph.length, shopify: d.shopify.length };
  // a clean photo says what it SHOWS (its outline: side view / sole / pair), not only PH's brand-tool slot — the
  // slots are often filled in the catalogue's order (2026-11-14: the "3/4" slot of IF1721-300 holds the sole)
  const VIEW = { side: 'side view', sole: 'sole', pair: 'pair' };
  const label = (x) => {
    if (d.source === 'clean' && x.view) return VIEW[x.view];
    if (d.source === 'clean' && x.angle) return `PH slot: ${ANGLE_LABEL[x.angle] || x.angle}`;
    if (x.angle) return ANGLE_LABEL[x.angle] || x.angle;
    if (x.phCopy?.slide) return `PH ${x.phCopy.slide} slide`;
    return x.phCopy ? 'PH-branded' : null;
  };

  return (
    <div className="shl-photos" data-photos-picker="" data-source={d.source}>
      {lede}
      <div className="shl-photo-src">
        <span className="xs">Photos SHEIN gets</span>
        <div className="seg sm" role="radiogroup" aria-label="Photos SHEIN gets">
          {SOURCES.map((s) => (
            <button key={s.key} type="button" role="radio" aria-checked={d.source === s.key} className={`seg-btn${d.source === s.key ? ' on' : ''}`} title={s.hint}
              data-src={s.key} disabled={busy || (!counts[s.key] && d.source !== s.key)} onClick={() => d.source !== s.key && pick(s.key)}>
              {s.label}<span className="seg-n">{fmt(counts[s.key])}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="xs">
        <b>{fmt(Math.min(kept, d.max))}</b> of {fmt(list.length)} photo{list.length === 1 ? '' : 's'} go to SHEIN{d.source === 'clean'
          ? <>: the clean photos of <b>{d.style}</b> — the shoe cut out of its catalogue photo, on white</>
          : d.source === 'ph_edited' ? <>, from the PH edited photos for <b>{d.style}</b></> : ', from Shopify'}{kept > d.max ? ` (the first ${d.max})` : ''}.
        {' '}Photo 1 is the main photo.{d.source === 'clean' && d.cleanPhotos == null ? ' Chosen automatically — this style has clean photos.' : ''}
      </p>
      {d.source === 'clean' && d.mainUnsure && (
        <p className="notice xs" role="status" data-main-unsure=""><b>Check the main photo.</b> None of these is confirmed as the side view, so nothing goes to SHEIN yet — press <b>Make main photo</b> on the side view (photo 1 is what SHEIN shows first).</p>
      )}
      {d.source === 'clean' && !d.mainUnsure && d.mainWhy === 'side_view_by_order' && (
        <p className="muted xs" data-main-why="">Photo 1 is a side view by its outline; its slot was only placed by the order it was cut out — check it.</p>
      )}
      {brandedIn > 0 && (
        <p className="shl-bad-text xs" role="status" data-branded="">{fmt(brandedIn)} of these carr{brandedIn === 1 ? 'ies' : 'y'} the PH brand template (brick wall, name, logo) — SHEIN rejects that as a watermark / promotional information.
          {clean.length ? ' Use the clean photos instead.' : ' Find the clean photos below, or leave them out.'}</p>
      )}
      {!clean.length && (
        <div className="xs" data-no-clean="">
          No clean photos on file for <b>{d.style || 'this style'}</b>.{' '}
          {d.style
            ? <button type="button" className="btn xs shl-fix" disabled={busy} onClick={findClean} data-act="find-clean">{busy ? 'Looking…' : 'Find clean photos'}</button>
            : <span className="muted">It has no style code to look them up by.</span>}
          <span className="muted xs shl-block">Looks for the cut-outs the Image Finder made when the shoe was branded and matches each to its angle. Reads only — nothing changes on Shopify or SHEIN.</span>
        </div>
      )}
      {d.source === 'shopify' && slidesIn.length > 0 && (
        <p className="xs" data-slides="">{fmt(slidesIn.length)} of Shopify’s photos {slidesIn.length === 1 ? 'is' : 'are'} the PH {slidesIn.map((x) => x.phCopy.slide).join(' + ')} slide{slidesIn.length === 1 ? '' : 's'} — never for SHEIN.{' '}
          <button type="button" className="btn xs shl-fix" disabled={busy} data-act="skip-slides" onClick={() => save([...skip, ...slidesIn.map((x) => x.key)], `Left out the ${slidesIn.map((x) => x.phCopy.slide).join(' + ')} slide${slidesIn.length === 1 ? '' : 's'}.`)}>Leave out the spec + welcome slides</button></p>
      )}
      {d.source !== 'shopify' && d.slidesOnFile > 0 && <p className="muted xs">The spec and welcome slides are never sent to SHEIN.</p>}
      {d.source === 'shopify' && d.copiesChecked === false && <p className="muted xs">Still comparing Shopify’s photos with the PH set — open this again in a moment to see which are branded.</p>}
      {!list.length && <p className="notice xs">No photos found {d.source === 'clean' ? 'among the clean photos' : d.source === 'ph_edited' ? 'for this style' : 'on Shopify'}.</p>}
      <div className="shl-photo-grid">
        {list.map((x, i) => (
          <div key={x.key} className={`shl-photo${x.skipped ? ' off' : ''}`} data-photo={i + 1} data-skipped={x.skipped ? 'yes' : 'no'} data-slide={x.phCopy?.slide || undefined}>
            <button type="button" className="shl-photo-img" onClick={() => setZoom(i)} aria-label={`Look at photo ${i + 1}`}>
              <RemoteThumb src={x.url} className="ebl-thumb shl-photo-thumb" alt={`Photo ${i + 1}`} />
            </button>
            <span className="xs">{i + 1}{(d.source === 'clean' ? x.main : i === 0) ? ' · main' : ''}{label(x) ? ` · ${label(x)}` : ''}{x.skipped ? <b className="shl-bad-text"> · left out</b> : ''}</span>
            {x.how === 'timestamp' && <span className="badge warn xs" data-unconfirmed="" title="Filed by the order it was cut out, not matched to PH’s photo — check what it shows">unconfirmed</span>}
            <button type="button" className={`btn xs ${x.skipped ? 'ghost' : 'shl-fix'}`} disabled={busy} onClick={() => toggle(x, i)}>{x.skipped ? 'Put back' : 'Leave out'}</button>
            {d.source === 'clean' && !x.skipped && !x.main && <button type="button" className="btn ghost xs" data-act="make-main" disabled={busy} onClick={() => act({ cleanMain: x.url }, `Photo ${i + 1} is now the main photo.`)}>Make main photo</button>}
            {d.source === 'clean' && x.main && d.mainWhy === 'person' && <button type="button" className="shl-linkbtn xs" disabled={busy} onClick={() => act({ cleanMain: null }, 'The main photo is picked automatically again (a side view).')}>Pick automatically</button>}
          </div>
        ))}
      </div>
      {kept < 2 && list.length > 0 && <p className="shl-bad-text xs" role="status">Only {fmt(kept)} photo{kept === 1 ? '' : 's'} left — SHEIN usually needs at least 2.{d.source !== 'clean' && clean.length ? ' Use the clean photos, or put one back.' : ' Put one back.'}</p>}
      {(d.stale || []).length > 0 && (
        <p className="muted xs">{fmt(d.stale.length)} left-out photo{d.stale.length === 1 ? ' is' : 's are'} no longer on {d.stale.every((x) => x.shopify) ? 'Shopify' : 'the list'}.{' '}
          <button type="button" className="shl-linkbtn" disabled={busy} onClick={() => save(skip.filter((k) => !d.stale.some((s) => s.key === k)), 'Forgot the photos that are gone.')}>Forget {d.stale.length === 1 ? 'it' : 'them'}</button></p>
      )}
      {msg && <p className={`${/^Not /.test(msg) ? 'error' : 'ebl-ok'} xs`} role="status">{msg}</p>}
      {zoom >= 0 && list[zoom] && (
        <ImageZoomModal url={list[zoom].url} label={`Photo ${zoom + 1}${label(list[zoom]) ? ` · ${label(list[zoom])}` : ''}${list[zoom].skipped ? ' (left out)' : ''}`} onClose={() => setZoom(-1)}
          onPrev={zoom > 0 ? () => setZoom(zoom - 1) : null} onNext={zoom < list.length - 1 ? () => setZoom(zoom + 1) : null} />
      )}
    </div>
  );
}
