// Admin tools on top of a job (2026-10-27): "Manage user access" and "Connect integrations"
// are PRIVILEGES, so a PH or warehouse account gets the admin's two everyday powers without
// becoming an admin — its role, and so its dashboard, stays its own. A holder works on other
// people's NON-admin accounts only, and only a real admin grants the two (accessRefusal).
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loadEnv } from './helpers/auth.js';
import { signToken, hashPassword } from '../api/_lib/util.js';

loadEnv();
test.describe.configure({ mode: 'serial' });

const stamp = `${Date.now()}`.slice(-6);
const CAST = {
  manager: { name: 'E2E Access Manager', username: `e2e_mgr_${stamp}`, role: 'ph_team', privileges: ['manage_access', 'connect_integrations'] },
  plain: { name: 'E2E Plain PH', username: `e2e_plain_${stamp}`, role: 'ph_team', privileges: [] },
  newbie: { name: 'E2E Newbie', username: `e2e_new_${stamp}`, role: 'warehouse', privileges: [], status: 'pending' },
  boss: { name: 'E2E DB Admin', username: `e2e_boss_${stamp}`, role: 'admin', privileges: [] },
};
let pool;
const people = {};
const alex = signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' });
const tokenFor = (u) => signToken({ uid: u.uid, username: u.username, name: u.name, role: u.role });
const post = (request, token, path, data) => request.post(`/api/${path}`, { headers: { Authorization: `Bearer ${token}` }, data })
  .then(async (r) => ({ status: r.status(), body: await r.json().catch(() => ({})) }));
const get = (request, token, path) => request.get(`/api/${path}`, { headers: { Authorization: `Bearer ${token}` } })
  .then(async (r) => ({ status: r.status(), body: await r.json().catch(() => ({})) }));
const row = async (who) => (await pool.query('SELECT role, status, privileges FROM users WHERE id = $1', [people[who].uid])).rows[0];

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  for (const [key, u] of Object.entries(CAST)) {
    const { rows } = await pool.query(
      `INSERT INTO users (name, username, pass_hash, role, status, privileges) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [u.name, u.username, hashPassword('e2e-not-used'), u.role, u.status || 'approved', u.privileges]);
    people[key] = { ...u, uid: Number(rows[0].id) };
  }
});
test.afterAll(async () => {
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [Object.values(people).map((p) => p.uid)]);
  await pool.end();
});

test('Check Access opens for "Manage user access", and only for it', async ({ request }) => {
  expect((await get(request, tokenFor(people.plain), 'admin/users')).status).toBe(403);
  const r = await get(request, tokenFor(people.manager), 'admin/users');
  expect(r.status).toBe(200);
  expect(r.body.users.some((u) => u.username === people.newbie.username)).toBe(true);
});

test('a holder approves, sets roles and staff privileges, resets passwords — on non-admin accounts', async ({ request }) => {
  const t = tokenFor(people.manager);
  expect((await post(request, t, 'admin/review', { userId: people.newbie.uid, decision: 'approve' })).status).toBe(200);
  expect((await post(request, t, 'admin/review', { userId: people.newbie.uid, decision: 'role', role: 'ph_team' })).status).toBe(200);
  expect((await post(request, t, 'admin/review', { userId: people.plain.uid, decision: 'privileges', privileges: ['audit_po'] })).status).toBe(200);
  expect((await post(request, t, 'admin/reset-password', { userId: people.plain.uid })).body.tempPassword).toBeTruthy();
  expect(await row('newbie')).toMatchObject({ status: 'approved', role: 'ph_team' });
  expect((await row('plain')).privileges).toEqual(['audit_po']);
});

test('…but never makes an admin, hands out the admin-level two, or touches an admin or themselves', async ({ request }) => {
  const t = tokenFor(people.manager);
  const no = async (path, data, msg) => {
    const r = await post(request, t, path, data);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(msg);
  };
  await no('admin/review', { userId: people.plain.uid, decision: 'role', role: 'admin' }, /Only an admin can make someone an admin/);
  await no('admin/review', { userId: people.plain.uid, decision: 'privileges', privileges: ['audit_po', 'manage_access'] }, /Only an admin can grant or remove/);
  await no('admin/review', { userId: people.boss.uid, decision: 'delete' }, /Only an admin can change an admin/);
  await no('admin/reset-password', { userId: people.boss.uid }, /Only an admin can change an admin/);
  await no('admin/review', { userId: people.manager.uid, decision: 'privileges', privileges: ['manage_access', 'connect_integrations', 'approve_buying'] }, /your own account/);
  expect((await row('plain')).privileges).toEqual(['audit_po']);
  expect((await row('boss')).role).toBe('admin');
  // An admin still can.
  expect((await post(request, alex, 'admin/review', { userId: people.plain.uid, decision: 'privileges', privileges: ['manage_access'] })).status).toBe(200);
  expect((await row('plain')).privileges).toEqual(['manage_access']);
  await post(request, alex, 'admin/review', { userId: people.plain.uid, decision: 'privileges', privileges: [] });
});

test('Connect SHEIN / eBay: "Connect integrations" gets past the gate, without it is refused', async ({ request }) => {
  for (const path of ['shein/connect', 'ebay/connect']) {
    const without = await post(request, tokenFor(people.plain), path, {});
    expect(without.status).toBe(403);
    expect(without.body.error).toMatch(/Connect integrations/);
    // Past the privilege gate: whatever it answers next (not set up here / a consent URL), it isn't 403.
    expect((await post(request, tokenFor(people.manager), path, {})).status).not.toBe(403);
  }
});

test('the holder keeps the PH dashboard, with Check Access on it', async ({ page }) => {
  const u = people.manager;
  await page.addInitScript(([tk, j]) => { sessionStorage.setItem('sb_session_token', tk); sessionStorage.setItem('sb_user', j); },
    [tokenFor(u), JSON.stringify({ username: u.username, name: u.name, role: u.role, privileges: u.privileges })]);
  await page.goto('/');
  await expect(page.getByText('Pricing & Listing')).toBeVisible();            // still the PH workspace
  await page.getByRole('button', { name: /Check Access/ }).first().click();
  await expect(page).toHaveURL(/\/ph\/access$/);
  const bossRow = page.locator('tr', { hasText: people.boss.username });
  await expect(bossRow).toContainText('Only an admin can change an admin’s account');
  // The admin-level privileges show, greyed, on someone else's row.
  const plainRow = page.locator('tr', { hasText: people.plain.username });
  await expect(plainRow.getByLabel('Manage user access')).toBeDisabled();
  await expect(plainRow.getByLabel('Approve buying requests')).toBeEnabled();
});
