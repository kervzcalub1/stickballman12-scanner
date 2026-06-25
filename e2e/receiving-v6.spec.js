// V6 Phase A coverage: the suppliers + duplicate-tracking endpoints and the
// shared size comparator. API tests mint a signed warehouse token (same trick
// as helpers/auth.js) and hit the routes directly — data-independent.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import { compareSizes } from '../src/lib/codes.js';

loadEnv();
const authHeaders = () => ({
  Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}`,
});

test.describe('V6 · suppliers endpoint (Feature 1)', () => {
  test('returns the seeded vendor list incl. JD Sports', async ({ request }) => {
    const res = await request.get('/api/suppliers', { headers: authHeaders() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.suppliers)).toBe(true);
    expect(body.suppliers).toContain('JD Sports');
  });

  test('requires auth', async ({ request }) => {
    const res = await request.get('/api/suppliers');
    expect(res.status()).toBe(401);
  });
});

test.describe('V6 · duplicate-tracking check (Feature 8)', () => {
  test('an unseen tracking number is not flagged', async ({ request }) => {
    const res = await request.get('/api/batches/check-tracking?tracking=ZZ-NOPE-' + Date.now(), { headers: authHeaders() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.exists).toBe(false);
    expect(body.batchCode).toBeNull();
  });
});

test.describe('V6 · size comparator (Feature 6)', () => {
  test('sorts numeric sizes smallest→largest regardless of input order', () => {
    expect(['8', '5', '9', '7'].sort(compareSizes)).toEqual(['5', '7', '8', '9']);
    expect(['10', '8.5', '9'].sort(compareSizes)).toEqual(['8.5', '9', '10']);
  });
  test('handles Y/W suffixes and floats blanks/custom to the end', () => {
    expect(['10Y', '8Y', '9.5Y'].sort(compareSizes)).toEqual(['8Y', '9.5Y', '10Y']);
    expect(['9', 'OS', '7'].sort(compareSizes)).toEqual(['7', '9', 'OS']);
  });
});
