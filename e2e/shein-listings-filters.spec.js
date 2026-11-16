// SHEIN Listings — stage 3 of the page fixes (2026-11-17): the PAGE on top of the stage-1 list API and the stage-2
// engine (docs/context/shein-listings.md → "The page (stage 3)"). What this pins, in the owner's words first:
//   (a) "we filter the errors, but we can't remove the filter" — every filter that is on is a chip with ✕; Clear all
//       takes them all off, the status tile included; all of it in the URL;
//   (b) "the filters for error should only be seen on the blockers or the with-errors items" — "What's stopping it"
//       only on Blocked / Error; leaving them drops the reason; a link with a reason lands on Blocked;
//   (c) "see the rejected products … can a rejected product be fixed and resubmitted?" — the Rejected tab: SHEIN's
//       reason, the one button per row (PH vs admin);
// plus: tile number = the list it opens (with another filter on too), the any-size link, sort in the URL, a stale
// ?p=, ticks dropped when the list changes, "Don't list" asks first, an action's error next to the button (drawer,
// rejected row), stage-2 renders (idle reasons, Confirm $X), and the phone bar (one line, no sideways scroll).
// Its shoes carry the word "zqflt" (ids 7761–7766); every write the page would make is answered by page.route —
// nothing here reaches SHEIN or Shopify, and nothing is written to the database through the page.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loginAs } from './helpers/auth.js';
import { computeListings, spuPayload } from '../src/lib/sheinListings.js';

const ZQ = 'zqflt';
const gidP = (n) => `gid://shopify/Product/${n}`;
const gidV = (n) => `gid://shopify/ProductVariant/${n}`;
const IDS = [7761, 7762, 7763, 7764, 7765, 7766].map(gidP);
const ATTR = 87;
const sku = (skuCode, supplierSku, label, valueId) => ({ skuCode, supplierSku, label, valueId });
const SPU = (spuName, sizes, price = 160) => ({ spuName, categoryId: 1001, productTypeId: 501, brandCode: 'NIKE', productMultiNameList: [{ language: 'en', productName: spuName }], dimensionAttributeInfoList: [],
  skcInfoList: [{ skcName: `${spuName}C`, shelfStatusInfoList: [{ siteAbbr: 'shein-us', shelfStatus: 1 }], skuInfoList: sizes.map((s) => ({ skuCode: s.skuCode, supplierSku: s.supplierSku, mallState: 1,
    saleAttributeList: [{ attributeId: ATTR, attributeValueId: s.valueId, attributeValueMultiList: [{ language: 'en', attributeValueName: s.label }] }],
    priceInfoList: [{ basePrice: price, specialPrice: 0, currency: 'USD', site: 'shein-us' }] })) }] });
const zp = (n, title, variants, extra = {}) => ({ productId: gidP(n), title, handle: `zqflt-${n}`, vendor: extra.vendor || 'Fltbrand', productType: 'Shoes', tags: [], status: 'ACTIVE',
  updatedAt: extra.updatedAt || '2026-11-01T12:00:00Z', image: null, imageCount: 3, style: (title.match(/\(([A-Z0-9-]+)\)/) || [])[1] || null,
  variants: variants.map(([v, s, size, price, qty]) => ({ variantId: gidV(v), sku: s, size, price: String(price), compareAt: null, qty, barcode: null, weightG: null })) });

let pool; let foreign = false; let auth; const jobs = [];
const base = (role) => (role === 'admin' ? '/shein?section=listings' : '/ph/shein?section=listings');
const listTotal = async (page) => {
  const t = await page.locator('[data-list-head]').innerText();
  const m = t.match(/of ([\d,]+) shoes?/);
  return m ? Number(m[1].replace(/,/g, '')) : t.includes('0 shoes') ? 0 : NaN;
};
const tileN = async (page, code) => Number((await page.locator(`.shl-tiles .shc-tile[data-status="${code}"] b`).innerText()).replace(/,/g, ''));
const apiGet = async (request, qs, who = 'ph') => { const r = await request.get(`/api/shein/listings${qs}`, { headers: auth[who] }); expect(r.status(), qs).toBe(200); return r.json(); };
// Every POST the page makes is answered here (never the database / SHEIN); `answer(body)` → { status, json }.
async function routePosts(page, answer) {
  const posted = [];
  await page.route('**/api/shein/listings', async (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const b = r.request().postDataJSON(); posted.push(b);
    const a = answer(b) || { status: 200, json: { ok: true } };
    return r.fulfill({ status: a.status, json: a.json });
  });
  return posted;
}

async function clean() {
  await pool.query('DELETE FROM shein_listing_variants WHERE shopify_product_id = ANY($1::text[])', [IDS]);
  await pool.query('DELETE FROM shein_listing_products WHERE shopify_product_id = ANY($1::text[])', [IDS]);
  const { rows } = await pool.query("SELECT id FROM shein_listing_jobs WHERE started_by = 'e2e-zqflt'");
  if (rows.length) await pool.query('DELETE FROM shein_listing_jobs WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
}

test.beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { rows: [f] } = await pool.query("SELECT count(*)::int AS n FROM shein_listing_products WHERE NOT (shopify_product_id LIKE 'gid://shopify/Product/77%' OR shopify_product_id LIKE 'shein:E2E%')");
  foreign = f.n > 0;   // a copy of production: this spec only runs on a test database
  if (foreign) return;
  const { signToken } = await import('../api/_lib/util.js');
  auth = { ph: { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` },
    admin: { Authorization: `Bearer ${signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' })}` } };
  await clean();
  const products = [
    // synced (+ a 0-stock size with no SKU → an "idle" reason, greyed "(out of stock)")
    zp(7761, 'Zqflt Synced Shoe (ZF1001-001)', [[776107, 'ZF7', '7', 160, 1], [776108, 'ZF8', '8', 160, 2], [776115, '', '15', 160, 0]], { updatedAt: '2026-11-05T12:00:00Z' }),
    // Blocked, with a synced size (the any-size mode)
    zp(7762, 'Zqflt Mixed Shoe (ZF1002-001)', [[776207, 'ZM7', '7', 160, 1], [776208, '', '8', 160, 1]]),
    // Blocked: no SKU (another brand)
    zp(7763, 'Zqflt Blocked Shoe (ZF1003-001)', [[776309, '', '9', 100, 1]], { vendor: 'Otherflt' }),
    // not on SHEIN, ready
    zp(7764, 'Zqflt New Shoe (ZF1004-001)', [[776409, 'ZN9', '9', 120, 1]]),
    // our publish was rejected (never live)
    zp(7765, 'Zqflt Rejected Shoe (ZF1005-001)', [[776509, 'ZR9', '9', 110, 1], [776510, 'ZR10', '10', 110, 2]]),
    // a $766 size next to $160 ones → Blocked "Price looks wrong"
    zp(7766, 'Zqflt Pricey Shoe (ZF1006-001)', [[776607, 'ZP7', '7', 160, 1], [776608, 'ZP8', '8', 160, 1], [776609, 'ZP9', '9', 766, 1], [776610, 'ZP10', '10', 160, 1]]),
  ];
  const spus = [
    spuPayload(SPU('E2EZF1', [sku('E2EZF1-07', 'ZF7', 'US7', 1), sku('E2EZF1-08', 'ZF8', 'US8', 2)])),
    spuPayload(SPU('E2EZF2', [sku('E2EZF2-07', 'ZM7', 'US7', 1)])),
    spuPayload(SPU('E2EZF6', [sku('E2EZF6-07', 'ZP7', 'US7', 1), sku('E2EZF6-10', 'ZP10', 'US10', 4)])),
  ];
  const { saveListingProducts, latestListingJob } = await import('../api/_lib/db.js');
  await saveListingProducts(computeListings({ products, spus }).filter((r) => IDS.includes(r.shopify_product_id)));
  await pool.query("UPDATE shein_listing_products SET spu = 'E2EZFREJ', review_version = 'v1' WHERE shopify_product_id = $1", [gidP(7765)]);
  // the page shows "Nothing read yet" until a refresh finished
  if (!(await latestListingJob('snapshot', 'done'))) {
    const { rows: [j] } = await pool.query("INSERT INTO shein_listing_jobs (kind, status, started_by, created_at, started_at, finished_at, phase) VALUES ('snapshot', 'done', 'e2e-zqflt', now(), now(), now(), 'Finished') RETURNING id");
    jobs.push(j.id);
  }
  // our send records: a rejected publish (7765, never live) and a rejected add-sizes on a live shoe (7761)
  const { rows: [job] } = await pool.query("INSERT INTO shein_listing_jobs (kind, mode, status, started_by, finished_at) VALUES ('run', 'run', 'done', 'e2e-zqflt', now()) RETURNING id");
  jobs.push(job.id);
  const rej = (reason) => JSON.stringify([{ code: 'review_rejected', params: { failedReason: reason } }]);
  const ins = (pid, op, blockers, variants, ago) => pool.query(`INSERT INTO shein_listing_job_items (job_id, seq, shopify_product_id, spu, op, status, blockers, variant_ids, sent_at, updated_at, error)
    VALUES ($1, 0, $2, 'E2EZFREJ', $3, 'failed', $4::jsonb, $5::text[], now() - $6::interval, now() - $6::interval, 'rejected')`, [job.id, gidP(pid), op, blockers, variants.map(gidV), ago]);
  await ins(7765, 'publish', rej('Taboo: E2E the brand name in the title'), [776509, 776510], '1 hour');
  await ins(7761, 'add_sku', rej('Reflection: E2E a template attribute is required'), [776115], '2 hours');
});
test.afterAll(async () => {
  if (!pool) return;
  if (!foreign) await clean();
  await pool.end();
});
test.beforeEach(async () => { test.skip(!pool || foreign, 'needs the test database (no real SHEIN Listings rows)'); });

test.describe('SHEIN Listings — the page filters (stage 3)', () => {
  test('(a) a reason filter is a chip that comes off in one tap; Clear all takes every filter off, the tile too — all in the URL', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto(`${base('ph')}&q=${ZQ}`);
    await page.locator('.shl-tiles .shc-tile[data-status="blocked"]').click();
    const before = await tileN(page, 'blocked');
    await expect.poll(() => listTotal(page)).toBe(before);                                  // the Blocked list has loaded
    await page.locator('[data-reason-filter]').selectOption('no_seller_sku');
    await expect(page).toHaveURL(/[?&]blocker=no_seller_sku/);
    const chip = page.locator('[data-active-filters] [data-chip="blocker"]');
    await expect(chip).toContainText('No SKU on Shopify');
    await page.reload();                                                                    // refresh keeps it
    await expect(page.locator('[data-active-filters] [data-chip="blocker"]')).toBeVisible();
    await page.locator('[data-active-filters] [data-chip="blocker"]').click();               // ✕ — just that one
    await expect(page).not.toHaveURL(/blocker=/);
    await expect(page).toHaveURL(/status=blocked/);
    await expect(page.locator('[data-active-filters] [data-chip="status"]')).toContainText('Blocked');
    await expect.poll(() => listTotal(page)).toBe(before);
    // every filter at once → one chip each; Clear all = none, the tile back on All
    await page.goto(`${base('ph')}&q=${ZQ}&status=blocked&blocker=no_seller_sku&shop=active&brand=Fltbrand&sort=title`);
    for (const k of ['status', 'q', 'brand', 'blocker', 'shop', 'sort']) await expect(page.locator(`[data-active-filters] [data-chip="${k}"]`)).toBeVisible();
    await page.locator('[data-active-filters] [data-chip="all"]').click();
    await expect(page.locator('[data-active-filters]')).toHaveCount(0);
    for (const k of ['status', 'q', 'brand', 'blocker', 'shop', 'sort', 'p']) await expect(page).not.toHaveURL(new RegExp(`[?&]${k}=`));
    await expect(page.getByRole('searchbox', { name: 'Search products' })).toHaveValue('');
    await expect(page.locator('.shl-tiles > .shc-tile').first()).toHaveAttribute('aria-pressed', 'true');   // All
    // More filters opens AND closes again
    const more = page.locator('[data-more-toggle]');
    await more.click(); await expect(page.locator('[data-more-filters]')).toBeVisible();
    await more.click(); await expect(page.locator('[data-more-filters]')).toHaveCount(0);
  });

  test('(b) "What’s stopping it" only on Blocked / Error; leaving them drops the reason; a link with a reason lands on Blocked', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto(`${base('ph')}&q=${ZQ}`);
    await expect(page.locator('[data-reason-filter]')).toHaveCount(0);                     // All
    await page.locator('.shl-tiles .shc-tile[data-status="synced"]').click();
    await expect(page.locator('[data-reason-filter]')).toHaveCount(0);                     // Synced
    await page.locator('.shl-tiles .shc-tile[data-status="blocked"]').click();
    const sel = page.locator('[data-reason-filter]');
    await expect(sel).toBeVisible();
    await expect(sel.locator('option', { hasText: 'No SKU on Shopify' })).toHaveText(/\(\d+ shoes? · \d+ sizes?\)/);   // label + counts, never a blank
    await page.locator('.shl-tiles .shc-tile[data-status="error"]').click();
    await expect(page.locator('[data-reason-filter]')).toBeVisible();                      // Error has it too
    await page.locator('.shl-tiles .shc-tile[data-status="blocked"]').click();
    await sel.selectOption('no_seller_sku');
    await page.locator('.shl-tiles .shc-tile[data-status="synced"]').click();              // leave Blocked → the reason goes
    await expect(page).not.toHaveURL(/blocker=/);
    await expect(page.locator('[data-active-filters] [data-chip="blocker"]')).toHaveCount(0);
    // Today → a reason → Shoes on SHEIN, Blocked, with that reason
    await page.goto('/ph/shein?section=today');
    const reason = page.locator('[data-today-reason]').first();
    await expect(reason).toBeVisible();
    const code = await reason.getAttribute('data-today-reason');
    await reason.click();
    await expect(page).toHaveURL(new RegExp(`status=blocked.*blocker=${code}|blocker=${code}.*status=blocked`));
    await expect(page.locator('[data-section="listings"] .shc-tile[data-status="blocked"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-section="listings"] [data-active-filters] [data-chip="blocker"]')).toBeVisible();
  });

  test('a tile’s number is the total of the list it opens — with and without another filter; the any-size link', async ({ page, request }) => {
    await loginAs(page, 'ph_team');
    for (const extra of ['', '&brand=Fltbrand']) {
      await page.goto(`${base('ph')}&q=${ZQ}${extra}`);
      for (const code of ['synced', 'blocked', 'not_on_shein']) {
        const n = await tileN(page, code);
        await page.locator(`.shl-tiles .shc-tile[data-status="${code}"]`).click();
        await expect.poll(() => listTotal(page), `${code}${extra}`).toBe(n);
        await expect(page.locator('.shl-product')).toHaveCount(n);
        for (const chip of await page.locator('.shl-product .shl-rollup > .ebo-chip:first-child').all()) await expect(chip).toHaveText(/./);
      }
    }
    // the any-size mode: "+n more have a synced size" opens the shoes with at least one synced size
    const s = (await apiGet(request, `?q=${ZQ}`)).summary.byStatus.synced;
    expect(s.anySize).toBeGreaterThan(s.products);
    await page.goto(`${base('ph')}&q=${ZQ}`);
    const more = page.locator('.shl-tile-more[data-any="synced"]');
    await expect(more).toContainText(`+${s.anySize - s.products} more have a synced size`);
    await more.click();
    await expect(page).toHaveURL(/[?&]any=1/);
    await expect(page.locator('[data-list-head]')).toContainText('Shoes with at least one synced size');
    await expect(page.locator('[data-list-head]')).toContainText('the chip on each row is the shoe’s own status');
    await expect.poll(() => listTotal(page)).toBe(s.anySize);
    await expect(page.locator(`.shl-product[data-product="${gidP(7762)}"] [data-any-match]`)).toContainText('1 synced');   // Blocked, one synced size
    await expect(page.locator('[data-active-filters] [data-chip="any"]')).toContainText('Has a synced size');
    await page.locator('[data-active-filters] [data-chip="any"]').click();
    await expect(page).not.toHaveURL(/any=1/);
    await expect.poll(() => listTotal(page)).toBe(s.products);
    // a Synced shoe: no red one-liner; its 0-stock size's reason greyed "(out of stock)"
    const row = page.locator(`.shl-product[data-product="${gidP(7761)}"]`);
    await expect(row.locator('.shl-pline.bad')).toHaveCount(0);
    await expect(row.locator('[data-idle]')).toContainText('(out of stock)');
  });

  test('sort is in the URL and a chip; a stale ?p= comes back as the real page (never “26–25 of 25”)', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto(`${base('ph')}&q=${ZQ}`);
    await page.getByRole('combobox', { name: 'Sort' }).selectOption('title');
    await expect(page).toHaveURL(/[?&]sort=title/);
    await expect(page.locator('[data-active-filters] [data-chip="sort"]')).toContainText('Title');
    const titles = await page.locator('.shl-product .shl-pname').allInnerTexts();
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Sort' })).toHaveValue('title');
    await page.locator('[data-active-filters] [data-chip="sort"]').click();
    await expect(page).not.toHaveURL(/sort=/);
    // a stale page number
    await page.goto(`${base('ph')}&q=${ZQ}&p=9`);
    await expect(page).not.toHaveURL(/[?&]p=/);
    const head = page.locator('[data-list-head]');
    await expect(head).toContainText(/1–\d+ of \d+ shoes/);
    await expect(head).not.toContainText('26–');
    expect(await page.locator('.shl-product').count()).toBeGreaterThan(0);
  });

  test('ticks are dropped when the list changes (said once); "Don’t list on SHEIN" asks first and acts on exactly the ticked shoes', async ({ page }) => {
    await loginAs(page, 'ph_team');
    const posted = await routePosts(page, (b) => (b.action === 'exclude' ? { status: 200, json: { ok: true, n: { products: b.productIds.length, variants: 0 }, products: [] } } : null));
    await page.goto(`${base('ph')}&q=${ZQ}`);
    for (const id of [7762, 7763]) await page.locator(`.shl-product[data-product="${gidP(id)}"] .shl-chk input`).check();
    await expect(page.locator('.shl-bar [data-bar-count]')).toHaveAttribute('data-bar-count', '2');
    await page.getByRole('combobox', { name: 'Sort' }).selectOption('updated');             // the list changed
    await expect(page.locator('.shl-bar')).toHaveCount(0);
    await expect(page.locator('[data-ticks-dropped]')).toHaveText('2 ticks cleared — the list changed.');
    await page.locator('.shl-tiles .shc-tile[data-status="blocked"]').click();
    await expect(page.locator('[data-ticks-dropped]')).toHaveCount(0);                     // nothing was ticked: said nothing
    // "Don't list" — a question naming the count; Cancel sends nothing; Confirm sends exactly the ticked ids
    await page.locator(`.shl-product[data-product="${gidP(7763)}"] .shl-chk input`).check();
    await page.locator('.shl-bar [data-bar="off"]').click();
    const ask = page.getByRole('dialog');
    await expect(ask).toContainText('Don’t list 1 shoe on SHEIN?');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    expect(posted.filter((b) => b.action === 'exclude')).toEqual([]);
    await page.locator('.shl-bar [data-bar="off"]').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Don’t list 1 shoe' }).click();
    await expect.poll(() => posted.filter((b) => b.action === 'exclude').at(-1)).toEqual({ action: 'exclude', productIds: [gidP(7763)] });
    await expect(page.locator('.shl-bar')).toHaveCount(0);                                  // done: ticks cleared, the bar gone…
    await expect(page.locator('[data-act-note="bar"]')).toContainText('1 shoe marked “Don’t list on SHEIN”');   // …and it says so
  });

  test('an action’s error shows in the drawer next to its button, not as “Couldn’t refresh” at the top; Confirm $766 sends price_ok (PH)', async ({ page }) => {
    await loginAs(page, 'ph_team');
    const posted = await routePosts(page, (b) => (b.action === 'exclude' ? { status: 409, json: { ok: false, error: 'E2E: refused on purpose' } }
      : b.action === 'price_ok' ? { status: 200, json: { ok: true, variant: {} } } : null));
    await page.goto(`${base('ph')}&q=${ZQ}&product=${encodeURIComponent(gidP(7764))}`);
    const drawer = page.getByRole('dialog', { name: 'Product details' });
    await expect(drawer).toContainText('Zqflt New Shoe');
    await drawer.getByRole('button', { name: 'Don’t list on SHEIN' }).click();
    await expect(drawer.locator('[data-act-note="drawer"]')).toContainText('E2E: refused on purpose');
    await expect(page.locator('.shl-strip-card')).not.toContainText('Couldn’t refresh');
    await expect(page.locator('[data-act-note="top"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    // the $766 size: Blocked "Price looks wrong" with Confirm $766 — PH may press it
    const row = page.locator(`.shl-product[data-product="${gidP(7766)}"]`);
    await row.locator('.shl-caret').click();
    const s9 = row.locator(`tr[data-row="${gidV(776609)}"]`);
    await expect(s9).toContainText('$766 is far from');
    await s9.getByRole('button', { name: 'Confirm $766' }).click();
    await expect.poll(() => posted.find((b) => b.action === 'price_ok')).toEqual({ action: 'price_ok', variantKey: gidV(776609), price: 766 });
    await expect(row.locator(`[data-act-note="row:${gidP(7766)}"]`)).toContainText('$766 confirmed');
  });

  test('(c) Rejected by SHEIN: SHEIN’s reason and the one button — PH sees Publish again greyed with who can; admin may press it', async ({ page }) => {
    await loginAs(page, 'ph_team');
    const posted = await routePosts(page, (b) => (b.action === 'preview' ? { status: 409, json: { ok: false, error: 'E2E: a job is already running' } } : null));
    await page.goto(`${base('ph')}&q=${ZQ}`);
    await expect(page.locator('[data-tab="rejected"] .seg-n')).toHaveText('2');
    await page.locator('[data-tab="rejected"]').click();
    await expect(page).toHaveURL(/[?&]tab=rejected/);
    const view = page.locator('[data-rejected-view]');
    await expect(view).toContainText('Yes, each one can be fixed and sent again');
    await expect(view).toContainText('sent by another tool');
    const pub = view.locator(`[data-rejected="${gidP(7765)}"]`);
    await expect(pub).toContainText('Taboo: E2E the brand name in the title');
    await expect(pub).toContainText('Publish rejected');
    await expect(pub).toContainText('Never accepted by SHEIN');
    await expect(pub.locator('[data-rej-next="publish_again"]')).toBeDisabled();
    await expect(pub.locator('[data-rej-who]')).toContainText('Only an admin');
    const add = view.locator(`[data-rejected="${gidP(7761)}"]`);
    await expect(add).toContainText('Live on SHEIN');
    await expect(add).toContainText('Reflection: E2E a template attribute is required');
    const btn = add.locator('[data-rej-next="preview_add_sizes"]');
    await expect(btn).toBeEnabled();
    await btn.click();                                                                      // PH ok: a preview — answered with an error here
    await expect.poll(() => posted.at(-1)).toEqual({ action: 'preview', productIds: [gidP(7761)] });
    await expect(add.locator(`[data-act-note="rej:${gidP(7761)}"]`)).toContainText('E2E: a job is already running');
    // search applies; Details opens the drawer
    await page.getByRole('searchbox', { name: 'Search rejected shoes' }).fill(`${ZQ} rejected`);
    await expect(view.locator('[data-rejected]')).toHaveCount(1);
    await pub.locator('[data-rej-details]').click();
    await expect(page.getByRole('dialog', { name: 'Product details' })).toContainText('Zqflt Rejected Shoe');
  });

  test('(c) admin: Publish again is live — recorded, then the publish preview', async ({ page }) => {
    await loginAs(page, 'admin');
    const posted = await routePosts(page, (b) => (b.action === 'publish_again' ? { status: 200, json: { ok: true, products: [] } }
      : b.action === 'preview' ? { status: 409, json: { ok: false, error: 'E2E: preview refused' } } : null));
    await page.goto(`${base('admin')}&tab=rejected&q=${ZQ}`);
    const pub = page.locator(`[data-rejected="${gidP(7765)}"]`);
    await expect(pub.locator('[data-rej-next="publish_again"]')).toBeEnabled();
    await pub.locator('[data-rej-next="publish_again"]').click();
    await expect.poll(() => posted.map((b) => b.action)).toEqual(['publish_again', 'preview']);
    expect(posted[1]).toEqual({ action: 'preview', productIds: [gidP(7765)], ops: ['publish'] });
  });

  test('390 px: the selection bar is one short line (More opens the rest); no sideways scroll; the tiles are on the first screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, 'ph_team');
    await page.goto(`${base('ph')}&q=${ZQ}`);
    const tiles = await page.locator('.shl-tiles').boundingBox();
    expect(tiles.y).toBeLessThan(770);
    await page.locator(`.shl-product[data-product="${gidP(7764)}"] .shl-chk input`).check();
    const bar = page.locator('.shl-bar');
    await expect(bar).toBeVisible();
    const box = await bar.boundingBox();
    expect(box.height).toBeLessThanOrEqual(80);                                             // never 40 % of the screen
    expect(box.y + box.height).toBeLessThanOrEqual(844 - 72);                               // above the advisor / keypad buttons
    await expect(bar.locator('[data-bar="off"]')).toBeHidden();
    await bar.locator('[data-bar="more"]').click();
    await expect(bar.locator('[data-bar="off"]')).toBeVisible();
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth }));
    expect(Math.max(w.doc, w.body)).toBeLessThanOrEqual(w.vw);
    await page.locator('[data-tab="rejected"]').click();
    await expect(page.locator('[data-rejected]').first()).toBeVisible();
    const w2 = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
    expect(w2.doc).toBeLessThanOrEqual(w2.vw);
  });
});
