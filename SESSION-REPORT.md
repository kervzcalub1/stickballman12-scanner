# Session report — Tue 9 Sep 2026 (EST)

The gift-card buying screens, from three screenshots to a feature the floor can
actually use. Six commits on `feat/gift-card-buying`, all pushed.

**Two bugs were found by fixing something else**, and both were worse than the thing
that surfaced them: a preview link that would have written to a live 17TRACK account,
and a buy call that priced a made-up style code off an unrelated shoe.

| Where | State |
|---|---|
| `feat/gift-card-buying` ([PR #188](https://github.com/kervzcalub1/stickballman12-scanner/pull/188)) | 6 new commits **pushed**; 24/24 e2e locally; **CI green** (run 34292952619) |
| `main` | Untouched today |
| Prod | Untouched today. **No `db:setup` needed** for any of this |

---

# PART ONE — "fix UI"

A screenshot of the buying-requests list, columns jammed against each other.

**`.table` had no CSS rule anywhere in `styles.css`.** All four buy-cart tables shipped
against a class that does not exist, so they rendered as bare browser tables: no cell
padding, no row rules, columns collapsed onto their content.

That is also the answer to the second screenshot — *"why call status is pending?"*.
`Call` and `Status` are **two columns**, and unstyled they ran together into one heading
that read "Call Status". So a blank buy call looked like a request whose *status* was the
word Pending, sitting in the wrong place.

Defined `.table` the same shape as `.inv-table` (which every other table in the app
uses), plus a `.num` class so money lines up on the decimal. The two headings are now
**Buy call** and **Approval** so they cannot merge again.

---

# PART TWO — "$0.00 · 0.0% via —" was a lie

The line said a pair was worth nothing. Nobody had priced it.

`api/cart/line.js` decided whether a field was supplied with
`Number.isFinite(Number(v))` — and **`Number(null)` is `0`**. So every line added
without a market price stored `profit = 0, roi = 0`.

A stored zero is a **claim**. Nothing downstream can tell it back apart from a gap, and
an approver reads "we priced this and it's worthless" instead of "nobody priced this".

> This is the **second** time this exact coercion has bitten. In August a blank cost box
> at receiving saved as `$0` (`Number('') === 0`) and hid 73 rows behind 10 visible ones.
> The rule now written down: in this codebase, "is it a number" is never the right test
> for "was it supplied". Test for absence **first**, then coerce.

---

# PART THREE — costs somebody can actually state

The brief: *"if supplier did not enter costs then let the approver and auditor enter it
instead… but we need logs to document everything."*

**Why it was empty in the first place.** A request's cost stack is snapshotted from the
buyer's **payout preset**, and buyers do not manage their own presets — an admin does.
So a buyer who was never given one opens a request where every pair "lands at" its shelf
price, no payout clears any threshold, and no buy call can be made at all. That is not an
edge case; it is what every new buyer's first request looks like.

### The correction, and it mattered

I built it approver/auditor-only, reasoning separation of duties. **Wrong reading of the
brief** — *"if supplier did not enter costs… let the approver and auditor enter it
**instead**"* makes the buyer the primary enterer. Confirmed directly when asked.

Now: **the buyer writes it, either desk can overwrite it.**

What makes that safe is **the trail, not the lock**. A buyer could set a flattering
stack; the approver overwrites it, and `buy_cart_events` holds both versions under the
names that set them — so a favourable number is visible *as the buyer's*, beside what the
approver replaced it with.

### What shipped

- **What a pair costs us** card above the lines: store %, promo %, gift card %,
  cashback %, tax %, tip $, shipping $.
- **The chip IS the field.** Tap a rate, type over it, Enter. A rate is corrected one at
  a time far more often than seven at a time. *Edit all seven* remains for stating a
  whole stack from nothing.
- Saving **re-prices every line** against the new rates — using the market prices already
  captured, never re-reading the market.
- **Correcting a line after submission** (size / qty / shelf price) is desk-only, and
  shelf prices **freeze at `funded`** — that is the number the gift cards were issued
  against.
- Every write lands in the history in words: `Store discount 0% → 20% · Sales tax 0% →
  8.25% · Shipping $0.00 → $12.00 — 1 line re-priced`, with the actor's name.

> **The UI trap worth keeping.** Enter commits *and* disables the input — and disabling a
> focused element **blurs** it, firing the blur handler into a second identical write.
> Guarded with a `useRef`, not the `busy` state: the blur arrives during React's commit,
> before any re-rendered handler could see it.

---

# PART FOUR — "why buy call is not priced? show decision like in the payout calculator"

The line had `alias_price` and `stockx_price` stored as **0** — the market lookup came
back empty when the buyer added it. The shoe prices fine now (Alias $133, StockX $97), so
it was a bad minute, not a bad SKU.

**A line now opens** to the Payout Calculator's own verdict card: chip, "lands at $62.19
a pair · $57.64 profit · 92.7% ROI via Alias", risk band, the calculator's sentence, and
the market prices with the date they were quoted. Same shape and same words, because one
call read in two places must not look like two tools' opinions. The **numbers** come off
the stored snapshot; only the **prose** is re-derived.

**`cart/price-line`** re-reads the market for a pair that never got a call. Explicit and
named, never automatic — an approver who re-prices has chosen to look at today's market
instead of the buyer's, and `line_priced` says so with the prices found and what the call
was before.

That line is now **BUY · $57.64 · 92.7% ROI · medium risk**.

---

# PART FIVE — the two bugs found by fixing the above

### 1 · The tunnel ran with the 17TRACK guard OFF

You chose Cloudflare tunnel over a Railway staging service. Before handing you the
command I checked it, and found this:

`vite.config.js` forces `APP_ENV=dev` so a dev server can never claim to be production.
**`scripts/mobile-preview.mjs` never did** — and it is the script that publishes this
machine on a *public URL*. It spawns `server.mjs`, the entrypoint production runs, which
deliberately never sets `APP_ENV`. So the preview inherited a bare environment and looked
like production to every guard keyed on it.

A teammate handed a tunnel link, clicking through a purchase order, would have registered
invented tracking numbers with the real, quota-limited 17TRACK account. **That is the
exact leak the guard was added for** after it happened once from a dev server — 50 numbers
in a week — and the preview path walked around it.

Fixed: `APP_ENV: 'dev'` is forced, and `ENV_LABEL` defaults so a published link carries a
"not production" bar.

> **The lesson:** the guard lives on `APP_ENV`, and only `vite.config.js` was setting it.
> Any *new* way of running this app — a preview script, a staging service, a container —
> has to set it too, or it silently opts out.

### 2 · A made-up style code priced as a confident BUY

CI went red: my `price-line` test asserted a stored event, which only exists when an
upstream actually answers — and CI is hermetic with no Alias or StockX creds. It was a
test of somebody else's API being up. Both branches are asserted now.

**Probing that empty branch found the real bug.** StockX's catalogue search falls back to
its first result when nothing carries the style code, flagged `exact:false`. The
calculator shows that to a person who can read the title; `price-line` **stores** it as
the call an approval is judged on. Asked for `ZZ0000-999` — a code no shop has ever sold —
it answered **"$264, BUY"** off a Nike Vomero.

Refusing every inexact hit was the first fix and it was too blunt: StockX's styleId
formatting often differs from the code on the box, so the *right* shoe frequently comes
back inexact (`IO8116-600` does). **Corroboration decides instead:**

- Alias priced it too → the code is a real shoe and there is a second opinion beside it.
  Use the hit, record "matched by name".
- Alias found nothing → nothing says the code exists. **Refuse it, and name the shoe it
  nearly used** — which turns a wrong answer into "check what you typed".

---

# Also shipped

**A non-production banner.** `server.mjs` stamps `<meta name="sb-env">` into the HTML
shell when `ENV_LABEL` is set, and `main.jsx` turns it into a striped bar above every
screen, **sign-in included** — the moment somebody most needs to know whether the request
they are about to approve spends real money. Injected at serve time, so the same build can
be promoted between environments; unset (production) changes nothing.

The shell is now served by us and never by `express.static`, or the stamp would be
bypassable at `/` and `/index.html`. A banner with a URL that skips it is not a banner.

**A staging runbook** in `docs/context/deploy.md`, written for the Railway route you
decided against for now. It leads with the variables that must *differ* rather than the
Railway clicks, because the risk in a preview deployment is not the code — it is the side
effects that leave the building: 17TRACK registrations, the metered KicksDB quota, the
shared R2 bucket, the gift-card key.

---

# Where things stand

**Pushed, nothing merged.** Five commits on `feat/gift-card-buying`:

```
4af3f63  test(buy-cart): the no-market branch asserts nothing MOVED, not that it is blank
84cffc4  fix(buy-cart): a style code nothing carries must not price off the nearest shoe
512cf7f  fix(preview): the tunnel ran with the 17TRACK guard off
6502de2  docs(deploy): how to stand up a staging service without spending prod's quotas
fb38f3e  feat(deploy): a non-production deployment says so, before you sign in
6527adf  feat(buy-cart): costs somebody can state, and a call you can check
```

> **CI went red twice, both times on the same new test, and it was worth it.**
> Run 1: the test asserted a stored event that only exists when an upstream answers —
> CI is hermetic. Chasing that is what found the `ZZ0000-999 → "$264, BUY"` bug.
> Run 2: my rewritten no-market branch asserted `verdict` would be null, but the fixture
> line carries the buyer's own `verdict: 'buy'` and a lookup that finds nothing correctly
> writes **nothing**. It now asserts the line is *untouched*, which is the stronger claim:
> blanking a call the buyer legitimately made because an API was down would be worse than
> the zeros this endpoint exists to undo.

### Before merging
- **CI is green** on `4af3f63` (run 34292952619, 523 passed). Re-check with
  `gh pr checks 188` if anything else lands first — never merge on a red run.
- **Prod needs `BUY_GC_KEY`** and a `db:setup` for the buy-cart tables — that is the
  original PR #188 requirement and has not changed. **Nothing added today needs a
  migration**: `cost_stack` is already JSONB and `buy_cart_events.kind` is free text.

### To show the team now
```
ENV_LABEL='Buy-cart demo' npm run mobile:tunnel
```
Serves **your local database** on a public HTTPS URL. I deleted the six `probe` carts I
created, but BC-165 is now priced and BC-223 / BC-231 carry edited cost stacks. The
endpoints that are public by design (`/api/track`, `/api/get-price`) are public on that
hostname too — don't leave it running unattended.

### Loose ends
- `.env.staging.secrets` (gitignored) holds generated staging keys. **Delete it** unless
  you go the Railway route.
- `docs/context/buy-cart.md` and `docs/context/deploy.md` are both updated and committed.
