// Payout Calculator (/payout) — the money math is the point, so the tests assert
// the numbers on screen, not just that the page renders. Hand-checked scenario:
// $150 shelf, 30% store, 10% promo, 5% gift card, $10 coupon, 2% cashback, 8% tax,
// $5 tip → $89.56 final cost; an Alias sale of $180 at 9.9% pays out $162.18.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';

// The rates persist per device (prefs.js). Playwright gives each test its own
// context, so localStorage already starts empty — do NOT clear it via addInitScript,
// which re-runs on every navigation and would wipe the prefs a reload is meant to
// prove survived.
async function openCalc(page, role = 'warehouse') {
  await loginAs(page, role);
  await page.goto('/payout');
  await expect(page.locator('.topbar .brand')).toContainText('Payout Calculator');
}

const field = (page, label) => page.locator('.pc-field', { hasText: label }).first().locator('input');

async function fillScenario(page) {
  await field(page, 'Shelf price').fill('150');
  await field(page, 'Tax').fill('8');
  await field(page, 'Store discount').fill('30');
  await field(page, 'Promo / birthday').fill('10');
  await field(page, 'Gift card').fill('5');
  await field(page, 'Coupon').fill('10');
  await field(page, 'Cashback').fill('2');
  await field(page, 'Tip').fill('5');
}

test('the discount stack compounds, then coupon, then tax', async ({ page }) => {
  await openCalc(page);
  await fillScenario(page);
  // 150 → 105 → 94.50 → 89.775 → −10 coupon = 79.775; +8% tax +$5 tip −2% cashback.
  await expect(page.locator('.pc-stat').filter({ hasText: 'Final cost' }).locator('.pc-stat-val')).toHaveText('$89.56');
  await expect(page.locator('.pc-stat').filter({ hasText: 'Saved off sticker' }).locator('.pc-stat-val')).toHaveText('$71.82');
});

test('a sale price turns into payout, profit and ROI at the default fee', async ({ page }) => {
  await openCalc(page);
  await fillScenario(page);
  const alias = page.locator('.pc-payout', { hasText: 'Alias' });
  await alias.locator('.pc-field', { hasText: 'Sale price' }).locator('input').fill('180');
  // 180 − 9.9% = 162.18 payout; 162.18 − 89.5615 cost = 72.62 profit.
  await expect(alias.locator('.pc-break-total', { hasText: 'Payout' }).locator('.pc-break-val')).toHaveText('$162.18');
  await expect(alias.locator('.pc-profit', { hasText: 'Profit' }).locator('.pc-break-val')).toHaveText('$72.62');
});

test('a blank fee box means the default rate, never 0%', async ({ page }) => {
  await openCalc(page);
  await field(page, 'Shelf price').fill('100');
  const alias = page.locator('.pc-payout', { hasText: 'Alias' });
  await alias.locator('.pc-field', { hasText: 'Sale price' }).locator('input').fill('200');
  // Left blank => 9.9%, so fees are $19.80 and the payout is NOT the full $200.
  await expect(alias.locator('tr', { hasText: 'Fees' }).locator('.pc-break-val')).toHaveText('−$19.80');
  await alias.locator('.pc-field', { hasText: 'Fee' }).locator('input').fill('1.5');
  await expect(alias.locator('tr', { hasText: 'Fees' }).locator('.pc-break-val')).toHaveText('−$3.00');
});

test('the call needs BOTH thresholds — profit alone is only a Watch', async ({ page }) => {
  await openCalc(page);
  const alias = page.locator('.pc-payout', { hasText: 'Alias' });
  // $500 cost, $600 sale → $540 payout, $40 profit (clears $15) but only 8% ROI.
  await field(page, 'Shelf price').fill('500');
  await alias.locator('.pc-field', { hasText: 'Sale price' }).locator('input').fill('600');
  await expect(page.locator('.pc-verdict-call')).toHaveText('Watch');
  // Same $40 profit on a $100 pair is 40% ROI — both thresholds, so it's a Buy.
  await field(page, 'Shelf price').fill('100');
  await alias.locator('.pc-field', { hasText: 'Sale price' }).locator('input').fill('155.5');
  await expect(page.locator('.pc-verdict-call')).toHaveText('Buy');
});

test('no call at all until there is a cost AND a price', async ({ page }) => {
  await openCalc(page);
  await expect(page.locator('.pc-verdict')).toHaveCount(0);
  await field(page, 'Shelf price').fill('100');
  await expect(page.locator('.pc-verdict')).toHaveCount(0); // cost but no sale price
  await page.locator('.pc-payout', { hasText: 'Alias' }).locator('.pc-field', { hasText: 'Sale price' }).locator('input').fill('200');
  await expect(page.locator('.pc-verdict')).toHaveCount(1);
});

test('rates stick per device, per-pair amounts do not', async ({ page }) => {
  await openCalc(page);
  await field(page, 'Tax').fill('8.25');
  await field(page, 'Store discount').fill('40');
  await field(page, 'Shelf price').fill('150');
  await page.reload();
  await expect(field(page, 'Tax')).toHaveValue('8.25');
  await expect(field(page, 'Store discount')).toHaveValue('40');
  await expect(field(page, 'Shelf price')).toHaveValue(''); // per pair — must not carry over
});

test('PH and admin reach the same calculator', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph/payout');
  await expect(page.locator('.topbar .brand')).toContainText('Payout Calculator');
});

/* ------------------------------------------------------------------ */
/* Live market strips. The quote endpoint is STUBBED here: these tests  */
/* are about what the screen does with an answer, and hanging them off  */
/* the real Alias/StockX APIs would make them fail for reasons that     */
/* have nothing to do with this code.                                   */
/* ------------------------------------------------------------------ */

const PRODUCT = { name: 'Nike Dunk Low Panda', sku: 'DD1391-100', colorway: 'White/Black', sizes: ['9', '10', '10.5'] };

async function stubLookup(page, quote) {
  await page.route('**/api/sku-search', (route) =>
    route.fulfill({ json: { ok: true, product: PRODUCT } }));
  await page.route('**/api/payout/quote', (route) => route.fulfill({ json: quote }));
}

async function pickSize(page, size = '10') {
  await page.locator('.pi-sku-input').fill('DD1391-100');
  await page.getByRole('button', { name: /Look up/ }).click();
  await page.locator('.pi-chip', { hasText: new RegExp(`^${size}$`) }).click();
}

const ALIAS_ROW = { size: '10', global_indicator: 100, price: 120, lowest_listing: 130, highest_offer: 90, last_sold: 118 };

test('both markets fill their own sale price box', async ({ page }) => {
  await openCalc(page);
  await stubLookup(page, {
    ok: true, configured: true, results: [ALIAS_ROW],
    stockx: { configured: true, results: [{ size: '10', lowest_ask: 145, highest_bid: 101, earn_more: 152, sell_faster: 144 }] },
  });
  await pickSize(page);
  const strips = page.locator('.pc-market');
  await expect(strips).toHaveCount(2);
  // Alias strip → Alias box.
  await strips.first().locator('.pc-market-cell', { hasText: 'Lowest ask' }).click();
  await expect(page.locator('.pc-payout', { hasText: 'Alias' }).locator('.pc-field', { hasText: 'Sale price' }).locator('input')).toHaveValue('130');
  // StockX strip → StockX box. Crossing these would price a pair off the wrong market.
  await strips.nth(1).locator('.pc-market-cell', { hasText: 'Highest bid' }).click();
  await expect(page.locator('.pc-payout', { hasText: 'StockX' }).locator('.pc-field', { hasText: 'Sale price' }).locator('input')).toHaveValue('101');
});

test('with StockX unconfigured the Alias half still works, and the screen says why', async ({ page }) => {
  await openCalc(page);
  await stubLookup(page, {
    ok: true, configured: true, results: [ALIAS_ROW],
    stockx: { configured: false, results: [] },
  });
  await pickSize(page);
  await expect(page.locator('.pc-market')).toHaveCount(1); // Alias only
  await expect(page.locator('.pc-payout', { hasText: 'StockX' })).toContainText('aren’t configured');
  await page.locator('.pc-market-cell', { hasText: 'Lowest ask' }).click();
  await expect(page.locator('.pc-payout', { hasText: 'Alias' }).locator('.pc-field', { hasText: 'Sale price' }).locator('input')).toHaveValue('130');
});

test('a StockX outage is reported, not read as "no market"', async ({ page }) => {
  await openCalc(page);
  await stubLookup(page, {
    ok: true, configured: true, results: [ALIAS_ROW],
    stockx: { configured: true, results: [], error: 'StockX prices are unavailable right now.' },
  });
  await pickSize(page);
  await expect(page.locator('.notice', { hasText: 'unavailable' })).toBeVisible();
});

test('a catalogue near-miss warns instead of pricing the wrong colourway', async ({ page }) => {
  await openCalc(page);
  await stubLookup(page, {
    ok: true, configured: true, results: [ALIAS_ROW],
    stockx: { configured: true, results: [{ size: '10', lowest_ask: 400, highest_bid: 300, inexact: true, title: 'Nike Dunk Low Reverse Panda' }] },
  });
  await pickSize(page);
  await expect(page.locator('.pc-market-note')).toContainText('Reverse Panda');
});

test('StockX with no market for the size says exactly that', async ({ page }) => {
  await openCalc(page);
  await stubLookup(page, {
    ok: true, configured: true, results: [ALIAS_ROW],
    stockx: { configured: true, results: [] },
  });
  await pickSize(page);
  await expect(page.getByText('StockX has no market for size 10.')).toBeVisible();
});

/* ------------------------------------------------------------------ */
/* Alias basis. This screen defaults to "With You" while every other    */
/* pricing surface defaults to consigned — the divergence is deliberate */
/* and worth pinning, because the two bases differ by real money        */
/* ($120 vs $105 ask on FZ9033-102 size 11).                            */
/* ------------------------------------------------------------------ */

test('the calculator asks Alias for "With You" pricing by default', async ({ page }) => {
  await openCalc(page);
  const sent = [];
  await page.route('**/api/sku-search', (r) => r.fulfill({ json: { ok: true, product: PRODUCT } }));
  await page.route('**/api/payout/quote', (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, configured: true, results: [ALIAS_ROW], stockx: { configured: false, results: [] } } });
  });
  await pickSize(page);
  // consigned:false IS the "With You" basis — the flag the server reads.
  expect(sent[0].consigned).toBe(false);
});

test('switching basis re-prices the size instead of relabelling a stale number', async ({ page }) => {
  await openCalc(page);
  const sent = [];
  await page.route('**/api/sku-search', (r) => r.fulfill({ json: { ok: true, product: PRODUCT } }));
  await page.route('**/api/payout/quote', (route) => {
    const body = route.request().postDataJSON();
    sent.push(body);
    // Consigned quotes higher than With You, exactly as Alias does in real life.
    const ask = body.consigned ? 120 : 105;
    return route.fulfill({ json: {
      ok: true, configured: true,
      results: [{ ...ALIAS_ROW, lowest_listing: ask }],
      stockx: { configured: false, results: [] },
    } });
  });
  await pickSize(page);
  await expect(page.locator('.pc-market-cell', { hasText: 'Lowest ask' })).toContainText('$105.00');
  await page.locator('.seg-btn', { hasText: 'Consigned' }).click();
  await expect(page.locator('.pc-market-cell', { hasText: 'Lowest ask' })).toContainText('$120.00');
  expect(sent.map((b) => b.consigned)).toEqual([false, true]);
  // The strip names the basis, so a screenshot of it can't be misread later.
  await expect(page.locator('.pc-market-head').first()).toContainText('Consigned');
});

test('the basis survives a refresh, like the shoe does', async ({ page }) => {
  await openCalc(page);
  // The toggle lives with the size chips — it governs what a tap fetches — so it only
  // exists once a shoe is loaded. Look one up first.
  await stubLookup(page, { ok: true, configured: true, results: [ALIAS_ROW], stockx: { configured: false, results: [] } });
  await page.locator('.pi-sku-input').fill('DD1391-100');
  await page.getByRole('button', { name: /Look up/ }).click();
  await page.locator('.seg-btn', { hasText: 'Consigned' }).click();
  await expect(page).toHaveURL(/basis=consigned/);
  await page.reload();
  await page.locator('.pi-sku-input').press('Enter'); // re-resolve the shoe after reload
  await expect(page.locator('.seg-btn', { hasText: 'Consigned' })).toHaveAttribute('aria-pressed', 'true');
});

/* ------------------------------------------------------------------ */
/* The advisor. Stubbed: what matters here is WHAT WE SEND it and how   */
/* the screen behaves around it — the model's own answers aren't ours   */
/* to assert.                                                           */
/* ------------------------------------------------------------------ */

async function stubAdvisor(page, handler) {
  await page.route('**/api/payout/advisor', handler);
}

test('the advisor is told the numbers actually on screen', async ({ page }) => {
  await openCalc(page);
  let sent = null;
  await stubLookup(page, { ok: true, configured: true, results: [ALIAS_ROW], stockx: { configured: false, results: [] } });
  await stubAdvisor(page, (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, reply: 'Pass — thin margin.' } });
  });
  await pickSize(page);
  await page.locator('.pc-market-cell', { hasText: 'Lowest ask' }).click();
  await field(page, 'Shelf price').fill('100');
  await page.locator('.seg-btn', { hasText: 'Weekly' }).click();
  await page.locator('.pc-chat-suggest button', { hasText: 'Is this a good buy?' }).click();
  await expect(page.locator('.pc-msg.assistant')).toContainText('Pass — thin margin.');

  // The shoe, the size, the basis and the liquidity the user picked.
  expect(sent.context.sku).toBe('DD1391-100');
  expect(sent.context.size).toBe('10');
  expect(sent.context.basis).toBe('with_you');
  expect(sent.context.liquidity).toBe('weekly');
  // The cost it must reason from, and the payout it must not re-derive wrongly.
  expect(sent.context.cost.finalCost).toBeCloseTo(100, 2);
  const alias = sent.context.payouts.find((p) => p.label === 'Alias');
  expect(alias.salePrice).toBe(130);
  expect(alias.payout).toBeCloseTo(130 * 0.901, 2);
  // And the call the screen is currently showing, so the two can't contradict.
  // $130 − 9.9% = $117.13 payout − $100 cost = $17.13 at 17.1% ROI: both thresholds
  // cleared, so this is a Buy.
  expect(sent.context.verdict).toContain('Buy');
  expect(sent.messages).toEqual([{ role: 'user', content: 'Is this a good buy?' }]);
});

test('an unconfigured server retires the panel instead of erroring at you', async ({ page }) => {
  await openCalc(page);
  await stubAdvisor(page, (route) => route.fulfill({
    status: 503, json: { ok: false, error: 'The advisor isn’t configured on this server (no model key).' },
  }));
  await page.locator('.pc-chat-suggest button').first().click();
  await expect(page.getByText(/isn’t configured on this server/)).toBeVisible();
  // A setup fact, not a failed question — so no error bubble is left in the transcript.
  await expect(page.locator('.pc-msg')).toHaveCount(0);
  await expect(page.locator('.pc-chat-ask')).toHaveCount(0);
});

test('a failed answer shows as a failure, never as advice', async ({ page }) => {
  await openCalc(page);
  await stubAdvisor(page, (route) => route.fulfill({
    status: 502, json: { ok: false, error: 'The advisor couldn’t answer just now.' },
  }));
  await page.locator('.pc-chat-suggest button').first().click();
  await expect(page.locator('.pc-msg.error')).toContainText('couldn’t answer');
  // The question stays on screen so it can be retried.
  await expect(page.locator('.pc-msg.user')).toHaveCount(1);
});

test('the conversation is carried forward, and clears with the pair', async ({ page }) => {
  await openCalc(page);
  let lastSent = null;
  await stubAdvisor(page, (route) => {
    lastSent = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, reply: `answer ${lastSent.messages.length}` } });
  });
  await page.locator('.pc-chat-suggest button', { hasText: 'Is this a good buy?' }).click();
  await expect(page.locator('.pc-msg.assistant')).toHaveCount(1);
  await page.locator('.pc-chat-ask input').fill('And at $20 less?');
  await page.locator('.pc-chat-ask button').click();
  // Turn two carries the whole thread — otherwise "and at $20 less?" means nothing.
  await expect.poll(() => lastSent.messages.length).toBe(3);
  await expect(page.locator('.pc-msg.user')).toHaveCount(2);
  // Clear wipes it: a conversation about one pair's margin must not follow the next shoe.
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.pc-msg')).toHaveCount(0);
});
