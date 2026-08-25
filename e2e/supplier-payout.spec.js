// A supplier account gets the Payout Calculator — with their OWN cost stack and
// nobody else's.
//
// The line under test is the scope: Andrew sees Andrew. It keys on
// `payout_presets.supplier_user_id`, so the tests set two suppliers up with two
// presets and check each side of the wall, plus the other half of the rule — a
// supplier can READ their stack but never write it, because that stack is an input to
// our own buy call.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-6);
const A = { username: `e2e_sup_a_${stamp}`, name: `E2E Andrew ${stamp}`, preset: `E2E Andrew ${stamp}` };
const B = { username: `e2e_sup_b_${stamp}`, name: `E2E Esteban ${stamp}`, preset: `E2E Esteban ${stamp}` };

// loginAs mints a token for a fixed demo uid; these accounts need REAL row ids,
// because that id is what the preset is scoped by.
async function signInAs(page, u) {
  const token = signToken({ uid: String(u.id), username: u.username, name: u.name, role: 'supplier' });
  const userJson = JSON.stringify({ username: u.username, name: u.name, role: 'supplier' });
  await page.addInitScript(([t, j]) => {
    sessionStorage.setItem('sb_session_token', t);
    sessionStorage.setItem('sb_user', j);
  }, [token, userJson]);
}
const authFor = (u) => ({ Authorization: `Bearer ${signToken({ uid: String(u.id), username: u.username, name: u.name, role: 'supplier' })}` });

test.beforeAll(async () => {
  for (const u of [A, B]) {
    u.id = Number((await q(
      `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,$2,'s2$00$00','supplier','approved') RETURNING id`,
      [u.name, u.username]))[0].id);
    await q(
      `INSERT INTO payout_presets (name, tip_amt, shipping_amt, tax_pct, gift_pct, supplier_user_id)
       VALUES ($1,$2,8.25,8.25,8,$3)`,
      [u.preset, u === A ? 5 : 7, u.id]);
  }
});

test.afterAll(async () => {
  await q(`DELETE FROM payout_presets WHERE name = ANY($1)`, [[A.preset, B.preset]]);
  await q(`DELETE FROM users WHERE username = ANY($1)`, [[A.username, B.username]]);
  await pool.end();
});

test('the supplier home offers Purchase Orders and the Payout Calculator', async ({ page }) => {
  await signInAs(page, A);
  await page.goto('/');
  await expect(page.locator('.home-card-title', { hasText: 'Purchase Orders' })).toBeVisible();
  await expect(page.locator('.home-card-title', { hasText: 'Payout Calculator' })).toBeVisible();

  await page.locator('.home-card', { hasText: 'Purchase Orders' }).click();
  await expect(page.locator('.topbar .brand')).toContainText('Outbound Shipments');
  await expect(page).toHaveURL(/\/orders$/);

  // Home and back out to the other card.
  await page.locator('.topbar').getByRole('button', { name: '← Home' }).click();
  await page.locator('.home-card', { hasText: 'Payout Calculator' }).click();
  await expect(page.locator('.topbar .brand')).toContainText('Payout Calculator');
  await expect(page).toHaveURL(/\/payout$/);
  // A refresh lands back on the calculator, not the home chooser.
  await page.reload();
  await expect(page.locator('.topbar .brand')).toContainText('Payout Calculator');
});

test('a supplier sees only their own stack, applied for them, and cannot manage it', async ({ page }) => {
  await signInAs(page, A);
  await page.goto('/payout');
  const chips = page.locator('.pc-preset-chips .pi-chip');
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveText(A.preset);
  // Nobody should have to tap their own name — it applies itself on load.
  await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.pc-field', { hasText: 'Tip' }).first().locator('input')).toHaveValue('5');
  await expect(page.locator('.pc-field', { hasText: 'Shipping' }).first().locator('input')).toHaveValue('8.25');
  // Their stack is what WE buy at through them — the floor's number to change.
  await expect(page.getByRole('button', { name: 'Manage' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '＋ Add a supplier' })).toHaveCount(0);
  // And the other supplier is nowhere on the page.
  await expect(page.getByText(B.preset)).toHaveCount(0);
});

test('the other supplier gets their own, and neither can write', async ({ request, baseURL }) => {
  const seen = async (u) => {
    const r = await request.get(`${baseURL}/api/payout/presets`, { headers: authFor(u) });
    expect(r.ok()).toBeTruthy();
    return (await r.json()).presets.map((p) => p.name);
  };
  expect(await seen(A)).toEqual([A.preset]);
  expect(await seen(B)).toEqual([B.preset]);

  // A supplier raising their own tip fee would move our buy call — staff-only.
  const write = await request.post(`${baseURL}/api/payout/presets`, {
    headers: authFor(A),
    data: { preset: { id: null, name: `E2E Sneaky ${stamp}`, tipAmt: 99 } },
  });
  expect(write.status()).toBe(403);
  // Nor can they delete the one they can see.
  const del = await request.post(`${baseURL}/api/payout/presets`, {
    headers: authFor(A), data: { deleteId: 1 },
  });
  expect(del.status()).toBe(403);
  expect((await q(`SELECT id FROM payout_presets WHERE name = $1`, [`E2E Sneaky ${stamp}`])).length).toBe(0);
});

test('staff still see every preset, and which account each is linked to', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/payout');
  const chips = page.locator('.pc-preset-chips .pi-chip');
  await expect(chips.filter({ hasText: A.preset })).toHaveCount(1);
  await expect(chips.filter({ hasText: B.preset })).toHaveCount(1);
  // Nothing auto-applies for staff — they pick who's buying.
  await expect(page.locator('.pc-preset-chips .pi-chip.on')).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage' }).click();
  const row = page.locator('.pc-preset-row', { hasText: A.preset });
  await expect(row.locator('.pc-preset-linked')).toContainText(A.username);
});
