// Under a search, what each order row shows of ITSELF before it is opened: the manifest
// lines the search landed on (shoe name, style code, how many), the tracking number it
// landed on, the status word it landed on — with the matched part marked. A list of PO
// codes that all "match chicago" is a list you still have to open one by one; this is
// the preview that saves the opening. Shared by the PO list and the Reconciliation list.
//
// Drawn only while a query is typed: with no search there is nothing to point at, and
// the row goes back to the shape it has always had.
import React from 'react';
import { poSearchHits } from '../lib/postatus.js';
import { segmentsFor } from '../lib/highlight.js';

export function Mark({ text, words, code = false }) {
  return segmentsFor(text, words, { code }).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <React.Fragment key={i}>{s.text}</React.Fragment>));
}

export function PoSearchPreview({ po, query }) {
  const hits = poSearchHits(po, query);
  if (!hits) return null;
  const { words, lines, more, tracking, status } = hits;
  if (!lines.length && !tracking.length && !status.length) return null;
  const noun = String(po?.order_kind || 'shoes') === 'boxes' ? 'box' : 'pair';
  return (
    <div className="po-hits" aria-label="What matched inside this order">
      {lines.map((l) => (
        <span key={l.sku || l.name} className={`po-hit${l.hit ? ' on' : ''}`}>
          {l.name && <span className="po-hit-name"><Mark text={l.name} words={words} /></span>}
          {l.sku && <span className="po-hit-sku"><Mark text={l.sku} words={words} code /></span>}
          {l.qty > 0 && <span className="po-hit-qty">{l.qty} {noun}{l.qty === 1 ? '' : (noun === 'box' ? 'es' : 's')}</span>}
        </span>
      ))}
      {more > 0 && <span className="po-hit muted">+{more} more style{more === 1 ? '' : 's'}</span>}
      {tracking.map((t) => (
        <span key={t} className="po-hit on"><span className="po-hit-sku"><Mark text={t} words={words} code /></span></span>
      ))}
      {status.map((w) => (
        <span key={w} className="po-hit on"><Mark text={w} words={words} /></span>
      ))}
    </div>
  );
}
