// Push the recorded SOP tutorials to Cloudflare R2 and write the manifest the app reads.
//
//   node --env-file=.env scripts/upload-sop-videos.mjs [id...]
//
// The videos deliberately do NOT live in the repo. ~1 MB per minute across the library
// is 60-100 MB that would land in git history AND in every Railway image, for assets
// that change independently of the code. R2 already backs listing photos, so the bucket,
// the credentials and the public CDN domain all exist — this reuses them.
//
// Writes src/lib/sop/videos.json: { id: { url, title, seconds } }. The URL is a public
// CDN address, not a secret, so baking it into the bundle keeps the SOP page's "static
// data, no API call" property — only the video bytes themselves are fetched, and only
// when someone presses play.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { presignPutUrl, r2Configured } from '../api/_lib/r2.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VID_DIR = process.env.VIDEO_OUT || path.join(ROOT, 'sop-videos');
const JSON_OUT = path.join(ROOT, 'src', 'lib', 'sop', 'videos.json');
const PREFIX = 'sop-videos';

async function main() {
  if (!r2Configured()) {
    console.error('R2 is not configured — set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET.');
    process.exit(1);
  }
  const base = String(process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    console.error('R2_PUBLIC_BASE_URL is required — it is the address the app plays the video from.');
    process.exit(1);
  }

  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  let recorded = {};
  try { recorded = JSON.parse(fs.readFileSync(path.join(VID_DIR, 'index.json'), 'utf8')); } catch {
    console.error(`No index.json in ${path.relative(ROOT, VID_DIR)} — run capture-sop-video.mjs first.`);
    process.exit(1);
  }

  // Merge into whatever is already published, so a partial re-upload does not drop the rest.
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(JSON_OUT, 'utf8')); } catch { /* first run */ }

  const ids = Object.keys(recorded).filter((id) => !only.length || only.includes(id));
  let done = 0;
  for (const id of ids) {
    const file = path.join(VID_DIR, recorded[id].file);
    if (!fs.existsSync(file)) { console.log(`  · ${id} — no mp4 on disk, skipped`); continue; }
    const body = fs.readFileSync(file);
    const key = `${PREFIX}/${id}.mp4`;
    const res = await fetch(presignPutUrl({ key, expiresIn: 600 }), {
      method: 'PUT', body, headers: { 'Content-Type': 'video/mp4' },
    });
    if (!res.ok) {
      console.log(`  ✗ ${id} — R2 said ${res.status}`);
      continue;
    }
    manifest[id] = {
      url: `${base}/${key}`,
      title: recorded[id].title,
      seconds: recorded[id].seconds || 0,
    };
    done++;
    console.log(`  ✓ ${id}  ${Math.round(body.length / 1024)} KB → ${key}`);
  }

  fs.writeFileSync(JSON_OUT, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n${done}/${ids.length} uploaded · manifest → src/lib/sop/videos.json (${Object.keys(manifest).length} total)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
