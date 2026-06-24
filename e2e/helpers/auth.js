// E2E auth helper. The app keeps its session in sessionStorage (sb_session_token
// + sb_user), and the server's verifyToken trusts the SIGNED payload (HMAC + exp,
// no DB lookup). So we mint a valid token with the server's own signToken using
// SESSION_SECRET from .env — no per-user passwords needed, and it stays the single
// source of truth for the token format.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signToken } from '../../api/_lib/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Load .env into process.env (only keys not already set), same as server.mjs /
// vite.config.js — so signToken sees the same SESSION_SECRET the server uses.
export function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

// Demo identities per role (uid is not verified against the DB).
const USERS = {
  admin:     { uid: 'admin', username: 'admin', name: 'Alex',  role: 'admin' },
  warehouse: { uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' },
  ph_team:   { uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' },
};

// Inject a signed session for `role` so the app boots authenticated. Must be
// called BEFORE the first navigation (uses addInitScript, which runs before page
// scripts on every load). Returns the user object.
export async function loginAs(page, role = 'admin') {
  const user = USERS[role];
  if (!user) throw new Error(`Unknown role: ${role}`);
  const token = signToken(user);
  const userJson = JSON.stringify({ username: user.username, name: user.name, role: user.role });
  await page.addInitScript(([t, u]) => {
    sessionStorage.setItem('sb_session_token', t);
    sessionStorage.setItem('sb_user', u);
  }, [token, userJson]);
  return user;
}
