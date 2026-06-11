// Neon Postgres access layer (HTTP driver — serverless-friendly, no pooling).
// All queries use tagged-template parameterization, so values are never
// interpolated into SQL text (injection-safe).

import { neon } from '@neondatabase/serverless';

let _sql = null;
function db() {
  if (_sql) return _sql;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

export function dbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

/* ------------------------------- Users -------------------------------- */

// Create a pending employee. Throws { code: 'USERNAME_TAKEN' } on conflict.
export async function createUser({ name, username, passHash }) {
  const sql = db();
  try {
    const rows = await sql`
      INSERT INTO users (name, username, pass_hash, role, status)
      VALUES (${name}, ${username}, ${passHash}, 'employee', 'pending')
      RETURNING id, name, username, role, status, created_at
    `;
    return rows[0];
  } catch (e) {
    if (String(e.message || '').includes('users_username_key') || e.code === '23505') {
      const err = new Error('That username is already taken.');
      err.code = 'USERNAME_TAKEN';
      throw err;
    }
    throw e;
  }
}

export async function findUserByUsername(username) {
  const rows = await db()`
    SELECT id, name, username, pass_hash, role, status
    FROM users WHERE username = ${username} LIMIT 1
  `;
  return rows[0] || null;
}

// Admin views. Pending first, then most recent.
export async function listUsers() {
  return await db()`
    SELECT id, name, username, role, status, created_at, reviewed_at, reviewed_by
    FROM users
    ORDER BY (status = 'pending') DESC, created_at DESC
    LIMIT 500
  `;
}

export async function reviewUser(id, status, reviewer) {
  const rows = await db()`
    UPDATE users
    SET status = ${status}, reviewed_at = now(), reviewed_by = ${reviewer}
    WHERE id = ${id}
    RETURNING id, name, username, role, status
  `;
  return rows[0] || null;
}

/* -------------------------- Login throttling -------------------------- */

export async function recordLoginAttempt({ username, ip, success }) {
  await db()`
    INSERT INTO login_attempts (username, ip, success)
    VALUES (${username || null}, ${ip || null}, ${success})
  `;
  // Occasionally prune old rows so the table doesn't grow unbounded.
  if (Math.random() < 0.02) {
    try { await db()`DELETE FROM login_attempts WHERE created_at < now() - interval '1 day'`; }
    catch { /* best effort */ }
  }
}

// Count failed attempts in the last `windowMins` minutes for a username and IP.
export async function countRecentFailures({ username, ip, windowMins = 15 }) {
  const rows = await db()`
    SELECT
      count(*) FILTER (WHERE username = ${username || ''}) ::int AS by_user,
      count(*) FILTER (WHERE ip = ${ip || ''}) ::int          AS by_ip
    FROM login_attempts
    WHERE success = false
      AND created_at > now() - (${windowMins} * interval '1 minute')
  `;
  return rows[0] || { by_user: 0, by_ip: 0 };
}

/* ---------------------- Distributed lock (mutex) ---------------------- */
// Atomic acquire: insert the key, or steal it if the prior holder's lease
// expired. Returns true if acquired. One round trip, safe over the HTTP driver.
async function tryAcquire(key, ttlSec) {
  const rows = await db()`
    INSERT INTO locks (key, locked_until)
    VALUES (${key}, now() + (${ttlSec} * interval '1 second'))
    ON CONFLICT (key) DO UPDATE SET locked_until = EXCLUDED.locked_until
    WHERE locks.locked_until < now()
    RETURNING key
  `;
  return rows.length > 0;
}

// Acquire `key`, waiting up to ~waitMs with small backoff. The lease (ttlSec)
// guards against a crashed holder never releasing.
export async function acquireLock(key, { ttlSec = 15, waitMs = 8000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    if (await tryAcquire(key, ttlSec)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, Math.min(250, 40 + attempt * 30)));
  }
}

export async function releaseLock(key) {
  try { await db()`DELETE FROM locks WHERE key = ${key}`; } catch { /* lease will expire */ }
}
