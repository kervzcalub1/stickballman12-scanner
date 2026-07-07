// Smoke tests for the superadmin role, Settings (price margin) screen, and the
// temp-password reset control. Data-independent: asserts on screen chrome that
// renders with any DB state. Uses a minted superadmin session (see helpers/auth).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
});

test.describe('superadmin', () => {
  test('home shows PH Team Workspace + Settings, and PH workspace opens & exits', async ({ page }) => {
    await loginAs(page, 'superadmin');
    await page.goto('/');
    // Admin + superadmin-only cards both present.
    await expect(page.getByText('PH Team Workspace')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
    await expect(page.getByText('Check Access')).toBeVisible();
    await expect(page.getByText('Settings', { exact: true })).toBeVisible();

    // Enter the PH workspace (reuses PHTeamApp) — its chooser home shows PH cards.
    await page.getByText('PH Team Workspace').click();
    await expect(page).toHaveURL(/\/ph$/);
    await expect(page.getByText('New Inventory')).toBeVisible();
    await expect(page.getByText('Edited Photos')).toBeVisible();

    // "← Home" (onExit) returns to the main admin home.
    await page.getByRole('button', { name: '← Home' }).click();
    await expect(page.getByText('PH Team Workspace')).toBeVisible();
  });

  test('Settings screen loads the margin and previews Final', async ({ page }) => {
    await loginAs(page, 'superadmin');
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Price margin' })).toBeVisible();
    // Value loads from /api/settings (default 20).
    await expect(page.getByRole('spinbutton')).toHaveValue(/\d+/);
    await expect(page.getByText(/Preview: GI \$100/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Save margin/ })).toBeVisible();
  });
});

test.describe('admin access management', () => {
  test('Check Access exposes a Reset password action', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/access');
    // Wait for the accounts list to load (TopBar title is plain text, not a heading).
    await expect(page.getByText('Check Access').first()).toBeVisible();
    await expect(page.getByText('Loading…')).toHaveCount(0);
    // With accounts present, each row exposes a "Reset password" button.
    if (await page.getByText('No accounts yet.').count() === 0) {
      await expect(page.getByRole('button', { name: 'Reset password' }).first()).toBeVisible();
    }
  });
});
