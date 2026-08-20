// "Always use EST" (the user, 2026-08-21) — the whole system dates by US Eastern.
//
// This is not a formatting preference: the server filters and groups by EST
// (`AT TIME ZONE 'America/New_York'`), the warehouse day is an EST day, and the PH team
// works a night shift from Manila — 10am–6pm EST is 10pm–7am the NEXT PH date. So a
// screen that quietly used the viewer's own clock asked the server for a different day
// than the one it was printing, and one PH shift straddles two Manila dates while being
// a single EST one.
//
// The browser half of this file therefore runs with the browser pinned to Asia/Manila:
// on an EST machine these assertions would pass no matter what the code did.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { estToday, estDate, estCivil, estCivilFromYmd, ymd } from '../src/lib/format.js';

// The EST calendar day right now, computed independently of the helpers under test.
const EST_TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

test('the date helpers answer in EST, whatever the machine is set to', () => {
  expect(estToday()).toBe(EST_TODAY);
  // A YYYY-MM-DD round-trips unchanged. Parsed at local midnight instead, a Manila
  // machine walked it back a day on every pass — which is what the URL anchors do.
  for (const day of ['2026-01-01', '2026-08-21', '2026-12-31']) {
    expect(ymd(estCivilFromYmd(day))).toBe(day);
    expect(ymd(estCivil(estCivilFromYmd(day)))).toBe(day);
  }
  // An instant just after EST midnight belongs to the new EST day even though Manila is
  // already well into the following afternoon.
  expect(estDate('2026-08-21T04:30:00Z')).toBe('2026-08-21');   // 00:30 EDT
  // …and one just before it belongs to the previous EST day, though UTC has ticked over.
  expect(estDate('2026-08-21T03:30:00Z')).toBe('2026-08-20');   // 23:30 EDT
});

test.describe('a viewer in PH time', () => {
  // The PH team's own machines. Nothing on screen may follow this clock.
  test.use({ timezoneId: 'Asia/Manila' });

  test('sees EST dates and an EST-labelled clock', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/inventory?period=day');
    // The topbar clock is the reference every other time on screen is read against.
    const clock = page.locator('.topbar-clock');
    await expect(clock).toContainText('EST');
    // "Today" is the EST day, not the viewer's — the server groups by EST, so a Manila
    // "today" would ask the server for a different day than the screen is printing.
    // (Rendered as e.g. "Fri, Aug 21, 2026".)
    const expected = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    }).format(new Date());
    await expect(page.locator('.cal-label')).toHaveText(expected);

    // …and stepping the period round-trips the anchor through the URL as an EST day:
    // parsed at local midnight it used to come back one day earlier every pass.
    await page.locator('.cal-nav button').first().click();     // ← previous day
    await expect.poll(() => new URL(page.url()).searchParams.get('anchor')).toBeTruthy();
    const back = new URL(page.url()).searchParams.get('anchor');
    const [y, m, d] = EST_TODAY.split('-').map(Number);
    const yesterday = new Date(Date.UTC(y, m - 1, d - 1, 12)).toISOString().slice(0, 10);
    expect(back).toBe(yesterday);
    await page.locator('.cal-nav button').last().click();       // → forward again
    await expect.poll(() => new URL(page.url()).searchParams.get('anchor')).toBe(EST_TODAY);
  });
});
