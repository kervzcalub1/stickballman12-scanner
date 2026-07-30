// PILOT — record a narrated-by-caption screen tutorial of a real flow.
//
//   npm run dev -- --port 5189 --strictPort
//   node scripts/capture-sop-video.mjs [id...]
//
// Same principle as capture-sop-shots.mjs: drive the REAL app in Playwright so the
// tutorial cannot drift from the product. A UI change is re-recorded, not re-edited.
//
// Three things a raw Playwright recording lacks as a tutorial, all fixed here:
//   1. NO CURSOR. Playwright's video shows clicks landing with nothing visibly doing
//      the clicking, which is unwatchable as instruction. We inject a fake pointer and
//      move it to each target before acting, with a click pulse.
//   2. NO NARRATION. There is no TTS tool available in this environment, so the
//      spoken track is replaced by on-screen captions — which also survive muted
//      autoplay and a noisy warehouse, and are translatable.
//   3. NO PACING. Real automation acts instantly. Every step holds long enough to read.
//
// Overlays are injected via addInitScript so they survive navigation, and they live in
// a shadow-free fixed layer with a z-index above the app's modals.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loginAs } from '../e2e/helpers/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.VIDEO_OUT || path.join(ROOT, 'sop-videos');
const PORT = Number(process.env.SOP_PORT) || Number(process.env.E2E_PORT) || 5189;
const BASE = `http://localhost:${PORT}`;
const SIZE = { width: 1280, height: 820 };

// Injected into every document: a caption bar and a fake pointer.
const OVERLAY = () => {
  const add = () => {
    if (document.getElementById('__vo')) return;
    const s = document.createElement('style');
    s.textContent = `
      #__vo{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;
        justify-content:center;pointer-events:none;padding:0 0 34px}
      #__vo b{font:600 24px/1.45 system-ui,-apple-system,sans-serif;color:#fff;
        background:rgba(10,12,18,.92);border:1px solid rgba(255,255,255,.14);
        border-radius:14px;padding:14px 26px;max-width:70%;text-align:center;
        box-shadow:0 10px 40px rgba(0,0,0,.55);opacity:0;transition:opacity .35s}
      #__vc{position:fixed;z-index:2147483647;width:26px;height:26px;left:0;top:0;
        pointer-events:none;transition:transform .55s cubic-bezier(.4,0,.2,1);
        transform:translate(-100px,-100px)}
      #__vc svg{filter:drop-shadow(0 2px 5px rgba(0,0,0,.7))}
      #__vr{position:fixed;z-index:2147483646;width:44px;height:44px;margin:-22px 0 0 -22px;
        border-radius:50%;border:3px solid #6c8cff;opacity:0;pointer-events:none;
        transform:translate(-100px,-100px) scale(.4)}
      #__vr.go{animation:__vp .55s ease-out}
      @keyframes __vp{0%{opacity:.9;transform:var(--p) scale(.4)}
                     100%{opacity:0;transform:var(--p) scale(1.5)}}`;
    document.head.appendChild(s);
    const cap = document.createElement('div');
    cap.id = '__vo'; cap.innerHTML = '<b></b>';
    const cur = document.createElement('div');
    cur.id = '__vc';
    cur.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 2l6.5 17 2.2-6.9 6.9-2.2z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    const ring = document.createElement('div');
    ring.id = '__vr';
    document.body.append(cap, cur, ring);
  };
  if (document.body) add();
  else document.addEventListener('DOMContentLoaded', add);
  window.__say = (t) => {
    const b = document.querySelector('#__vo b');
    if (!b) return;
    b.style.opacity = '0';
    setTimeout(() => { b.textContent = t; b.style.opacity = t ? '1' : '0'; }, 200);
  };
  window.__move = (x, y) => {
    const c = document.getElementById('__vc');
    if (c) c.style.transform = `translate(${x}px, ${y}px)`;
  };
  window.__pulse = (x, y) => {
    const r = document.getElementById('__vr');
    if (!r) return;
    r.style.setProperty('--p', `translate(${x}px, ${y}px)`);
    r.classList.remove('go'); void r.offsetWidth; r.classList.add('go');
  };
};

const wait = (page, ms) => page.waitForTimeout(ms);

// Caption + hold. Pacing is generous on purpose: this is instruction, not a demo reel.
async function say(page, text, ms = 2600) {
  await page.evaluate((t) => window.__say(t), text);
  await wait(page, ms);
}

async function centerOf(page, sel) {
  const loc = page.locator(sel).first();
  await loc.waitFor({ state: 'visible', timeout: 10_000 });
  const b = await loc.boundingBox();
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, loc } : null;
}

// Move the pointer, let it land, then act — so the viewer sees WHAT is being clicked.
async function point(page, sel) {
  const c = await centerOf(page, sel);
  if (!c) return null;
  // Only the coordinates cross into the page — `c.loc` is a Locator and is not serializable.
  await page.evaluate(({ x, y }) => window.__move(x, y), { x: c.x, y: c.y });
  await wait(page, 650);
  return c;
}

async function click(page, sel) {
  const c = await point(page, sel);
  if (!c) return false;
  await page.evaluate(({ x, y }) => window.__pulse(x, y), { x: c.x, y: c.y });
  await wait(page, 180);
  await c.loc.click();
  await wait(page, 700);
  return true;
}

// Type visibly — fill() would teleport the text in and show nothing being entered.
async function type(page, sel, text) {
  const c = await point(page, sel);
  if (!c) return;
  await c.loc.click();
  await c.loc.fill('');
  await c.loc.pressSequentially(text, { delay: 55 });
}

// --- Beats -------------------------------------------------------------------
// A flow is DATA, the same way an SOP article is. A beat is one caption plus an
// optional action:
//
//   { say, at?, click?, type?: [sel, text], waitFor?, hold? }
//
// `at` points the cursor without clicking; `click` points then clicks; `type` types
// visibly. A beat whose selector does not resolve **still shows its caption** and is
// reported — the narration stays truthful and the video keeps its shape, rather than
// the run dying at step 9 of 14. That is the same rule the screenshot capture uses for
// a stale hotspot: skip and report, never guess.
async function playBeats(page, beats, report) {
  for (const b of beats) {
    if (b.say != null) await page.evaluate((t) => window.__say(t), b.say);
    try {
      if (b.waitFor) await page.locator(b.waitFor).first().waitFor({ state: 'visible', timeout: 8000 });
      if (b.type) await type(page, b.type[0], b.type[1]);
      else if (b.click) { if (!(await click(page, b.click))) report(`click target missing: ${b.click}`); }
      else if (b.at) { if (!(await point(page, b.at))) report(`point target missing: ${b.at}`); }
    } catch (e) {
      report(`${b.click || b.at || b.waitFor || 'beat'} — ${e.message.split('\n')[0].slice(0, 70)}`);
    }
    await wait(page, b.hold ?? (b.say ? Math.min(5200, 1500 + String(b.say).length * 52) : 700));
  }
}

const VIDEOS = [
  {
    id: 'locations-edit-delete',
    role: 'warehouse',
    title: 'Rename, move or delete a location',
    path: '/locations',
    // Non-destructive by construction: it opens the delete confirm to show what it says,
    // and cancels. Nothing in this recording writes to the database.
    async run(page) {
      await say(page, 'Locate Shoe — every shelf, grouped Site → Area → Row → Bay.', 3000);
      await say(page, 'Every tile has a pencil. That is where you rename, move or delete.', 3400);
      await point(page, '.loc-tile:nth-child(1) .loc-tile-edit');
      await say(page, 'On a folder tile it changes EVERY shelf underneath it.', 3200);
      await click(page, '.loc-tile:nth-child(1) .loc-tile-edit');
      await say(page, 'This site has 253 shelf locations under it.', 3000);
      await say(page, 'Type the new name…', 1800);
      await type(page, '.loc-edit-modal .loc-edit-label input', 'Manheim Main Depot');
      await page.locator('.loc-edit-warn').first().waitFor({ state: 'visible', timeout: 10_000 });
      await wait(page, 900);
      await say(page, 'The preview is a real dry run — this is exactly what will happen.', 3800);
      await say(page, 'The site is part of the barcode, so all 253 codes change.', 3600);
      await say(page, 'Reprint those tags, or they stop scanning at put-away.', 3600);
      await say(page, 'The pairs do NOT move. Only their codes change.', 3400);
      await say(page, 'Delete sits apart from Save, and asks separately.', 3000);
      await click(page, '.loc-edit-modal .modal-actions .btn.danger');
      await wait(page, 1200);
      await say(page, 'Deleting a folder deletes every shelf under it.', 3200);
      await say(page, 'Here it is refused: pairs are still shelved underneath.', 3600);
      await say(page, 'Nothing is deleted — not even the empty shelves. Move the stock first.', 4200);
      await say(page, 'To retire a shelf you might want back, deactivate it instead.', 3600);
      await click(page, '.loc-del-modal .modal-actions .btn.ghost');
      await say(page, '', 600);
      await wait(page, 800);
    },
  },

  // ---------------------------------------------------------------- intake --
  {
    id: 'receive-single', role: 'warehouse', title: 'Receive a shipment (one box)', path: '/receiving',
    beats: [
      { say: 'Receiving, step 1 — the shipment header.' },
      { say: 'Supplier is required. Pick one, or "Custom…" to add a new supplier.', at: 'select' },
      { say: 'Tracking is required too — type it, scan the barcode, or photograph the label.', at: '.track-field' },
      { say: 'For a single box, leave "Boxes expected" at 1.' },
      { say: 'Step 2 is where you scan: "+ Add Item", then the shoe box UPC, or type the SKU.' },
      { say: 'Check the size, set the quantity, and tick "With Box" if the pair has its box.' },
      { say: 'Scan no-box pairs SEPARATELY from with-box pairs.' },
      { say: 'Their VINs and printed labels must never get mixed up.' },
      { say: 'Then Review → Issues → Submit. Every pair gets its own VIN and label.' },
    ],
  },
  {
    id: 'receive-multibox', role: 'warehouse', title: 'Receive a multi-box shipment', path: '/receiving',
    beats: [
      { say: 'A shipment that arrives across several boxes, over several days.' },
      { say: 'On step 1, set "Boxes expected" to the number of boxes.' },
      { say: 'You get a row per box. Type or scan each box\'s own tracking number.' },
      { say: 'A box row is saved as soon as it has a tracking number…' },
      { say: '…even before any items — so a box that turned up EMPTY is still on the record.' },
      { say: '"Add items" on a row runs just that box through Items → Review → Issues.' },
      { say: 'Boxes can be done in any order, whenever they turn up.' },
      { say: 'Leaving via Home keeps the batch open — resume it from Home → Batches.' },
      { say: '"Finish batch" only when everything has arrived.' },
    ],
  },
  {
    id: 'receive-against-po', role: 'warehouse', title: 'Receive against a purchase order', path: '/receiving',
    beats: [
      { say: 'When the supplier scanned the order out, receive against the PO.' },
      { say: 'Step 1 → "Receive against a purchase order".' },
      { say: 'Find it by PO code, or by pasting or scanning any of its tracking numbers.' },
      { say: 'Picking it pulls in the supplier, the tag and every shipping label.' },
      { say: 'Each label becomes a box slot, already waiting for you.' },
      { say: 'Print the manifest BEFORE you unpack — "Per box" gives you a checklist per box.' },
      { say: 'Then scan the box in exactly as you would any other box.' },
      { say: 'At the end, read the "batch saved" panel.' },
      { say: 'A red alert means it does not match the manifest — that is the discrepancy to chase.' },
      { say: 'You can receive against an order still in draft. Boxes routinely beat the paperwork.' },
    ],
  },
  {
    id: 'receiving-issues', role: 'warehouse', title: 'Flag damage and defects at intake', path: '/receiving',
    beats: [
      { say: 'Damage is recorded at intake, on the Review step — not later from memory.' },
      { say: 'Expand the size that holds the bad pair, then "＋ Issue" on that exact unit.' },
      { say: 'Pick the defect: crease, dirty, yellowing, glue, missing insole, damaged box…' },
      { say: 'Add a note and photograph it. Photos attach to that unit\'s VIN.' },
      { say: 'More than one defect on one pair is fine, if that is the truth of it.' },
      { say: 'Flagging "No box" as a defect forces that unit to no_box on commit.' },
      { say: 'Same end state as never ticking "With Box" — it cannot be shelved until a box is found.' },
      { say: 'Whole-shipment problems — ripped, stolen, short count — go on the Issues step instead.' },
    ],
  },
  {
    id: 'listing-photos-intake', role: 'warehouse', title: 'Shoot listing photos at intake', path: '/receiving',
    beats: [
      { say: 'Listing photos are shot once, at intake, in the Add Item modal.' },
      { say: 'Five angle slots: side, diagonal, outsole, top, rear.' },
      { say: 'If the SKU already has photos they load in and the button reads "View / replace".' },
      { say: 'Do not re-shoot a SKU that already has a set.' },
      { say: '"Add listing photos" opens the full-screen camera.' },
      { say: 'Tap an angle in the bottom strip, frame the shoe, hit the shutter. Repeat for all five.' },
      { say: 'Unhappy with one? Tap its thumbnail to replace or remove it.' },
      { say: 'A "PH edited on file" banner means PH has finished images already — yours stay as the raw record.' },
    ],
  },
  {
    id: 'batches-manage', role: 'warehouse', title: 'Work with batches (open, resume, finish)', path: '/batches',
    // Imperative, because the useful batch is the one that HAS boxes and CSS can't say
    // "not the empty one". The first row is often a freshly-opened, empty batch, and
    // narrating "expand a box row" over "No boxes yet" teaches nothing.
    async run(page) {
      await say(page, 'Batches — every shipment you have received, open or done.', 3200);
      const withBoxes = page.locator('.batch-nav-row').filter({ hasNotText: '0 boxes' }).first();
      const target = (await withBoxes.count()) ? withBoxes : page.locator('.batch-nav-row').first();
      await say(page, 'Open one to see its boxes, each with its tracking number and item count.', 3600);
      const b = await target.boundingBox();
      if (b) {
        await page.evaluate(({ x, y }) => window.__move(x, y), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
        await wait(page, 650);
        await page.evaluate(({ x, y }) => window.__pulse(x, y), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
        await target.click();
        await wait(page, 1200);
      }
      await say(page, 'Each box row carries its own tracking number and its own item count.', 3600);
      await click(page, '.box-row');
      await say(page, 'Expand a box row to see the shoes inside it.', 3200);
      await say(page, 'Tap any VIN to open that unit\'s full detail and history.', 3400);
      await say(page, 'A red 0 on a box row means tracking was recorded but nothing was scanned in.', 4000);
      await say(page, 'Either the box is still coming, or someone forgot. Both are worth knowing.', 3800);
      await say(page, '"Add box" drops you into the receiving wizard for that batch.', 3400);
      await say(page, 'Finish the batch only when the shipment is genuinely complete.', 3600);
    },
  },

  // -------------------------------------------------------------- in-store --
  {
    id: 'instore-buying', role: 'warehouse', title: 'In-store buying', path: '/instore',
    beats: [
      { say: 'In-store buying — stock bought over the counter, not shipped to us.' },
      { say: 'Step 1 is short: store, date, cost, notes.' },
      { say: 'No supplier, no buyer, no tracking, no boxes — none of it applies.' },
      { say: 'Step 2 scans each pair by box UPC or SKU, exactly as in receiving.' },
      { say: 'Review and Issues work the same — flag defects per pair here.' },
      { say: 'Pairs land as "Needs shelf", or "No box" if the box was not ticked.' },
      { say: 'In-store buys NEVER reach the PH team.' },
      { say: 'They are listed to the stores by hand, on the In-Store Listing page.' },
    ],
  },
  {
    id: 'instore-listing', role: 'warehouse', title: 'In-store listing', path: '/instore-listing',
    beats: [
      { say: 'In-store stock bypasses PH, so listing it is a manual job — this page.' },
      { say: 'Rows are grouped by SKU: list a SKU once and it covers all its sizes.' },
      { say: 'List the shoe by hand on the store site first.' },
      { say: 'Then tick the matching toggle here: Alias, StockX, Shopify.' },
      { say: '"Needs listing only" hides SKUs where all three are already ticked.' },
      { say: 'This page is the ONLY thing that writes those flags.' },
      { say: 'So a SKU group is never half-ticked behind your back by a sync.' },
    ],
  },

  // -------------------------------------------------------------- put-away --
  {
    id: 'shelve-putaway', role: 'warehouse', title: 'Shelve / put-away', path: '/shelve',
    beats: [
      { say: 'Put-away — giving a pair a physical home you can scan against.' },
      { say: 'Two modes. "Scan shelf → shoes" is the classic: shelf tag first, then each VIN onto it.' },
      { say: '"Pick from pending list" is the reverse — choose from shoes waiting for a shelf.' },
      { say: 'Then assign a shelf by scanning, or through the Site → Area → Bay → Shelf picker.' },
      { say: 'Watch the flash banner on every scan.' },
      { say: 'Green means it went on. Amber means duplicate or rejected — do not ignore it.' },
      { say: '"Shelve here" commits. The pairs flip to "In Stock" at that shelf.' },
      { say: 'A pair with NO BOX cannot be shelved. It is refused.' },
      { say: 'Unless you confirm "box found now?", which makes it a with-box pair on the spot.' },
      { say: 'To move stock, just shelve an already-shelved pair onto a new shelf. That is a logged transfer.' },
    ],
  },
  {
    id: 'nobox-resolve', role: 'warehouse', title: 'Resolve the No Box queue', path: '/nobox',
    beats: [
      { say: 'The No Box queue — pairs we hold but cannot sell, because the box is missing.' },
      { say: 'Find the box. That is the whole job. We do not sell without a box.' },
      { say: '"Box found → With Box" makes the pair sellable and moves it to "Needs shelf".' },
      { say: 'If the box genuinely cannot be found, use "Other status…" and set the honest state.' },
      { say: 'Need the pair to scan normally? "Print box labels" recreates a real box label.' },
      { say: 'Vertical UPC barcode, just like the original.' },
      { say: 'That button lives ONLY on this page. That is deliberate.' },
      { say: 'Reprinting a box label is a no-box fix, not a routine reprint.' },
    ],
  },
  {
    id: 'locate-shoe', role: 'warehouse', title: 'Locate a shoe', path: '/locations',
    beats: [
      { say: 'Locate Shoe answers both directions: where is this pair, and what is on this shelf.' },
      { say: 'Search by name, SKU, VIN or UPC.', at: '.loc-search input' },
      { say: 'Or tap Scan and read the VIN label, or the box UPC.', at: 'button:has-text("Scan")' },
      { say: 'Results group by SKU, with an "N shelved · M not shelved" summary.' },
      { say: 'The shelf chip in the "where" column jumps you straight to that shelf.' },
      { say: 'An amber "Not shelved yet" chip means we DO have the pair — it just is not put away.' },
      { say: 'For the reverse, browse the tiles down Site → Area → Bay → Shelf.', at: '.loc-tile:nth-child(1)' },
      { say: 'Every level is a real URL, so Back drills up and you can link someone a shelf.' },
    ],
  },
  {
    id: 'locations-manage', role: 'warehouse', title: 'Manage shelves and print shelf labels', path: '/locations',
    beats: [
      { say: 'Setting up the shelves the warehouse scans against.' },
      { say: '"+ Add shelf" adds one.', at: 'button:has-text("Add shelf")' },
      { say: '"Bulk add" does a whole aisle — one bay per line, "A1 5" meaning bay A1 with 5 shelves.', at: 'button:has-text("Bulk add")' },
      { say: 'For a new site or area, use "＋ Custom…" in the Warehouse and Area pickers.' },
      { say: 'The area picker suggests the selected site\'s own areas first.' },
      { say: 'A shelf code is SITE-AREA-BAY-SHELF — MNH-WH-A2-04.' },
      { say: 'Whole-bay spots like pods drop the shelf part: MNH-PD-1.' },
      { say: 'Codes are globally unique. That is what makes a shelf barcode unmistakable next to a VIN.' },
      { say: 'To print tags: tick the shelves, then "Print labels" in the breadcrumb bar.', at: '.loc-tile-check' },
      { say: 'Folder tiles roll up everything inside them, and there is "Select all" per level.' },
    ],
  },

  // --------------------------------------------------------------- rescale --
  {
    id: 'rescale-stock', role: 'warehouse', title: 'Rescale stock', path: '/rescale',
    beats: [
      { say: 'Rescale puts stock you ALREADY hold back in front of the PH team.' },
      { say: 'No shipment involved — a return, a re-listing, a recount, a transfer.' },
      { say: 'Pick the reason first. It travels with the batch.' },
      { say: 'Then scan each pair by its VIN.' },
      { say: 'VIN, not the box UPC — this is stock we already have, not a fresh intake.' },
      { say: 'Finish, and those pairs appear on PH\'s Rescale Stock worklist.' },
      { say: 'PH re-prices and re-lists them, ticks "Restocked", and they drop off.' },
      { say: 'An in-store pair cannot be rescaled — it returns an error.' },
      { say: 'In-store stock bypasses PH entirely, by design.' },
    ],
  },
  {
    id: 'rescale-requests-audit', role: 'warehouse', title: 'Audit a rescale request from PH', path: '/rescalereq',
    // This page opens on TODAY and on "Open" only, and requests are rare — the first cut
    // filmed "No requests in this range", i.e. a tutorial about a blank page. Widen the
    // window and show every status so there is a real request on screen.
    prep: ['button:has-text("Month")', '.cal-nav button:first-child, button:has-text("‹")', 'button:has-text("All")'],
    beats: [
      { say: 'PH thinks a SKU\'s count is wrong. This is you going to check.' },
      { say: 'Read the request: the SKU, the sizes and quantities PH reported, and their reason.' },
      { say: 'Now go and physically count that SKU on the shelf.' },
      { say: 'Then "Audit shelf" and enter the ACTUAL quantity per size.' },
      { say: 'Add a note explaining anything odd, and save. The request flips to "audited".' },
      { say: 'The comparison grid shows reported on top, actual underneath.' },
      { say: 'Red cells are mismatches. Green cells match.' },
      { say: 'Requests are about a SKU, not specific VINs — it is a counting exercise.' },
    ],
  },

  // ---------------------------------------------------- browse & fulfilment --
  {
    id: 'inventory-browse', role: 'warehouse', title: 'Browse and search inventory', path: '/inventory',
    beats: [
      { say: 'Inventory — everything we hold, however you need to slice it.' },
      { say: 'Search by VIN, SKU or name. Or scan a VIN to jump straight to it.', at: '.searchrow input' },
      { say: 'Type or scan a SHELF code instead, and you get that shelf\'s contents.' },
      { say: 'Narrow it with Day / Week / Month, or a custom date range.', at: '.cal-modes' },
      { say: 'Plus supplier, status and intake filters.' },
      { say: 'Rows merge by SKU and status — sizes show as quantity chips with a total.' },
      { say: 'Expand a row to see the individual pairs.' },
      { say: 'Tap a unit for its detail: full history, listing photos, location, status controls.' },
      { say: 'A pin chip on a row is its shelf. "N shelves" means that merged row is spread across several.' },
    ],
  },
  {
    id: 'inventory-bulk-status', role: 'warehouse', title: 'Change status in bulk', path: '/inventory',
    beats: [
      { say: 'Changing the status of many pairs at once.' },
      { say: 'Tick the rows, or the individual pairs inside them.', at: '.inv-col-check' },
      { say: 'Then the per-group status dropdown, or "Edit status" in the bulk bar.' },
      { say: 'Pick the status and save. Each pair still gets its OWN logged status change.' },
      { say: 'You cannot set "In Stock" this way.' },
      { say: 'A pair is In Stock only once it is physically on a shelf.' },
      { say: 'So picking it here sends you to put-away instead — which is the honest answer.' },
    ],
  },
  {
    id: 'inventory-move-shelf', role: 'warehouse', title: 'Move to shelf without leaving Inventory', path: '/inventory',
    beats: [
      { say: 'Put pairs away without leaving Inventory.' },
      { say: 'Three ways in: the group button, the bulk bar, or a single unit\'s detail.' },
      { say: 'Scan or type the shelf barcode. The shelf name is confirmed back to you.' },
      { say: 'Check the list of pairs, then "Shelve N here".' },
      { say: 'The list refreshes and the moved pairs show their new shelf chip.' },
      { say: 'No-box pairs show a "Box found now" toggle.' },
      { say: 'Leave it unticked and the pair is REFUSED — it belongs in the No Box queue, not on a shelf.' },
    ],
  },
  {
    id: 'print-labels', role: 'warehouse', title: 'Print labels (VIN, box and shelf)', path: '/inventory',
    beats: [
      { say: 'Three kinds of label, three places they come from.' },
      { say: 'VIN labels — Inventory: select pairs, then "Print labels". One per pair.' },
      { say: 'Box labels — the No Box page only. Recreates a box label with a vertical UPC.' },
      { say: 'Shelf labels — Locate Shoe: tick shelves, then "Print labels" in the breadcrumb bar.' },
      { say: 'Then pick your stock: CR80 card is the default.' },
      { say: 'Plus Small 1.1 × 3.5", Rollo, Dymo, Box, and Brother 62 × 100 mm.' },
      { say: 'On a phone the PDF opens in a new tab — use share → Print.' },
      { say: 'On stock smaller than 62 × 100 mm the shoe NAME is left off on purpose.' },
      { say: 'SKU, size and the barcode are what shelving actually needs. The name just shrinks them.' },
    ],
  },
  {
    id: 'mark-sold', role: 'warehouse', title: 'Mark pairs sold', path: '/sold',
    beats: [
      { say: 'Marking pairs sold. Short flow, permanent effect.' },
      { say: 'Scan each VIN — with a gun, or the camera.', at: '.searchrow input' },
      { say: 'Confirm. Each pair is marked sold and logged.' },
      { say: 'Sold clears Intelligent Inventory, Alias, StockX and Shopify in one go.' },
      { say: 'The pair is deliberately pulled from every store at once.' },
      { say: 'This is terminal. A sold pair cannot be scanned back into an active state.' },
    ],
  },
  {
    id: 'mark-shipped', role: 'warehouse', title: 'Mark pairs shipped', path: '/shipped',
    beats: [
      { say: 'Mark Shipped works exactly like Mark Sold.' },
      { say: 'Scan each VIN.', at: '.searchrow input' },
      { say: 'Confirm.' },
      { say: 'Like sold, this clears every store sync flag.' },
      { say: 'And like sold, it is terminal — there is no scanning it back.' },
    ],
  },
  {
    id: 'listings-sync-warehouse', role: 'warehouse', title: 'Read the Listings & Sync grid', path: '/report',
    beats: [
      { say: 'Listings & Sync — what PH has done with the stock you received.' },
      { say: 'One row per SKU and status, with size chips.' },
      { say: 'And four store badges: II, AL, SX, SH.' },
      { say: 'Intelligent Inventory, Alias, StockX, Shopify.' },
      { say: 'Expand a row for the per-size breakdown.' },
      { say: 'Every field is per size, so sizes can legitimately differ from each other.' },
      { say: 'The History button on a size shows who changed what, and when.' },
      { say: 'Global indicator and Final price are hidden from the warehouse role.' },
    ],
  },
  {
    id: 'reconcile-warehouse', role: 'warehouse', title: 'Reconcile a purchase order', path: '/reconcile',
    beats: [
      { say: 'PO Reconciliation — what the supplier said they sent, against what actually landed.' },
      { say: 'The chip on each order says what is actually true.' },
      { say: 'Reconciled, Receiving, Received blind, or N discrepancies.' },
      { say: 'Open an order for the line-by-line table: SKU and size, name, got against expected.' },
      { say: 'Switch between "By size" and "By SKU" depending on what you are chasing.' },
      { say: 'Matched lines fold away, so what is left is the problem.' },
      { say: 'Need it on paper to recount against, or to send with a claim? "Manifest PDF".' },
      { say: 'Then write the note to the supplier — the WHY behind the numbers.' },
      { say: 'A perfectly-matched order closes itself.' },
      { say: 'So if it is in this queue at all, something needs a human.' },
    ],
  },
];

const probeSeconds = (file) => {
  try {
    return Math.round(Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim()));
  } catch { return 0; }
};

// `--reindex` rebuilds index.json from the mp4s already on disk, without re-recording.
// Recovering a lost manifest should not cost 20 minutes of capture.
function reindex() {
  const manifest = {};
  for (const v of VIDEOS) {
    const file = path.join(OUT_DIR, `${v.id}.mp4`);
    if (!fs.existsSync(file)) continue;
    manifest[v.id] = { title: v.title, role: v.role, seconds: probeSeconds(file), file: `${v.id}.mp4` };
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Reindexed ${Object.keys(manifest).length} video(s) → ${path.relative(ROOT, OUT_DIR)}/index.json`);
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (process.argv.includes('--reindex')) return reindex();
  const wanted = only.length ? VIDEOS.filter((v) => only.includes(v.id)) : VIDEOS;
  const browser = await chromium.launch();
  const made = [];
  const problems = [];
  // Merge into whatever is already recorded, so re-recording ONE flow does not drop the
  // other 22 from the manifest — same rule as the screenshot capture's shots.json.
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8')); } catch { /* first run */ }

  for (const v of wanted) {
    const ctx = await browser.newContext({
      viewport: SIZE,
      recordVideo: { dir: OUT_DIR, size: SIZE },
    });
    await ctx.addInitScript(OVERLAY);
    const page = await ctx.newPage();
    const report = (m) => problems.push(`${v.id}: ${m}`);
    try {
      await loginAs(page, v.role);
      await page.goto(`${BASE}${v.path}`, { waitUntil: 'networkidle', timeout: 20_000 });
      await wait(page, 1400);
      // `prep` runs BEFORE the first caption and is not narrated: it puts the screen into
      // the state the procedure is about. Mostly widening a date filter — several pages
      // default to "today", and a tutorial recorded against "No requests in this range"
      // teaches nothing. Missing prep targets are ignored; the flow is still worth having.
      for (const sel of v.prep || []) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 2500 })) { await loc.click(); await wait(page, 900); }
          else report(`prep target missing: ${sel}`);
        } catch { report(`prep failed: ${sel}`); }
      }
      // Title card, so a video shared on its own still says what it is.
      await say(page, v.title, 2600);
      if (v.beats) await playBeats(page, v.beats, report);
      else await v.run(page);
      await page.evaluate(() => window.__say(''));
      await wait(page, 700);
    } catch (e) {
      console.log(`  ✗ ${v.id}  ${e.message.split('\n')[0]}`);
      report(e.message.split('\n')[0].slice(0, 80));
    }
    const video = page.video();
    await ctx.close(); // the .webm is only finalized on context close
    if (video) {
      const webm = path.join(OUT_DIR, `${v.id}.webm`);
      fs.renameSync(await video.path(), webm);
      // webm plays in browsers but not in QuickTime/Preview; ship an mp4 alongside.
      let mp4 = '';
      try {
        mp4 = path.join(OUT_DIR, `${v.id}.mp4`);
        execFileSync('ffmpeg', ['-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          '-vf', 'scale=1280:-2', '-crf', '23', '-preset', 'medium', mp4], { stdio: 'ignore' });
      } catch { mp4 = ''; }
      const kb = (f) => `${Math.round(fs.statSync(f).size / 1024)} KB`;
      made.push(v.id);
      let secs = 0;
      try {
        secs = Math.round(Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
          'format=duration', '-of', 'default=nw=1:nk=1', mp4 || webm]).toString().trim()));
      } catch { /* ffprobe optional */ }
      manifest[v.id] = { title: v.title, role: v.role, seconds: secs, file: `${v.id}.mp4` };
      console.log(`  ✓ ${v.id}  ${secs}s  ${kb(webm)} webm${mp4 ? ` · ${kb(mp4)} mp4` : ' (no ffmpeg — webm only)'}`);
    }
  }
  await browser.close();
  // Drop entries whose mp4 is gone, so the manifest can never point at a missing file.
  for (const id of Object.keys(manifest)) {
    if (!fs.existsSync(path.join(OUT_DIR, manifest[id].file || `${id}.mp4`))) delete manifest[id];
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n${made.length}/${wanted.length} recorded → ${path.relative(ROOT, OUT_DIR)}/`);
  if (problems.length) {
    // Same rule as the screenshot capture: a target that no longer resolves is skipped
    // and REPORTED, never guessed at. The caption still plays, so the video stays honest —
    // it just loses the cursor move. These are the ones to fix.
    console.log(`\n${problems.length} beat target(s) did not resolve (caption still played):`);
    problems.forEach((p) => console.log(`  · ${p}`));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
