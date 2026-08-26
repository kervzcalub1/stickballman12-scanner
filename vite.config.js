import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// In dev the api/**/*.js handlers run inside THIS process, so it gets the same US
// Eastern pinning as server.mjs — otherwise a date defaulted server-side in dev lands on
// the developer's own zone (Asia/Manila here) and disagrees with prod by a day.
process.env.TZ = process.env.TZ || 'America/New_York';

const apiDir = path.dirname(fileURLToPath(import.meta.url));

// Dev-only plugin: serve the /api/*.js serverless functions through Vite's
// middleware so `npm run dev` mirrors the Vercel runtime (no `vercel dev`
// required). Production uses Vercel's real serverless functions.
function devApi(env) {
  // Expose loaded env vars to the Node process for the handlers.
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  // This plugin only ever runs inside `vite dev`, so it is the one honest signal that
  // we are NOT the production server. `registerTracking` reads it to refuse writes to
  // the live 17TRACK account (api/_lib/tracking.js explains why). Set after the loop on
  // purpose: a stray APP_ENV in .env must not be able to claim this is production.
  process.env.APP_ENV = 'dev';

  return {
    name: 'dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/')) return next();

        const route = req.url.split('?')[0].replace(/\/+$/, '');
        const file = path.join(apiDir, `${route.slice(1)}.js`);

        try {
          const mod = await server.ssrLoadModule(file);
          const handler = mod.default;
          if (typeof handler !== 'function') return next();
          await handler(req, res);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[dev-api] ${route}:`, err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: 'Dev API error.' }));
          }
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ''); // load all vars (no VITE_ prefix filter)
  return {
    plugins: [react(), devApi(env)],
    // NOTE (security): the Vite DEV server can serve project source (e.g.
    // /api/../server.mjs) via path traversal — dev-only, dotfiles/.env are blocked,
    // and prod (server.mjs) has its own traversal guard. Mitigation: never bind the
    // dev server to a non-localhost interface / expose it publicly.
    server: { port: 5173, allowedHosts: true },
  };
});
