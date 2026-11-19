// The claim photos on Receive New's Issues step (docs/context/receiving-evidence.md), for specs
// that walk a receive with something off: the uploads are stubbed — these tests are about the
// gate and what is saved, not the bucket.
import { expect } from '@playwright/test';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export async function stubClaimUploads(page, tag = 'claim') {
  let n = 0;
  await page.route('**/api/inbound-issues/photo-sign', (route) => { n += 1; return route.fulfill({ json: { ok: true, uploadUrl: 'https://uploads.e2e.test/put', publicUrl: `https://photos.e2e.test/${tag}-${n}.jpg` } }); });
  await page.route('https://uploads.e2e.test/**', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('https://photos.e2e.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
}

// Take one photo for each of `keys` (label · pairs · slip) on the required card.
export async function shootClaim(page, keys = ['label', 'pairs']) {
  const claim = page.locator('.oo-claim');
  for (const key of keys) {
    await claim.locator(`[data-claim="${key}"] input[type=file]`).last().setInputFiles({ name: `${key}.png`, mimeType: 'image/png', buffer: PNG });
    await expect(claim.locator(`[data-claim="${key}"] .dp-thumb`)).toHaveCount(1);
  }
}
