import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const apiDir = path.dirname(fileURLToPath(import.meta.url));

// Dev-only plugin: serve the /api/*.js serverless functions through Vite's
// middleware so `npm run dev` mirrors the Vercel runtime (no `vercel dev`
// required). Production uses Vercel's real serverless functions.
function devApi(env) {
  // Expose loaded env vars to the Node process for the handlers.
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }

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
    server: { port: 5173, allowedHosts: true },
  };
});
