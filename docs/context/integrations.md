# External integrations

All third-party calls are server-side (`api/*`); browser only hits `/api/*`.

## Product lookup
- **UPC** (`api/upc-search.js`): **StockX primary** (keyless Railway proxy
  `/stockx-upc-search`) → **Alias fallback**. StockX → `source:'stockx'`, single
  `sizes:[size]`. Alias → `source:'alias'`, full size list + **gender**.
- **SKU** (`api/sku-search.js`): KicksDB `?display[variants]=true` →
  `source:'kicksdb'`, full size run. Allowed for warehouse + ph_team.
- Both return `{ name, sku, upc, image, brand, colorway, sizes[], gender, source }`.

## Alias client (`api/_lib/alias.js`)
- Shared: `aliasLogin, getAliasToken, clearAliasToken, looksLikeAuthFailure,
  aliasAuthed(fn), aliasPost(path,body)`.
- **Auto-relogin on 401**: `aliasAuthed` detects an auth failure, calls
  `aliasLogin()` (env `ALIAS_EMAIL` / `ALIAS_PASSWORD`), and retries once.
- ⚠️ Auto-relogin is **Alias-only — never StockX**.
- Uses the Railway bypass proxy (`bypass-alias-host-railway-alias.up.railway.app`,
  `/alias-login` + `/alias-upc-search`). Official alias.org API is **set aside**.

## Railway proxies
- StockX: separate keyless Railway host (no auto-relogin).
- Alias: the bypass proxy above.

## Env keys (server-side only; see `deploy.md`)
`KICKSDB_KEY, ALIAS_EMAIL, ALIAS_PASSWORD` (+ `ADMIN_PASSWORD, SESSION_SECRET,
DATABASE_URL`). Never hardcode; `.env` is git-ignored. Railway: use the
single-variable field and alphanumeric passwords (special chars get mangled).
