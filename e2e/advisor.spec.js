// The app-wide advisor — the floating button and its panel.
//
// Stubbed at the endpoint: what matters here is WHAT WE SEND, and how the screen
// behaves around an answer. The model's own words aren't ours to assert, and the
// server's tool-calling is exercised by hand against live data, not in CI.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { systemPrompt, supplierPrompt } from '../api/advisor/ask.js';
import { estToday } from '../src/lib/format.js';

const fab = (page) => page.locator('.advisor-fab');
const panel = (page) => page.locator('.advisor-panel');

async function stub(page, handler) {
  await page.route('**/api/advisor/ask', handler);
}
const reply = (text) => (route) => route.fulfill({ json: { ok: true, reply: text } });

test('the button is on every staff screen, not just the calculator', async ({ page }) => {
  await loginAs(page, 'warehouse');
  for (const path of ['/', '/inventory', '/shelve', '/payout', '/sop']) {
    await page.goto(path);
    await expect(fab(page), `no advisor button on ${path}`).toBeVisible();
  }
});

test('PH accounts get it too', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph/new-inventory');
  await expect(fab(page)).toBeVisible();
});

// Changed 2026-08-26: suppliers DO get an advisor now — a narrower one. What it can
// and can't reach is in e2e/supplier-advisor.spec.js.
test('suppliers get it too, on their own portal', async ({ page }) => {
  await loginAs(page, 'supplier');
  await page.goto('/');
  await expect(fab(page)).toBeVisible();
});

test('it opens, answers, and closes on Escape', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await stub(page, reply('Scan the shelf, then scan the pair.'));
  await page.goto('/');
  await expect(panel(page)).toHaveCount(0);
  await fab(page).click();
  await expect(panel(page)).toBeVisible();
  await panel(page).locator('.advisor-ask input').fill('how do I shelve a pair?');
  await panel(page).locator('.advisor-ask button').click();
  await expect(panel(page).locator('.ah-msg.assistant')).toContainText('Scan the shelf');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
});

test('a screen with no context still gets a working advisor', async ({ page }) => {
  await loginAs(page, 'warehouse');
  let sent = null;
  await stub(page, (route) => { sent = route.request().postDataJSON(); return reply('ok')(route); });
  await page.goto('/locations');
  await fab(page).click();
  await panel(page).locator('.advisor-ask input').fill('what needs doing?');
  await panel(page).locator('.advisor-ask button').click();
  await expect(panel(page).locator('.ah-msg.assistant')).toBeVisible();
  // No page context is a valid state — the server can still use its own tools.
  expect(sent.context).toEqual({});
});

test('on the calculator it carries that screen’s numbers', async ({ page }) => {
  await loginAs(page, 'warehouse');
  let sent = null;
  await page.route('**/api/sku-search', (r) => r.fulfill({ json: { ok: true, product: { name: 'Dunk Low Panda', sku: 'DD1391-100', sizes: ['9', '10'] } } }));
  await page.route('**/api/payout/quote', (r) => r.fulfill({ json: {
    ok: true, configured: true,
    results: [{ size: '10', lowest_listing: 130, highest_offer: 90, last_sold: 118, global_indicator: 100 }],
    stockx: { configured: false, results: [] },
  } }));
  await stub(page, (route) => { sent = route.request().postDataJSON(); return reply('Buy it.')(route); });

  await page.goto('/payout');
  await page.locator('.pi-sku-input').fill('DD1391-100');
  await page.getByRole('button', { name: /Look up/ }).click();
  await page.locator('.pi-chip', { hasText: /^10$/ }).click();
  await page.locator('.pc-market-cell', { hasText: 'Lowest ask' }).click();
  await page.locator('.pc-field', { hasText: 'Shelf price' }).first().locator('input').fill('100');

  await fab(page).click();
  await panel(page).locator('.advisor-ask input').fill('good buy?');
  await panel(page).locator('.advisor-ask button').click();
  await expect(panel(page).locator('.ah-msg.assistant')).toBeVisible();

  expect(sent.context.page).toContain('Payout Calculator');
  expect(sent.context.sku).toBe('DD1391-100');
  expect(sent.context.size).toBe('10');
  // Read at ASK time, not when the panel opened — the cost was typed before opening.
  expect(sent.context.cost.finalCost).toBeCloseTo(100, 2);
  expect(sent.context.payouts.find((p) => p.label === 'Alias').salePrice).toBe(130);
  expect(sent.context.verdict).toContain('Buy');
});

test('leaving a screen drops its context — a stale answer is worse than none', async ({ page }) => {
  await loginAs(page, 'warehouse');
  let sent = null;
  await stub(page, (route) => { sent = route.request().postDataJSON(); return reply('ok')(route); });
  await page.goto('/payout');
  await page.goto('/locations');
  await fab(page).click();
  await panel(page).locator('.advisor-ask input').fill('anything?');
  await panel(page).locator('.advisor-ask button').click();
  await expect(panel(page).locator('.ah-msg.assistant')).toBeVisible();
  expect(sent.context.page).toBeUndefined();
});

test('an unconfigured server retires the panel instead of erroring at you', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await stub(page, (route) => route.fulfill({ status: 503, json: { ok: false, error: 'The advisor isn’t configured on this server (no model key).' } }));
  await page.goto('/');
  await fab(page).click();
  await panel(page).locator('.advisor-ask input').fill('hello');
  await panel(page).locator('.advisor-ask button').click();
  await expect(page.getByText(/isn’t configured on this server/)).toBeVisible();
  await expect(panel(page).locator('.ah-msg')).toHaveCount(0);
  await expect(panel(page).locator('.advisor-ask')).toHaveCount(0);
});

test('a failed answer shows as a failure, never as advice', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await stub(page, (route) => route.fulfill({ status: 502, json: { ok: false, error: 'The advisor couldn’t answer just now.' } }));
  await page.goto('/');
  await fab(page).click();
  await panel(page).locator('.advisor-ask input').fill('hello');
  await panel(page).locator('.advisor-ask button').click();
  await expect(panel(page).locator('.ah-msg.error')).toContainText('couldn’t answer');
  await expect(panel(page).locator('.ah-msg.user')).toHaveCount(1); // kept, so it can be retried
});

test('the thread carries forward, and Clear wipes it', async ({ page }) => {
  await loginAs(page, 'warehouse');
  let sent = null;
  await stub(page, (route) => { sent = route.request().postDataJSON(); return reply('answer')(route); });
  await page.goto('/');
  await fab(page).click();
  await panel(page).locator('.advisor-ask input').fill('first');
  await panel(page).locator('.advisor-ask button').click();
  await expect(panel(page).locator('.ah-msg.assistant')).toHaveCount(1);
  await panel(page).locator('.advisor-ask input').fill('and then?');
  await panel(page).locator('.advisor-ask button').click();
  await expect.poll(() => sent.messages.length).toBe(3); // "and then?" means nothing alone
  await panel(page).getByRole('button', { name: 'Clear' }).click();
  await expect(panel(page).locator('.ah-msg')).toHaveCount(0);
});

test('bullet lists render as a list, not as literal dashes', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await stub(page, reply('36 pairs in Shopify:\n- **8**: 4\n- **8.5**: 6\n- **13**: 7\n\nMostly small sizes.'));
  await page.goto('/');
  await fab(page).click();
  await panel(page).locator('.advisor-ask input').fill('stock?');
  await panel(page).locator('.advisor-ask button').click();
  const body = panel(page).locator('.ah-msg.assistant .ah-body');
  await expect(body.locator('.ah-list li')).toHaveCount(3);
  await expect(body.locator('.ah-list li').first()).toHaveText('8: 4');
  // The dashes are gone from the text, and the trailing paragraph is its own block.
  await expect(body).not.toContainText('- **8**');
  await expect(body.locator('.ah-p')).toHaveCount(2);
});

test('the stock caveat is attached by the UI, not left to the model', async ({ page }) => {
  await loginAs(page, 'warehouse');
  // The model says NOTHING about physical counts — the panel must add it anyway.
  await stub(page, (route) => route.fulfill({ json: { ok: true, reply: '36 pairs.', used: ['stock_status'] } }));
  await page.goto('/');
  await fab(page).click();
  await panel(page).locator('.advisor-ask input').fill('how many do we have?');
  await panel(page).locator('.advisor-ask button').click();
  await expect(panel(page).locator('.ah-caveat')).toContainText('Not a physical count');
  await expect(panel(page).locator('.ah-caveat')).toContainText('Ask the warehouse');
});

test('and it is NOT attached to answers that carry no stock figure', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await stub(page, (route) => route.fulfill({ json: { ok: true, reply: 'Scan the shelf first.', used: ['search_sop'] } }));
  await page.goto('/');
  await fab(page).click();
  await panel(page).locator('.advisor-ask input').fill('how do I shelve?');
  await panel(page).locator('.advisor-ask button').click();
  await expect(panel(page).locator('.ah-msg.assistant')).toBeVisible();
  // A caveat on every answer is a caveat nobody reads.
  await expect(panel(page).locator('.ah-caveat')).toHaveCount(0);
});

test('markdown renders as elements — model output is never HTML', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await stub(page, reply('Buy **1 pair** of `DD1391-100` — <img src=x onerror=alert(1)> stays text.'));
  await page.goto('/');
  await fab(page).click();
  await panel(page).locator('.advisor-ask input').fill('go');
  await panel(page).locator('.advisor-ask button').click();
  const body = panel(page).locator('.ah-msg.assistant .ah-body');
  await expect(body.locator('strong')).toHaveText('1 pair');
  await expect(body.locator('code')).toHaveText('DD1391-100');
  await expect(body).not.toContainText('**');
  // The one that matters: the advisor quotes strings from Alias, StockX, our database
  // and our SOPs. None of it may become a node.
  await expect(body.locator('img')).toHaveCount(0);
  await expect(body).toContainText('<img src=x onerror=alert(1)>');
});

test('the thread survives moving between screens — it is one conversation', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await stub(page, reply('Scan the shelf first.'));
  await page.goto('/');
  await fab(page).click();
  await panel(page).locator('.advisor-ask input').fill('how do I shelve?');
  await panel(page).locator('.advisor-ask button').click();
  await expect(panel(page).locator('.ah-msg.assistant')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // Navigate INSIDE the app (not a reload) — the advisor is mounted beside the router,
  // so the conversation must not restart every time someone changes page.
  await page.locator('.home-card', { hasText: 'Inventory' }).first().click();
  await expect(page).toHaveURL(/inventory/);
  await fab(page).click();
  await expect(panel(page).locator('.ah-msg.assistant')).toContainText('Scan the shelf first.');
  await expect(panel(page).locator('.ah-msg.user')).toHaveCount(1);
});

test('his messages carry his name and an EST time', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await stub(page, reply('Yes.'));
  await page.goto('/');
  await fab(page).click();
  await panel(page).locator('.advisor-ask input').fill('ok?');
  await panel(page).locator('.advisor-ask button').click();
  await expect(panel(page).locator('.ah-msg.assistant .ah-who')).toContainText('Alex Head');
  // estClock formats America/New_York to the minute — the browser clock is irrelevant
  // here by design, and seconds are noise in a thread.
  await expect(panel(page).locator('.ah-msg.assistant .ah-time')).toHaveText(/^\d{1,2}:\d{2}\s?(AM|PM)$/);
});

/* ------------------------------------------------------------------ */
/* Getting out of it. On a phone the sheet covers the FAB, so the FAB   */
/* cannot be the only way to close — that was a genuine trap.           */
/* ------------------------------------------------------------------ */

test('the header ✕ closes it, on any screen size', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/');
  for (const size of [{ width: 1200, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await fab(page).click();
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole('button', { name: 'Close' }).click();
    await expect(panel(page), `stuck open at ${size.width}px`).toHaveCount(0);
  }
});

test('on a phone the backdrop closes it, and the FAB is not left underneath', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await fab(page).click();
  await expect(panel(page)).toBeVisible();
  // The sheet covers the FAB, so leaving it rendered is an invisible tap target.
  await expect(fab(page)).toBeHidden();
  await page.locator('.advisor-backdrop').click({ position: { x: 195, y: 80 } });
  await expect(panel(page)).toHaveCount(0);
  await expect(fab(page)).toBeVisible();
});

test('the panel fits a phone without pushing the page sideways', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await fab(page).click();
  const box = await panel(page).boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
  expect(box.height).toBeLessThanOrEqual(844 * 0.85);
  // Warehouse staff live on phones; a horizontal scrollbar on the body is a bug here.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('the safe-area contract holds: viewport-fit is set, so env() is not inert', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/');
  // Without viewport-fit=cover, every env(safe-area-inset-*) in this stylesheet
  // silently resolves to 0 on iOS — which is exactly why the status bar was sitting on
  // the header while the CSS "handled" it. The two only work together.
  const meta = await page.locator('meta[name=viewport]').getAttribute('content');
  expect(meta).toContain('viewport-fit=cover');
  // And the page owning the full screen means WE owe the insets back.
  const pad = await page.evaluate(() => getComputedStyle(document.querySelector('.app')).paddingTop);
  expect(pad).not.toBe('0px');
});

// The two rules that live only in the prompt, and so have nothing else guarding them.
// Both were added 2026-08-27 — see docs/context/advisor.md.
test('both prompts are told the EST clock, not left to guess the date', () => {
  for (const build of [systemPrompt, supplierPrompt]) {
    const p = build('page: Home', { name: 'E2E', role: 'warehouse' });
    // Without a "now" the model dates "today" from its training; the host is UTC and
    // the PH team's clock is a day ahead, so neither of those is the answer either.
    expect(p).toContain(`EST (today's date is ${estToday()})`);
    expect(p).toMatch(/only\s+"now" there is/);
  }
});

test('the staff prompt is scoped to this business, and declines the whole bundled message', () => {
  const p = systemPrompt('page: Home', { name: 'E2E', role: 'warehouse' });
  expect(p).toContain('I only help with Stickballman12');
  // The failure this fixed: an off-topic ask answered, then a menu of alternatives.
  expect(p).toMatch(/Don't offer a safer or more factual version/);
  // And the half-answer, which the model did about one run in three when asked to split.
  expect(p).toMatch(/decline is the whole reply/i);
});

// The scope rule's own failure (2026-08-28): "can you check Shopify for me?" earned the
// decline line. The systems we sell and price on are the subject, and so is what he can
// do — a work tool that answers "what can you see?" with a refusal reads as broken.
// Purchase orders (2026-09-01). The rules that keep a PO from being MISREAD live only
// in the prompt and the tool payload, so this is the only thing guarding them.
test('the prompt knows the PO tools, and how not to misread an order', () => {
  const p = systemPrompt('page: Home', { name: 'E2E', role: 'warehouse' });
  expect(p).toMatch(/nine read-only tools/);
  expect(p).toContain('po_status');
  expect(p).toContain('po_list');
  // The three things that look exactly like a shortage in the raw numbers.
  expect(p).toMatch(/where_it_stands` first/);
  expect(p).toMatch(/unshipped label can never read as short/i);
  expect(p).toMatch(/received blind/i);
  // A notation difference is not a missing pair — this once faked 154 short pairs.
  expect(p).toMatch(/spelling difference is not a missing pair/i);
  // "One Dunk is missing" sends nobody anywhere.
  expect(p).toMatch(/Say which BOX, not only which shoe/);
  // And it still can't act — reconciling is a screen, not a chat message.
  expect(p).toMatch(/cannot fix an order/i);
});

// The gap the 2026-08-27 date rule left open, now closed: an order IS raised on a day.
test('orders are the one count allowed to carry a date, and never come from pending_work', () => {
  const p = systemPrompt('page: Home', { name: 'E2E', role: 'warehouse' });
  expect(p).toMatch(/ONE\s*\n?\s*exception, purchase orders/);
  expect(p).toMatch(/po_list` takes `days`/);
  // "Orders" reached for the shipping backlog once; pending_work is a queue length.
  expect(p).toMatch(/never `pending_work`/);
});

test('our own channels, and questions about what he can do, are IN scope', () => {
  const p = systemPrompt('page: Home', { name: 'E2E', role: 'warehouse' });
  expect(p).toMatch(/systems this business runs on are part of that subject/i);
  expect(p).toMatch(/Shopify, GOAT, Alias,\s*\n?\s*StockX, eBay and TikTok are where we sell and price/i);
  expect(p).toMatch(/So are questions about YOU/);
  // The wrong-tool half: pending_work's per-store backlog quoted as a Shopify figure.
  expect(p).toMatch(/never pending_work/i);
});
