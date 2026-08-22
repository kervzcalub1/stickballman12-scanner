# Alex Head — the app-wide advisor

Button + panel: `src/components/Advisor.jsx`, mounted **once** beside the router
(`App.jsx`, `withAdvisor`). Screen context: `src/lib/advisorContext.js`. Endpoint:
`api/advisor/ask.js`. E2E: `e2e/advisor.spec.js`.

The advisor is named **Alex Head** (`ADVISOR_NAME` in `src/lib/advisorContext.js` — one
constant, read by the panel *and* written into the system prompt, so the label and the
model's self-description can't diverge).

⚠️ **The admin account is also called Alex** (`admin` / name "Alex"). The identity line
in the prompt is explicit about which is which — *"you are Alex Head and they are not"* —
because otherwise the model has two Alexes in front of it and picks wrong.

A floating button on every **staff** screen. It answers two different kinds of question,
which is why it isn't bolted to one page:

- **"Is this pair worth buying?"** — needs the screen you're standing on.
- **"How do I shelve a pair with no box?"** — needs our written procedures.
- **"What needs doing today?" / "Where is this VIN?"** — needs our database.

## Where it appears, and where it must not
`withAdvisor(...)` wraps every staff return in `App.jsx` (all 23 view routes, both PH
shells, and Home). It is deliberately **absent** from the three returns above it: `Auth`
and the forced password change are pre-auth, and the **supplier portal is a different
app with none of this data in it**. `api/advisor/ask.js` is gated
`['warehouse','ph_team']` (admin/superadmin auto-allowed) — suppliers are excluded on
both sides, and a test signs in as one to prove the button isn't there.

## Screen context
A screen opts in with `useAdvisorContext(() => ({...}), [deps])`. It's a **module-level
slot, not React context** — the advisor is mounted *outside* the router while the thing
it describes is rendered *inside* it, so a provider would mean wrapping every screen.

- Publish plain values (`finalCost: 83.16`), not React elements — the server renders
  this into prose for the prompt.
- The hook **clears the context on unmount**. A stale context is worse than none: the
  advisor would answer confidently about a shoe you navigated away from.
- Context is read at **ask** time, not when the panel opened — someone types a cost,
  *then* asks.
- Today only the Payout Calculator publishes. Every other screen still gets a working
  advisor, because the server can look things up itself.

## The five tools — all reads
| Tool | Answers | Source |
|---|---|---|
| `sku_history` | "have we sold this before, and what did we pay?" | `advisorSkuHistory` (db.js) |
| `find_stock` | "do we have it, and which shelf?" | `findStockByCode` |
| `pending_work` | "what are we behind on?" | `pendingCounts` |
| `search_sop` | "how do I…?" / "what's the rule about…?" | `searchSop` (lib/sop) |
| `market_price` | "what's it worth right now?" | Alias + StockX |

- **Read-only is structural, not a promise.** All five are existing queries; nothing here
  can write. The prompt tells it to name the screen that does the job instead.
- **`search_sop` is role-scoped** through `sopRoleForAccount` — the same rule the `/sop`
  screen applies. That helper was moved *into* `src/lib/sop/index.js` precisely so the
  screen and the advisor can't drift: a warehouse account can't reach the PH team's
  procedures by asking nicely.
- **`MAX_TOOL_HOPS = 4`**, and the last hop drops the tools entirely — that forces an
  answer rather than a fifth lookup the user is still waiting on.
- Tool results are trimmed before they enter the prompt (25 pairs, 3 SOP hits, 14 steps).

## The prompt
Identity, the live screen, the rules, then how to answer. The rules are **injected**:
fee defaults and the Buy/Watch/Pass thresholds come from `src/lib/payout.js`, the same
module the calculator computes with, so the advisor cannot quote a threshold the screen
disagrees with. Two guardrails worth keeping:

- *"If a lookup comes back empty, say so plainly"* — a made-up shelf number sends someone
  to the wrong aisle, and an invented procedure is worse: it reads exactly like a real one.
- *"For 'how do I' questions, search_sop FIRST"* — a generally sensible warehouse process
  that isn't ours is a wrong answer.

## It's a thread, not a form
The panel reads like a messaging app: his replies on the left behind an **AH** avatar,
yours on the right, each stamped with `estClock` — **EST to the minute**, like every
other time in this app (seconds are noise in a chat; `estTime` still exists for the
grids that want them). Typing dots run while he's calling a tool, because a lookup takes
a few seconds and a frozen panel reads as broken.

**The conversation survives navigation.** The advisor is mounted beside the router, so
moving between screens keeps one thread — "which of those should I do first?" works
against the answer he gave you two screens ago. It does *not* survive a reload, and
deliberately: a stale thread costs tokens on every turn and is rarely what anyone wants
back. **Clear** empties it on demand.

## Rendering
Assistant replies are markdown-lite — `**bold**` and `` `code` `` — rendered as **React
elements, never HTML**. `dangerouslySetInnerHTML` here would be an XSS hole wearing a
formatting hat: the advisor quotes strings from Alias, StockX, our database and our SOPs.
What the *user* typed renders literally. Both are tested.

## Failure modes, kept distinct
- **No `OPENAI_API_KEY`** → 503 → the panel retires itself with the server's message. It
  is a setup fact, not a failed question, so it leaves no error bubble inviting a retry
  that cannot work.
- **Upstream failure** → an error bubble, with the question kept so it can be retried.
- Neither is ever dressed up as advice.

## Model and cost
`PAYOUT_AI_MODEL` (default `gpt-5.4-mini`) on `OPENAI_API_KEY` — the key already here for
SOP narration. Rate-limited to **12 questions/min**, 20 turns of history, 4,000 chars a
message. A tool-using question costs 2–3 upstream calls, so it is throttled harder than
the price lookups. Moving to Claude means an `ANTHROPIC_API_KEY` and a different call
shape; the model pin already accommodates the swap.

**Verified live**: *"how do I shelve a pair that came with no box?"* → `search_sop` →
answered from our own articles with the real navigation path. *"what needs doing today?"*
→ `pending_work` → 400 needing shelving, 64 no-box, 11 awaiting shipment, 10 missing
cost, 1 PO to reconcile — every figure matching `pendingCounts()` exactly.
