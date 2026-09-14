// /api/sku-lookup — the public "what shoe is this style code?" endpoint. No session,
// one upstream call to the official Alias catalogue, nothing from our own stock.
import { test, expect } from '@playwright/test';
import { loadEnv } from './helpers/auth.js';

loadEnv();

test('a bad request is refused before anything upstream is called', async ({ request }) => {
  const r = await request.get('/api/sku-lookup');
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toMatch(/sku/i);
  expect((await request.delete('/api/sku-lookup?sku=DQ8426-109')).status()).toBe(405);
});

test('a SKU comes back with the shoe name from the official Alias catalogue, no auth needed', async ({ request }) => {
  test.skip(!process.env.ALIAS_API_KEY, 'no Alias key in this env');
  const r = await request.get('/api/sku-lookup?sku=DQ8426-109', { timeout: 60_000 });
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.ok).toBe(true);
  expect(body.name).toMatch(/Air Jordan 1 Mid/i);
  expect(body.catalogId).toBeTruthy();
  expect(body.sizes.length).toBeGreaterThan(5);
  // Says what the code IS, never what we hold.
  expect(JSON.stringify(body)).not.toMatch(/vin|on_hand|location|cost/i);
  // The same answer for a POST body, so a non-browser caller can pick either.
  const p = await request.post('/api/sku-lookup', { data: { sku: 'DQ8426 109' }, timeout: 60_000 });
  expect((await p.json()).catalogId).toBe(body.catalogId);
});

test('a code the catalogue does not know is a 404, not an invented shoe', async ({ request }) => {
  test.skip(!process.env.ALIAS_API_KEY, 'no Alias key in this env');
  const r = await request.get('/api/sku-lookup?sku=ZZZZ-NOPE-000', { timeout: 60_000 });
  expect(r.status()).toBe(404);
});
