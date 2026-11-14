// One sign-in for every tab of the browser (owner 2026-11-15: "logged in, open a new tab, it
// asks me to log in again"). The session used to live in sessionStorage only — per TAB — so a
// new tab started signed out. src/api.js now keeps it in localStorage too (shared), with the
// tab's own copy read first.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';

loadEnv();

const WH = { uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' };
const home = (page) => page.locator('.home-greeting');
const loginForm = (page) => page.getByPlaceholder('Username');

// A sign-in written the way the app writes it (both stores), without the rate-limited login.
async function signInHere(page, user) {
  const token = signToken(user);
  const json = JSON.stringify({ username: user.username, name: user.name, role: user.role });
  await page.evaluate(([t, u]) => {
    for (const s of [sessionStorage, localStorage]) { s.setItem('sb_session_token', t); s.setItem('sb_user', u); }
  }, [token, json]);
}

test('signed in once: a NEW tab of the same browser is signed in; signing out there signs out this tab too', async ({ context }) => {
  const adminPass = process.env.ADMIN_PASSWORD;
  test.skip(!adminPass, 'ADMIN_PASSWORD not set');
  const a = await context.newPage();
  await a.goto('/');
  await loginForm(a).fill('admin');
  await a.getByPlaceholder('Password').fill(adminPass);
  const resp = a.waitForResponse((r) => r.url().includes('/api/auth/login'));
  await a.locator('form').getByRole('button', { name: 'Sign in' }).click();
  const status = (await resp).status();
  test.skip(status === 429, 'login rate-limited (rapid re-runs) — restart dev server to reset');
  await expect(home(a)).toContainText('Hi Alex');

  // The new tab: no sign-in screen.
  const b = await context.newPage();
  await b.goto('/inventory');
  await expect(loginForm(b)).toHaveCount(0);
  await expect(b).toHaveURL(/\/inventory/);
  await b.goto('/');
  await expect(home(b)).toContainText('Hi Alex');

  // Sign out in the new tab → the first tab follows, and a third tab asks to sign in.
  await b.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(loginForm(b)).toBeVisible();
  await expect(loginForm(a)).toBeVisible();
  const c = await context.newPage();
  await c.goto('/');
  await expect(loginForm(c)).toBeVisible();
});

test('a tab on the sign-in screen is signed in when another tab signs in', async ({ context }) => {
  const a = await context.newPage();
  await a.goto('/');
  await expect(loginForm(a)).toBeVisible();
  const b = await context.newPage();
  await b.goto('/');
  await signInHere(b, { uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' });
  await expect(home(a)).toContainText('Hi Alex');
});

test('a tab keeps its own account when another tab signs in as someone else', async ({ context }) => {
  const a = await context.newPage();
  await a.goto('/');
  await signInHere(a, { uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' });
  await a.reload();
  await expect(home(a)).toContainText('Hi Alex');

  // Another tab becomes the warehouse account.
  const b = await context.newPage();
  await b.goto('/');
  await signInHere(b, WH);
  await b.reload();
  await expect(home(b)).toContainText('E2E Warehouse');

  // The first tab is still Alex after a reload — its own copy wins over the shared one.
  await a.reload();
  await expect(home(a)).toContainText('Hi Alex');
  // The warehouse tab signs out: that was not the first tab's session, so it stays in.
  await b.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(loginForm(b)).toBeVisible();
  await a.reload();
  await expect(home(a)).toContainText('Hi Alex');
});

test('an expired saved sign-in goes to the sign-in screen, not a broken page', async ({ context }) => {
  const a = await context.newPage();
  await a.goto('/');
  const expired = signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' }, -1000);
  await a.evaluate((t) => {
    localStorage.setItem('sb_session_token', t);
    localStorage.setItem('sb_user', JSON.stringify({ username: 'admin', name: 'Alex', role: 'admin' }));
  }, expired);
  const b = await context.newPage();
  await b.goto('/');
  await expect(loginForm(b)).toBeVisible({ timeout: 15_000 });
  expect(await b.evaluate(() => localStorage.getItem('sb_session_token'))).toBeNull();
});
