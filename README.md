# pi-inferhub

A [Pi](https://pi.dev) extension that registers the
[InferHub](https://inferhub.dev) inference provider with Pi, exposing your
InferHub **combos** as selectable chat models.

InferHub pools AI subscriptions behind one OpenAI-compatible endpoint. Combos
are its server-side routed bundles — failover, cache-sticky, billed in USDC —
and they are the primary consumption surface. This extension exposes **combos
only**: each combo on your account appears as exactly one model named
`combo/<slug>`. Upstream `prefix/model` entries, bare-name aliases, and
free-tier models from InferHub's model list are intentionally not exposed.

## Install

Add the package to your Pi settings:

```jsonc
// ~/.pi/agent/settings.json
{
	"packages": ["npm:pi-inferhub"]
}
```

or run `pi install npm:pi-inferhub`.

For local development against a checkout:

```sh
pi -e /path/to/pi-inferhub
```

## Auth

Either:

- set `INFERHUB_API_KEY` in your environment (`sk-airo-…`), or
- run `/login inferhub` and paste the key at the prompt.

`/login inferhub` prompts for the key (input is masked), validates it against
`GET https://inferhub.dev/api/me`, and only then hands it to Pi's credential
store (`auth.json`). A rejected key (HTTP 401) notifies you and re-prompts;
after **three failed attempts** the login aborts without storing anything.

When both exist, the stored credential wins; `INFERHUB_API_KEY` is the
fallback when nothing is stored.

`/inferhub-login` reports whether the provider is currently configured and
points you to `/login inferhub` if not.

## Model selection

Send `/model` and filter by provider name `inferhub` or by `combo/`. Each
model id is `combo/<slug>` — the routable inference name on
`https://api.inferhub.dev/v1`.

## Catalog derivation

On refresh the extension makes two authenticated GETs —
`GET https://inferhub.dev/api/combos` (the account's combos) and
`GET https://api.inferhub.dev/v1/models` (per-model metadata) — and maps each
combo to one model:

- **Context/output limits** — minimum across resolvable members
  (`input_token_limit` / `max_output_tokens`), so a combo is only as large as
  its smallest member. When no resolvable member supplies limits, conservative
  fallbacks apply: **128k context / 8k max output**.
- **Image input** — offered (`text` + `image`) only when *every* resolvable
  member's modality includes image; otherwise text-only.
- **Reasoning** — the combo is marked reasoning-capable when any resolvable
  member advertises `reasoning_levels`; Pi's thinking levels map onto the
  advertised ladder (levels a combo doesn't advertise are unavailable).
- **Cost** — per-direction minimum of resolvable members' *official* rates
  (see below). `cacheRead`/`cacheWrite` are shown as `0`: the catalog carries
  no per-combo cache pricing, and none is fabricated.

Combos whose members are all unresolvable aliases get safe defaults:
text-only, reasoning-capable, `0` cost, and the fallback limits.

## Refresh semantics

The catalog is fetched **on demand** via the provider's `fetchModels`; the
extension keeps no snapshot of its own. Every refresh hits both endpoints
live, so combos added, removed, or changed server-side appear on the next
refresh instead of being served stale. When no credential is configured the
refresh is a no-op returning an empty list — no unauthenticated upstream call
and no silent fake catalog.

> [!NOTE]
> Pi refreshes provider model catalogs in TUI and RPC modes; other
> non-interactive modes use the latest persisted catalog. Open the TUI to
> discover new combos.

## Cost estimates

The per-model cost is an **upper-bound estimate**: the cheapest resolvable
member's *official* list rates (`official_in` / `official_out`) per direction.
InferHub's marketplace bills below list, so the real `usage.cost` reported per
request comes in **at or under** the displayed estimate.

## Design rationale

The full design — why combos only, why `/v1/models` supplies member metadata
instead of the management `/catalog` endpoint, why the OpenAI completions
surface, and the conservative-defaults philosophy — is in the
[design spec](docs/superpowers/specs/2026-10-06-inferhub-provider-design.md).

## Development

```sh
npm install
npm test          # vitest
npm run typecheck
```

## License

MIT
