// Capture the annotated screenshots used by the SOP pages.
//
//   npm run sop:shots            # all shots
//   npm run sop:shots -- inventory batches   # only these ids
//
// Writes public/sop/<id>.png and rewrites src/lib/sop/shots.json.
//
// The point of doing this in Playwright rather than by hand: each callout is a
// LOCATOR, and its rectangle is read out of the live DOM at capture time. A UI
// change moves the arrow on the next re-capture instead of leaving it pointing at
// blank space — which is what always rots hand-annotated documentation.
//
// A hotspot whose locator no longer resolves is SKIPPED and reported, never
// guessed at, so a stale callout disappears rather than lying.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAs } from '../e2e/helpers/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'sop');
const JSON_OUT = path.join(ROOT, 'src', 'lib', 'sop', 'shots.json');
const PORT = Number(process.env.SOP_PORT) || Number(process.env.E2E_PORT) || 5189;
const BASE = `http://localhost:${PORT}`;

// Documentation viewport: wide enough for the real desktop layout, short enough
// that the resulting figure is still readable inside an article column.
const VIEWPORT = { width: 1280, height: 820 };

// `at` is a Playwright locator factory; the first one that resolves to a visible
// element wins, so a screen with two plausible anchors still annotates.
const hot = (label, selectors, side = 'left') => ({ label, selectors: [].concat(selectors), side });

const SHOTS = [
  {
    id: 'home',
    role: 'admin',
    path: '/',
    caption: 'Home is laid out along the lifecycle of a shoe. "Needs attention" only appears when something is actually waiting.',
    ready: '.home-grid',
    hotspots: [
      hot('Your name and role — check this is the right account before you start', '.home-greeting', 'below'),
      hot('Work that needs a decision today. Cards only show here when their count is above zero.', '.home-section[data-accent="attention"]', 'right'),
      hot('Sections follow the shoe: Receiving → In-Store → Put-away → Rescale → Sell & Ship → Browse', '.home-section-title >> nth=1', 'right'),
    ],
  },
  {
    id: 'receiving-step1',
    role: 'warehouse',
    path: '/receiving',
    caption: 'Step 1 of the receiving wizard. Supplier and tracking are both required — the server rejects a batch without them.',
    ready: '.batch-form',
    hotspots: [
      hot('Supplier — required. Pick from the list, or "Custom…" to add a new one (it is saved for next time).', 'select >> nth=0', 'right'),
      hot('Tracking number — required. Type it, scan the barcode, or photograph the label.', '.track-field', 'right'),
      hot('Boxes expected. Set above 1 and this becomes a per-box list, each with its own tracking number.', 'input[type="number"] >> nth=0', 'right'),
    ],
  },
  {
    id: 'batches',
    role: 'warehouse',
    path: '/batches',
    caption: 'Every intake. Open batches are resumable; a box showing a red 0 has a tracking number but no items.',
    ready: '.batch-nav-list',
    hotspots: [
      hot('Open batches are resumable — tap one to see its boxes, or to add a box that arrived late.', '.batch-nav-row >> nth=0', 'right'),
      hot('Boxes received / expected, and the item count. An "Empty" badge means nothing was scanned in.', '.batch-nav-prog >> nth=0', 'left'),
    ],
  },
  {
    id: 'inventory',
    role: 'warehouse',
    path: '/inventory',
    caption: 'Rows merge by SKU and status. Scan a VIN to jump to a pair, or a shelf code to list that shelf.',
    prep: ['.seg-btn:has-text("Month")'],
    ready: '.inv-table',
    hotspots: [
      hot('Search — a VIN, SKU or name. A shelf code (MNH-WH-A2-04) returns that shelf\'s contents instead.', 'input[type="search"], input[placeholder*="earch"] >> nth=0', 'right'),
      hot('Filters: date, supplier, status, and intake (receiving / rescale / in-store).', 'select >> nth=0', 'below'),
      hot('Sizes as quantity chips with a total. Tick the row to select every pair in it for a bulk action.', ['.inv-col-size >> nth=0', '.inv-trow >> nth=0'], 'left'),
    ],
  },
  {
    id: 'shelve',
    role: 'warehouse',
    path: '/shelve',
    caption: 'Put-away. Scan the shelf first, then each VIN onto it — or pick from the list of shoes waiting for a shelf.',
    ready: '.app',
    hotspots: [
      hot('Two modes: scan a shelf then the shoes, or pick from the pending list and assign a shelf.', '.tabs, .tab >> nth=0', 'below'),
      hot('Every scan flashes green (accepted) or amber (duplicate or refused) and buzzes the device.', 'input >> nth=0', 'below'),
    ],
  },
  {
    id: 'nobox',
    role: 'warehouse',
    path: '/nobox',
    caption: 'Pairs received without a box. Not sellable, and hidden from the listing grid until resolved.',
    prep: ['.seg-btn:has-text("Month")'],
    ready: '.app',
    hotspots: [
      hot('"Box found → With Box" makes the pair sellable again and sends it to Needs shelf.', 'button:has-text("Box found")', 'right'),
      hot('Print box labels lives only on this page — it recreates a shoe-box label with a UPC barcode.', 'button:has-text("box label"), button:has-text("Box label")', 'left'),
    ],
  },
  {
    id: 'listings',
    role: 'warehouse',
    path: '/report',
    caption: 'Listings & Sync, warehouse view: read-only, and Global indicator / Final price are hidden.',
    prep: ['.seg-btn:has-text("Month")'],
    ready: '.app',
    hotspots: [
      hot('II · AL · SX · SH — a badge reads "on" only when every pair in the group has that flag.', '.sync-badges, .sb, .badges >> nth=0', 'left'),
      hot('One row per SKU and status. Click it to expand the per-size table, where every field actually lives.', '.ph-trow >> nth=0 >> td >> nth=1', 'right'),
    ],
  },
  {
    id: 'reconcile',
    role: 'warehouse',
    path: '/reconcile',
    caption: 'PO reconciliation. The chip says what is actually true — a clean order closes itself and never appears here.',
    ready: '.app',
    hotspots: [
      hot('Active / Archived. The archive is loaded only when you open it, so the live queue stays fast.', 'button:has-text("Archived")', 'below'),
      hot('The chip: Reconciled · Receiving · Received blind · N discrepancies · Boxes still out · Matched.', '.po-chip >> nth=0', 'right'),
    ],
  },
  {
    id: 'locations',
    role: 'warehouse',
    path: '/locations',
    caption: 'Locate Shoe. Search for a pair, or browse the tiles down Site → Area → Bay → Shelf.',
    ready: '.app',
    hotspots: [
      hot('Search by name, SKU, VIN or UPC — or scan. Results group by SKU with a shelved / not-shelved count.', 'input >> nth=0', 'right'),
      hot('Each tile is a real URL, so Back drills up and a shelf can be linked to someone.', '.loc-tile, .tile >> nth=0', 'right'),
    ],
  },
  {
    id: 'access',
    role: 'admin',
    path: '/access',
    caption: 'Check Access. Approve accounts, change roles, issue a temporary password, or remove an account.',
    ready: '.access-table, .app',
    hotspots: [
      hot('Role picker — Warehouse or PH Team for staff, Supplier for an external partner.', '.role-select >> nth=0', 'right'),
      hot('Reset password shows a temporary password ONCE. Only its hash is stored.', 'button:has-text("Reset")', 'left'),
    ],
  },
  {
    id: 'ph-grid',
    role: 'ph_team',
    path: '/ph/new-inventory',
    caption: 'New Inventory. One row per SKU and status; expand it for the per-size table where every field lives.',
    prep: ['.seg-btn:has-text("Month")'],
    ready: '.app',
    hotspots: [
      hot('Date range — work the intake you are pricing. Days are Eastern, wherever you are sitting.', '.cal-modes', 'below'),
      hot('Refresh prices re-pulls the Global Indicator for everything on screen and recomputes Final.', '.ph-gi-refresh-btn', 'left'),
      hot('Click a row to expand its per-size table; click Edit to change it. One row at a time per session.', '.ph-trow >> nth=0 >> td >> nth=1', 'right'),
    ],
  },
  {
    id: 'po-create',
    role: 'ph_team',
    path: '/ph/purchase-orders',
    caption: 'Opening a purchase order: the supplier, and one row per shipping label with its real tracking number.',
    ready: '.app',
    hotspots: [
      hot('The supplier account that will scan this order out.', 'select >> nth=0', 'right'),
      hot('Drop a labels PDF here — one label per page — and each page\'s tracking number and courier are read off it.', '.po-dropzone', 'right'),
      hot('One row per shipping label. Set the courier — that is what makes tracking pull from the right carrier.', ['.po-label-carrier >> nth=0', '.po-label-row >> nth=0'], 'left'),
    ],
  },
  {
    id: 'po-overview',
    role: 'ph_team',
    path: '/ph/po-status',
    caption: 'Every order you opened, with live tracking per shipping label.',
    ready: '.app',
    hotspots: [
      hot('Status chip, labels shipped, delivered count and units — then tap to expand per-label tracking.', '.po-ov-head >> nth=0', 'right'),
    ],
  },
  // Supplier portal. Needs a REAL login (see loginSupplier) — a minted token with a
  // made-up uid authenticates but scopes to zero orders, so the shot would be of an
  // empty portal.
  {
    id: 'supplier-list',
    role: 'supplier',
    path: '/',
    caption: 'The supplier portal: every order we opened for you. Nothing else on the system is visible here.',
    ready: '.po-list',
    hotspots: [
      hot('The order code. Quote this when you message us about a shipment.', '.po-code >> nth=0', 'right'),
      hot('How many of your labels are shipped, and how many units you declared. A replacement we sent is not counted here.', '.po-card-meta >> nth=0', 'right'),
    ],
  },
  {
    id: 'supplier-order',
    role: 'supplier',
    path: '/',
    caption: 'One order: a card per shipping label, each with its own tracking number, status and contents.',
    prep: ['.po-card >> nth=0'],
    ready: '.po-box',
    hotspots: [
      hot('Refresh all tracking at once, or use the per-label button lower down to check just one.', '.po-track-refresh', 'right'),
      hot('Each shipping label is its own card, with its own tracking number and unit count.', '.po-box >> nth=0 >> .po-card-top', 'right'),
      hot('Scan the shoes into this label. Re-scanning the same shoe bumps its quantity; each line\'s size and quantity stay editable while the label is open.', 'button:has-text("Add items")', 'left'),
      hot('Close the label once it is packed. You can reopen it to edit, then mark it shipped when the courier has it.', 'button:has-text("Review & close box")', 'right'),
      hot('The label\'s state: filling → packed → shipped → in transit → delivered.', '.po-box .po-chip >> nth=0', 'left'),
    ],
  },
];

// ---------------------------------------------------------------------------

// Staff shots mint their own session (`loginAs`) because the token payload is
// trusted without a DB lookup. A SUPPLIER cannot be faked that way: every /api/po/*
// endpoint scopes them by `supplier_user_id`, so the token needs the real `users.id`
// — a made-up uid authenticates fine and then sees zero orders. So we do a real
// login and let the server hand back the correct identity.
//
// Credentials come from the environment (SOP_SUPPLIER_USERNAME / _PASSWORD in the
// git-ignored .env), never from this file. Unset → supplier shots are SKIPPED, not
// failed, so `npm run sop:shots` still works for everyone else.
const SUPPLIER_CREDS = process.env.SOP_SUPPLIER_USERNAME && process.env.SOP_SUPPLIER_PASSWORD
  ? { username: process.env.SOP_SUPPLIER_USERNAME, password: process.env.SOP_SUPPLIER_PASSWORD }
  : null;

async function loginSupplier(page) {
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: SUPPLIER_CREDS });
  if (!res.ok()) throw new Error(`supplier login failed (${res.status()})`);
  const { token, user } = await res.json();
  if (user?.role !== 'supplier') throw new Error(`SOP_SUPPLIER_USERNAME is a '${user?.role}', not a supplier`);
  const userJson = JSON.stringify(user);
  await page.addInitScript(([t, u]) => {
    sessionStorage.setItem('sb_session_token', t);
    sessionStorage.setItem('sb_user', u);
  }, [token, userJson]);
}

async function resolveHotspot(page, hs) {
  for (const sel of hs.selectors) {
    const loc = page.locator(sel).first();
    try {
      if (!(await loc.isVisible({ timeout: 500 }))) continue;
      // Read the rect in VIEWPORT coordinates — the screenshot is the viewport,
      // not the full page, so a document-space rect would be offset by the scroll.
      const box = await loc.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      if (!box || box.w < 4 || box.h < 4) continue;
      // Outside the frame — annotating it would point off the image. Horizontal
      // overflow is the common one: a wide table row inside a scroll container
      // reports its full scroll width, not the slice that is actually visible.
      if (box.y + box.h > VIEWPORT.height || box.y < 0) continue;
      if (box.x < 0 || box.x + box.w > VIEWPORT.width) continue;
      return {
        x: Math.round(box.x - 4), y: Math.round(box.y - 4),
        w: Math.round(box.w + 8), h: Math.round(box.h + 8),
        side: hs.side, label: hs.label,
      };
    } catch { /* try the next selector */ }
  }
  return null;
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  let wanted = only.length ? SHOTS.filter((s) => only.includes(s.id)) : SHOTS;
  if (!SUPPLIER_CREDS) {
    const skipped = wanted.filter((s) => s.role === 'supplier');
    if (skipped.length) console.log(`  · skipping ${skipped.length} supplier shot(s) — set SOP_SUPPLIER_USERNAME / _PASSWORD in .env`);
    wanted = wanted.filter((s) => s.role !== 'supplier');
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Merge into whatever is already captured, so a partial re-run does not wipe
  // the other shots.
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(JSON_OUT, 'utf8')); } catch { /* first run */ }

  const browser = await chromium.launch();
  let captured = 0;
  const problems = [];

  for (const shot of wanted) {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    try {
      if (shot.role === 'supplier') await loginSupplier(page);
      else await loginAs(page, shot.role);
      await page.goto(`${BASE}${shot.path}`, { waitUntil: 'networkidle', timeout: 20_000 });
      // `prep` widens a date filter or opens a panel so the frame shows real rows.
      // A screen documented in its empty state teaches nothing. Missing prep
      // targets are ignored — the shot is still worth having.
      for (const sel of shot.prep || []) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 2000 })) { await loc.click(); await page.waitForTimeout(900); }
        } catch { /* nothing to prepare on this run */ }
      }
      if (shot.ready) await page.locator(shot.ready).first().waitFor({ state: 'visible', timeout: 10_000 });
      // Let the live-refresh / lazy images settle so the frame is not half-drawn.
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.scrollTo(0, 0));

      const hotspots = [];
      for (const hs of shot.hotspots) {
        const r = await resolveHotspot(page, hs);
        if (r) hotspots.push({ n: hotspots.length + 1, ...r });
        else problems.push(`${shot.id}: no element for "${hs.label.slice(0, 48)}…"`);
      }

      const file = path.join(OUT_DIR, `${shot.id}.png`);
      await page.screenshot({ path: file, fullPage: false });
      manifest[shot.id] = {
        file: `/sop/${shot.id}.png`,
        w: VIEWPORT.width, h: VIEWPORT.height,
        caption: shot.caption,
        hotspots,
      };
      captured++;
      console.log(`  ✓ ${shot.id}  (${hotspots.length}/${shot.hotspots.length} callouts)`);
    } catch (e) {
      problems.push(`${shot.id}: ${e.message.split('\n')[0]}`);
      console.log(`  ✗ ${shot.id}  ${e.message.split('\n')[0]}`);
    } finally {
      await ctx.close();
    }
  }

  await browser.close();

  // Drop shots whose PNG is not on disk, so shots.json can never point at a file
  // that was pruned — SopShot would render an empty frame.
  for (const id of Object.keys(manifest)) {
    if (!fs.existsSync(path.join(OUT_DIR, `${id}.png`))) delete manifest[id];
  }
  fs.writeFileSync(JSON_OUT, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\n${captured}/${wanted.length} shots captured → public/sop/`);
  if (problems.length) {
    console.log(`\n${problems.length} callout(s) could not be anchored (skipped, not guessed):`);
    problems.forEach((p) => console.log(`  · ${p}`));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
