// SOP library — the vocabulary (roles / areas) plus the article registry and the
// search index the SOP screen queries.
//
// An SOP article is DATA, not JSX, so the same entry can be rendered as a page,
// matched by search, and cross-linked without duplicating the copy. Shape:
//
//   {
//     id, title, area, roles[], summary,
//     when,                    // when in the day this procedure applies
//     steps: [{ do, note?, warn? }],
//     rules?: [string],        // hard rules — the "never do this" list
//     diagram?: <SopDiagram id>,
//     shot?: <capture id from shots.json> | [ids],   // several = a figure per screen
//     related?: [article id],
//     keywords: [string],      // extra search terms not present in the prose
//   }
//
// Keep prose in the voice of the person doing the job ("scan the box", not "the
// user scans"). Steps are numbered on render — don't number them here.
import { WAREHOUSE_ARTICLES } from './articles.warehouse.js';
import { PH_ARTICLES } from './articles.ph.js';
import { SUPPLIER_ARTICLES } from './articles.supplier.js';
import { ADMIN_ARTICLES } from './articles.admin.js';
import { REFERENCE_ARTICLES } from './articles.reference.js';
import { PAYOUT_ARTICLES } from './articles.payout.js';
import { FAQ } from './faq.js';

// Roles, in the order the filter bar shows them. `key` matches users.role except
// `all`, the default view.
export const SOP_ROLES = [
  { key: 'all', label: 'All roles', blurb: 'Every procedure in the system' },
  { key: 'warehouse', label: 'Warehouse', blurb: 'Receive, shelve, pick, ship' },
  { key: 'ph_team', label: 'PH Team', blurb: 'Price, list & sync to the stores' },
  { key: 'supplier', label: 'Supplier', blurb: 'Scan out and ship an order' },
  { key: 'admin', label: 'Admin', blurb: 'Accounts, settings, oversight' },
  { key: 'superadmin', label: 'Super Admin', blurb: 'Admin + the PH workspace' },
];

// Feature areas — the left-hand grouping. `accent` reuses the Home section accent
// tokens ([data-accent] in styles.css) so the SOP reads like the app it documents.
export const SOP_AREAS = [
  { key: 'start', label: 'Getting started', accent: 'listing' },
  { key: 'intake', label: 'Receiving & intake', accent: 'shipping' },
  { key: 'po', label: 'Purchase orders', accent: 'orders' },
  { key: 'instore', label: 'In-store mode', accent: 'inventory' },
  { key: 'putaway', label: 'Put-away & locations', accent: 'orders' },
  { key: 'rescale', label: 'Rescale', accent: 'requests' },
  { key: 'listing', label: 'Pricing & listing', accent: 'listing' },
  { key: 'fulfil', label: 'Sell & ship', accent: 'shipping' },
  { key: 'browse', label: 'Browse, search & labels', accent: 'listing' },
  { key: 'admin', label: 'Administration', accent: 'orders' },
  { key: 'reference', label: 'Reference', accent: 'requests' },
];

export const SOP_ARTICLES = [
  ...WAREHOUSE_ARTICLES,
  ...PH_ARTICLES,
  // Its own file because it belongs to no single desk — warehouse, PH and admin all
  // buy off it. See the note at the top of articles.payout.js.
  ...PAYOUT_ARTICLES,
  ...SUPPLIER_ARTICLES,
  ...ADMIN_ARTICLES,
  ...REFERENCE_ARTICLES,
];

export { FAQ };

export const areaLabel = (k) => (SOP_AREAS.find((a) => a.key === k) || {}).label || k;
export const areaAccent = (k) => (SOP_AREAS.find((a) => a.key === k) || {}).accent || 'listing';
export const roleLabelSop = (k) => (SOP_ROLES.find((r) => r.key === k) || {}).label || k;
export const articleById = (id) => SOP_ARTICLES.find((a) => a.id === id);

// An article is visible to a role only if it lists that role.
//
// Cross-cutting procedures are not special-cased here — they simply LIST every role
// they apply to (the Reference and Getting-started articles carry the full staff or
// all-roles list), so a warehouse account still gets "what scans as what" while never
// seeing the PH pricing grid. admin/superadmin appear in the staff articles' own role
// lists, so supervising still works without a blanket override: previously
// `role === 'admin'` returned true for EVERYTHING, which meant an admin browsing as
// "Supplier" was shown warehouse procedures too.
// Which SOP role an ACCOUNT is allowed to read. warehouse / ph_team / supplier are
// LOCKED to their own desk's procedures; admin and superadmin browse everything.
//
// This is a permission rule, not a filter default, so it lives beside the search it
// governs — the SOP screen and the app-wide advisor both apply it, and a rule copied
// into two files is a rule that eventually disagrees with itself.
export const SOP_LOCKED_ROLES = ['warehouse', 'ph_team', 'supplier'];
export const sopRoleForAccount = (role) => (SOP_LOCKED_ROLES.includes(role) ? role : 'all');

export function visibleTo(article, role) {
  if (role === 'all') return true;
  return article.roles.includes(role);
}

// --- Search -----------------------------------------------------------------
// One flat haystack per article/FAQ, built once at module load. Matching is
// AND-over-terms on a normalized string, so "shelve no box" finds the put-away
// refusal rule regardless of field or word order. Scoring is deliberately simple
// (title hits outrank body hits) — the corpus is ~50 documents, not a search
// engine's worth.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function articleHaystack(a) {
  const steps = (a.steps || []).map((s) => `${s.do} ${s.note || ''} ${s.warn || ''}`).join(' ');
  return norm([a.title, a.summary, a.when, steps, (a.rules || []).join(' '), (a.keywords || []).join(' '), areaLabel(a.area), a.roles.map(roleLabelSop).join(' ')].join(' '));
}

const INDEX = [
  ...SOP_ARTICLES.map((a) => ({ kind: 'article', id: a.id, title: a.title, area: a.area, roles: a.roles, ref: a, hay: articleHaystack(a), titleHay: norm(a.title) })),
  ...FAQ.map((f) => ({ kind: 'faq', id: f.id, title: f.q, area: f.area, roles: f.roles, ref: f, hay: norm(`${f.q} ${f.a} ${(f.keywords || []).join(' ')}`), titleHay: norm(f.q) })),
];

export function searchSop(query, role = 'all') {
  const terms = norm(query).split(' ').filter(Boolean);
  // Same rule as visibleTo — search must never surface a procedure the browse list
  // won't show, or a locked account could reach another desk's SOP through the box.
  const pool = INDEX.filter((e) => role === 'all' || e.roles.includes(role));
  if (!terms.length) return [];
  return pool
    .map((e) => {
      if (!terms.every((t) => e.hay.includes(t))) return null;
      // Whole-phrase title match ranks top, then per-term title hits, then body.
      let score = 0;
      if (e.titleHay.includes(terms.join(' '))) score += 100;
      terms.forEach((t) => { if (e.titleHay.includes(t)) score += 10; });
      if (e.kind === 'article') score += 2; // a procedure beats a FAQ on a tie
      return { ...e, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

// The chips under the search box: the terms people actually arrive with. Each
// maps to a query, not an article, so one chip can surface a procedure + its FAQ.
export const SOP_KEYWORDS = [
  'VIN', 'UPC', 'SKU', 'barcode scan', 'no box', 'shelve', 'shelf code', 'batch',
  'tracking number', 'purchase order', 'reconcile', 'discrepancy', 'supplier',
  'rescale', 'restock', 'global indicator', 'final price', 'margin', 'sync',
  'Intelligent Inventory', 'Alias', 'StockX', 'Shopify', 'GOAT only', 'in-store',
  'sold', 'shipped', 'labels', 'print', 'photos', 'password', 'roles', 'in stock',
  'payout', 'markup', 'ROI', 'buy call',
];
