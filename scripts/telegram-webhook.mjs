// Point the bot at THIS app — replaces the Make scenario that used to receive its taps.
//
//   npm run telegram:webhook              show what the bot is pointed at now
//   npm run telegram:webhook -- set       point it at $APP_BASE_URL/api/telegram/webhook
//   npm run telegram:webhook -- set <url> point it at <url>/api/telegram/webhook
//   npm run telegram:webhook -- delete    unhook it (taps then go nowhere)
//
// A bot has ONE webhook. Setting ours takes it over from Make's "Telegram tap → decision
// recorded" scenario at once — deactivate that scenario (and the card one) afterwards.
// Dev and prod share the bot, so it is always pointed at PRODUCTION; prod passes dev
// cards' taps on to TELEGRAM_DEV_FORWARD_URL.
import fs from 'node:fs';

for (const line of (fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
if (!token) { console.error('TELEGRAM_BOT_TOKEN is not set.'); process.exit(1); }
const call = async (method, params = {}) => {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
  });
  return r.json();
};

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'set') {
  if (!secret) { console.error('TELEGRAM_WEBHOOK_SECRET is not set — the endpoint refuses every update without it.'); process.exit(1); }
  const base = String(arg || process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) { console.error(`Telegram needs a public https origin; got "${base || '(nothing)'}".`); process.exit(1); }
  const url = `${base}/api/telegram/webhook`;
  const out = await call('setWebhook', {
    url, secret_token: secret, allowed_updates: ['callback_query', 'message'], drop_pending_updates: false,
  });
  console.log(out.ok ? `Bot now posts to ${url}` : `Refused: ${out.description}`);
  if (!out.ok) process.exit(1);
} else if (cmd === 'delete') {
  const out = await call('deleteWebhook');
  console.log(out.ok ? 'Webhook removed.' : `Refused: ${out.description}`);
}
const info = await call('getWebhookInfo');
const me = await call('getMe');
console.log({ bot: me.result?.username, ...info.result });
