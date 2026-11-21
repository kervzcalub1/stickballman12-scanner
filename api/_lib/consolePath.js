// Railway console: keep `npm` / `node` on the PATH of a login shell.
//
// Railway's web Console opens a LOGIN shell (`-bash`). A login shell runs /etc/profile,
// which resets PATH to the system default and drops the folders Railpack puts Node in
// (/mise/shims, /mise/installs/node/<v>/bin). So `npm run db:setup` answered
// "npm: command not found" from Nov 2026 on, while the app itself (and `railway ssh
// -- <cmd>`, a plain shell) still had them. /etc/profile does source /etc/profile.d/*.sh,
// so on boot we write one file there that puts the app's own Node folders back.
//
// Written at runtime, not at build: the console attaches to the RUNNING container, and
// every deploy starts a fresh one, so each boot rewrites it. Best-effort and Railway-only
// — a failure here must never stop the server (docs/context/deploy.md).
import fs from 'node:fs';
import path from 'node:path';

export function ensureConsolePath({ env = process.env, execPath = process.execPath } = {}) {
  if (!env.RAILWAY_ENVIRONMENT && !env.RAILWAY_DEPLOYMENT_ID) return false;
  try {
    const dirs = [
      path.dirname(execPath),             // the node (and npm) this server runs on
      '/mise/shims',
      path.join(process.cwd(), 'node_modules', '.bin'),
    ].filter((d, i, a) => d && a.indexOf(d) === i && fs.existsSync(d));
    if (!dirs.length || !fs.existsSync('/etc/profile.d')) return false;
    const body = '# Written by server.mjs on boot (api/_lib/consolePath.js): npm/node in the Railway console.\n'
      + `export PATH="${dirs.join(':')}:$PATH"\n`;
    fs.writeFileSync('/etc/profile.d/zz-app-node-path.sh', body, { mode: 0o644 });
    return true;
  } catch (e) {
    console.warn('[console-path] could not write /etc/profile.d:', e.message);
    return false;
  }
}
