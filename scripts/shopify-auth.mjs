// Exchange Shopify Dev Dashboard client credentials for an Admin API access token.
//
//   node scripts/shopify-auth.mjs            # get a token, write it into .env
//   node scripts/shopify-auth.mjs --print    # show the stored token (for Railway)
//
// Why this exists: apps built in the **Dev Dashboard** don't hand you a `shpat_…`
// token in the UI the way legacy custom apps did. You get a Client ID and secret and
// exchange them here, via Shopify's client-credentials grant, for a token scoped to the
// store the app is installed on.
//
// The token is written STRAIGHT INTO .env and never printed. A credential that passes
// through a terminal is a credential in scrollback, in screenshots and in chat logs —
// that happened once already this session with a StockX secret, and the fix is to not
// route it through the screen at all. `--print` exists for the one legitimate case
// (copying it into Railway) and has to be asked for.
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const domain = String(process.env.SHOPIFY_STORE_DOMAIN || '')
  .replace(/^https?:\/\//, '').replace(/\/$/, '');
const clientId = process.env.SHOPIFY_CLIENT_ID;
// Accept either name: the Dev Dashboard labels it "Client secret", but "secret key" is
// what people reach for. Failing over a variable name would be a silly way to stop.
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_SECRET_KEY;

if (process.argv.includes('--print')) {
  const t = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!t) { console.log(bad('\nNo SHOPIFY_ACCESS_TOKEN in .env yet — run this without --print first.\n')); process.exit(1); }
  console.log(`\nSHOPIFY_ACCESS_TOKEN=${t}\n`);
  console.log(dim('Paste into Railway → Variables. Clear your terminal afterwards.\n'));
  process.exit(0);
}

const missing = [
  !domain && 'SHOPIFY_STORE_DOMAIN',
  !clientId && 'SHOPIFY_CLIENT_ID',
  !clientSecret && 'SHOPIFY_CLIENT_SECRET (or SHOPIFY_SECRET_KEY)',
].filter(Boolean);
if (missing.length) {
  console.log(bad(`\nMissing in .env: ${missing.join(', ')}\n`));
  process.exit(1);
}

console.log(`\nExchanging client credentials for a token on ${bold(domain)}…`);
const r = await fetch(`https://${domain}/admin/oauth/access_token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  }),
});
const data = await r.json().catch(() => null);

if (!r.ok || !data?.access_token) {
  console.log(bad(`\nFailed (${r.status}).`));
  if (data) console.log(`  ${JSON.stringify(data).slice(0, 300)}`);
  console.log(dim('\nThe usual causes, in order:'));
  console.log(dim('  · the app is not INSTALLED on this store — Dev Dashboard → Home → Install app'));
  console.log(dim('  · the version with your scopes was never Released'));
  console.log(dim('  · client id/secret belong to a different app than the one installed here\n'));
  process.exit(1);
}

let wrote = false;
try {
  const cur = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `SHOPIFY_ACCESS_TOKEN=${data.access_token}`;
  const next = /^SHOPIFY_ACCESS_TOKEN=.*$/m.test(cur)
    ? cur.replace(/^SHOPIFY_ACCESS_TOKEN=.*$/m, line)
    : `${cur}${cur.endsWith('\n') || !cur ? '' : '\n'}${line}\n`;
  fs.writeFileSync(envPath, next, { mode: 0o600 });
  wrote = true;
} catch (e) {
  console.log(bad(`\nCould not write .env (${e.message}).`));
}

console.log(`\n${ok('Success.')} ${wrote ? 'SHOPIFY_ACCESS_TOKEN written to .env.' : 'Token obtained but NOT saved.'}`);
if (data.scope) console.log(dim(`granted scopes: ${data.scope}`));
console.log(`\nStill to do by hand: set the same value in ${bold("Railway's variables")} —`);
console.log(`  ${bold('node scripts/shopify-auth.mjs --print')}   to display it when you need it there.`);
console.log(`\nVerify:  ${bold('node scripts/probe-shopify.mjs')}\n`);
