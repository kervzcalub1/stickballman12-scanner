// V6 Phase A coverage: the suppliers + duplicate-tracking endpoints and the
// shared size comparator. API tests mint a signed warehouse token (same trick
// as helpers/auth.js) and hit the routes directly — data-independent.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import { compareSizes } from '../src/lib/codes.js';
import { presignPutUrl } from '../api/_lib/r2.js';

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

test.describe('V6 · listing photos (Feature 5)', () => {
  test('photo list is auth-gated and reports R2 config state', async ({ request }) => {
    const noauth = await request.get('/api/photos/list?sku=TEST-SKU');
    expect(noauth.status()).toBe(401);

    const res = await request.get('/api/photos/list?sku=TEST-SKU', { headers: authHeaders() });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.photos)).toBe(true);
    expect(typeof body.configured).toBe('boolean');
  });

  test('sign returns 503 when R2 is not configured', async ({ request }) => {
    test.skip(!!process.env.R2_ACCOUNT_ID, 'R2 is configured in this env');
    const res = await request.post('/api/photos/sign', {
      headers: authHeaders(), data: { sku: 'TEST-SKU', angle: 'side', contentType: 'image/jpeg' },
    });
    expect(res.status()).toBe(503);
  });

  test('presignPutUrl builds a well-formed signed URL', () => {
    const prev = { ...process.env };
    Object.assign(process.env, {
      R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'photos',
    });
    const url = presignPutUrl({ key: 'listings/AB-12/side-1.jpg' });
    Object.assign(process.env, prev);
    expect(url).toContain('https://acct123.r2.cloudflarestorage.com/photos/listings/AB-12/side-1.jpg?');
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
  });
});

test.describe('V6 · defect issue photos (Feature 4)', () => {
  test('sign-issue is auth-gated and rejects a bad VIN', async ({ request }) => {
    const noauth = await request.post('/api/photos/sign-issue', { data: { vin: 'SBM-260626-000001' } });
    expect(noauth.status()).toBe(401);

    // A bad VIN is never signed: 400 when R2 is configured, or 503 first when it
    // isn't (the endpoint checks storage availability before body validation,
    // matching sign.js). Either way it must not succeed.
    const bad = await request.post('/api/photos/sign-issue', { headers: authHeaders(), data: { vin: 'not-a-vin' } });
    expect([400, 503]).toContain(bad.status());
  });

  test('sign-issue returns a presigned URL keyed by VIN (or 503 if R2 unset)', async ({ request }) => {
    const vin = 'SBM-260626-000001';
    const res = await request.post('/api/photos/sign-issue', { headers: authHeaders(), data: { vin, contentType: 'image/jpeg' } });
    if (!process.env.R2_ACCOUNT_ID) { expect(res.status()).toBe(503); return; }
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.uploadUrl).toContain(`/issues/${vin}/`);
    expect(body.uploadUrl).toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
    expect(body.publicUrl).toContain(`/issues/${vin}/`);
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
