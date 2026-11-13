// Lost Package Tracker Tool, Phase 2 on the SERVER (docs/context/lost-packages.md): the
// original ran it in a local Python process that died with its window. Here closing the
// page, or a restart, never stops it — the queue is in lost_pkg_orders and every answer
// is written as it comes. Pause / Stop just stop handing out work (claimLostOrder only
// takes from a RUNNING run). Same shape as gc-read-worker.js.
import {
  claimLostOrder, finishLostOrder, finishIdleLostRuns, lostAnswerFor, requeueStuckLostOrders, dbConfigured,
} from './db.js';
import { checkOrder, carriersConfigured } from './lostpkg-carriers.js';
import { cleanTracking } from '../../src/lib/lostPackage.js';

const EVERY_MS = 30_000;
const STUCK_MINUTES = 10;    // one order is a few calls + up to ~34 s of EasyPost polling
const PACE_MS = 750;         // the original's 0.75 s between rows, to stay polite with both APIs
let busy = false;
let again = false;
let started = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function lostTick() {
  if (busy) { again = true; return; }
  if (!dbConfigured() || !carriersConfigured()) return;
  busy = true;
  try {
    do {
      again = false;
      for (;;) {
        const order = await claimLostOrder();
        if (!order) {
          // Nothing left to ask: close any run still marked running (a Resume after the last
          // order finished while paused would otherwise sit at 100% "Checking…").
          await finishIdleLostRuns();
          break;
        }
        try {
          const tracking = cleanTracking(order.tracking || order.tracking_fallback || '');
          // Asked already in this run (the same number on two rows): reuse the answer.
          const seen = tracking ? await lostAnswerFor(order.run_id, tracking) : null;
          if (seen) {
            await finishLostOrder(order, {
              class: seen.p2_class, courier: seen.p2_courier, primary: seen.p2_primary, fallback: seen.p2_fallback,
              raw: seen.p2_raw, error: seen.p2_error, label: `${tracking} → same answer as before`,
            });
            continue;
          }
          await finishLostOrder(order, await checkOrder(order));
        } catch (e) {
          console.error(`[lostpkg] order ${order.id}:`, e.message);
          await finishLostOrder(order, { class: 'failed', error: 'Checking this one failed on our side.', label: `${order.key} → failed` })
            .catch(() => {});
        }
        await sleep(PACE_MS);
      }
    } while (again);
  } catch (e) {
    console.error('[lostpkg]', e.message);
  } finally {
    busy = false;
  }
}

/** Start now rather than at the next tick. Never throws, never waits. */
export function kickLostPackages() {
  setImmediate(() => { lostTick().catch((e) => console.error('[lostpkg]', e.message)); });
}

export function startLostPackageWorker() {
  if (started) return;
  started = true;
  // Whatever a previous process was checking when it stopped goes back in the queue.
  requeueStuckLostOrders(0).catch((e) => console.warn('[lostpkg] requeue:', e.message)).finally(kickLostPackages);
  setInterval(() => {
    requeueStuckLostOrders(STUCK_MINUTES).catch((e) => console.warn('[lostpkg] requeue:', e.message)).finally(kickLostPackages);
  }, EVERY_MS).unref?.();
  console.log(`[lostpkg] worker on${carriersConfigured() ? '' : ' (carrier keys missing — Phase 2 waits)'}`);
}
