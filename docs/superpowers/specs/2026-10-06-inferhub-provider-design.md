# InferHub provider extension for pi — design

Date: 2026-10-06
Status: approved design, pre-plan
Repo: `~/repos/pi-inferhub` (fresh, main has no commits)

## Purpose

A pi provider extension exposing the user's [InferHub](https://inferhub.dev)
**combos** as selectable chat models. InferHub pools AI subscriptions into one
OpenAI-compatible endpoint; combos are the user's primary consumption surface:
each `combo/<slug>` is a server-side routed, failover, cache-sticky bundle of
upstream models billed in USDC.

Scope is deliberately narrow: **basic inference + catalog only.** No MCP, no
publisher/marketplace, no billing or budget management, no image/video
generation, no status widgets.

## API surface facts (verified against https://inferhub.dev/api/openapi.json)

- **Inference**: `https://api.inferhub.dev` — OpenAI (`/v1/chat/completions`)
  and Anthropic (`/v1/messages`) compatible, both streamable, Go proxy. Auth:
  `Authorization: Bearer sk-airo-…` (Anthropic-style `x-api-key` also
  accepted). Rate limit: 500 req/min per account, `X-RateLimit-*` headers,
  OpenAI/Anthropic-shaped 429s with `Retry-After`.
- **Management API**: `https://inferhub.dev/api` — same `sk-airo-` key, Bearer
  header. Rate limit: 30 req/min per account (shared with MCP). Errors:
  `{"error":{"code","message"}}`; suspended/banned accounts return 403
  `account_blocked` on every endpoint.
- **`GET /v1/models`** (inference surface, auth required): returns
  `prefix/model` ids, bare aliases, `free/<slug>/<model>`, and image models —
  but **combos do not appear**. Model items carry: `id`, `supports_cache`,
  `modality` (e.g. `"text"` or `"text,image"`), `output_modality`,
  `input_token_limit`, `max_output_tokens`, `reasoning_levels` (e.g.
  `["low","medium","high"]`), `upstream_label`, and a `pricing` object
  (`official_in`/`official_out` required; `min_ask_in`/`min_ask_out` when
  supplied by the marketplace). Pricing omitted for aliases.
- **`GET /combos`** (management surface): the account's combos. Each has:
  `id` (uuid), `name`, `slug`, `maxInputPerMtok`/`maxOutputPerMtok` (decimal
  string $/Mtok caps, or `null` = unlimited), `selection`
  (`order|cheapest|fastest|balanced|reliable`), performance filters
  (`maxTtftMs`, `minTps`, `minSuccessPct`), `sticky` (bool), `members[]`.
  Member kinds:
  - `{"kind":"model", modelId: uuid, model: "<prefix>/<upstream_model_id>",
    label}` — resolvable against the catalog.
  - `{"kind":"alias", alias: "<bare-name>"}` — auto-routed alias, **no**
    catalog linkage, no pricing.
- **`GET /catalog`** (management surface): upstreams (`prefix`, `slug`,
  `label`, enabled flags, `systemPromptNote`) each with `models[]` keyed by
  `upstreamModelId` and carrying `officialIn`/`officialOut` (decimal strings,
  USD per Mtok), `asksIn`/`asksOut`, `supportsCache`, `cacheHitRate`, and
  enabled/disabled flags. **Not used by the extension**: it lacks the
  capability fields (`reasoning_levels`, input/output limits, modality) the
  mapping needs — those come from `GET /v1/models`, which carries the same
  official rates in numeric form.
- **Money**: USDC decimal strings on the management surface; inference reports
  per-request consumer cost as `usage.cost` in USD (OpenRouter convention),
  with a $0.00001 minimum charge on billed requests.

## Approach

Register one provider via pi-ai's `createProvider` with
`api: openAICompletionsApi()`. Every combo streams through
`https://api.inferhub.dev/v1/chat/completions` — InferHub's proxy translates
to every upstream family server-side, so pi's built-in OpenAI Chat Completions
implementation owns message conversion, tool handling, streaming, usage,
cancellation, and retry semantics. **No custom `streamSimple`.**

The Anthropic-native surface (`/v1/messages`) is intentionally unused in v1:
the OpenAI surface is InferHub's primary advertised interface and combos are
upstream-agnostic from the client's perspective.

### Auth

- `envApiKeyAuth("InferHub API key", ["INFERHUB_API_KEY"])`.
- A `/login inferhub` OAuth-less flow: prompt for the `sk-airo-…` key,
  validate it against `GET https://inferhub.dev/api/me` (401 → re-prompt),
  then hand it to pi's credential store (`auth.json`). Env remains the
  no-stored-credential fallback.

### Catalog (`refreshModels`)

`fetchComboCatalog({ signal, token })` makes two authenticated GETs (well
under every rate budget):

1. `GET /combos` (management surface) — the account's combos, order preserved.
2. `GET /v1/models` (inference surface) — per-model metadata used for member
   joins: `reasoning_levels`, `input_token_limit`, `max_output_tokens`,
   `modality`, and `pricing.official_in/out` (same official rates as the
   management `/catalog` endpoint, in numeric form; `/catalog` itself is not
   called — it lacks the capability fields the mapping needs).

Each combo becomes exactly one `Model<"openai-completions">`:

- `id = "combo/" + slug` (the routable inference name; bare-name aliases are
  not exposed).
- `name` = combo `name` (fallback: slug when name is empty).
- `reasoning` = any resolvable member advertises non-empty
  `reasoning_levels`; `thinkingLevelMap` maps pi's thinking levels onto the
  advertised levels.
- `contextWindow` = min of resolvable members' `input_token_limit`;
  `maxTokens` = min of their `max_output_tokens`. pi-ai's `Model` type
  requires both as numbers, so when no resolvable member supplies a field,
  conservative fallback constants apply (`CONTEXT_WINDOW_FALLBACK = 128_000`,
  `MAX_TOKENS_FALLBACK = 8_192`) rather than a guess at the model's ceiling.
- `input` = `["text", "image"]` only when **every** resolvable member's
  `modality` includes image; otherwise `["text"]`. A combo is only as
  multimodal as its weakest member.
- `cost` = per-direction min of resolvable members' `pricing.official_in`/
  `official_out`. This is a conservative estimate: InferHub bills consumer
  requests at a discount below official list, so real `usage.cost` will
  typically come in at or under this number. Never fabricate a cache-write
  price: `cacheRead`/`cacheWrite` = 0 unless the catalog supplies them.
- Combo-level metadata (`maxInputPerMtok`, `maxOutputPerMtok`, `selection`,
  filters, `sticky`, members) is **extension-owned state only** — it is not
  placed on the pi-ai `Model` object (reserved-key play-safe ruling).
- `supports_cache`: not forwarded as a Model field; pi's cache-warming knobs
  (`promptCache.short/long`) stay unset in v1.

**Alias-member fallback:** alias members cannot be joined to `/v1/models`.
They are skipped for pricing/feature derivation. If a combo's resolvable
(model-kind) member set is empty, expose it with safe defaults: `input:
["text"]`, `reasoning: true` (aliases typically route to reasoning-capable
models; a false negative would hide thinking levels, a false positive merely
shows an inert knob), no cost, and the conservative fallback limits.

**Disabled/upstream-absent members:** catalog entries whose upstream is
`upstreamDisabled` or missing still count for joins (the combo may still
route); their pricing/feature data is used like any other member. The combo
either works or 4xx/5xxs at request time — pi shows the provider error.

### Refresh semantics

- `fetchModels` fetches and returns the combo `Model[]` (complete-`Provider`
  contract, per the pi-hyper-provider pattern: pi composes the returned list
  over the registered provider and handles persistence requests).
- No persistence of the catalog across runs: pi starts, the user picks a
  combo, refresh happens on demand. Combos change on the server; a stale
  snapshot is worse than an explicit refresh. (YAGNI: no offline snapshot.)
- Refresh errors surface as provider error strings via pi's normal
  model-picker refresh path. Do not swallow 401/403: surface
  `account_blocked` verbatim — its message carries the ban reason.

### Layout

```
~/repos/pi-inferhub/
  package.json          # name pi-inferhub, type module, pi.extensions: ["./src/index.ts"]
  tsconfig.json
  src/
    index.ts            # extension factory: registerProvider + /login inferhub
    auth.ts             # env auth + login flow (prompt → validate via GET /me → store)
    inferhub.ts         # constants: INFERENCE_BASE_URL, MGMT_BASE_URL, PROVIDER_NAME
    catalog.ts          # fetchComboCatalog: /combos + /catalog → Model[]
    http.ts             # fetchJson helper: Bearer, AbortSignal, UA string
  test/
    catalog.test.ts     # mapping fixtures (see Testing)
    auth.test.ts
```

Streaming delegation imports `openAICompletionsApi` from
`@earendil-works/pi-ai/compat` (per the pi-hyper-provider pattern — pi's
extension loader does not virtualize lazy API implementation subpaths).
Dependencies stay at `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`
(types), `typebox` + `typebox/compile` for response validation, vitest for
tests. Distribution: npm package; loaded via `npm:pi-inferhub` in
`~/.pi/agent/settings.json` packages.

## Error handling

- Inference errors: pi-native via the built-in OpenAI implementation (429 +
  `Retry-After`, transient retries, context overflow recognition).
- Catalog refresh: any non-2xx surfaces an error message; HTTP 403 with
  `account_blocked` passes the upstream message through; network failure is
  reported, never silently cached.
- Empty catalog (zero combos): valid state — provider registers with zero
  models; pi renders an empty model list rather than erroring.

## Testing

Vitest unit tests over fixture JSON shaped exactly like the documented
endpoint responses:

- combo → model mapping: `id`/`name`, order preservation, slug fallback for
  empty names.
- feature derivation: min context/output across members; image-input rule
  (all-members-image vs one-text-member); reasoning derivation.
- cost derivation: min official across members; zero-cost when no resolvable
  members; alias-only combo fallback defaults.
- member kinds: model-kind join success; alias members skipped; empty
  resolvable set.
- malformed/edge payloads: missing `pricing`, `null` caps, missing optional
  fields (via typebox validation).
- auth: validation flow logic (401 → reprompt, success → store); env fallback.
- HTTP helper: abort signal honored, UA header present.

Live smoke (manual, end of implementation): register provider, refresh
catalog against the real account, one cheap echo request on a cheap combo,
confirm `usage.cost` lands in pi's usage accounting.

## Explicitly out of scope (v1)

- Anthropic `/v1/messages` surface, image/video generation endpoints, free
  tier, bare aliases, prefix models as pi models.
- Combo management (create/update/delete via management API), budgets, usage
  dashboards, status widgets, credit/balance notifications.
- Catalog persistence, cache-warming configuration, background refresh.
