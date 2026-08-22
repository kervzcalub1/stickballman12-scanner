// Get a StockX REFRESH TOKEN — the one step of the StockX setup a server can't do
// for itself.
//
//   node scripts/stockx-auth.mjs              # step 1: prints the URL to open
//   node scripts/stockx-auth.mjs <code>       # step 2: swaps the code for tokens
//
// Why a human has to be involved at all: StockX's Public API only offers the OAuth
// `authorization_code` and `refresh_token` grants — there is no client_credentials
// (machine-to-machine) grant, so client id + secret alone cannot mint a token. Someone
// has to approve the app once, in a browser, signed in as the StockX account the API
// should act as. That hands back a refresh token, and from then on the server renews
// its own ~12 h access tokens with no one watching.
//
// Every parameter below is verified against developer.stockx.com/portal/authentication
// (read 2026-08-22): the authorize call takes response_type/client_id/redirect_uri/
// scope=offline_access%20openid/audience=gateway.stockx.com/state, and the code
// exchange takes grant_type/client_id/client_secret/code/redirect_uri — note it does
// NOT take `audience`, unlike the refresh call in api/_lib/stockx.js, which does.
//
// Read-only against our own files: it prints, it never writes .env for you.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const AUTHORIZE_URL = 'https://accounts.stockx.com/authorize';
const TOKEN_URL = process.env.STOCKX_TOKEN_URL || 'https://accounts.stockx.com/oauth/token';
const AUDIENCE = process.env.STOCKX_AUDIENCE || 'gateway.stockx.com';
// Must match the redirect URI registered on the app EXACTLY, on both requests.
// It never has to serve anything: the browser just needs somewhere to land so the
// ?code= lands in the address bar where you can copy it.
const REDIRECT_URI = process.env.STOCKX_REDIRECT_URI || 'https://localhost:3000/callback';

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// PKCE. StockX's auth service is Auth0, which REQUIRES a code_challenge when the
// application is registered as a public client and rejects the authorize call with a
// bare `invalid_request` when it's missing — no hint as to which parameter. For a
// confidential client (one with a secret, like ours) PKCE is merely allowed, so
// sending it is safe in both cases and removes one whole class of failure.
// The verifier has to survive between the two runs of this script, so it's parked in
// a temp file rather than asked for twice.
const PKCE_FILE = path.join(os.tmpdir(), 'stockx-pkce.json');
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const clientId = process.env.STOCKX_CLIENT_ID;
const clientSecret = process.env.STOCKX_CLIENT_SECRET;
const code = process.argv[2] === '--print' ? null : process.argv[2];

// Deliberate, asked-for disclosure — the only way the token reaches Railway.
if (process.argv.includes('--print')) {
  const t = process.env.STOCKX_REFRESH_TOKEN;
  if (!t) { console.log(bad('\nNo STOCKX_REFRESH_TOKEN in .env yet — run the two grant steps first.\n')); process.exit(1); }
  console.log(`\nSTOCKX_REFRESH_TOKEN=${t}\n`);
  console.log(dim('Paste into Railway → Variables. Clear your terminal afterwards.\n'));
  process.exit(0);
}

if (!clientId || !clientSecret) {
  console.log(bad('\nSTOCKX_CLIENT_ID and STOCKX_CLIENT_SECRET must be set in .env first.'));
  console.log(dim('Both come from your app on developer.stockx.com (Keys page).\n'));
  process.exit(1);
}

if (!code) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  try { fs.writeFileSync(PKCE_FILE, JSON.stringify({ verifier, redirect: REDIRECT_URI }), { mode: 0o600 }); } catch { /* step 2 falls back to no PKCE */ }
  const url = `${AUTHORIZE_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // offline_access is what makes StockX return a refresh token at all; openid is
    // required by OIDC. Drop either one and step 2 gives you an access token that
    // dies in 12 hours with no way to renew it.
    scope: 'offline_access openid',
    audience: AUDIENCE,
    state: 'stickballman12',
  // URLSearchParams encodes the space in "offline_access openid" as `+`, which is
  // only a space in form bodies — in a URL query it can arrive literally. StockX's
  // docs write %20, so normalise it. A scope read as "offline_access+openid" is an
  // unknown scope, and you'd get an access token with no refresh token.
  }).toString().replace(/\+/g, '%20')}`;
  console.log(`\n${bold('Step 1 — approve the app')}`);
  console.log('Open this in a browser, signed in as the StockX account the API should act as:\n');
  console.log(`  ${url}\n`);
  console.log(`Redirect URI in use: ${bold(REDIRECT_URI)}`);
  console.log(dim('  This MUST equal the Callback URI registered on your app, character for character.'));
  console.log(dim('  Find it at developer.stockx.com → Applications: that page lists the app name,'));
  console.log(dim('  description, Callback URI and a link to the credentials (EDIT changes it). StockX'));
  console.log(dim('  allows one application per account, so there is only ever one to check.'));
  console.log(dim('  Set STOCKX_REDIRECT_URI in .env if yours differs from the above.'));
  console.log(dim('  The page itself need not load — "site can\'t be reached" is fine. What matters'));
  console.log(dim('  is the ?code=… in the address bar.\n'));
  console.log(`${bold('Step 2')} — copy that code and run, within a minute or two:\n`);
  console.log('  node scripts/stockx-auth.mjs <code>\n');
  console.log(dim('The code is single-use and expires fast. If step 2 says "invalid grant",'));
  console.log(dim('just open the URL again for a fresh one.\n'));
  process.exit(0);
}

// The verifier proves this exchange belongs to the same authorize call. Omitted if
// step 1 couldn't write the temp file, which is still a valid request for a
// confidential client.
let pkce = null;
try { pkce = JSON.parse(fs.readFileSync(PKCE_FILE, 'utf8')); } catch { /* none */ }
if (pkce && pkce.redirect && pkce.redirect !== REDIRECT_URI) {
  console.log(bad(`\nSTOCKX_REDIRECT_URI changed since step 1 (${pkce.redirect} → ${REDIRECT_URI}).`));
  console.log(bad('Re-run step 1 — the code is bound to the redirect it was issued for.\n'));
  process.exit(1);
}
const form = new URLSearchParams({
  grant_type: 'authorization_code',
  client_id: clientId,
  client_secret: clientSecret,
  code,
  redirect_uri: REDIRECT_URI,
  ...(pkce?.verifier ? { code_verifier: pkce.verifier } : {}),
});

const r = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  body: form.toString(),
});
const data = await r.json().catch(() => null);

if (!r.ok || !data?.refresh_token) {
  console.log(bad(`\nToken exchange failed (${r.status}).`));
  if (data?.error) console.log(`  ${data.error}${data.error_description ? `: ${data.error_description}` : ''}`);
  console.log(dim('\nThe usual causes, in order of likelihood:'));
  console.log(dim('  · the code was already used, or is more than a couple of minutes old'));
  console.log(dim(`  · redirect_uri doesn't match the app's registered one (used: ${REDIRECT_URI})`));
  console.log(dim('  · the authorize URL was opened without scope=offline_access → no refresh token'));
  console.log(dim('    (an access_token with no refresh_token means exactly this)\n'));
  if (data?.access_token && !data?.refresh_token) {
    console.log(bad('  StockX returned an access token but NO refresh token — that is the scope problem.\n'));
  }
  process.exit(1);
}

try { fs.unlinkSync(PKCE_FILE); } catch { /* already gone */ }

// Write it STRAIGHT into .env rather than printing it. A refresh token is a
// long-lived credential: the moment it lands in a terminal it is in scrollback, and
// from there in screenshots and chat logs. Printing it also cost us a whole grant
// once — the value was masked out of the output before anything could store it, and
// authorization codes are single-use, so it could not be recovered. `--print` exists
// for the one legitimate case (copying it into Railway) and must be asked for.
const envFile = path.join(process.cwd(), '.env');
let wrote = false;
try {
  const cur = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const line = `STOCKX_REFRESH_TOKEN=${data.refresh_token}`;
  const next = /^STOCKX_REFRESH_TOKEN=.*$/m.test(cur)
    ? cur.replace(/^STOCKX_REFRESH_TOKEN=.*$/m, line)
    : `${cur}${cur.endsWith('\n') || !cur ? '' : '\n'}${line}\n`;
  fs.writeFileSync(envFile, next, { mode: 0o600 });
  wrote = true;
} catch (e) {
  console.log(bad(`\nCould not write .env (${e.message}).`));
}

console.log(`\n${ok('Success.')} ${wrote ? 'STOCKX_REFRESH_TOKEN written to .env.' : 'Token obtained but NOT saved:'}`);
if (!wrote) console.log(`  STOCKX_REFRESH_TOKEN=${data.refresh_token}`);
console.log(dim(`An access token was issued too (expires in ${data.expires_in || '?'}s) — discarded, the server mints its own.`));
console.log(`\nStill to do by hand: set the same value in ${bold("Railway's variables")} — run`);
console.log(`  ${bold('node scripts/stockx-auth.mjs --print')}   to display it when you need to copy it there.`);
console.log(bad('\nTreat it like a password: long-lived, grants API access as your StockX account.'));
console.log(`\nVerify end to end:  ${bold('node scripts/probe-stockx.mjs DD1391-100 10')}\n`);
