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

const clientId = process.env.STOCKX_CLIENT_ID;
const clientSecret = process.env.STOCKX_CLIENT_SECRET;
const code = process.argv[2];

if (!clientId || !clientSecret) {
  console.log(bad('\nSTOCKX_CLIENT_ID and STOCKX_CLIENT_SECRET must be set in .env first.'));
  console.log(dim('Both come from your app on developer.stockx.com (Keys page).\n'));
  process.exit(1);
}

if (!code) {
  const url = `${AUTHORIZE_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
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

const form = new URLSearchParams({
  grant_type: 'authorization_code',
  client_id: clientId,
  client_secret: clientSecret,
  code,
  redirect_uri: REDIRECT_URI,
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

console.log(`\n${ok('Success.')} Put this line in your .env (and in Railway's variables):\n`);
console.log(`  STOCKX_REFRESH_TOKEN=${data.refresh_token}\n`);
console.log(dim(`access token also issued, expires in ${data.expires_in || '?'}s — not needed, the server mints its own.`));
console.log(bad('\nTreat that refresh token like a password: it is long-lived and grants API access'));
console.log(bad('as your StockX account. Never commit it, never paste it into a chat.\n'));
console.log(`Then verify end to end:  ${bold('node scripts/probe-stockx.mjs DD1391-100 10')}\n`);
