// PH grid interaction suite — the most heavily refactored screen (PHTeam.jsx),
// exercising the seams the build can't check: per-size editor (components/YesNo),
// the GI→Final auto-calc (lib/ph calcFinalPrice), and the History modal
// (components/HistoryModal + lib/history). Data-dependent, so each test skips
// gracefully when the current range has no rows (e.g. an empty CI database).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
});

async function openGrid(page) {
  await loginAs(page, 'ph_team');
  await page.goto('/ph/new-inventory');
  await expect(page.getByText('New Inventory')).toBeVisible();
  // Wait for the grid to settle (loading → rows or empty message).
  await page.waitForTimeout(800);
  return page.locator('.ph-trow').count();
}

test('grid loads with editable rows', async ({ page }) => {
  const rows = await openGrid(page);
  test.skip(rows === 0, 'no rows in range (empty DB)');
  await expect(page.getByRole('button', { name: 'Edit' }).first()).toBeVisible();
});

test('Edit reveals the per-size editor (inputs + flag checkboxes)', async ({ page }) => {
  const rows = await openGrid(page);
  test.skip(rows === 0, 'no rows in range (empty DB)');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await expect(page.locator('input.ph-price').first()).toBeVisible();
  await expect(page.locator('.ph-yn-check').first()).toBeVisible();
  // Button text is "Submit" — the "×{qty}" is a sibling badge span, not part of the button label.
  await expect(page.getByRole('button', { name: 'Submit' }).first()).toBeVisible();
});

test('Global Indicator drives Final Price = GI × margin (whole dollar)', async ({ page }) => {
  const rows = await openGrid(page);
  test.skip(rows === 0, 'no rows in range (empty DB)');
  // Final = GI × the configured margin, rounded to the nearest whole dollar. Read
  // the current margin so the test stays correct whatever it's set to.
  const pct = await page.evaluate(async () => {
    const t = sessionStorage.getItem('sb_session_token');
    const r = await fetch('/api/settings', { headers: { Authorization: `Bearer ${t}` } });
    return (await r.json()).priceMarkupPct;
  });
  const mult = 1 + Number(pct) / 100;
  await page.getByRole('button', { name: 'Edit' }).first().click();
  const inputs = page.locator('input.ph-price');
  await expect(inputs.first()).toBeVisible();
  // In the per-size table the GI input precedes the Final-price input.
  const gi = inputs.nth(0);
  const final = inputs.nth(1);
  await gi.fill('100');
  await expect(final).toHaveValue(String(Math.round(100 * mult)));
  await gi.fill('250');
  await expect(final).toHaveValue(String(Math.round(250 * mult)));
});

test('flag checkbox toggles', async ({ page }) => {
  const rows = await openGrid(page);
  test.skip(rows === 0, 'no rows in range (empty DB)');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  const cb = page.locator('.ph-yn-check').first();
  const before = await cb.isChecked();
  await cb.click();
  expect(await cb.isChecked()).toBe(!before);
});

// The column "All" tick: a 13-size shoe is 13 identical clicks otherwise, and PH
// lists a whole row to a store in one pass. Guards the header control staying wired
// to every size's draft — the bug it replaces is silent (one size left unticked).
test('column "All" ticks that store for every size', async ({ page }) => {
  const rows = await openGrid(page);
  test.skip(rows === 0, 'no rows in range (empty DB)');
  // Edit the first MULTI-size row — a one-size row can't show that "All" spans sizes.
  const trows = page.locator('.ph-trow');
  let target = -1;
  for (let i = 0; i < Math.min(rows, 20); i++) {
    if (await trows.nth(i).locator('.szq-chip').count() > 1) { target = i; break; }
  }
  test.skip(target < 0, 'no multi-size row in range');
  await trows.nth(target).getByRole('button', { name: 'Edit' }).click();
  const table = page.locator('.ph-sizetable').first();
  await expect(table).toBeVisible();
  const sizeCount = await table.locator('tbody tr').count();

  // Column index of Alias (it shifts with the pricing columns, which warehouse can't see).
  // innerText is the RENDERED text and the header is text-transform: uppercase — match
  // case-insensitively or this silently finds nothing and the test skips itself.
  const headers = await table.locator('thead th').allInnerTexts();
  const col = headers.findIndex((h) => h.trim().toLowerCase().startsWith('alias'));
  test.skip(col < 0, 'GOAT-only row — Alias column not present in this shape');

  const cellBox = (i) => table.locator('tbody tr').nth(i).locator('td').nth(col).locator('input.ph-yn-check');
  await table.locator('thead th').nth(col).locator('.ph-flag-all input').check();
  for (let i = 0; i < sizeCount; i++) await expect(cellBox(i)).toBeChecked();

  // …and unticking it clears the whole column again (it is not a one-way switch).
  await table.locator('thead th').nth(col).locator('.ph-flag-all input').uncheck();
  for (let i = 0; i < sizeCount; i++) await expect(cellBox(i)).not.toBeChecked();
});

test('History modal opens with a timeline', async ({ page }) => {
  const rows = await openGrid(page);
  test.skip(rows === 0, 'no rows in range (empty DB)');
  // The History button lives in the expanded per-size drawer — expand the row first.
  await page.locator('.ph-trow').first().click();
  await expect(page.getByRole('button', { name: /History/ }).first()).toBeVisible();
  await page.getByRole('button', { name: /History/ }).first().click();
  await expect(page.locator('.hist-modal')).toBeVisible();
  await expect(page.locator('.hist-modal .modal-title')).toContainText('History');
  // Either a populated timeline or the explicit empty state — both are valid.
  const ok = page.locator('.hist-timeline .tl-item').first().or(page.getByText('No history yet.'));
  await expect(ok).toBeVisible();
});
