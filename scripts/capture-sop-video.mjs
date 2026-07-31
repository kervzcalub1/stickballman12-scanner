// PILOT — record a narrated-by-caption screen tutorial of a real flow.
//
//   npm run dev -- --port 5189 --strictPort
//   node scripts/capture-sop-video.mjs [id...]
//
// Same principle as capture-sop-shots.mjs: drive the REAL app in Playwright so the
// tutorial cannot drift from the product. A UI change is re-recorded, not re-edited.
//
// Three things a raw Playwright recording lacks as a tutorial, all fixed here:
//   1. NO CURSOR. Playwright's video shows clicks landing with nothing visibly doing
//      the clicking, which is unwatchable as instruction. We inject a fake pointer and
//      move it to each target before acting, with a click pulse.
//   2. NO NARRATION. Lines are spoken by OpenAI TTS when a key is present, else the
//      macOS `say` engine. Captions stay on screen either way — they survive a muted
//      autoplay and a noisy warehouse, and are translatable.
//   3. NO PACING. Real automation acts instantly. Every step holds long enough to read.
//
// Overlays are injected via addInitScript so they survive navigation, and they live in
// a shadow-free fixed layer with a z-index above the app's modals.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
// node:crypto explicitly — the `crypto` global is WebCrypto and has no createHash.
import crypto from 'node:crypto';
import { loginAs } from '../e2e/helpers/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.VIDEO_OUT || path.join(ROOT, 'sop-videos');
const PORT = Number(process.env.SOP_PORT) || Number(process.env.E2E_PORT) || 5189;
const BASE = `http://localhost:${PORT}`;
const SIZE = { width: 1280, height: 820 };
// Branding on the opening card. The logo is served by the dev server out of public/,
// so it is a normal same-origin request — no data-URI or file:// juggling.
const BRAND = process.env.SOP_BRAND ?? 'Stickballman12';
const BRAND_LOGO = process.env.SOP_BRAND_LOGO ?? '/logo.png';

// Injected into every document: a caption bar and a fake pointer.
const OVERLAY = () => {
  const add = () => {
    if (document.getElementById('__vo')) return;
    const s = document.createElement('style');
    s.textContent = `
      #__vo{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;
        justify-content:center;pointer-events:none;padding:0 0 34px}
      #__vo b{font:600 24px/1.45 system-ui,-apple-system,sans-serif;color:#fff;
        background:rgba(10,12,18,.92);border:1px solid rgba(255,255,255,.14);
        border-radius:14px;padding:14px 26px;max-width:70%;text-align:center;
        box-shadow:0 10px 40px rgba(0,0,0,.55);opacity:0;transition:opacity .35s}
      /* No CSS transition: the path is stepped from Node so the motion can be eased,
         arced and overshot like a hand, and so page.mouse follows the same track. */
      #__vc{position:fixed;z-index:2147483647;width:26px;height:26px;left:0;top:0;
        pointer-events:none;transform:translate(-100px,-100px)}
      #__vc svg{filter:drop-shadow(0 2px 5px rgba(0,0,0,.7))}
      #__vr{position:fixed;z-index:2147483646;width:44px;height:44px;margin:-22px 0 0 -22px;
        border-radius:50%;border:3px solid #6c8cff;opacity:0;pointer-events:none;
        transform:translate(-100px,-100px) scale(.4)}
      #__vr.go{animation:__vp .55s ease-out}
      @keyframes __vp{0%{opacity:.9;transform:var(--p) scale(.4)}
                     100%{opacity:0;transform:var(--p) scale(1.5)}}
      /* Title card. Opaque, not translucent — it has to hide whatever the app is
         mid-render, or the first second reads as a glitch rather than a title. */
      #__vt{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;
        background:#0b0d12;opacity:0;transition:opacity .55s;pointer-events:none}
      #__vt .__vt-in{text-align:center;max-width:80%}
      #__vt img{width:88px;height:88px;object-fit:contain;margin:0 auto 20px;display:block;
        border-radius:20px}
      #__vt .__vt-b{font:700 15px/1 system-ui,-apple-system,sans-serif;letter-spacing:.22em;
        text-transform:uppercase;color:#6c8cff;margin-bottom:14px}
      #__vt .__vt-t{font:600 40px/1.25 system-ui,-apple-system,sans-serif;color:#fff}`;
    document.head.appendChild(s);
    const cap = document.createElement('div');
    cap.id = '__vo'; cap.innerHTML = '<b></b>';
    const cur = document.createElement('div');
    cur.id = '__vc';
    cur.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 2l6.5 17 2.2-6.9 6.9-2.2z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    const ring = document.createElement('div');
    ring.id = '__vr';
    document.body.append(cap, cur, ring);
  };
  if (document.body) add();
  else document.addEventListener('DOMContentLoaded', add);
  window.__say = (t) => {
    const b = document.querySelector('#__vo b');
    if (!b) return;
    b.style.opacity = '0';
    setTimeout(() => { b.textContent = t; b.style.opacity = t ? '1' : '0'; }, 200);
  };
  window.__move = (x, y) => {
    const c = document.getElementById('__vc');
    if (c) c.style.transform = `translate(${x}px, ${y}px)`;
  };
  window.__pulse = (x, y) => {
    const r = document.getElementById('__vr');
    if (!r) return;
    r.style.setProperty('--p', `translate(${x}px, ${y}px)`);
    r.classList.remove('go'); void r.offsetWidth; r.classList.add('go');
  };
  window.__card = ({ brand, title, logo }) => {
    let el = document.getElementById('__vt');
    if (!el) { el = document.createElement('div'); el.id = '__vt'; document.body.appendChild(el); }
    el.innerHTML = `<div class="__vt-in">${logo ? `<img src="${logo}" alt="">` : ''}`
      + `${brand ? `<div class="__vt-b">${brand}</div>` : ''}`
      + `<div class="__vt-t">${title || ''}</div></div>`;
    requestAnimationFrame(() => { el.style.opacity = '1'; });
  };
  window.__cardOff = () => {
    const el = document.getElementById('__vt');
    if (el) el.style.opacity = '0';
  };
};

const wait = (page, ms) => page.waitForTimeout(ms);

// --- Narration ---------------------------------------------------------------
// macOS ships a TTS engine (`say`), so the tutorials get a real voice track rather
// than captions alone. Every line is rendered to disk FIRST and its true duration
// measured, because the voice has to drive the pacing — a beat that holds for a
// guessed 3.2s while the sentence runs 4.1s talks over the next step. Captions stay
// on screen as well: the warehouse floor is loud and phones are muted.
// Provider: `openai` when a key is present (better voices, pennies per run), otherwise
// the macOS engine, which needs nothing and works offline. SOP_TTS forces either.
const TTS = process.env.SOP_TTS || (process.env.OPENAI_API_KEY ? 'openai' : 'say');
const VOICE = process.env.SOP_VOICE || (TTS === 'openai' ? 'onyx' : 'Samantha');
const WPM = process.env.SOP_VOICE_WPM || '175';
const OPENAI_MODEL = process.env.SOP_TTS_MODEL || 'gpt-4o-mini-tts';

// Rendered lines are cached by (provider, voice, model, speed, text). Re-recording a flow
// or A/B-ing a single line then costs nothing and, on a paid API, bills once — most
// re-runs change the video, not the script.
const CACHE = path.join(OUT_DIR, '.voice-cache');
const cacheKey = (text) => crypto.createHash('sha1')
  .update([TTS, VOICE, OPENAI_MODEL, WPM, text].join('|')).digest('hex').slice(0, 16);

async function synth(text, out) {
  if (TTS === 'openai') {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL, voice: VOICE, input: String(text), response_format: 'mp3' }),
    });
    if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 120)}`);
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return;
  }
  // No --data-format: `say` rejects it against an .aiff target ("Opening output file
  // failed: fmt?") and writes a 0-byte file. The default AIFF is fine — ffmpeg re-encodes.
  execFileSync('say', ['-v', VOICE, '-r', String(WPM), '-o', out, String(text)]);
}

async function renderLine(text, file) {
  fs.mkdirSync(CACHE, { recursive: true });
  const ext = TTS === 'openai' ? 'mp3' : 'aiff';
  const cached = path.join(CACHE, `${cacheKey(text)}.${ext}`);
  if (!fs.existsSync(cached) || fs.statSync(cached).size === 0) await synth(text, cached);
  fs.copyFileSync(cached, `${file}.${ext}`);
  return { file: `${file}.${ext}`, seconds: probeSeconds(`${file}.${ext}`, true) };
}

// --- Auth --------------------------------------------------------------------
// Staff roles can use a minted session — the uid is never checked against the DB.
// A SUPPLIER cannot: every /api/po/* endpoint scopes by `supplier_user_id`, so a made-up
// uid authenticates perfectly and then sees zero orders, and the tutorial would be a
// recording of an empty portal. PH logs in for real too, so edits are attributed to a
// real person on screen rather than to a synthetic "E2E PH".
const REAL_LOGIN = {
  supplier: ['SOP_SUPPLIER_USERNAME', 'SOP_SUPPLIER_PASSWORD'],
  ph_team: ['SOP_PH_USERNAME', 'SOP_PH_PASSWORD'],
};

async function signIn(page, role) {
  const pair = REAL_LOGIN[role];
  const creds = pair && process.env[pair[0]] && process.env[pair[1]]
    ? { username: process.env[pair[0]], password: process.env[pair[1]] }
    : null;
  if (!creds) return loginAs(page, role);
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: creds });
  if (!res.ok()) throw new Error(`${role} login failed (${res.status()}) for ${creds.username}`);
  const { token, user } = await res.json();
  if (user?.role !== role) throw new Error(`${creds.username} is a '${user?.role}', not a ${role}`);
  await page.addInitScript(([t, u]) => {
    sessionStorage.setItem('sb_session_token', t);
    sessionStorage.setItem('sb_user', u);
  }, [token, JSON.stringify(user)]);
}

// --- Cursor ------------------------------------------------------------------
// A straight, constant-speed slide reads as a machine. Real pointer motion accelerates
// out, decelerates in, bows slightly off the straight line, and overshoots a little
// before settling. The same track is fed to page.mouse so genuine hover states fire —
// otherwise the recording shows a pointer over a button that never lights up.
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);

async function glide(page, to, { steps = 26 } = {}) {
  const from = page.__cur || { x: SIZE.width / 2, y: SIZE.height * 0.75 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) return;
  // Bow perpendicular to the travel, scaled to distance — a hand does not draw a ruler line.
  const bow = Math.min(46, dist * 0.13);
  const nx = -dy / (dist || 1);
  const ny = dx / (dist || 1);
  const n = Math.max(10, Math.min(steps, Math.round(dist / 16)));
  for (let i = 1; i <= n; i++) {
    const p = easeInOut(i / n);
    // Slight overshoot near the end, pulled back on the final frames.
    const over = i / n > 0.82 ? Math.sin((i / n - 0.82) / 0.18 * Math.PI) * Math.min(9, dist * 0.03) : 0;
    const arc = Math.sin(p * Math.PI) * bow;
    const x = from.x + dx * p + nx * arc + (dx / (dist || 1)) * over;
    const y = from.y + dy * p + ny * arc + (dy / (dist || 1)) * over;
    await page.evaluate(({ x: a, y: b }) => window.__move(a, b), { x, y });
    await page.mouse.move(x, y).catch(() => {});
    await page.waitForTimeout(i < n * 0.3 ? 22 : 15);
  }
  await page.evaluate(({ x, y }) => window.__move(x, y), to);
  await page.mouse.move(to.x, to.y).catch(() => {});
  page.__cur = to;
}

// Bring the target into view the way a person would — scroll, let it settle, then reach
// for it. Pointing at something off-screen is the classic automated-video tell.
async function reveal(page, loc) {
  try {
    await loc.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }));
    await page.waitForTimeout(700);
  } catch { /* not scrollable */ }
}

// Caption + hold. Pacing is generous on purpose: this is instruction, not a demo reel.
async function say(page, text, ms = 2600) {
  await page.evaluate((t) => window.__say(t), text);
  await wait(page, ms);
}

// Measure what a viewer actually SEES, not the layout box.
//
// A span inside a flex row stretches to the full row width, so getBoundingClientRect
// reports ~1100px for a 380px run of text. Two things then go wrong: the cursor is sent
// to the middle of that box, which is empty space well to the right of the words, and the
// zoom decides the element is too wide to fit and refuses. Measuring the text's own ink
// via a Range over the element's contents fixes both — the pointer lands on the words and
// the zoom frames them.
async function centerOf(page, sel) {
  const loc = page.locator(sel).first();
  await loc.waitFor({ state: 'visible', timeout: 10_000 });
  await reveal(page, loc);
  const b = await loc.evaluate((el) => {
    const er = el.getBoundingClientRect();
    let use = er;
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      const tr = r.getBoundingClientRect();
      // Only when the ink is genuinely tighter — an element whose children are laid out
      // block-wise can report a range wider or taller than itself.
      if (tr.width > 4 && tr.height > 4 && tr.width <= er.width && tr.height <= er.height) use = tr;
    } catch { /* no text content — the layout box is the honest answer */ }
    return { x: use.left, y: use.top, width: use.width, height: use.height };
  });
  return b && b.width > 0
    ? { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b, loc }
    : null;
}

// Move the pointer, let it land, then act — so the viewer sees WHAT is being clicked.
async function point(page, sel) {
  const c = await centerOf(page, sel);
  if (!c) return null;
  await glide(page, { x: c.x, y: c.y });
  await wait(page, 300);
  return c;
}

async function click(page, sel) {
  const c = await point(page, sel);
  if (!c) return false;
  await page.evaluate(({ x, y }) => window.__pulse(x, y), { x: c.x, y: c.y });
  await wait(page, 180);
  await c.loc.click();
  await wait(page, 700);
  return true;
}

// Type visibly — fill() would teleport the text in and show nothing being entered.
async function typeInto(page, target, text) {
  if (!target) return;
  await target.loc.click();
  await target.loc.fill('');
  await target.loc.pressSequentially(text, { delay: 55 });
}
async function type(page, sel, text) {
  const c = await point(page, sel);
  await typeInto(page, c, text);
}

// --- Beats -------------------------------------------------------------------
// A flow is DATA, the same way an SOP article is. A beat is one caption plus an
// optional action:
//
//   { say, at?, click?, type?: [sel, text], waitFor?, hold? }
//
// `at` points the cursor without clicking; `click` points then clicks; `type` types
// visibly. A beat whose selector does not resolve **still shows its caption** and is
// reported — the narration stays truthful and the video keeps its shape, rather than
// the run dying at step 9 of 14. That is the same rule the screenshot capture uses for
// a stale hotspot: skip and report, never guess.
async function playBeats(page, beats, report, track) {
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const clip = track?.clips?.[i];
    if (b.say != null) await page.evaluate((t) => window.__say(t), b.say);
    // The voice starts with the caption; everything after is timed against it.
    if (clip) track.mark(i, clip);
    let target = null;
    try {
      if (b.waitFor) await page.locator(b.waitFor).first().waitFor({ state: 'visible', timeout: 8000 });
      // Closing a modal by its Cancel button means depending on that button's exact label
      // in every screen; Escape is the one gesture they all honour.
      if (b.key) { await page.keyboard.press(b.key); await wait(page, 600); }
      // A native <select> cannot be driven by clicking — the option list is OS-rendered and
      // invisible to the page. selectOption sets it properly, and the cursor still travels
      // to the control first so the viewer sees which field changed.
      else if (b.select) {
        target = await point(page, b.select[0]);
        if (target) await target.loc.selectOption(b.select[1]).catch(() => report(`select failed: ${b.select[0]}`));
      } else if (b.type) { target = await point(page, b.type[0]); await typeInto(page, target, b.type[1]); }
      else if (b.click) { target = await click(page, b.click); if (!target) report(`click target missing: ${b.click}`); }
      else if (b.at) { target = await point(page, b.at); if (!target) report(`point target missing: ${b.at}`); }
    } catch (e) {
      report(`${b.click || b.at || b.waitFor || 'beat'} — ${e.message.split('\n')[0].slice(0, 70)}`);
    }
    // `at` means "look at this", which IS the request to zoom — so it zooms by default.
    // `click` does not: a navigation click is a move, not a detail, and pushing in on
    // every button press makes the whole thing seasick. Either can be forced or
    // suppressed with an explicit `zoom`.
    const wantZoom = b.zoom !== undefined ? b.zoom : Boolean(b.at);
    // A zoom is only honest if we know WHERE to zoom, so it needs a resolved element.
    // Asking for one that did not resolve is reported rather than guessed at a centre.
    if (wantZoom && track) {
      if (target?.box) track.zoom(target.box, typeof b.zoom === 'number' ? b.zoom : 1.6);
      else if (b.zoom) report(`zoom asked for but no element resolved (${b.click || b.at || 'no selector'})`);
    }
    // Hold for as long as the line actually takes to speak. A guessed hold either
    // clips the sentence or leaves dead air; the rendered audio knows the truth.
    const spoken = clip ? clip.seconds * 1000 + 550 : null;
    await wait(page, b.hold ?? spoken ?? (b.say ? Math.min(5200, 1500 + String(b.say).length * 52) : 700));
    if (wantZoom && track) track.zoomEnd();
  }
}

// --- Timeline ----------------------------------------------------------------
// Records WHEN each narration clip should start and WHEN each zoom runs, in ms from
// the moment recording began. Playwright's clock and ours drift slightly over a minute,
// so every offset is rescaled at the end against the video's true duration — otherwise
// the voice slides steadily out of step with the picture it is describing.
function makeTrack(clips) {
  const t0 = Date.now();
  const audio = [];
  const zooms = [];
  const skipped = [];
  let open = null;
  return {
    clips,
    mark(i, clip) { audio.push({ at: Date.now() - t0, file: clip.file, seconds: clip.seconds }); },
    // Zoom must never crop the thing it is pointing at. The magnification is therefore
    // derived from the element's own box in BOTH axes — the largest zoom that still
    // fits it, with breathing room — and capped by what the beat asked for.
    //
    // If that fit-zoom comes out below MIN, the element already fills the frame (a whole
    // results list, a full-width table row) and there is no zoom that shows more of it
    // than you can already see. Pushing in anyway is what cut the VIN column off the
    // left edge. So: fit, or don't zoom at all — never a floor that forces a crop.
    zoom(box, factor) {
      const PAD = 1.18;
      const fit = Math.min(SIZE.width / (box.width * PAD), SIZE.height / (box.height * PAD));
      const z = Math.min(fit, factor);
      if (z < 1.2) { skipped.push({ w: Math.round(box.width), h: Math.round(box.height) }); return; }
      open = { from: Date.now() - t0, cx: box.x + box.width / 2, cy: box.y + box.height / 2, z };
    },
    zoomEnd() { if (open) { zooms.push({ ...open, to: Date.now() - t0 }); open = null; } },
    elapsed: () => Date.now() - t0,
    audio,
    zooms,
    skipped,
  };
}

// zoompan drives everything off the output frame number, so each segment becomes a
// trapezoid: ramp in, hold, ramp out. They never overlap, so the terms simply sum —
// z stays 1 and the centre stays mid-frame wherever no segment is active.
function zoomFilter(zooms, scale, fps = 30) {
  if (!zooms.length) return null;
  const R = Math.round(fps * 0.55); // ramp frames
  const terms = zooms.map((s) => {
    const f0 = Math.round((s.from * scale / 1000) * fps);
    const f1 = Math.round((s.to * scale / 1000) * fps);
    const a = f0 - R;
    const b = f1 + R;
    return { t: `min(max((on-${a})/${R}\\,0)\\,1)*min(max((${b}-on)/${R}\\,0)\\,1)`, s };
  });
  const z = `1+${terms.map(({ t, s }) => `(${(s.z - 1).toFixed(3)})*${t}`).join('+')}`;
  const cx = `(iw/2)+${terms.map(({ t, s }) => `(${(s.cx - SIZE.width / 2).toFixed(1)})*${t}`).join('+')}`;
  const cy = `(ih/2)+${terms.map(({ t, s }) => `(${(s.cy - SIZE.height / 2).toFixed(1)})*${t}`).join('+')}`;
  // Clamp so a target near an edge crops inside the frame instead of panning off it.
  const x = `max(0\\,min((${cx})-iw/zoom/2\\,iw-iw/zoom))`;
  const y = `max(0\\,min((${cy})-ih/zoom/2\\,ih-ih/zoom))`;
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${SIZE.width}x${SIZE.height}:fps=${fps}`;
}

const VIDEOS = [
  {
    id: 'locations-edit-delete',
    role: 'warehouse',
    title: 'Rename, move or delete a location',
    path: '/locations',
    // Non-destructive by construction: it opens the delete confirm to show what it says,
    // and cancels. Nothing in this recording writes to the database.
    async run(page) {
      await say(page, 'Locate Shoe — every shelf, grouped Site → Area → Row → Bay.', 3000);
      await say(page, 'Every tile has a pencil. That is where you rename, move or delete.', 3400);
      await point(page, '.loc-tile:nth-child(1) .loc-tile-edit');
      await say(page, 'On a folder tile it changes EVERY shelf underneath it.', 3200);
      await click(page, '.loc-tile:nth-child(1) .loc-tile-edit');
      await say(page, 'This site has 253 shelf locations under it.', 3000);
      await say(page, 'Type the new name…', 1800);
      await type(page, '.loc-edit-modal .loc-edit-label input', 'Manheim Main Depot');
      await page.locator('.loc-edit-warn').first().waitFor({ state: 'visible', timeout: 10_000 });
      await wait(page, 900);
      await say(page, 'The preview is a real dry run — this is exactly what will happen.', 3800);
      await say(page, 'The site is part of the barcode, so all 253 codes change.', 3600);
      await say(page, 'Reprint those tags, or they stop scanning at put-away.', 3600);
      await say(page, 'The pairs do NOT move. Only their codes change.', 3400);
      await say(page, 'Delete sits apart from Save, and asks separately.', 3000);
      await click(page, '.loc-edit-modal .modal-actions .btn.danger');
      await wait(page, 1200);
      await say(page, 'Deleting a folder deletes every shelf under it.', 3200);
      await say(page, 'Here it is refused: pairs are still shelved underneath.', 3600);
      await say(page, 'Nothing is deleted — not even the empty shelves. Move the stock first.', 4200);
      await say(page, 'To retire a shelf you might want back, deactivate it instead.', 3600);
      await click(page, '.loc-del-modal .modal-actions .btn.ghost');
      await say(page, '', 600);
      await wait(page, 800);
    },
  },

  // ---------------------------------------------------------------- intake --
  // The receiving flows walk the wizard for real — step 1 to 2 to Review — and open the
  // Add Item modal rather than describing it. They stop short of Submit: committing would
  // mint VINs and consume the batch, so the flow could not be re-recorded without first
  // resetting the data. Every screen is still shown; only the final write is withheld.
  {
    id: 'receive-single', role: 'warehouse', title: 'Receive a shipment (one box)', path: '/receiving',
    beats: [
      { say: 'Receiving takes a box of shoes and turns it into individually tracked pairs.' },
      { say: 'Step one is the shipment header — who sent it, and how it travelled.', at: '.batch-form' },
      { say: 'Supplier is required. Pick one, or add a new supplier inline.',
        select: ['.batch-form select', { index: 1 }] },
      { say: 'Tracking is required too. Type it, scan the barcode, or photograph the label.',
        type: ['.track-field input', '1Z3YY4080320654285'] },
      { say: 'For a single box, leave boxes expected at one.' },
      { say: 'Neither field is optional — the server rejects a batch without them.' },
      { say: 'Now move on to the items.', click: 'button:has-text("Next")', hold: 2600 },
      { say: 'This is where the scanning happens.', at: 'button:has-text("Add Item")' },
      { say: 'Open it.', click: 'button:has-text("Add Item")', hold: 2600 },
      { say: 'Scan the shoe box barcode, or type the SKU if the box is damaged.', at: '.additem' },
      { say: 'The product comes back with its sizes. Set the size and the quantity.' },
      { say: 'Tick With Box if the pair actually has its box in your hands.' },
      { say: 'Scan boxless pairs SEPARATELY from boxed ones.' },
      { say: 'Their VINs and their printed labels must never get mixed up.', key: 'Escape' },
      { say: 'Then Review, then Issues, then Submit.' },
      { say: 'On submit every single pair gets its own VIN and its own printable label.' },
    ],
  },
  {
    id: 'receive-multibox', role: 'warehouse', title: 'Receive a multi-box shipment', path: '/receiving',
    beats: [
      { say: 'One shipment often arrives as several boxes, across several days.' },
      { say: 'On step one, set boxes expected to however many are coming.', at: '.batch-form' },
      { say: 'You get a row per box, and each row takes its OWN tracking number.', at: '.track-field' },
      { say: 'A box row is saved the moment it has a tracking number.' },
      { say: 'Even with no items in it — so a box that turned up empty is still on the record.' },
      { say: 'That is the point. An empty box is information, not an absence.' },
      { say: 'Add items on a row runs just that box through items, review and issues.' },
      { say: 'Boxes can be done in any order, whenever they physically turn up.' },
      { say: 'Leaving through Home keeps the batch open.' },
      { say: 'Pick it up later from Batches, and add the next box to the same shipment.' },
      { say: 'Finish the batch only when everything has arrived.' },
    ],
  },
  {
    id: 'receive-against-po', role: 'warehouse', title: 'Receive against a purchase order', path: '/receiving',
    beats: [
      { say: 'If the supplier scanned the order out, receive against the purchase order instead.' },
      { say: 'That way the system already knows what SHOULD be in the box.' },
      { say: 'Step one offers it.', at: '.batch-form' },
      { say: 'Find the order by its code, or by pasting or scanning any tracking number on it.' },
      { say: 'Picking it pulls in the supplier, the tag, and every shipping label on the order.' },
      { say: 'Each label becomes a box slot, already waiting for you.' },
      { say: 'Print the manifest BEFORE you start unpacking. Per box gives you a checklist per box.' },
      { say: 'Then scan the box in exactly as you would any other.' },
      { say: 'At the end, read the saved panel carefully.' },
      { say: 'A red alert means what arrived does not match the manifest.' },
      { say: 'That is the discrepancy, and it is far easier to chase now than next week.' },
      { say: 'You can receive against an order still in draft — boxes routinely beat the paperwork.' },
    ],
  },
  {
    id: 'receiving-issues', role: 'warehouse', title: 'Flag damage and defects at intake', path: '/receiving',
    beats: [
      { say: 'Damage gets recorded at intake, while the shoe is in your hand.' },
      { say: 'Not later, from memory. Later is how damage becomes an argument.' },
      { say: 'Defects are flagged on the Review step, which sits after the items.',
        select: ['.batch-form select', { index: 1 }] },
      { say: 'So fill the header first.', type: ['.track-field input', '1Z3YY4080320654285'] },
      { say: 'Then move through to the items.', click: 'button:has-text("Next")', hold: 2400 },
      { say: 'On Review, expand the size holding the bad pair.' },
      { say: 'Then add an issue against that exact unit — not the size, the unit.' },
      { say: 'Pick the defect: crease, dirty, yellowing, glue, missing insole, damaged box.' },
      { say: 'Add a note and photograph it. The photo attaches to that pair\'s VIN for ever.' },
      { say: 'More than one defect on one pair is fine, if that is the truth of it.' },
      { say: 'Flagging No Box as a defect forces that unit to no-box status on commit.' },
      { say: 'Same end state as never ticking With Box. It cannot be shelved until a box is found.' },
      { say: 'Problems with the whole shipment go on the Issues step instead.' },
      { say: 'Ripped open, stolen, missing boxes, short count — those are about the delivery, not a shoe.' },
    ],
  },
  {
    id: 'listing-photos-intake', role: 'warehouse', title: 'Shoot listing photos at intake', path: '/receiving',
    beats: [
      { say: 'Listing photos are shot once, at intake, while the shoe is out of the box.' },
      { say: 'They live inside the Add Item modal, so step one has to be filled in first.',
        select: ['.batch-form select', { index: 1 }] },
      { say: 'Supplier, and a tracking number.', type: ['.track-field input', '1Z3YY4080320654285'] },
      { say: 'Then on to the items.', click: 'button:has-text("Next")', hold: 2400 },
      { say: 'Open Add Item.', click: 'button:has-text("Add Item")', hold: 2600 },
      { say: 'The photo block has five angle slots.', at: '.additem' },
      { say: 'Side, diagonal, outsole, top, rear. Always those five, always in that order.' },
      { say: 'If the SKU already has photos they load in, and the button changes to view or replace.' },
      { say: 'Do not re-shoot a SKU that already has a set. You are duplicating work.' },
      { say: 'Add listing photos opens the full-screen camera.' },
      { say: 'Tap an angle in the strip, frame the shoe, hit the shutter. Repeat for all five.' },
      { say: 'Unhappy with one? Tap its thumbnail to replace or remove just that angle.' },
      { say: 'A "PH edited on file" banner means PH already produced finished images.', key: 'Escape' },
      { say: 'Yours still matter — they stay as the raw record of what actually arrived.' },
    ],
  },
  {
    id: 'batches-manage', role: 'warehouse', title: 'Work with batches (open, resume, finish)', path: '/batches',
    // Imperative, because the useful batch is the one that HAS boxes and CSS can't say
    // "not the empty one". The first row is often a freshly-opened, empty batch, and
    // narrating "expand a box row" over "No boxes yet" teaches nothing.
    async run(page) {
      await say(page, 'Batches — every shipment you have received, open or done.', 3200);
      const withBoxes = page.locator('.batch-nav-row').filter({ hasNotText: '0 boxes' }).first();
      const target = (await withBoxes.count()) ? withBoxes : page.locator('.batch-nav-row').first();
      await say(page, 'Open one to see its boxes, each with its tracking number and item count.', 3600);
      const b = await target.boundingBox();
      if (b) {
        await page.evaluate(({ x, y }) => window.__move(x, y), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
        await wait(page, 650);
        await page.evaluate(({ x, y }) => window.__pulse(x, y), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
        await target.click();
        await wait(page, 1200);
      }
      await say(page, 'Each box row carries its own tracking number and its own item count.', 3600);
      await click(page, '.box-row');
      await say(page, 'Expand a box row to see the shoes inside it.', 3200);
      await say(page, 'Tap any VIN to open that unit\'s full detail and history.', 3400);
      await say(page, 'A red 0 on a box row means tracking was recorded but nothing was scanned in.', 4000);
      await say(page, 'Either the box is still coming, or someone forgot. Both are worth knowing.', 3800);
      await say(page, '"Add box" drops you into the receiving wizard for that batch.', 3400);
      await say(page, 'Finish the batch only when the shipment is genuinely complete.', 3600);
    },
  },

  // -------------------------------------------------------------- in-store --
  {
    id: 'instore-buying', role: 'warehouse', title: 'In-store buying', path: '/instore',
    beats: [
      { say: 'In-store buying — stock bought over the counter, not shipped to us.' },
      { say: 'Step 1 is short: store, date, cost, notes.' },
      { say: 'No supplier, no buyer, no tracking, no boxes — none of it applies.' },
      { say: 'Step 2 scans each pair by box UPC or SKU, exactly as in receiving.' },
      { say: 'Review and Issues work the same — flag defects per pair here.' },
      { say: 'Pairs land as "Needs shelf", or "No box" if the box was not ticked.' },
      { say: 'In-store buys NEVER reach the PH team.' },
      { say: 'They are listed to the stores by hand, on the In-Store Listing page.' },
    ],
  },
  {
    id: 'instore-listing', role: 'warehouse', title: 'In-store listing', path: '/instore-listing',
    beats: [
      { say: 'In-store stock bypasses PH, so listing it is a manual job — this page.' },
      { say: 'Rows are grouped by SKU: list a SKU once and it covers all its sizes.' },
      { say: 'List the shoe by hand on the store site first.' },
      { say: 'Then tick the matching toggle here: Alias, StockX, Shopify.' },
      { say: '"Needs listing only" hides SKUs where all three are already ticked.' },
      { say: 'This page is the ONLY thing that writes those flags.' },
      { say: 'So a SKU group is never half-ticked behind your back by a sync.' },
    ],
  },

  // -------------------------------------------------------------- put-away --
  {
    id: 'shelve-putaway', role: 'warehouse', title: 'Shelve / put-away', path: '/shelve',
    beats: [
      { say: 'Put-away gives a pair a physical home you can scan against.' },
      { say: 'It is the ONLY way a pair becomes In Stock. Nothing else sets that status.' },
      { say: 'There are two modes, and they suit different jobs.', at: '.searchrow' },
      { say: 'Scan shelf, then shoes, is the classic: read the shelf tag, then each VIN onto it.' },
      { say: 'Pick from the pending list is the reverse — start from what is waiting for a home.' },
      { say: 'Then assign a shelf by scanning it, or through the site, area, bay and shelf picker.' },
      { say: 'Watch the flash banner on every single scan.', at: '.searchrow input' },
      { say: 'Green means it went on. Amber means duplicate, or rejected.' },
      { say: 'The device buzzes differently for each, so you can work without watching the screen.' },
      { say: 'Shelve here commits, and the pairs flip to In Stock at that shelf.' },
      // .shelve-box-toggle only renders against a scanned row, which needs a live scan we
      // cannot fake here — so this beat narrates the rule without a cursor target.
      { say: 'A pair with no box is REFUSED.' },
      { say: 'Unless you tick box found now, which makes it a with-box pair on the spot.' },
      { say: 'Otherwise it belongs in the No Box queue, not on a shelf.' },
      { say: 'To move stock, simply shelve an already-shelved pair onto a different shelf.' },
      { say: 'That is a transfer, and it is logged as one.' },
    ],
  },
  {
    id: 'nobox-resolve', role: 'warehouse', title: 'Resolve the No Box queue', path: '/nobox',
    beats: [
      { say: 'The No Box queue is stock we own but cannot sell, because the box is missing.' },
      { say: 'These pairs are deliberately hidden from the PH listing grid.' },
      { say: 'Every row is one pair, with its VIN, its size, and when it came in.', at: '.nobox-name' },
      { say: 'Find the box. That is the whole job. We do not sell a shoe without its box.' },
      { say: 'Box found, with box, makes the pair sellable again.', at: '.nobox-boxfound' },
      { say: 'It moves straight to needs shelf, and put-away will accept it.' },
      { say: 'If the box genuinely cannot be found, set the honest status instead.', at: '.nobox-actions' },
      { say: 'Missing is a real answer. Leaving it sitting here pretending is not.' },
      { say: 'Need the pair to scan normally? Print box labels rebuilds a real box label.',
        at: '.nobox-label-btn' },
      { say: 'Vertical UPC barcode, exactly like the original that was lost.' },
      { say: 'That button lives on this page and nowhere else, on purpose.' },
      { say: 'Reprinting a box label is a no-box fix, not a routine reprint.' },
    ],
  },
  {
    id: 'locate-shoe', role: 'warehouse', title: 'Locate a shoe', path: '/locations',
    // Walks the whole job end to end — search, the result, the jump to the shelf, the
    // shelf's contents, then back up the breadcrumb and down the tiles the other way.
    // `SOP_SPEC_SKU` lets the specimen change with the dataset without touching the script.
    beats: [
      { say: 'Locate Shoe answers both directions: where is this pair, and what is on this shelf.' },
      { say: 'Start with what you have in your hand — a name, a SKU, a VIN, or the box UPC.',
        at: '.loc-search input' },
      { say: 'Or tap Scan, and read the VIN label or the box barcode with the camera.',
        at: 'button:has-text("Scan")' },
      { say: 'Here we will look up a SKU.', type: ['.loc-search input', process.env.SOP_SPEC_SKU || 'IQ1867-474'], zoom: false },
      { say: 'Locate.', click: 'button:has-text("Locate")', hold: 1800 },
      // Targets are the smallest element that IS the subject, not the container holding
      // it — a full-width row or the whole results list cannot be magnified without
      // losing its ends, so those now skip the zoom and just get the cursor.
      { say: 'Hits are grouped by SKU — one header per shoe, then a row per physical pair.',
        waitFor: '.loc-sku-group', at: '.loc-group-info' },
      { say: 'The header counts what is shelved against what is not, so you know before you walk.',
        at: '.loc-group-meta', zoom: 2.1 },
      { say: 'Each row is one pair: its VIN, its size, its status, and where it actually is.',
        at: '.loc-unit-row' },
      { say: 'The VIN is the pair. Every physical shoe has exactly one, forever.',
        at: '.loc-unit-vin', zoom: 2.4 },
      { say: 'This green chip is the shelf it sits on. Tap it.', at: '.loc-locate-chip', zoom: 2.4 },
      { say: 'And that is the shelf — everything stored there, not just the pair you searched for.',
        click: '.loc-locate-chip', hold: 2600 },
      { say: 'Which is how you check a shelf while you are standing at it.',
        waitFor: '.loc-shelf-items', at: '.loc-item-name', zoom: 1.9 },
      { say: 'An amber "Not shelved yet" chip instead means we do own the pair — it just has not been put away.' },
      { say: 'The breadcrumb is the path you took. Any step of it is clickable.', at: '.loc-crumbs' },
      { say: 'Go back up and you can travel the other way — by place instead of by shoe.',
        click: '.loc-crumbs .loc-crumb', hold: 2200 },
      { say: 'Site, then area, then row, then bay, then the shelf itself.', at: '.loc-tile', zoom: 1.3 },
      { say: 'Every level is a real address in the URL.' },
      { say: 'So Back walks you up the rack, and you can send someone a link to one shelf.' },
    ],
  },
  {
    id: 'locations-manage', role: 'warehouse', title: 'Manage shelves and print shelf labels', path: '/locations',
    beats: [
      { say: 'Setting up the shelves the warehouse scans against.' },
      { say: '"+ Add shelf" adds one.', at: 'button:has-text("Add shelf")' },
      { say: '"Bulk add" does a whole aisle — one bay per line, "A1 5" meaning bay A1 with 5 shelves.', at: 'button:has-text("Bulk add")' },
      { say: 'Open bulk add and you can lay out a whole aisle in one go.',
        click: 'button:has-text("Bulk add")', hold: 2400 },
      { say: 'One bay per line. "A1 space 5" means bay A1 with five shelves.', at: '.loc-bulk-text' },
      { say: 'For a new site or area, use custom in the warehouse and area pickers.' },
      { say: 'The area picker suggests the selected site\'s own areas first.', key: 'Escape' },
      { say: 'A shelf code is SITE-AREA-BAY-SHELF — MNH-WH-A2-04.' },
      { say: 'Whole-bay spots like pods drop the shelf part: MNH-PD-1.' },
      { say: 'Codes are globally unique. That is what makes a shelf barcode unmistakable next to a VIN.' },
      { say: 'To print tags: tick the shelves, then "Print labels" in the breadcrumb bar.', at: '.loc-tile-check' },
      { say: 'Folder tiles roll up everything inside them, and there is "Select all" per level.' },
    ],
  },

  // --------------------------------------------------------------- rescale --
  {
    id: 'rescale-stock', role: 'warehouse', title: 'Rescale stock', path: '/rescale',
    beats: [
      { say: 'Rescale puts stock you ALREADY hold back in front of the PH team.' },
      { say: 'No shipment involved — a return, a re-listing, a recount, a transfer.' },
      { say: 'Pick the reason first. It travels with the batch.' },
      { say: 'Then scan each pair by its VIN.' },
      { say: 'VIN, not the box UPC — this is stock we already have, not a fresh intake.' },
      { say: 'Finish, and those pairs appear on PH\'s Rescale Stock worklist.' },
      { say: 'PH re-prices and re-lists them, ticks "Restocked", and they drop off.' },
      { say: 'An in-store pair cannot be rescaled — it returns an error.' },
      { say: 'In-store stock bypasses PH entirely, by design.' },
    ],
  },
  {
    id: 'rescale-requests-audit', role: 'warehouse', title: 'Audit a rescale request from PH', path: '/rescalereq',
    // This page opens on TODAY and on "Open" only, and requests are rare — the first cut
    // filmed "No requests in this range", i.e. a tutorial about a blank page. Widen the
    // window and show every status so there is a real request on screen.
    prep: ['button:has-text("Month")', '.cal-nav button:first-child, button:has-text("‹")', 'button:has-text("All")'],
    beats: [
      { say: 'PH thinks a SKU\'s count is wrong. This is you going to check.' },
      { say: 'Read the request: the SKU, the sizes and quantities PH reported, and their reason.' },
      { say: 'Now go and physically count that SKU on the shelf.' },
      { say: 'Then "Audit shelf" and enter the ACTUAL quantity per size.' },
      { say: 'Add a note explaining anything odd, and save. The request flips to "audited".' },
      { say: 'The comparison grid shows reported on top, actual underneath.' },
      { say: 'Red cells are mismatches. Green cells match.' },
      { say: 'Requests are about a SKU, not specific VINs — it is a counting exercise.' },
    ],
  },

  // ---------------------------------------------------- browse & fulfilment --
  {
    id: 'inventory-browse', role: 'warehouse', title: 'Browse and search inventory', path: '/inventory',
    beats: [
      { say: 'Inventory is everything we hold, sliced however you need it.' },
      { say: 'Search by VIN, SKU or name — or scan a VIN to jump straight to that pair.',
        at: '.searchrow input' },
      { say: 'Type or scan a SHELF code instead, and you get that shelf\'s contents rather than a shoe.' },
      { say: 'The date filter defaults to a recent window, so widen it when you are hunting.',
        at: '.cal-modes' },
      { say: 'Then narrow by supplier, by status, or by how the stock came in.' },
      { say: 'Rows merge by SKU and status. Sizes become quantity chips with a total.', at: '.inv-col-size' },
      { say: 'That keeps the list readable when one shoe arrives forty times.' },
      { say: 'Expand a row to see the individual pairs underneath.', click: '.inv-caret' },
      { say: 'Each one is a real physical shoe with its own VIN and its own history.',
        at: '.inv-units .vin' },
      { say: 'Open a unit for its full detail — every event, its photos, where it is, and its status.' },
      { say: 'A pin chip on a row is its shelf.' },
      { say: 'If it says several shelves, that merged row is genuinely spread across the building.' },
    ],
  },
  {
    id: 'inventory-bulk-status', role: 'warehouse', title: 'Change status in bulk', path: '/inventory',
    beats: [
      { say: 'Sometimes a whole group of pairs needs the same status change.' },
      { say: 'Tick the rows, or expand and tick individual pairs inside them.', at: '.inv-col-check' },
      { say: 'The bulk bar appears once something is selected, and tells you what it will affect.',
        at: '.batch-bar' },
      { say: 'Choose the status and save.' },
      { say: 'Every pair still gets its OWN logged change. Bulk is a convenience, not a shortcut in the record.' },
      { say: 'One status you cannot set this way is In Stock.' },
      { say: 'A pair is In Stock only when it is physically on a shelf.' },
      { say: 'So choosing it here sends you to put-away instead, which is the honest answer.' },
      { say: 'Sold and shipped are terminal. Applied in bulk they are just as permanent.' },
    ],
  },
  {
    id: 'inventory-move-shelf', role: 'warehouse', title: 'Move to shelf without leaving Inventory', path: '/inventory',
    beats: [
      { say: 'Put pairs away without leaving Inventory.' },
      { say: 'Three ways in: the group button, the bulk bar, or a single unit\'s detail.' },
      { say: 'Scan or type the shelf barcode. The shelf name is confirmed back to you.' },
      { say: 'Check the list of pairs, then "Shelve N here".' },
      { say: 'The list refreshes and the moved pairs show their new shelf chip.' },
      { say: 'No-box pairs show a "Box found now" toggle.' },
      { say: 'Leave it unticked and the pair is REFUSED — it belongs in the No Box queue, not on a shelf.' },
    ],
  },
  {
    id: 'print-labels', role: 'warehouse', title: 'Print labels (VIN, box and shelf)', path: '/inventory',
    beats: [
      { say: 'Three kinds of label, and they come from three different places.' },
      { say: 'VIN labels come from Inventory. Find the shoe, and expand it.', at: '.inv-caret' },
      // The list re-renders when a group expands, which detaches whatever was located
      // before it — hence the longer settle and the explicit waitFor on the button.
      { say: 'Expanding a group reveals its own action bar.', click: '.inv-caret', hold: 3200 },
      { say: 'Print labels there prints one label per pair in the group.',
        waitFor: 'button:enabled:has-text("Print labels")', at: 'button:enabled:has-text("Print labels")' },
      { say: 'Open it.', waitFor: 'button:enabled:has-text("Print labels")',
        click: 'button:enabled:has-text("Print labels")', hold: 3200 },
      { say: 'Now pick your label stock. C R 80 card is the default.' },
      { say: 'Plus small one-point-one by three-point-five, Rollo, Dymo, Box, and Brother.' },
      { say: 'Get this wrong and the label prints at the wrong scale — it is the usual cause.' },
      { say: 'Labels come out as an exact-size PDF, one label per page.' },
      { say: 'Not a browser print. That is what makes them come out the right size on a label printer.' },
      { say: 'On a phone it opens in a new tab — use share, then print.', key: 'Escape' },
      { say: 'Box labels come from the No Box page only, with a vertical UPC barcode.' },
      { say: 'Shelf labels come from Locate Shoe — tick shelves, then print from the breadcrumb bar.' },
      { say: 'On stock smaller than sixty-two by one hundred millimetres, the shoe name is left off.' },
      { say: 'SKU, size and barcode are what shelving needs. The name only shrinks them.' },
    ],
  },
  {
    id: 'mark-sold', role: 'warehouse', title: 'Mark pairs sold', path: '/sold',
    beats: [
      { say: 'Marking sold is a short flow with a permanent effect. Worth understanding before you use it.' },
      { say: 'Scan each VIN — with a gun, or the camera. Typing works too.',
        type: ['.searchrow input', process.env.SOP_SPEC_VIN || 'SBM-260730-000190'] },
      { say: 'Add puts it on the list.', click: 'button:has-text("Add")', hold: 2400 },
      { say: 'The pair appears with its shoe, its size, and its CURRENT status.',
        waitFor: '.inv-table', at: '.inv-col-vin' },
      { say: 'That current status is the safety net — a mis-scan is obvious before you commit.' },
      { say: 'Scanned the wrong one? Remove it from the list first.', at: '.remove' },
      { say: 'The bar keeps a running count of what you are about to mark.', at: '.batch-totals' },
      { say: 'Save opens a confirmation.', click: 'button:has-text("Save")', hold: 2600 },
      { say: 'It lists the VINs back to you one final time.', waitFor: '.confirm-list', at: '.confirm-list' },
      { say: 'This is the last point at which nothing has happened yet.', key: 'Escape' },
      { say: 'Confirm, and each pair is marked sold and logged individually.' },
      { say: 'Sold clears all four store flags at once.' },
      { say: 'Intelligent Inventory, Alias, StockX and Shopify — the pair is pulled from everywhere together.' },
      { say: 'That is deliberate. A sold shoe listed anywhere is how you sell it twice.' },
      { say: 'And this is terminal. A sold pair cannot be scanned back into an active state.' },
    ],
  },
  {
    id: 'mark-shipped', role: 'warehouse', title: 'Mark pairs shipped', path: '/shipped',
    beats: [
      { say: 'Mark shipped works exactly like mark sold, and is just as final.' },
      { say: 'Scan each VIN.',
        type: ['.searchrow input', process.env.SOP_SPEC_VIN || 'SBM-260730-000190'] },
      { say: 'They collect in a list first.', click: 'button:has-text("Add")', hold: 2400 },
      { say: 'Nothing has changed yet — this is a list, not the action.',
        waitFor: '.inv-table', at: '.inv-col-vin' },
      { say: 'Check it against what is physically going out of the door.' },
      { say: 'Then Save, which asks you once more.', click: 'button:has-text("Save")', hold: 2600 },
      { say: 'The VINs are read back to you before anything is written.',
        waitFor: '.confirm-list', at: '.confirm-list' },
      { say: 'Confirm.', key: 'Escape' },
      { say: 'Like sold, this clears every store sync flag in one action.' },
      { say: 'And like sold, it is terminal. There is no scanning it back.' },
      { say: 'If you shipped the wrong pair, that is a conversation, not an undo button.' },
    ],
  },
  {
    id: 'listings-sync-warehouse', role: 'warehouse', title: 'Read the Listings & Sync grid', path: '/report',
    beats: [
      { say: 'Listings and Sync shows what the PH team has done with the stock you received.' },
      { say: 'You can read it. You cannot edit it — this is their workspace, shown to you.' },
      { say: 'One row per SKU and status.', at: '.ph-title-name' },
      { say: 'Sizes show as chips with their quantities, so one row can cover a whole size run.',
        at: '.ph-sizes' },
      { say: 'Four badges follow every listing: I I, A L, S X, S H.', at: '.sync-badges' },
      { say: 'Intelligent Inventory, Alias, StockX, Shopify.' },
      { say: 'A lit badge means that size is live on that store.' },
      { say: 'Expand a row for the per-size breakdown.', click: '.ph-caret', hold: 2600 },
      { say: 'Every field is per size, so two sizes of one shoe can legitimately differ.' },
      { say: 'Who added it is recorded on the row.', at: '.ph-addedby' },
      { say: 'Global indicator and final price are hidden from the warehouse role.' },
      { say: 'Not because they are secret, but because they are not yours to act on.' },
    ],
  },
  // =========================================== CROSS-CUTTING / REFERENCE ==
  // Recorded as warehouse because that is the desk with the most staff; the articles
  // themselves list every role, so the same clip is shown to all of them.
  {
    id: 'sign-in', role: 'warehouse', title: 'Signing in', path: '/',
    beats: [
      { say: 'Accounts are approved by an admin. Signing up does not get you in on its own.' },
      { say: 'Until you are approved, the app tells you so rather than pretending your password is wrong.' },
      { say: 'A temporary password has to be changed the first time you use it.' },
      { say: 'Sessions expire. If the app drops you back to sign-in mid-task, that is why.' },
      { say: 'Nothing you had entered is lost — sign back in and it is still there.' },
      { say: 'Repeated wrong passwords are throttled, so do not hammer it. Ask for a reset.' },
    ],
  },
  {
    id: 'password-reset', role: 'warehouse', title: 'Forgotten password', path: '/',
    beats: [
      { say: 'There is no self-service password reset. That is deliberate.' },
      { say: 'Ask an admin. They issue a temporary password from Check Access.' },
      { say: 'It is shown to them once and never stored in readable form.' },
      { say: 'You will be made to change it the moment you sign in with it.' },
      { say: 'Nobody can read your existing password — not an admin, not us. Only a hash is kept.' },
    ],
  },
  {
    id: 'scan-guide', role: 'warehouse', title: 'What scans as what', path: '/inventory',
    beats: [
      { say: 'Three kinds of barcode go through this system, and they are not interchangeable.' },
      { say: 'A UPC is the manufacturer code on the shoe box. It identifies the MODEL and size, not the pair.' },
      { say: 'A VIN is ours. It looks like S-B-M, then the date, then a number.' },
      { say: 'One VIN is one physical pair, for ever. Two identical size tens get two VINs.' },
      { say: 'Numbers are never reused, so gaps in the sequence are normal and harmless.' },
      { say: 'A shelf code is a place — site, area, bay, shelf.', at: '.searchrow input' },
      { say: 'Receiving and in-store want the UPC or the SKU.' },
      { say: 'Rescale, sold, shipped and shelving all want the VIN off our own label.' },
      { say: 'Scanning the wrong kind into a screen does nothing. That is a guard, not a fault.' },
    ],
  },
  {
    id: 'statuses-explained', role: 'warehouse', title: 'Statuses and what they mean', path: '/inventory',
    beats: [
      { say: 'A status says what can happen to a pair next.' },
      { say: 'Needs shelf: received, has its box, waiting to be put away.' },
      { say: 'In stock: physically on a shelf and sellable. The only way to reach it is to shelve the pair.' },
      { say: 'No box: we hold the shoe but not its box, so it cannot be posted.' },
      { say: 'Restock pending: it has been rescanned and is waiting for PH to re-price it.' },
      { say: 'Sold and shipped are terminal. A pair cannot be scanned back out of them.' },
      { say: 'Both clear every store flag at once, so the pair is pulled from everywhere together.' },
    ],
  },
  {
    id: 'sync-flags', role: 'warehouse', title: 'The four store flags', path: '/report',
    beats: [
      { say: 'Four badges follow every size: I I, A L, S X, S H.' },
      { say: 'Intelligent Inventory, Alias, StockX, Shopify.' },
      { say: 'They record where a size has been listed. They are set by the PH team.' },
      { say: 'A shoe flagged GOAT-only lists to Alias and Intelligent Inventory only.' },
      { say: 'StockX and Shopify then read as not applicable rather than as outstanding work.' },
      { say: 'Marking a pair sold or shipped clears all four at once.' },
    ],
  },
  {
    id: 'home-badges', role: 'warehouse', title: 'Reading the home screen', path: '/',
    beats: [
      { say: 'Home is laid out along the life of a shoe: receive, shelve, sell, ship.' },
      { say: 'Needs attention only appears when something is genuinely waiting.', at: '.home-greeting' },
      { say: 'An empty day shows no cards there at all — that is the system saying nothing is outstanding.' },
      { say: 'A count on a card is live. It is the number right now, not from when you loaded the page.' },
      { say: 'Your name and role are at the top. Check it before you start — the role changes what you can do.' },
    ],
  },
  {
    id: 'roles-map', role: 'warehouse', title: 'Who can do what', path: '/',
    beats: [
      { say: 'Four roles, and they see genuinely different systems.' },
      { say: 'Warehouse receives, shelves, picks and ships.' },
      { say: 'PH Team prices and lists, and never touches the physical stock.' },
      { say: 'Supplier sees only their own orders, and nothing else at all.' },
      { say: 'Admin manages accounts and settings, and can see across the desks.' },
      { say: 'The split is enforced on the server. Hiding a button is not the same as blocking the request.' },
    ],
  },
  {
    id: 'dates-est', role: 'warehouse', title: 'Dates and time zones', path: '/inventory',
    beats: [
      { say: 'Every date and every filter in this system is Eastern time.' },
      { say: 'That is true wherever you are working from.' },
      { say: 'So "today" means the warehouse day, not your local one.', at: '.cal-modes' },
      { say: 'If a shipment received late in the evening seems to land on the wrong day, this is why.' },
      { say: 'It is one time zone on purpose. Two teams in different places counting different days is worse.' },
    ],
  },
  {
    id: 'troubleshooting', role: 'warehouse', title: 'When something goes wrong', path: '/inventory',
    beats: [
      { say: 'A few things go wrong often enough to be worth knowing.' },
      { say: 'The camera preview is black: close the scanner and reopen it. It releases the camera properly.' },
      { say: 'A scan does nothing: check what the screen wants. A UPC into a VIN field is ignored on purpose.' },
      { say: 'The keyboard will not appear on an iPhone: tap the field itself rather than waiting.' },
      { say: 'Something looks stale after an update: hard-refresh the browser. The old bundle is cached.' },
      { say: 'You are logged out mid-task: your session expired. Sign back in — nothing is lost.' },
      { say: 'A label prints mis-scaled: check the stock you picked. Labels are exact-size PDFs, one per page.' },
    ],
  },

  // ================================================================= PH TEAM ==
  {
    id: 'ph-new-inventory', role: 'ph_team', title: 'New Inventory — what just arrived', path: '/ph/new-inventory',
    beats: [
      { say: 'New Inventory is everything the warehouse received that you have not priced yet.' },
      { say: 'One card per SKU and status, with the sizes underneath.', at: '.ph-title-name' },
      { say: 'The quantity badge counts the physical pairs waiting on that size.', at: '.szq-chip' },
      { say: 'Boxless pairs are deliberately absent — they are not postable, so they sit in No Box until a box turns up.' },
      { say: 'In-store buys never appear here either. They are listed by hand, by the warehouse.' },
      { say: 'Open a card to price and list it.', click: '.ph-caret' },
      { say: 'The list re-fetches on its own, so a shoe received while you are working simply appears.' },
    ],
  },
  {
    id: 'ph-grid-editing', role: 'ph_team', title: 'Edit the grid, size by size', path: '/ph/new-inventory',
    beats: [
      { say: 'Listings and Sync is the working grid: one row per SKU and status.' },
      { say: 'Expand a row and every size becomes its own line.', click: '.ph-caret' },
      { say: 'That matters, because every field is per size.', at: '.ph-sizetable' },
      { say: 'Two sizes of the same shoe can legitimately carry different prices and different store flags.' },
      { say: 'Edits are attributed — the grid records who last touched each size, and when.', at: '.ph-addedby' },
      { say: 'A row someone else is editing is locked while they hold it, so two people cannot overwrite each other.' },
      { say: 'Notes travel with the size, not the SKU.', at: '.ph-note-cell' },
    ],
  },
  {
    id: 'ph-refresh-prices', role: 'ph_team', title: 'Refresh Global Indicator prices', path: '/ph/new-inventory',
    beats: [
      { say: 'Global Indicator is the market price we pull from Alias.' },
      { say: 'Expand a shoe to see it per size.', click: '.ph-caret', hold: 2600 },
      { say: 'Every size carries its own Global Indicator.', waitFor: '.ph-sizetable', at: '.ph-gi-th' },
      { say: 'Final price is derived from it by the configured margin, then rounded to whole dollars.' },
      { say: 'If the basis says "With You" rather than consigned, that is the fallback — the consigned figure was unavailable.' },
      { say: 'A price that has drifted since you last looked is flagged, with the old value beside it.', at: '.ph-sizetable' },
      { say: 'Frozen rows keep the price they were given and are not re-derived.', at: '.ph-frozen' },
    ],
  },
  {
    id: 'ph-rescale', role: 'ph_team', title: 'Work the Rescale worklist', path: '/ph/rescale',
    beats: [
      { say: 'Rescale is stock the warehouse already holds and has put back in front of you.' },
      { say: 'A return, a re-listing, a recount, a transfer between sites.' },
      { say: 'Each entry carries the reason it was rescanned, so you know what you are looking at.' },
      { say: 'Re-price and re-list it exactly as you would new stock.' },
      { say: 'Then tick Restocked, and it drops off the worklist.' },
      { say: 'Nothing here is a fresh intake — these pairs already have VINs and already exist.' },
    ],
  },
  {
    id: 'ph-request-rescale', role: 'ph_team', title: 'Ask the warehouse to recount a SKU', path: '/ph/request',
    beats: [
      { say: 'When the numbers look wrong, you ask for a physical count rather than guessing.' },
      { say: 'Pick the SKU and enter what you believe the quantity is, per size.' },
      { say: 'Give the reason — mismatch, quantity, recount, or a return you cannot place.' },
      { say: 'Submit, and it lands on the warehouse Rescale Requests queue.' },
      { say: 'They walk the shelf, count it, and enter the ACTUAL numbers.' },
      { say: 'Then both teams see the comparison: your reported figures against their count.' },
      { say: 'The request is about a SKU, not about specific VINs. It is a counting exercise.' },
    ],
  },
  {
    id: 'ph-price-inquiry', role: 'ph_team', title: 'Price inquiry — check a shoe before committing', path: '/ph/price-inquiry',
    beats: [
      { say: 'Price Inquiry answers "what is this shoe worth" without touching inventory.' },
      { say: 'Enter a SKU or a UPC.', type: ['.pi-lookup input', process.env.SOP_SPEC_SKU || 'HQ1988-006'] },
      { say: 'And look it up.', key: 'Enter', hold: 6000 },
      { say: 'You get the product back with every size we can price.',
        waitFor: '.pi-product-name', at: '.pi-product-name' },
      { say: 'The size grid shows the market price per size — they differ, often a lot.', at: '.pi-sizegrid' },
      { say: 'Switch the basis between consigned and With You to see both sides.', at: '.pi-basis-seg' },
      { say: 'Nothing here writes anything. It is a lookup, safe to use on a shoe we do not own.' },
    ],
  },
  {
    id: 'ph-image-finder', role: 'ph_team', title: 'Find listing images for a SKU', path: '/ph/image-finder',
    beats: [
      { say: 'Image Finder sources product photography for a SKU you are about to list.' },
      { say: 'Enter the SKU and it queries several catalogues at once.' },
      { say: 'Nike and Jordan, adidas, and the GOAT and StockX galleries.' },
      { say: 'Each result is labelled with where it came from and which angle it is.' },
      { say: 'Pick the ones you want.' },
      { say: 'Brand and Fill composites them onto our template, with the name and SKU set for you.' },
      { say: 'Committed images are saved as the SKU listing photos and take precedence over warehouse shots.' },
    ],
  },
  {
    id: 'ph-edited-photos', role: 'ph_team', title: 'Upload edited listing photos', path: '/ph/image-finder',
    beats: [
      { say: 'When you have edited photography of your own, this is where it goes.' },
      { say: 'Drop the files onto the SKU.' },
      { say: 'Edited photos outrank the warehouse intake shots wherever a listing photo is shown.' },
      { say: 'The originals stay on file underneath — nothing is destroyed.' },
      { say: 'Angles can be re-ordered, so the side shot leads where it should.' },
      { say: 'Download all pulls the finished set back down as a zip.' },
    ],
  },
  {
    id: 'ph-history', role: 'ph_team', title: 'Read the history on a size', path: '/ph/new-inventory',
    beats: [
      { say: 'Every field on every size keeps a history.' },
      { say: 'Expand the SKU, then open History on the size you are questioning.', click: '.ph-caret' },
      { say: 'You get what changed, what it changed from, who changed it, and when.' },
      { say: 'A change made by the system reads as the system — a price refresh is not attributed to a person.' },
      { say: 'This is how a disputed price is settled: you read it rather than argue it.' },
    ],
  },
  {
    id: 'ph-nobox-view', role: 'ph_team', title: 'Why stock is missing — the No Box view', path: '/ph/nobox',
    beats: [
      { say: 'Stock you were expecting can be missing from New Inventory for exactly two reasons.' },
      { say: 'The first is No Box. A pair received without its box is not postable, so it is held back.' },
      { say: 'This view shows you what is waiting, so you know it exists.' },
      { say: 'The warehouse resolves it — when the box is found the pair becomes sellable and appears in your grid.' },
      { say: 'The second reason is in-store stock, which bypasses the PH team entirely by design.' },
    ],
  },
  {
    id: 'po-create', role: 'ph_team', title: 'Create a purchase order', path: '/ph/purchase-orders',
    beats: [
      { say: 'A purchase order is how we tell a supplier what to send, and how we check what arrived.' },
      { say: 'Pick the supplier and give the order its lines — SKU, size, quantity.' },
      { say: 'Shipping labels can be imported straight from a PDF, and the tracking numbers are parsed out.',
        at: '.po-dropzone-text' },
      { say: 'Each label becomes a box on the order.', at: '.po-label-row' },
      { say: 'Create it, and the supplier sees it in their portal — and nothing else on our system.' },
      { say: 'They scan out against it, and the warehouse receives against the same order.' },
    ],
  },
  {
    id: 'po-overview', role: 'ph_team', title: 'Track orders in flight', path: '/ph/po-status',
    beats: [
      { say: 'PO Status is every order that is out there, and where it has got to.' },
      { say: 'Each card is one order, with its code and its supplier.', at: '.po-code' },
      { say: 'Tracking is pushed to us — the carrier tells the system, the system does not sit and poll.' },
      { say: 'A label that has not moved is as informative as one that has.' },
      { say: 'Open an order for the label-by-label picture.', click: '.po-ov-head' },
      { say: 'Delivered labels stop being tracked, which is what keeps the quota sane.' },
    ],
  },
  {
    id: 'po-onbehalf', role: 'ph_team', title: 'Enter a manifest on the supplier\'s behalf', path: '/ph/purchase-orders',
    beats: [
      { say: 'Not every supplier will scan their order out. You can enter the manifest for them.' },
      { say: 'Three ways, depending on what you actually know.' },
      { say: 'Per box, when you know which shoe went in which box. It is attributed to you, on their behalf.' },
      { say: 'Whole order, when you have one list and no idea how it was split across boxes.' },
      { say: 'Or nothing at all — the order is received blind, and the receiving side is told so plainly.' },
      { say: 'Receiving still happens box by box regardless. Only the expectation changes.' },
    ],
  },
  {
    id: 'po-resolution', role: 'ph_team', title: 'Resolve a discrepancy', path: '/ph/reconciliation',
    beats: [
      { say: 'A perfectly matched order closes itself. Anything in this queue needs a person.' },
      { say: 'The chip on each card says what is actually true, not what stage it is at.', at: '.po-flag' },
      { say: 'Open it for the line-by-line: what was expected against what was counted.', click: '.po-card-top' },
      { say: 'Work the checklist. Each step is a real thing someone has to do.' },
      { say: 'The internal thread is for us — the supplier never sees it.' },
      { say: 'The note to the supplier is what they DO see, so write the why, not just the number.' },
      { say: 'A replacement shipment becomes a real label on the order, but is excluded from the expected count.' },
      { say: 'Otherwise the order would read short for ever.' },
    ],
  },

  // ================================================================ SUPPLIER ==
  {
    id: 'supplier-portal-read', role: 'supplier', title: 'Your portal — what you can see', path: '/',
    beats: [
      { say: 'This portal shows the orders we opened for you, and nothing else on our system.' },
      { say: 'One card per order.', at: '.po-code' },
      { say: 'The meta line counts how many of your labels have shipped, and how many units you declared.',
        at: '.po-card-meta' },
      { say: 'Open an order to see a card per shipping label.', click: '.po-card-top' },
      { say: 'Each label carries its own tracking number, its own status, and its own contents.', at: '.po-box' },
      { say: 'You cannot see our inventory, our pricing, or any other supplier. Only your own orders.' },
    ],
  },
  {
    id: 'supplier-scanout', role: 'supplier', title: 'Scan out what you are shipping', path: '/',
    beats: [
      { say: 'Scanning out is you telling us what is actually in the box before it leaves you.' },
      { say: 'Open the order, then the box you are packing.', click: '.po-card-top' },
      { say: 'Scan each shoe by its box barcode, or type the SKU.' },
      { say: 'Set the size and the quantity as you go.' },
      { say: 'What you scan becomes the manifest for that box.' },
      { say: 'When the box arrives, our warehouse receives against exactly this list.' },
      { say: 'Anything that does not match is a discrepancy we will come back to you about.' },
      { say: 'So it is worth being accurate here rather than fast.' },
    ],
  },
  {
    id: 'supplier-close-ship', role: 'supplier', title: 'Close a box and ship it', path: '/',
    beats: [
      { say: 'A box moves through three states: filling, packed, then shipped.' },
      { say: 'Open the order and the box you have finished.', click: '.po-card-top' },
      { say: 'Close the box when it is physically packed and you are done adding to it.', at: '.po-box-actions' },
      { say: 'That freezes the manifest. If you need to change it, reopen the box first.' },
      { say: 'Then mark it shipped once it is with the carrier.' },
      { say: 'Shipped is what starts the tracking, and what tells our warehouse to expect it.' },
    ],
  },
  {
    id: 'supplier-tracking', role: 'supplier', title: 'Tracking numbers', path: '/',
    beats: [
      { say: 'Every box needs its own tracking number. One per label, not one per order.' },
      { say: 'Open the order to reach its boxes.', click: '.po-card-top', hold: 2600 },
      { say: 'Each box carries its own carrier and number.', at: '.po-carrier' },
      { say: 'The carrier updates us directly from then on — you do not have to keep telling us where it is.' },
      { say: 'Status flows one way only. A parcel that has been delivered does not go back to in transit.' },
      { say: 'If a number is wrong, correct it on the box and tracking re-registers against the new one.' },
    ],
  },
  {
    id: 'supplier-signup', role: 'supplier', title: 'Getting your account', path: '/',
    beats: [
      { say: 'Supplier accounts are created by us, not self-served.' },
      { say: 'You are given a username and a temporary password.' },
      { say: 'Change the password the first time you sign in.' },
      { say: 'Your account only ever sees your own orders — the scoping is enforced on the server, not just hidden in the page.' },
      { say: 'If you lose access, ask us to issue a new temporary password. We cannot read your existing one.' },
    ],
  },

  // =================================================================== ADMIN ==
  {
    id: 'admin-check-access', role: 'admin', title: 'Approve accounts and set roles', path: '/access',
    beats: [
      { say: 'Check Access is where accounts are approved, changed and removed.' },
      { say: 'Every account on the system, with its role and its status.', at: '.access-table' },
      { say: 'A new sign-up arrives as pending and can do nothing at all until you approve it.' },
      { say: 'Set the role deliberately.', at: '.role-select', zoom: 2.2 },
      { say: 'Warehouse and PH Team are staff. Supplier is an external partner and sees only their own orders.' },
      { say: 'Reset issues a temporary password, shown to you once and never again.' },
      { say: 'Only its hash is stored, so nobody — including you — can read it back later.' },
      { say: 'Removing an account is immediate. Their session stops working on the next request.' },
    ],
  },
  {
    id: 'admin-settings', role: 'admin', title: 'Settings — the margin', path: '/settings',
    beats: [
      { say: 'Settings holds the values that change how the whole system prices.' },
      { say: 'The margin is the one that matters.', at: '.settings-field' },
      { say: 'Final price is derived from the market price by this margin, then rounded to whole dollars.' },
      { say: 'Changing it re-prices everything not yet listed.' },
      { say: 'Already-listed stock is left alone — we do not silently move a price someone has published.' },
    ],
  },
  {
    id: 'superadmin-ph', role: 'superadmin', title: 'Superadmin — admin plus the PH workspace', path: '/',
    beats: [
      { say: 'Superadmin is an admin who can also open the PH team workspace.' },
      { say: 'It is an environment account, not a database role — it is configured on the server.' },
      { say: 'Use it to see what PH sees when you are diagnosing a pricing or listing question.' },
      { say: 'Everything an admin can do, it can do. Plus the grid, the worklists and the image tools.' },
    ],
  },

  {
    id: 'reconcile-warehouse', role: 'warehouse', title: 'Reconcile a purchase order', path: '/reconcile',
    beats: [
      { say: 'PO Reconciliation — what the supplier said they sent, against what actually landed.' },
      { say: 'The chip on each order says what is actually true.' },
      { say: 'Reconciled, Receiving, Received blind, or N discrepancies.' },
      { say: 'Open an order for the line-by-line table: SKU and size, name, got against expected.' },
      { say: 'Switch between "By size" and "By SKU" depending on what you are chasing.' },
      { say: 'Matched lines fold away, so what is left is the problem.' },
      { say: 'Need it on paper to recount against, or to send with a claim? Manifest PDF.' },
      { say: 'Then write the note to the supplier — the WHY behind the numbers.' },
      { say: 'A perfectly-matched order closes itself.' },
      { say: 'So if it is in this queue at all, something needs a human.' },
      { say: 'Open one and see.', click: '.po-card-top', hold: 2600 },
      { say: 'Line by line: what was expected, and what was actually counted in.', at: '.rcn-main' },
      { say: 'Matched lines fold away, so what is left on screen IS the problem.', at: '.rcn-fold-cta' },
    ],
  },
];

// `precise` keeps the decimals — narration timing needs them; the manifest's display
// duration does not.
const probeSeconds = (file, precise = false) => {
  try {
    const n = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());
    return precise ? n : Math.round(n);
  } catch { return 0; }
};

// `--reindex` rebuilds index.json from the mp4s already on disk, without re-recording.
// Recovering a lost manifest should not cost 20 minutes of capture.
function reindex() {
  const manifest = {};
  for (const v of VIDEOS) {
    const file = path.join(OUT_DIR, `${v.id}.mp4`);
    if (!fs.existsSync(file)) continue;
    manifest[v.id] = { title: v.title, role: v.role, seconds: probeSeconds(file), file: `${v.id}.mp4` };
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Reindexed ${Object.keys(manifest).length} video(s) → ${path.relative(ROOT, OUT_DIR)}/index.json`);
}

// `--lint` loads each flow's page and checks every selector it references, without
// recording anything. A missed target costs a caption its cursor and its zoom, and finding
// that out from a finished video means paying for the whole render again — this answers the
// same question in a couple of minutes. It does not verify that the element is the RIGHT
// one, only that it exists; a selector that resolves to the wrong thing still needs eyes.
async function lint(wanted) {
  const browser = await chromium.launch();
  let bad = 0;
  let checked = 0;
  for (const v of wanted) {
    const ctx = await browser.newContext({ viewport: SIZE });
    const page = await ctx.newPage();
    const misses = [];
    try {
      await signIn(page, v.role);
      await page.goto(`${BASE}${v.path}`, { waitUntil: 'networkidle', timeout: 20_000 });
      await wait(page, 1200);
      for (const sel of v.prep || []) {
        try {
          const l = page.locator(sel).first();
          if (await l.isVisible({ timeout: 1500 })) { await l.click(); await wait(page, 700); }
          else misses.push(`prep ${sel}`);
        } catch { misses.push(`prep ${sel}`); }
      }
      // Beats are checked in order and their clicks ARE performed, because a later beat's
      // target usually only exists after an earlier one navigated or opened something.
      for (const b of v.beats || []) {
        for (const sel of [b.waitFor, b.at, b.click, b.type?.[0]].filter(Boolean)) {
          checked++;
          try {
            const loc = page.locator(sel).first();
            if (!(await loc.isVisible({ timeout: 2500 }))) { misses.push(sel); continue; }
            // Visible is not the same as clickable. "Print labels" matched a toolbar button
            // that stays disabled until rows are ticked, so .first() resolved to something
            // that could never be clicked and the recording burned 30s timing out on it.
            if (sel === b.click && !(await loc.isEnabled())) misses.push(`${sel} [disabled]`);
          } catch { misses.push(sel); }
        }
        try {
          if (b.key) await page.keyboard.press(b.key);
          else if (b.select) await page.locator(b.select[0]).first().selectOption(b.select[1]);
          else if (b.type) await page.locator(b.type[0]).first().fill(b.type[1]);
          else if (b.click) await page.locator(b.click).first().click({ timeout: 2500 });
          // Honour the beat's own hold. A fixed short wait made the lint report targets as
          // missing that a real recording reaches fine — it flagged "+ Add Item" as absent
          // purely because it checked before the wizard had finished changing step.
          await wait(page, Math.min(3000, b.hold ?? 700));
        } catch { /* already recorded as a miss */ }
      }
    } catch (e) {
      misses.push(`PAGE: ${e.message.split('\n')[0].slice(0, 60)}`);
    }
    await ctx.close();
    bad += misses.length;
    console.log(misses.length
      ? `  ✗ ${v.id.padEnd(26)} ${misses.length} miss: ${[...new Set(misses)].join(' · ')}`
      : `  ✓ ${v.id.padEnd(26)} all targets resolve`);
  }
  await browser.close();
  console.log(`\n${checked} selectors checked · ${bad} unresolved across ${wanted.length} flow(s)`);
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (process.argv.includes('--reindex')) return reindex();
  if (process.argv.includes('--lint')) {
    return lint(only.length ? VIDEOS.filter((v) => only.includes(v.id)) : VIDEOS);
  }
  const wanted = only.length ? VIDEOS.filter((v) => only.includes(v.id)) : VIDEOS;
  const browser = await chromium.launch();
  const made = [];
  const problems = [];
  // Merge into whatever is already recorded, so re-recording ONE flow does not drop the
  // other 22 from the manifest — same rule as the screenshot capture's shots.json.
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8')); } catch { /* first run */ }

  for (const v of wanted) {
    const ctx = await browser.newContext({
      viewport: SIZE,
      recordVideo: { dir: OUT_DIR, size: SIZE },
    });
    await ctx.addInitScript(OVERLAY);
    const report = (m) => problems.push(`${v.id}: ${m}`);
    // Narration is rendered BEFORE the browser opens: every line's true spoken length
    // has to be known up front, because it is what each beat holds for.
    const voiceDir = path.join(OUT_DIR, '.voice', v.id);
    fs.rmSync(voiceDir, { recursive: true, force: true });
    fs.mkdirSync(voiceDir, { recursive: true });
    const lines = [v.title, ...(v.beats || []).map((b) => b.say)];
    const clips = [];
    for (const [i, text] of lines.entries()) {
      if (text == null || text === '') { clips.push(null); continue; }
      const stem = path.join(voiceDir, String(i).padStart(2, '0'));
      try {
        const c = await renderLine(text, stem);
        clips.push({ ...c, text });
      } catch (e) {
        // Say it once, loudly, and name the reason — a silent tutorial that looks fine
        // in the log is how you discover the key was wrong after 23 renders.
        report(`TTS failed (${String(e.message).slice(0, 80)}) — recording silent`);
        clips.push(null);
      }
    }
    const page = await ctx.newPage();
    const track = makeTrack(clips.slice(1)); // clips[0] is the title card
    try {
      await signIn(page, v.role);
      await page.goto(`${BASE}${v.path}`, { waitUntil: 'networkidle', timeout: 20_000 });
      await wait(page, 1400);
      // `prep` runs BEFORE the first caption and is not narrated: it puts the screen into
      // the state the procedure is about. Mostly widening a date filter — several pages
      // default to "today", and a tutorial recorded against "No requests in this range"
      // teaches nothing. Missing prep targets are ignored; the flow is still worth having.
      for (const sel of v.prep || []) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: 2500 })) { await loc.click(); await wait(page, 900); }
          else report(`prep target missing: ${sel}`);
        } catch { report(`prep failed: ${sel}`); }
      }
      // Branded title card, so a video shared on its own says what it is and whose it is.
      // It covers the app while the first line is spoken, then lifts into the live screen.
      await page.evaluate(({ brand, title, logo }) => window.__card({ brand, title, logo }),
        { brand: BRAND, title: v.title, logo: BRAND_LOGO });
      await wait(page, 500);
      if (clips[0]) track.mark(-1, clips[0]);
      await wait(page, clips[0] ? clips[0].seconds * 1000 + 500 : 2200);
      await page.evaluate(() => window.__cardOff());
      await wait(page, 700);
      if (v.beats) await playBeats(page, v.beats, report, track);
      else await v.run(page);
      await page.evaluate(() => window.__say(''));
      await wait(page, 900);
    } catch (e) {
      console.log(`  ✗ ${v.id}  ${e.message.split('\n')[0]}`);
      report(e.message.split('\n')[0].slice(0, 80));
    }
    const video = page.video();
    const scriptMs = track.elapsed();
    await ctx.close(); // the .webm is only finalized on context close
    if (video) {
      const webm = path.join(OUT_DIR, `${v.id}.webm`);
      fs.renameSync(await video.path(), webm);
      // webm plays in browsers but not in QuickTime/Preview; ship an mp4 alongside.
      let mp4 = '';
      try {
        mp4 = path.join(OUT_DIR, `${v.id}.mp4`);
        // Our clock and the recorder's drift over a minute of capture. Rescale every
        // offset by the ratio of real video length to script elapsed, so the last line
        // lands on the last step instead of a second or two adrift.
        const realMs = probeSeconds(webm, true) * 1000;
        const scale = scriptMs > 0 && realMs > 0 ? realMs / scriptMs : 1;
        const zf = zoomFilter(track.zooms, scale);
        const vf = ['scale=1280:-2', 'fps=30', zf].filter(Boolean).join(',');

        // Video and audio both go through filter_complex: mixing -vf with a
        // filter_complex audio graph makes ffmpeg ambiguous about which stream it is
        // filtering, and it fails rather than picking.
        const audio = track.audio.filter((a) => a.file && fs.existsSync(a.file));
        const args = ['-y', '-i', webm];
        audio.forEach((a) => args.push('-i', a.file));
        const graph = [`[0:v]${vf}[vout]`];
        if (audio.length) {
          audio.forEach((a, i) => {
            const at = Math.max(0, Math.round(a.at * scale));
            graph.push(`[${i + 1}:a]adelay=${at}|${at}[a${i}]`);
          });
          // loudnorm to the EBU R128 broadcast target. Without it the level depends on
          // whichever engine spoke the lines — macOS `say` lands around -20 LUFS and
          // OpenAI around -25 — so swapping voices would change how loud the tutorials
          // are, and a set played back to back would be inconsistent.
          graph.push(`${audio.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audio.length}:normalize=0,`
            + 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]');
        }
        args.push('-filter_complex', graph.join(';'), '-map', '[vout]');
        if (audio.length) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '112k');
        args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23',
          '-preset', 'medium', '-movflags', '+faststart', mp4);
        execFileSync('ffmpeg', args, { stdio: 'ignore' });
      } catch (e) { report(`post-process failed: ${String(e.message).split('\n')[0].slice(0, 60)}`); mp4 = ''; }
      const kb = (f) => `${Math.round(fs.statSync(f).size / 1024)} KB`;
      made.push(v.id);
      let secs = 0;
      try {
        secs = Math.round(Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
          'format=duration', '-of', 'default=nw=1:nk=1', mp4 || webm]).toString().trim()));
      } catch { /* ffprobe optional */ }
      // Say which zooms were dropped for being un-fittable. Silence here would look like
      // "all zooms applied"; these are the beats whose target should be a smaller element.
      if (track.skipped.length) {
        report(`${track.skipped.length} zoom(s) skipped — target too large to fit: `
          + track.skipped.map((s) => `${s.w}x${s.h}`).join(', '));
      }
      manifest[v.id] = { title: v.title, role: v.role, seconds: secs, file: `${v.id}.mp4` };
      console.log(`  ✓ ${v.id}  ${secs}s  ${kb(webm)} webm${mp4 ? ` · ${kb(mp4)} mp4` : ' (no ffmpeg — webm only)'}`);
    }
  }
  await browser.close();
  // Drop entries whose mp4 is gone, so the manifest can never point at a missing file.
  for (const id of Object.keys(manifest)) {
    if (!fs.existsSync(path.join(OUT_DIR, manifest[id].file || `${id}.mp4`))) delete manifest[id];
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n${made.length}/${wanted.length} recorded → ${path.relative(ROOT, OUT_DIR)}/`);
  if (problems.length) {
    // Same rule as the screenshot capture: a target that no longer resolves is skipped
    // and REPORTED, never guessed at. The caption still plays, so the video stays honest —
    // it just loses the cursor move. These are the ones to fix.
    console.log(`\n${problems.length} beat target(s) did not resolve (caption still played):`);
    problems.forEach((p) => console.log(`  · ${p}`));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
