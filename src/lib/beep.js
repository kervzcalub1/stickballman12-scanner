// Scan feedback tones for the high-volume scanning screens.
//
// Synthesized with WebAudio rather than shipped as audio files: two short tones
// cost nothing to download, can't 404 behind the CSP, and stay crisp at any
// volume. Warehouse staff are looking at the shoe and the scanner gun, not the
// screen — the sound IS the feedback, the banner is the confirmation they read
// only when something sounded wrong.
//
// iOS/Safari won't start an AudioContext until a user gesture, so the context is
// created lazily on the first scan (which always follows a tap, a keystroke, or a
// gun's keyboard input) and resumed defensively on every play.

let ctx = null;

function audioCtx() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) { try { ctx = new AC(); } catch { return null; } }
  if (ctx.state === 'suspended') ctx.resume().catch(() => { /* still gesture-locked */ });
  return ctx;
}

// One short tone. `at` offsets it so a two-tone error buzz can be scheduled in
// a single call without timers drifting under load.
function tone(c, { freq, start, duration, gain = 0.09 }) {
  const osc = c.createOscillator();
  const vol = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // Ramp in/out — a square-edged gate on a sine clicks audibly.
  vol.gain.setValueAtTime(0, start);
  vol.gain.linearRampToValueAtTime(gain, start + 0.008);
  vol.gain.setValueAtTime(gain, start + duration - 0.02);
  vol.gain.linearRampToValueAtTime(0, start + duration);
  osc.connect(vol).connect(c.destination);
  osc.start(start);
  osc.stop(start + duration + 0.01);
}

// A single bright blip — "that one's in".
export function beepOk() {
  const c = audioCtx();
  if (!c) return;
  try { tone(c, { freq: 1320, start: c.currentTime, duration: 0.09 }); } catch { /* audio unavailable */ }
}

// Two low buzzes — deliberately unlike the success blip, so it's distinguishable
// across a noisy room without looking up.
export function beepErr() {
  const c = audioCtx();
  if (!c) return;
  try {
    const t = c.currentTime;
    tone(c, { freq: 300, start: t, duration: 0.13, gain: 0.11 });
    tone(c, { freq: 240, start: t + 0.16, duration: 0.18, gain: 0.11 });
  } catch { /* audio unavailable */ }
}
