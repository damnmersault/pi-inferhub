# pi-inferhub

pi provider extension exposing the user's InferHub (https://inferhub.dev)
**combos** as selectable chat models. Combos are the product: the extension
never surfaces `prefix/model` upstream ids, bare aliases, `free/` tier
models, or images/video generation. Combos are `combo/<slug>` models routed
through InferHub's OpenAI-compatible inference surface; all failover,
serialization, and selection happens server-side.

Spec (binding design authority): `docs/superpowers/specs/2026-10-06-inferhub-provider-design.md`
Plan: `docs/superpowers/plans/2026-10-06-inferhub-provider.md`

## Architecture

Four modules, acyclic, one-directional:

```
src/inferhub.ts   constants only — PROVIDER_NAME="inferhub", PROVIDER_DISPLAY_NAME="InferHub",
                  INFERENCE_BASE_URL="https://api.inferhub.dev/v1", MGMT_BASE_URL="https://inferhub.dev/api"
src/http.ts    ← transport only — fetchJson (Bearer GET + typebox validation), InferhubHttpError{status,code,message}
src/auth.ts    ← loginInferhub (prompt → validate GET /me → store), inferhubApiKeyAuth (envApiKeyAuth)
src/catalog.ts ← fetchComboCatalog (Promise.all of the two GETs), pure combosToModels for tests
src/index.ts   ← default extension factory: createProvider registration + inferhub-login signpost command
```

No custom `streamSimple`. Everything streams through pi-ai's
`openAICompletionsApi()` (imported from `@earendil-works/pi-ai/compat` —
pi's extension loader does not virtualize lazy API subpaths). pi-ai owns
message conversion, tool handling, usage, cancellation, retries. Adding a
custom stream is a design-level decision, never a drive-by fix for an
upstream quirk.

## Wire contract (live-pinned 2026-10-07, verify before trusting)

- Auth: `Authorization: Bearer sk-airo-…` on BOTH surfaces.
- `GET MGMT_BASE_URL/combos` → **bare JSON array** of combos (id/name/slug/
  members[]; member kinds `model` with `model: "prefix/upstream_id"` and
  `alias` with bare name, no catalog linkage).
- `GET INFERENCE_BASE_URL/models` → `{object:"list", data:[...]}`; items
  carry `id, modality ("text" | "text,image"), input_token_limit,
  max_output_tokens, reasoning_levels, pricing.official_in/official_out`.
  Combos do NOT appear here — that is why refresh fetches /combos
  separately. `/v1/models` requires auth (401 unauthenticated).
- `GET MGMT_BASE_URL/me` → any JSON object; login validation endpoint.
- Management API rate limit 30 req/min/account; inference 500 req/min/account.
- Errors: `{"error":{"code","message"}}`; suspended/banned → 403
  `account_blocked` with the ban reason in `message`.
- Cost: inference responses report `usage.cost` USD (OpenRouter convention),
  $0.00001 minimum on billed requests. All management-surface money is USDC
  decimal strings.

## Invariants (breaking any of these is a reverted commit)

1. **Reserved-key play-safe**: combo-level metadata (maxInputPerMtok/
   maxOutputPerMtok caps, selection mode, filters, sticky, members) never
   rides on the pi-ai `Model` object. Mapped models carry exactly pi-ai
   `Model<"openai-completions">` fields.
2. **Cost honesty**: `cost.input/output` = per-direction MIN of resolvable
   members' `official` rates (conservative upper bound — InferHub bills
   discounts below official). `cost.cacheRead/cacheWrite` = 0 always —
   InferHub's /v1/models pricing carries no cache fields; never fabricate.
3. **Fallback constants**: `CONTEXT_WINDOW_FALLBACK = 128_000`,
   `MAX_TOKENS_FALLBACK = 8_192` — used when no resolvable member supplies
   the field. pi-ai's `Model` type requires both as numbers; never guess a
   model's ceiling other than via these constants.
4. **Image rule**: `input: ["text","image"]` only when ≥1 resolvable member
   AND every resolvable member's `modality` includes `image`. Understating
   input is acceptable; overstating sends requests the upstream rejects.
5. **Alias-member fallback**: empty resolvable set (alias-only combos, or
   all member joins missed) → `input:["text"]`, `reasoning:true`, zero
   cost, fallback limits. `reasoning:true` is deliberate: a false negative
   hides thinking levels (the worse error); a false positive shows an inert
   knob.
6. **thinkingLevelMap**: built from the union of resolvable members'
   `reasoning_levels`; each pi level (`minimal|low|medium|high|xhigh|max`)
   maps to itself when advertised, else `null`; `off:"off"`. Set only when
   `reasoning` is true. Alias-only/level-less combos OMIT the map entirely —
   an all-null map would hide every selectable level.
7. **No key leakage**: the API key appears ONLY in the Authorization header
   and pi's credential store (`auth.json` via pi's own store). Never log,
   print, or persist it anywhere else. Tests inject fetch mocks; a test
   asserting the header is fine, echoing the key in fixtures is not.
8. **Unconfigured = zero models, no network**: `fetchModels` returns `[]`
   and fetches nothing when auth resolves no key. pi-ai passes BOTH
   stored-credential and env-resolved keys as `context.credential`
   (verified in pi-ai 1.0.4 `dist/models.js` `resolveRefreshCredential`) —
   do not add a second key-resolution path.
9. **No cross-run catalog persistence**: refresh is always live. A stale
   combo snapshot silently serving the wrong routing is worse than an
   explicit refresh.

## Commands

```
npx vitest run        # full suite (18 tests, <2s)
npx tsc --noEmit      # typecheck
npm pack --dry-run    # inspect package contents before publishing
```

pi packs the extension from `package.json` `pi.extensions:
["./src/index.ts"]`. Local dev: `pi -e <repo path>`. Published install:
`npm:pi-inferhub` in `~/.pi/agent/settings.json` packages (NOT yet
	published npm:pi-inferhub (v0.1.1).

## Environment gotchas (learned the hard way)

- **Pi packages declare host modules as peerDependencies, never
  dependencies**: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
  `typebox` (and pi-tui if used) go in `peerDependencies` with `"*"` ranges;
  keep `dependencies` empty. Regular dependencies make pi's package installer
  warn about duplicate host-module copies — extensions must bind to the
  copies the pi host already loads. Mirror the same modules in
  `devDependencies` (with real version pins) for the repo's own
  tests/typecheck.

- **TypeScript 6.0.3**: tsconfig MUST carry `types: ["node"]` — TS 6 dropped
  automatic `@types/*` inclusion; without it `node:module`/`fetch`/`AbortSignal`
  don't resolve and `tsc --noEmit` fails.
- **typebox 1.3.36**: compiled validators are typed `Validator<TProperties,
  TSchema>` — pass the validator, not the schema, to `fetchJson`. Validation
  error detail lives on `instancePath` (there is no `path` field). Extra
  payload keys pass through by default; do NOT add
  `additionalProperties: false` to wire schemas.
- **Git signing**: fresh clones inherit `gpg.format=ssh` globally but need
  `git config user.signingkey ~/.ssh/michaelmacleod.id_ecdsa.pub` locally
  before the first commit fails.
- **pi-ai `AuthEvent`** is a union; non-info variants carry no `message`.
  Anything typing an interaction callback as `{type: string; message:
  string}` breaks under contravariance — use `{type: string; message?:
  string}`.
- **Live pinning of wire shapes is allowed and encouraged** when a shape is
  undocumented: run a free listing GET, pin the parsed envelope in a typebox
  validator, and leave a dated comment. Drift surfaces as
  `code: "schema_mismatch"` with `instancePath` — fail-loud by design.

## Testing conventions

- Typebox schemas live at module scope (`Compile(Type.Object({...}))`).
- Tabs, ESM with `.js` import specifiers, single-responsibility modules.
- Tests verify real behavior through public seams (`combosToModels` pure
  function; real `createProvider` refresh path in test/index.test.ts with
  injected `fetchImpl`). No seams into internals.
- Deleting a brief-verbatim test line, or "fixing" a failing test by editing
  the test to fit the code rather than the contract, is not allowed without
  naming the contract being violated.
