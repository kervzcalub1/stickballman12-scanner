// eBay Listings (PH, read-only) — docs/context/ebay-listings.md. What this pins:
//   · eBay's GetMyeBaySelling XML → one row per SIZE (variations) or one row (single
//     listing), available = quantity − sold, size from the "size" specific, style from title;
//   · the OAuth callback refuses a return it didn't start (state nonce) and never leaves
//     the browser on a raw API response;
//   · the page: Connect for admins only; one row per listing (photo, Custom label, price
//     range), its sizes underneath, filters and search.
// eBay itself is never called — the page's endpoints are mocked.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { rowsFromItem } from '../api/_lib/ebay.js';
import { styleFromTitle } from '../src/lib/ebayReprice.js';

const VARIATIONS = `<Item><ItemID>327090839752</ItemID><Title>Nike Dunk Low Panda (DD1391-100)</Title><SKU>10077487</SKU>
  <ListingType>FixedPriceItem</ListingType><WatchCount>4</WatchCount>
  <PictureDetails><GalleryURL>http://i.ebayimg.com/thumbs/images/g/abc/s-l140.jpg</GalleryURL></PictureDetails>
  <ListingDetails><StartTime>2026-09-01T12:00:00.000Z</StartTime><ViewItemURL>https://www.ebay.com/itm/327090839752</ViewItemURL></ListingDetails>
  <SellingStatus><CurrentPrice currencyID="USD">120.0</CurrentPrice><QuantitySold>3</QuantitySold></SellingStatus>
  <Variations>
    <Variation><SKU>10077481</SKU><StartPrice currencyID="USD">125.0</StartPrice><Quantity>3</Quantity>
      <SellingStatus><QuantitySold>1</QuantitySold></SellingStatus>
      <VariationSpecifics><NameValueList><Name>Color</Name><Value>White</Value></NameValueList><NameValueList><Name>US Shoe Size</Name><Value>10</Value></NameValueList></VariationSpecifics></Variation>
    <Variation><StartPrice currencyID="USD">130.0</StartPrice><Quantity>1</Quantity>
      <SellingStatus><QuantitySold>0</QuantitySold></SellingStatus>
      <VariationSpecifics><NameValueList><Name>US Shoe Size</Name><Value>10.5</Value></NameValueList></VariationSpecifics></Variation>
  </Variations></Item>`;
const SINGLE = `<Item><ItemID>327090839799</ItemID><Title>Jordan 4 Retro &amp; Friends - FV5029-141</Title><SKU>10101157</SKU>
  <Quantity>2</Quantity><QuantityAvailable>1</QuantityAvailable>
  <SellingStatus><CurrentPrice currencyID="USD">210.5</CurrentPrice><QuantitySold>1</QuantitySold></SellingStatus></Item>`;

test.describe('eBay listing rows', () => {
  test('a multi-size listing is one row per size; a single listing is one row', () => {
    const v = rowsFromItem(VARIATIONS, (t) => styleFromTitle(t));
    expect(v).toEqual([
      expect.objectContaining({ item_id: '327090839752', variation_key: '10077481', sku: '10077481', size: '10', price: 125, qty_available: 2, qty_sold: 1, style: 'DD1391-100', view_url: 'https://www.ebay.com/itm/327090839752',
        item_sku: '10077487', watch_count: 4, listing_type: 'FixedPriceItem', image_url: 'https://i.ebayimg.com/thumbs/images/g/abc/s-l140.jpg' }),
      expect.objectContaining({ variation_key: 'US Shoe Size=10.5', sku: null, size: '10.5', price: 130, qty_available: 1, qty_sold: 0 }),
    ]);
    const s = rowsFromItem(SINGLE, (t) => styleFromTitle(t));
    expect(s).toEqual([expect.objectContaining({ item_id: '327090839799', variation_key: '', title: 'Jordan 4 Retro & Friends - FV5029-141',
      sku: '10101157', item_sku: '10101157', size: null, price: 210.5, qty_available: 1, qty_sold: 1, style: 'FV5029-141', image_url: null })]);
  });
});

test('the eBay callback refuses an approval it did not start', async ({ request }) => {
  const r = await request.get('/api/ebay/callback?code=x&state=forged', { maxRedirects: 0 });
  expect(r.status()).toBe(302);
  expect(r.headers().location).toMatch(/^\/ph\/ebay-listings\?ebay_error=/);
  const declined = await request.get('/api/ebay/callback?error=access_denied&error_description=declined', { maxRedirects: 0 });
  expect(decodeURIComponent(declined.headers().location)).toContain('eBay: declined');
});

test.describe('eBay Listings page', () => {
  const STATUS = { ok: true, configured: true, missing: [], secrets: true, sandbox: false, connected: true, user: 'stickballman12',
    connectedBy: 'Kervy', connectedAt: '2026-10-10T15:00:00Z', refreshExpiresAt: '2028-04-10T15:00:00Z',
    pull: { state: 'done', by: 'Kervy', finishedAt: '2026-10-10T16:00:00Z', listings: 2, rows: 3, removed: 0, inventoryItems: 0 } };
  const ROWS = [
    { item_id: '1', variation_key: 'a', title: 'Nike Dunk Low (DD1391-100)', style: 'DD1391-100', item_sku: '10077487', sku: '10077481', size: '10', price: '125.00', qty_available: 3, qty_sold: 1, watch_count: 4, image_url: 'https://i.ebayimg.com/x.jpg' },
    { item_id: '1', variation_key: 'b', title: 'Nike Dunk Low (DD1391-100)', style: 'DD1391-100', item_sku: '10077487', sku: '10077482', size: '10.5', price: '130.00', qty_available: 0, qty_sold: 0, watch_count: 4, image_url: 'https://i.ebayimg.com/x.jpg' },
    { item_id: '2', variation_key: '', title: 'Mystery Shoe', style: null, item_sku: '10101157', sku: '10101157', size: null, price: '99.00', qty_available: 0, qty_sold: 2, watch_count: null, image_url: null },
  ];

  test('connected: one row per listing with photo + Custom label, sizes underneath, filters', async ({ page }) => {
    await page.route('**/api/ebay/status', (r) => r.fulfill({ json: STATUS }));
    await page.route('**/api/ebay/pull', (r) => r.fulfill({ json: { ok: true, rows: ROWS } }));
    await page.route('https://i.ebayimg.com/**', (r) => r.fulfill({ status: 404 }));   // never reach eBay
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings');
    await expect(page.locator('.ebl-ok')).toContainText('stickballman12');
    await expect(page.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);   // PH can't unlink the account
    await expect(page.getByText('Listing model: classic (Trading API)')).toBeVisible();
    const listingRows = page.locator('.ebl-table tbody tr.ebl-row');
    await expect(listingRows).toHaveCount(2);
    const dunk = listingRows.filter({ hasText: 'Nike Dunk Low' });
    await expect(dunk).toContainText('10077487');          // the listing's Custom label
    await expect(dunk).toContainText('2 sizes');
    await expect(dunk).toContainText('$125.00–$130.00');
    await expect(page.locator('.ebl-table')).not.toContainText('we hold');   // the stock comparison is gone
    await dunk.click();
    await expect(page.locator('.ebl-size')).toHaveCount(2);
    await expect(page.locator('.ebl-size').nth(1)).toContainText('10077482');   // each size's own label
    await page.getByRole('button', { name: /Out of stock on eBay/ }).click();
    await expect(listingRows).toHaveCount(1);
    await expect(listingRows.first()).toContainText('Mystery Shoe');
    await page.getByRole('button', { name: /^All/ }).click();
    await page.getByLabel('Search eBay listings').fill('10077482');   // a size's SKU finds its listing
    await expect(listingRows).toHaveCount(1);
  });

  test('not connected: Connect is for admins; PH is told an admin does it', async ({ page }) => {
    await page.route('**/api/ebay/status', (r) => r.fulfill({ json: { ...STATUS, connected: false, user: null, pull: null } }));
    await page.route('**/api/ebay/pull', (r) => r.fulfill({ json: { ok: true, rows: [] } }));
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings');
    await expect(page.getByText('an admin connects the eBay account once')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect eBay' })).toHaveCount(0);
  });
});
