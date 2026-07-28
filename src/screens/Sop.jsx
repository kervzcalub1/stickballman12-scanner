// SOP & Help — the written procedures for every feature, per role, plus the FAQ.
//
// Three views in one screen, chosen by state rather than routing, because they are
// one task ("find out how to do the thing"): the INDEX (browse by area), SEARCH
// results (the moment you type), and an ARTICLE. The open article and the query
// live in `?a=` / `?q=` / `?role=` so a refresh, the Back button, and a link
// pasted into the group chat all land in the same place.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from '../components/common.jsx';
import { NavIcon, Icon } from '../components/NavIcons.jsx';
import { SopDiagram, hasDiagram } from '../components/SopDiagram.jsx';
import { SopShot, hasShot } from '../components/SopShot.jsx';
import { useMediaQuery } from '../hooks.js';
import { readParam, writeParam } from '../lib/urlstate.js';
import {
  SOP_ROLES, SOP_AREAS, SOP_ARTICLES, FAQ, SOP_KEYWORDS,
  areaLabel, areaAccent, roleLabelSop, articleById, visibleTo, searchSop,
} from '../lib/sop/index.js';

// The role whose procedures a signed-in user most likely wants first. Admins get
// "All roles" — they supervise every desk, so pre-filtering hides work from them.
const defaultRoleFor = (role) => (role === 'warehouse' || role === 'ph_team' || role === 'supplier' ? role : 'all');

export function Sop({ user, navBack, onHome, onSignOut }) {
  const [role, setRole] = useState(() => readParam('role') || defaultRoleFor(user?.role));
  const [query, setQuery] = useState(() => readParam('q'));
  const [openId, setOpenId] = useState(() => readParam('a'));
  const isPhone = useMediaQuery('(max-width: 768px)');
  const searchRef = useRef(null);
  const topRef = useRef(null);

  useEffect(() => { writeParam('role', role === defaultRoleFor(user?.role) ? '' : role); }, [role, user]);
  useEffect(() => { writeParam('q', query); }, [query]);
  useEffect(() => { writeParam('a', openId); }, [openId]);

  // Back closes the open article before it leaves the page, matching every other
  // screen's "Back undoes the last thing you did" behaviour.
  useEffect(() => {
    if (!navBack) return undefined;
    navBack.current = () => { if (openId) { setOpenId(''); return true; } return false; };
    return () => { navBack.current = null; };
  }, [navBack, openId]);

  // Follow Back/Forward between articles (writeParam uses replaceState, but a
  // link someone pasted still needs to resolve on popstate).
  useEffect(() => {
    const onPop = () => { setOpenId(readParam('a')); setQuery(readParam('q')); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const article = openId ? articleById(openId) : null;
  useEffect(() => { if (article && topRef.current) topRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => (query.trim().length >= 2 ? searchSop(query, role) : []), [query, role]);
  const searching = query.trim().length >= 2;

  const byArea = useMemo(() => SOP_AREAS.map((a) => ({
    ...a,
    items: SOP_ARTICLES.filter((x) => x.area === a.key && visibleTo(x, role)),
  })).filter((a) => a.items.length), [role]);

  const faqForRole = useMemo(() => FAQ.filter((f) => visibleTo(f, role)), [role]);

  const open = (id) => { setOpenId(id); setQuery(''); };

  return (
    <div className="app app-wide">
      <TopBar title="SOP & Help" onHome={onHome} onSignOut={onSignOut} />
      <div ref={topRef} />

      {/* --- search + role filter: always visible, so you can re-search from
          inside an article without going back first --- */}
      <div className="sop-hero">
        <div className="sop-hero-top">
          <div>
            <h1 className="sop-h1">Standard operating procedures</h1>
            <p className="sop-lede">Every feature, written up for the person doing it. Search, or browse by area below.</p>
          </div>
          <div className="sop-count">{SOP_ARTICLES.length} procedures · {FAQ.length} FAQs</div>
        </div>

        <div className="sop-searchrow">
          <span className="sop-search-icon"><Icon name="search" /></span>
          <input
            ref={searchRef}
            className="sop-search"
            type="search"
            value={query}
            placeholder={isPhone ? 'Search procedures…' : 'Search — try "no box", "shelve", "reconcile", "margin"…'}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search procedures and FAQs"
          />
          {query && <button className="btn ghost sm sop-clear" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>Clear</button>}
        </div>

        <div className="sop-roles" role="tablist" aria-label="Filter by role">
          {SOP_ROLES.map((r) => (
            <button
              key={r.key}
              role="tab"
              aria-selected={role === r.key}
              className={`sop-role${role === r.key ? ' is-on' : ''}`}
              onClick={() => setRole(r.key)}
              title={r.blurb}
            >{r.label}</button>
          ))}
        </div>

        {/* Chips are a browsing aid — inside an article they are just noise, and on
            a phone the sticky hero would eat most of the screen. */}
        {!searching && !article && (
          <div className="sop-chips">
            <span className="sop-chips-label">Jump to</span>
            {SOP_KEYWORDS.map((k) => (
              <button key={k} className="sop-chip" onClick={() => { setQuery(k); setOpenId(''); }}>{k}</button>
            ))}
          </div>
        )}
      </div>

      {searching ? (
        <SearchResults query={query} results={results} onOpen={open} />
      ) : article ? (
        <Article a={article} onOpen={open} onBack={() => setOpenId('')} role={role} />
      ) : (
        <Index byArea={byArea} faq={faqForRole} onOpen={open} role={role} />
      )}
    </div>
  );
}

// --- index ------------------------------------------------------------------

function Index({ byArea, faq, onOpen, role }) {
  return (
    <>
      {byArea.map((a) => (
        <section className="home-section sop-area" key={a.key} data-accent={a.accent}>
          <h2 className="home-section-title">{areaLabel(a.key)}</h2>
          <div className="sop-list">
            {a.items.map((x) => (
              <button className="sop-item" key={x.id} onClick={() => onOpen(x.id)}>
                <span className="sop-item-title">{x.title}</span>
                <span className="sop-item-sub">{x.summary}</span>
                <span className="sop-item-meta">
                  {x.roles.filter((r) => r !== 'admin' && r !== 'superadmin').map((r) => (
                    <span className="sop-tag" key={r}>{roleLabelSop(r)}</span>
                  ))}
                  <span className="sop-steps-n">{x.steps.length} steps</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

      <section className="home-section sop-area" data-accent="requests">
        <h2 className="home-section-title">Frequently asked</h2>
        <FaqList items={faq} onOpen={onOpen} />
        <p className="sop-faq-foot">Filtered to <strong>{roleLabelSop(role)}</strong>. Use the search box above to look across everything.</p>
      </section>
    </>
  );
}

function FaqList({ items, onOpen }) {
  return (
    <div className="sop-faq">
      {items.map((f) => (
        <details className="sop-q" key={f.id}>
          <summary>{f.q}</summary>
          <div className="sop-a">
            <p>{f.a}</p>
            {f.see && articleById(f.see) && (
              <button className="link-btn" onClick={() => onOpen(f.see)}>Full procedure: {articleById(f.see).title} →</button>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

// --- search results ---------------------------------------------------------

function SearchResults({ query, results, onOpen }) {
  const articles = results.filter((r) => r.kind === 'article');
  const faqs = results.filter((r) => r.kind === 'faq');
  if (!results.length) {
    return (
      <div className="card empty-state sop-empty">
        Nothing matches <strong>“{query}”</strong> for this role.
        <div className="muted mt">Try fewer words, or switch the role filter to <strong>All roles</strong>.</div>
      </div>
    );
  }
  return (
    <>
      <div className="sop-results-head">{results.length} result{results.length === 1 ? '' : 's'} for “{query}”</div>
      {articles.length > 0 && (
        <section className="home-section sop-area" data-accent="listing">
          <h2 className="home-section-title">Procedures</h2>
          <div className="sop-list">
            {articles.map((r) => (
              <button className="sop-item" key={r.id} onClick={() => onOpen(r.id)}>
                <span className="sop-item-title">{r.ref.title}</span>
                <span className="sop-item-sub">{r.ref.summary}</span>
                <span className="sop-item-meta">
                  <span className="sop-tag sop-tag-area">{areaLabel(r.area)}</span>
                  {r.ref.roles.filter((x) => x !== 'admin' && x !== 'superadmin').map((x) => <span className="sop-tag" key={x}>{roleLabelSop(x)}</span>)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {faqs.length > 0 && (
        <section className="home-section sop-area" data-accent="requests">
          <h2 className="home-section-title">Answers</h2>
          <FaqList items={faqs.map((r) => r.ref)} onOpen={onOpen} />
        </section>
      )}
    </>
  );
}

// --- article ----------------------------------------------------------------

function Article({ a, onOpen, onBack, role }) {
  const related = (a.related || []).map(articleById).filter(Boolean).filter((x) => visibleTo(x, role));
  const faqs = FAQ.filter((f) => f.see === a.id);
  return (
    <article className="sop-article" data-accent={areaAccent(a.area)}>
      <button className="btn ghost sm sop-back" onClick={onBack}>← All procedures</button>

      <header className="sop-head">
        <span className="sop-head-icon"><NavIcon name={ICON_FOR[a.area] || 'inventory'} /></span>
        <div>
          <div className="sop-kicker">{areaLabel(a.area)}</div>
          <h1 className="sop-title">{a.title}</h1>
          <p className="sop-summary">{a.summary}</p>
          <div className="sop-head-meta">
            {a.roles.filter((r) => r !== 'admin' && r !== 'superadmin').map((r) => <span className="sop-tag" key={r}>{roleLabelSop(r)}</span>)}
            {a.roles.includes('admin') && <span className="sop-tag">Admin</span>}
          </div>
        </div>
      </header>

      {a.when && (
        <div className="sop-when"><span className="sop-when-label">When</span>{a.when}</div>
      )}

      {a.diagram && hasDiagram(a.diagram) && <SopDiagram id={a.diagram} />}
      {a.shot && hasShot(a.shot) && <SopShot id={a.shot} />}

      <h2 className="sop-h2">Procedure</h2>
      <ol className="sop-steps">
        {a.steps.map((s, i) => (
          <li key={i}>
            <span className="sop-step-n">{i + 1}</span>
            <div className="sop-step-body">
              <p className="sop-step-do">{s.do}</p>
              {s.note && <p className="sop-step-note">{s.note}</p>}
              {s.warn && <p className="sop-step-warn">{s.warn}</p>}
            </div>
          </li>
        ))}
      </ol>

      {a.rules?.length > 0 && (
        <>
          <h2 className="sop-h2">Rules &amp; gotchas</h2>
          <ul className="sop-rules">
            {a.rules.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </>
      )}

      {faqs.length > 0 && (
        <>
          <h2 className="sop-h2">Questions people ask about this</h2>
          <FaqList items={faqs} onOpen={onOpen} />
        </>
      )}

      {related.length > 0 && (
        <>
          <h2 className="sop-h2">See also</h2>
          <div className="sop-related">
            {related.map((r) => (
              <button className="sop-rel" key={r.id} onClick={() => onOpen(r.id)}>
                <span className="sop-rel-title">{r.title}</span>
                <span className="sop-rel-area">{areaLabel(r.area)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </article>
  );
}

// Reuse the existing nav icon set so an area reads the same here as on Home.
const ICON_FOR = {
  start: 'sop',
  intake: 'receiving',
  po: 'reconcile',
  instore: 'instore',
  putaway: 'shelve',
  rescale: 'rescale',
  listing: 'report',
  fulfil: 'shipped',
  browse: 'inventory',
  admin: 'access',
  reference: 'sop',
};
