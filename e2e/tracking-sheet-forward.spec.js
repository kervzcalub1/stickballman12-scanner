// forwardTrackingToSheet — the server → Google Sheet half of the tracking loop
// (api/_lib/tracking.js). A real Apps Script /exec took 8.8 s to answer on 2026-10-28; at the old
// 6 s limit about half of all updates were logged "aborted". A slow sheet must still get its update.
import { test, expect } from '@playwright/test';
import http from 'node:http';
import { forwardTrackingToSheet } from '../api/_lib/tracking.js';

function fakeSheet(delayMs) {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      got.push(JSON.parse(body));
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"updated":true}'); }, delayMs);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, url: `http://127.0.0.1:${server.address().port}/exec?secret=x` })));
}

test('a sheet that takes 8 s to answer still counts as delivered', async () => {
  test.setTimeout(40_000);
  const sheet = await fakeSheet(8000);
  const before = process.env.GOOGLE_SHEETS_TRACKING_URL;
  process.env.GOOGLE_SHEETS_TRACKING_URL = sheet.url;
  try {
    const r = await forwardTrackingToSheet([{ trackingNumber: '1ZE2E0000000000001', trackingStatus: 'Delivered',
      subStatus: 'Delivered_Other', boxStatus: 'delivered', carrier: 'UPS', lastCheckpoint: 'MANHEIM, PA, US, Delivered' }]);
    expect(r).toEqual({ ok: true, sent: 1, targets: 1, failed: 0 });
    expect(sheet.got).toHaveLength(1);
    expect(sheet.got[0]).toMatchObject({ source: 'stickballman12',
      updates: [{ trackingNumber: '1ZE2E0000000000001', status: 'Delivered', stage: 'delivered', subStatusLabel: 'Delivered' }] });
  } finally {
    process.env.GOOGLE_SHEETS_TRACKING_URL = before ?? '';
    if (before === undefined) delete process.env.GOOGLE_SHEETS_TRACKING_URL;
    sheet.server.close();
  }
});

test('no sheet configured → nothing is sent', async () => {
  const before = process.env.GOOGLE_SHEETS_TRACKING_URL;
  delete process.env.GOOGLE_SHEETS_TRACKING_URL;
  try {
    expect(await forwardTrackingToSheet([{ trackingNumber: '1ZE2E0000000000002', trackingStatus: 'InTransit' }])).toEqual({ skipped: true });
  } finally { if (before !== undefined) process.env.GOOGLE_SHEETS_TRACKING_URL = before; }
});
