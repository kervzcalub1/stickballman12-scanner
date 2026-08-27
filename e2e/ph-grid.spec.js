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

// Search on the PH grid: same keyword rule as the Inventory page, but client-side
// over the rows already loaded for the date range (lib/ph phRowMatches).
test('search narrows the lines by non-adjacent keywords', async ({ page }) => {
  const rows = await openGrid(page);
  test.skip(rows === 0, 'no rows in range (empty DB)');
  const trows = page.locator('.ph-trow');
  // Read the NAME ELEMENT, not the whole cell. The cell also carries an expand caret and
  // a listing-status chip ("• Not listed"), and scraping the lot fed the search words that
  // are not in any shoe's name — so the filter correctly returned nothing and the test
  // failed. It only ever passed because the first row happened to carry no chip.
  // `.copytext` is the shoe name itself; its innerText still ends with the "Copy" cue.
  // Look for a row long enough to test non-adjacency, rather than only the first one.
  // Judging the first row alone skipped the whole test whenever it happened to be
  // something like "UI Only Test" — a pass that exercised nothing.
  const readName = async (i) => {
    const cell = trows.nth(i).locator('td').nth(1);
    const el = cell.locator('.copytext').first();
    const raw = await (await el.count() ? el : cell).innerText();
    return raw.replace(/\bCopy\b/g, '').replace(/Copied ✓/g, '').trim();
  };
  let name = ''; let words = [];
  for (let i = 0; i < Math.min(rows, 10); i += 1) {
    const n = await readName(i);
    const w = n.split(/\s+/).filter((x) => x.length > 2);
    if (w.length >= 3) { name = n; words = w; break; }
  }
  test.skip(words.length < 3, 'no row in range has a long enough name to test non-adjacency');

  // First + LAST word — deliberately not adjacent, which a plain substring can't match.
  const query = `${words[0]} ${words[words.length - 1]}`;
  const want = [words[0], words[words.length - 1]].map((w) => w.toLowerCase());
  await page.locator('.ph-search-input').fill(query);
  // Poll the INVARIANT, not the count: "≤ rows" is true before the filter has even
  // rendered, so asserting on it first reads the unfiltered table and passes for the
  // wrong reason (it did exactly that here).
  await expect.poll(async () => {
    const n = await trows.count();
    if (!n) return 'no rows';
    for (let i = 0; i < n; i++) {
      const text = (await trows.nth(i).innerText()).toLowerCase();
      if (!want.every((w) => text.includes(w))) return 'unfiltered row still shown';
    }
    return 'all shown rows match';
  }).toBe('all shown rows match');

  await page.locator('.ph-search').getByRole('button', { name: 'Clear' }).click();
  await expect.poll(() => trows.count()).toBe(rows);
});

// The row you're editing must never be filtered away: it holds an unsaved draft AND a
// server-side edit lock, and hiding it strands both behind a search box.
test('a row being edited survives a search that excludes it', async ({ page }) => {
  const rows = await openGrid(page);
  test.skip(rows === 0, 'no rows in range (empty DB)');
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await expect(page.locator('.ph-sizetable').first()).toBeVisible();
  await page.locator('.ph-search-input').fill('zzz definitely no match');
  await page.waitForTimeout(300);
  await expect(page.locator('.ph-sizetable').first()).toBeVisible();
  expect(await page.locator('.ph-trow').count()).toBe(1);
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
