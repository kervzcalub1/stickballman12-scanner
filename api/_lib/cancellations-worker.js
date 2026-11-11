// Order cancellations — the restart sweep (docs/context/cancellations.md "One reply per batch").
//
// The bot answers a batch of photos once, from memory (api/_lib/cancellations.js). A restart
// (a deploy) in the middle of a batch would lose that memory; what survives is on the photo
// rows. Every minute this:
//   · re-reads a photo whose read never finished (written > 3 min ago, still 'pending') —
//     from Telegram again by its file id; if its rows were already recorded, just marks it;
//   · answers every photo read but not answered (> 1 min old), one message per person per
//     chat, as a reply to their first photo.
// Never twice: the reply claims replied_at compare-and-set. Only the last 6 hours.
//
// Production only by default (dev and prod share one Telegram bot); CANCEL_REPLY_WORKER
// =on / =off overrides.
import { sweepCancellationPhotos } from './cancellations.js';

const TICK_MS = 60 * 1000;

export function cancellationsWorkerEnabled(env = process.env) {
  const flag = String(env.CANCEL_REPLY_WORKER || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}

let started = false;
let running = false;
export function startCancellationsWorker() {
  if (started) return;
  if (!cancellationsWorkerEnabled()) {
    console.log('[cancellations] restart sweep off (CANCEL_REPLY_WORKER / not production)');
    return;
  }
  started = true;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const out = await sweepCancellationPhotos();
      if (out.reread || out.answered) console.log(`[cancellations] sweep: re-read ${out.reread}, answered ${out.answered}`);
    } catch (e) {
      console.error('[cancellations] sweep failed:', e.message);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 20_000);
  setInterval(tick, TICK_MS).unref?.();
}
