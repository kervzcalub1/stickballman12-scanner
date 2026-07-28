# SOP & Help (in-app procedures, search, FAQ)

The written procedures for every feature, per role, served from inside the app.
Screen: `src/screens/Sop.jsx`. Content: `src/lib/sop/*`. Nothing is fetched — the
whole library is static data bundled with the app, so it works on a warehouse
phone with no signal to the API.

## Where it lives
| Role | Entry point | Route |
|---|---|---|
| warehouse / admin / superadmin | Home → **Help** → "SOP & Help" | `/sop` |
| ph_team (and superadmin in PH mode) | PH home → **Help** card | `/ph/sop` |
| supplier | Top bar **How-to** button on the shipments list | (no route — a `help` flag in `SupplierApp`) |

`sop` is in `ROUTES` (`src/lib/constants.js`) and `PH_PATHS` (`src/lib/ph.js`).
The supplier portal has no home screen to hang a card on, so it toggles state
rather than routing.

## Content model (`src/lib/sop/index.js`)
An article is DATA, not JSX, so one entry can be rendered as a page, matched by
search, and cross-linked without duplicating copy.

```js
{ id, title, area, roles[], summary, when,
  steps: [{ do, note?, warn? }],   // numbered on render — don't number in the data
  rules?: [string],                // the "never do this" list
  diagram?, shot?, related?: [id], keywords?: [string] }
```

- **Files:** `articles.warehouse.js` · `articles.ph.js` · `articles.supplier.js` ·
  `articles.admin.js` · `articles.reference.js` · `faq.js`. `index.js` concatenates
  them and owns the vocabulary (`SOP_ROLES`, `SOP_AREAS`, `SOP_KEYWORDS`).
- **Roles:** `visibleTo()` — admin/superadmin see everything (they supervise every
  desk), mirroring `isPrivileged()` on the server. A default role is pre-selected
  from the signed-in user, except for admins, who get "All roles" (pre-filtering
  would hide work from them).
- **FAQ** entries are `{ id, q, a, area, roles, see?, keywords? }`. `see` links to
  an article id; that article's page also renders every FAQ pointing at it. The bar
  for a FAQ: a real misunderstanding, answered in one paragraph. Anything needing
  steps is an article.

## Search
One flat normalized haystack per document, built once at module load; matching is
AND-over-terms, scored so a title hit outranks a body hit and a procedure beats a
FAQ on a tie. ~50 documents — deliberately not a search engine. Role filter applies
before matching. Query, role and open article live in `?q=` / `?role=` / `?a=` so a
refresh, Back, and a link pasted into the group chat all land in the same place.

## Schematics (`src/components/SopDiagram.jsx`)
13 hand-laid inline SVG diagrams (plus one HTML permission matrix), registered in
`DIAGRAMS` and referenced by an article's `diagram` key. `hasDiagram(id)` guards
rendering.

**Colour comes from CSS classes (`.sd-*` in `styles.css`), never from `fill=` /
`stroke=` attributes** — CSS custom properties do not resolve inside SVG
presentation attributes on the older iPhones the warehouse runs, so
`fill="var(--panel-2)"` would render nothing at all. Same reasoning as the
three-stop accent tokens (no `color-mix()`).

The role map is an HTML `<table>`, not SVG: a permission grid is tabular data, and
SVG would cost accessibility and wrap badly on a phone for no gain.

Diagrams scroll inside their own `overflow-x: auto` container (`.sd-canvas`, SVG
`min-width: 560px`) so the page body never scrolls horizontally.

## Annotated screenshots
`npm run sop:shots` (`scripts/capture-sop-shots.mjs`) drives the **real app** in
Playwright, writes `public/sop/<id>.png`, and regenerates `src/lib/sop/shots.json`.

**Each callout is a LOCATOR, and its rectangle is read out of the live DOM at
capture time.** A UI change moves the arrow on the next re-capture instead of
leaving it pointing at blank space — which is what always rots hand-annotated
documentation. A hotspot whose locator no longer resolves is **skipped and
reported**, never guessed at, so a stale callout disappears rather than lying.

**15 shots:** home · receiving step 1 · batches · inventory · shelve · no-box ·
listings · reconcile · locations · access · PH grid · PO create · PO status ·
supplier list · supplier order.

- Auth for **staff** shots reuses `e2e/helpers/auth.js` `loginAs` (a minted signed
  session), so no passwords are needed. Requires the dev server on `:5189`
  (`E2E_PORT`/`SOP_PORT`) and a local DB with data.
- Auth for **supplier** shots does a **real login** (`loginSupplier`). A supplier
  cannot be faked the way staff can: every `/api/po/*` endpoint scopes them by
  `supplier_user_id`, so a minted token with a made-up `uid` authenticates fine and
  then sees **zero orders** — the shot would be of an empty portal. Credentials come
  from `SOP_SUPPLIER_USERNAME` / `SOP_SUPPLIER_PASSWORD` in the git-ignored `.env`
  (documented blank in `.env.example`), never from the script. Unset → supplier shots
  are **skipped with a message, not failed**, so the run still works for everyone else.
  The login host-gate exempts `localhost`, so a supplier can sign in locally.
- `prep: [selector]` clicks a date filter or panel first — a screen documented in
  its empty state teaches nothing.
- Rects are read in **viewport** coordinates (the screenshot is the viewport, not
  the full page) and rejected if they fall outside the frame. Horizontal overflow
  is the common case: a wide table row inside a scroll container reports its full
  scroll width, not the visible slice.
- Captured at `deviceScaleFactor: 2` but `w`/`h` in the manifest are **CSS px** —
  the overlay only needs a proportional coordinate space.
- `SopShot` renders markers + arrows on the image and the **wording in an HTML
  legend underneath**. Label text baked into a 1280px-wide image is unreadable on a
  390px phone; a legend stays full size, selectable and translatable.
- Missing shot or a pruned PNG → renders nothing (`hasShot`, plus an `onError`
  guard), so an article never shows a broken frame.

## Working on it
- Adding a procedure: add the object to the right `articles.*.js` file. Nothing
  else to register — it appears in the index, the search index and the role filter.
- Changing behaviour in the app: update the matching article's `steps`/`rules` in
  the same PR you'd update this `docs/context/*` file.
- Re-capture after a visual change: `npm run dev -- --port 5189 --strictPort`, then
  `npm run sop:shots` (or `npm run sop:shots -- inventory batches` for a subset).
  Re-runs merge, so a partial run does not wipe the other shots.
- Smoke coverage in `e2e/smoke.spec.js` asserts the **wiring** (routing, search,
  role filtering, deep links) — the prose is reviewed, not tested.
