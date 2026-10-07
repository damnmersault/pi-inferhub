# InferHub pi provider extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pi provider extension that exposes the user's InferHub combos as selectable chat models over InferHub's OpenAI-compatible inference surface.

**Architecture:** One provider registered via pi-ai's `createProvider` with `api: openAICompletionsApi()` — no custom streaming. `fetchModels` merges `GET inferhub.dev/api/combos` (account combos) with `GET api.inferhub.dev/v1/models` (member capability/pricing metadata) into `Model<"openai-completions">` entries. Auth is `envApiKeyAuth(["INFERHUB_API_KEY"])` plus a `/login inferhub` prompt-validate-store flow.

**Tech Stack:** TypeScript (ESM), `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent` (types), `typebox/compile` for payload validation, vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-inferhub-provider-design.md`

## Global Constraints

- Provider name: `inferhub`. Constants: `INFERENCE_BASE_URL = "https://api.inferhub.dev/v1"`, `MGMT_BASE_URL = "https://inferhub.dev/api"`, `PROVIDER_NAME = "inferhub"`, `PROVIDER_DISPLAY_NAME = "InferHub"`.
- Fallback limits: `CONTEXT_WINDOW_FALLBACK = 128_000`, `MAX_TOKENS_FALLBACK = 8_192` (exact values from the spec).
- Model ids on the wire are `combo/<slug>`; bare-name aliases and `prefix/model` ids are never exposed as pi models.
- Combo-level metadata (caps, selection, filters, sticky, members) is never placed on the pi-ai `Model` object.
- `thinkingLevelMap` derives from each combo's resolvable members' union of `reasoning_levels` (see Task 3 for the exact rule).
- `cost`: `cacheRead`/`cacheWrite` are `0` unless a member supplies them (InferHub's `/v1/models` pricing has no cache fields — they stay 0).
- Empty catalog (zero combos) is a valid registration state: provider registers with zero models, no error.
- package.json: `name: "pi-inferhub"`, `"type": "module"`, `pi.extensions: ["./src/index.ts"]`; devDeps `vitest`, `typescript`, `@types/node`; deps `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`. Test command: `npx vitest run`. Typecheck: `npx tsc --noEmit`.
- HTTP helper contract: JSON-validated GET with Bearer auth, `AbortSignal` honored, `User-Agent: pi-inferhub/<version>`.
- Payload validation philosophy: typebox schemas validate shape and required fields; unknown extra fields pass through (no `additionalProperties: false`).
- Never log or persist the API key; `auth.ts` returns credentials to pi, never writes them anywhere else.

## Review Focus

1. **Member-join mismatch**: a combo member whose `model` string is absent from `/v1/models` (upstream vanished between the two GETs). Expected: that member is skipped silently for derivation; the combo still registers on remaining members; empty resolvable set → safe defaults (spec's alias-member fallback rule applies verbatim). Pinned by Task 3 tests.
2. **Reasoning-capable combo mapped to non-reasoning**: `reasoning: false` when every member lacks `reasoning_levels` — pi then hides thinking controls, and `reasoning_effort` is not sent. If wrong (true when unsupported), requests may 400 upstream. Pinned by Task 3.
3. **Image-capability overstatement**: `input: ["text","image"]` on a combo with a text-only member sends images the upstream rejects (worse than understating). Pinned by Task 3 (all-members rule).
4. **Alias-only combos**: member `{"kind":"alias"}` carries no `model`/`modelId` — indexing members by `model` string must not crash. Pinned by Task 3.
5. **403 `account_blocked` swallowing**: refresh must surface the ban reason verbatim, not a generic "refresh failed". Pinned by Task 1 (fetchJson error extraction preserves `error.code`/`error.message`); Task 5 step 4 exercises the no-credential path end to end.

---

### Task 1: Project scaffold + HTTP helper

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/inferhub.ts`
- Create: `src/http.ts`
- Test: `test/http.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `PROVIDER_NAME`, `PROVIDER_DISPLAY_NAME`, `INFERENCE_BASE_URL`, `MGMT_BASE_URL` from `src/inferhub.ts`; `fetchJson<T>(url: string, token: string, schema: TSchema, signal?: AbortSignal): Promise<T>` from `src/http.ts` (typebox-validated; throws `InferhubHttpError` with `status`, `code`, `message` on non-2xx).

- [ ] **Step 1: Write package.json, tsconfig, .gitignore**

package.json fields pinned by Global Constraints; tsconfig: `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `target: ES2022`, `strict: true`, `noEmit: true`, `skipLibCheck: true`. `.gitignore`: `node_modules/`.

- [ ] **Step 2: Write `src/inferhub.ts` with the four constants**

```ts
export const PROVIDER_NAME = "inferhub";
export const PROVIDER_DISPLAY_NAME = "InferHub";
export const INFERENCE_BASE_URL = "https://api.inferhub.dev/v1";
export const MGMT_BASE_URL = "https://inferhub.dev/api";
```

- [ ] **Step 3: Write the failing tests for `fetchJson`**

```ts
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { fetchJson, InferhubHttpError } from "../src/http.js";

const Payload = Type.Object({ object: Type.String() });
const Validator = Compile(Payload);

function respond(status: number, body: string, headers: Record<string, string> = {}): Response {
	const h = new Headers({ "content-type": "application/json", ...headers });
	return new Response(body, { status, headers: h });
}

describe("fetchJson", () => {
	it("sends bearer auth and user agent, parses and validates JSON", async () => {
		const fetchMock = vi.fn(async () => respond(200, JSON.stringify({ object: "list" })));
		const result = await fetchJson("https://x/y", "sk-test", Validator, undefined, { fetchImpl: fetchMock as typeof fetch });
		expect(result).toEqual({ object: "list" });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://x/y");
		expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
		expect((init.headers as Record<string, string>)["User-Agent"]).toMatch(/^pi-inferhub\//);
	});

	it("throws InferhubHttpError with parsed code/message on error JSON", async () => {
		const fetchMock = vi.fn(async () => respond(403, JSON.stringify({ error: { code: "account_blocked", message: "banned: reason" } })));
		await expect(fetchJson("https://x/y", "k", Validator, undefined, { fetchImpl: fetchMock as typeof fetch }))
			.rejects.toMatchObject({ status: 403, code: "account_blocked", message: "banned: reason" });
	});

	it("aborts via signal and surfaces non-JSON error bodies as raw text", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			controller.abort();
			throw new DOMException("aborted", "AbortError");
		});
		await expect(fetchJson("https://x/y", "k", Validator, controller.signal, { fetchImpl: fetchMock as typeof fetch }))
			.rejects.toMatchObject({ name: "AbortError" });
		const fetchMock2 = vi.fn(async () => respond(500, "<html>oops</html>"));
		await expect(fetchJson("https://x/y", "k", Validator, undefined, { fetchImpl: fetchMock2 as typeof fetch }))
			.rejects.toMatchObject({ status: 500, code: "http_500" });
	});
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/http.test.ts`
Expected: FAIL — `src/http.js` does not exist.

- [ ] **Step 5: Implement `src/http.ts`**

`fetchJson<T>(url, token, schema, signal?, opts?)` where `opts: { fetchImpl?: typeof fetch }` is an injectable fetch for tests (default `globalThis.fetch`). Sends `Authorization: Bearer <token>`, `User-Agent: pi-inferhub/<version from package.json via createRequire>`, `Accept: application/json`. Non-2xx: parse body as JSON; extract `error.code`/`error.message` when present (OpenAI-style `{error:{message}}` without `code` → `code: "unknown"`), else raw text with `code: "http_<status>"`; throw `InferhubHttpError extends Error` with `status`, `code`, `message`. On 2xx: `schema.Decode`/validate, rethrow typebox validation failures as `InferhubHttpError` with `status: response.status`, `code: "schema_mismatch"`, and the validator's error text as `message`. Abort errors propagate untouched.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/http.test.ts`
Expected: PASS

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add package.json tsconfig.json .gitignore src/inferhub.ts src/http.ts test/http.test.ts
git commit -m "feat: scaffold + bearer fetchJson helper"
```

### Task 2: Auth — env resolution + `/login inferhub`

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- Consumes: `MGMT_BASE_URL` (Task 1), `fetchJson` (Task 1), pi-ai's `envApiKeyAuth` from `@earendil-works/pi-ai/compat`.
- Produces: `loginInferhub(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential>` — prompt for the key (`secret` prompt, placeholder `sk-airo-…`), validate via `GET MGMT_BASE_URL + "/me"` (401 → notify + re-prompt, max 3 attempts then throw), return `{ type: "api_key", key }`. Validation uses an injectable fetch (`opts` param, same pattern as `fetchJson`). Also re-exports `envApiKeyAuth("InferHub API key", ["INFERHUB_API_KEY"])` as `inferhubApiKeyAuth`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { loginInferhub } from "../src/auth.js";

function interaction(responses: string[], notified: string[] = []) {
	let i = 0;
	return {
		signal: new AbortController().signal,
		prompt: vi.fn(async () => {
			const v = responses[i++];
			if (v === undefined) throw new Error("prompt exhausted");
			return v;
		}),
		notify: (e: { type: string; message: string }) => notified.push(`${e.type}: ${e.message}`),
	};
}

describe("loginInferhub", () => {
	it("validates the key against /me and returns an api_key credential", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
			new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
		const result = await loginInferhub(interaction(["sk-airo-abc"]), { fetchImpl: fetchMock as typeof fetch });
		expect(result).toEqual({ type: "api_key", key: "sk-airo-abc" });
		expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-airo-abc");
	});

	it("re-prompts after a 401 and notifies, up to 3 attempts", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "bad key" } }), { status: 401 }));
		const notified: string[] = [];
		const result = await loginInferhub(interaction(["sk-bad", "sk-bad", "sk-airo-good"], notified), { fetchImpl: fetchMock as typeof fetch });
		expect(result.key).toBe("sk-airo-good");
		expect(notified.some((n) => n.startsWith("info:"))).toBe(true);
	});

	it("throws after 3 failed attempts", async () => {
		const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
		await expect(loginInferhub(interaction(["a", "b", "c"]), { fetchImpl: fetchMock as typeof fetch })).rejects.toThrow(/three/);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/auth.test.ts`
Expected: FAIL — `src/auth.js` does not exist.

- [ ] **Step 3: Implement `src/auth.ts`**

`loginInferhub(interaction, opts?)`: loop up to 3 attempts — `interaction.prompt({ type: "secret", message: "InferHub API key", placeholder: "sk-airo-…" })`; trim; `fetchJson(MGMT_BASE_URL + "/me", key, MeSchema, interaction.signal, opts)` where `MeSchema` accepts any object; on success return `{ type: "api_key", key }`; on `InferhubHttpError` with `status: 401`: `interaction.notify({ type: "info", message: "Key rejected (401). Check the key and try again." })`, continue; on 3rd failure throw `new Error("InferHub login failed after three attempts")`. Re-export `inferhubApiKeyAuth = envApiKeyAuth("InferHub API key", ["INFERHUB_API_KEY"])`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/auth.ts test/auth.test.ts
git commit -m "feat: /login inferhub prompt-validate flow"
```

### Task 3: Catalog — combo → Model mapping

**Files:**
- Create: `src/catalog.ts`
- Test: `test/catalog.test.ts`

**Interfaces:**
- Consumes: `INFERENCE_BASE_URL`, `MGMT_BASE_URL` (Task 1), `fetchJson` (Task 1).
- Produces:
  - `fetchComboCatalog(token: string, signal?: AbortSignal, opts?: { fetchImpl?: typeof fetch }): Promise<Model<"openai-completions">[]>` — GETs `MGMT_BASE_URL + "/combos"` and `INFERENCE_BASE_URL + "/models"`, maps combos to models (see mapping rules below).
  - `combosToModels(combos: Combo[], catalogModels: CatalogModel[]): Model<"openai-completions">[]` — pure mapping function, exported for direct unit testing.
  - Typebox schemas + exported TS types: `ComboSchema`/`Combo` (id, name, slug, members[]), `MemberSchema`/`Member` (`kind: "model"` with `model: string` | `kind: "alias"` with `alias: string`), `CatalogModelSchema`/`CatalogModel` (id, `modality?`, `input_token_limit?`, `max_output_tokens?`, `reasoning_levels?: string[]`, `pricing?: { official_in, official_out }`).

Mapping rules (verbatim from the spec):
- `id = "combo/" + slug`; `name` = combo `name`, falling back to `slug` when empty/whitespace.
- Resolvable member = member with `kind === "model"` whose `model` string matches a `CatalogModel.id`.
- `reasoning` = any resolvable member has non-empty `reasoning_levels`; `thinkingLevelMap` = built from the union of advertised levels across resolvable members.
- `contextWindow` = min of resolvable members' `input_token_limit` (where present), else `CONTEXT_WINDOW_FALLBACK = 128_000`; `maxTokens` = min of `max_output_tokens` (where present), else `MAX_TOKENS_FALLBACK = 8_192`.
- `input` = `["text", "image"]` only if every resolvable member's `modality` includes `image` (and there is ≥1 resolvable member); else `["text"]`.
- `cost` = per-direction min of resolvable members' `pricing.official_in`/`official_out`; `cacheRead`/`cacheWrite` = 0. If no resolvable member has pricing, `cost` = all-zeros.
- Empty resolvable set (alias-only or all-missed-joins): `input: ["text"]`, `reasoning: true`, `cost` zeros, fallback limits.
- Output order = input combo order; unknown extra payload fields pass validation.
- Every model also carries `api: "openai-completions"`, `provider: PROVIDER_NAME`, `baseUrl: INFERENCE_BASE_URL`, `reasoning` flag per above.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import type { CatalogModel, Combo } from "../src/catalog.js";
import { combosToModels } from "../src/catalog.js";
import { INFERENCE_BASE_URL, PROVIDER_NAME } from "../src/inferhub.js";

const base = {
	input_token_limit: 200_000,
	max_output_tokens: 32_000,
	modality: "text,image",
	reasoning_levels: ["low", "high"],
	pricing: { official_in: 3.0, official_out: 15.0 },
};

const catalog: CatalogModel[] = [
	{ id: "croc/glm-5.3", ...base },
	{ id: "ag/claude-opus", ...base, modality: "text", input_token_limit: 100_000, max_output_tokens: 16_000, pricing: { official_in: 1.0, official_out: 5.0 } },
];

const combo = (members: Combo["members"], overrides: Partial<Combo> = {}): Combo => ({
	id: "c1", name: "My Combo", slug: "my-combo", members, ...overrides,
});

describe("combosToModels", () => {
	it("maps id, name, provider, baseUrl, api", () => {
		const [m] = combosToModels([combo([{ kind: "model", model: "croc/glm-5.3" }])], catalog);
		expect(m.id).toBe("combo/my-combo");
		expect(m.name).toBe("My Combo");
		expect(m.provider).toBe(PROVIDER_NAME);
		expect(m.baseUrl).toBe(INFERENCE_BASE_URL);
		expect(m.api).toBe("openai-completions");
	});

	it("derives min limits, all-members image rule, and cheapest-member cost", () => {
		const [m] = combosToModels([combo([{ kind: "model", model: "croc/glm-5.3" }, { kind: "model", model: "ag/claude-opus" }])], catalog);
		expect(m.contextWindow).toBe(100_000);
		expect(m.maxTokens).toBe(16_000);
		expect(m.input).toEqual(["text"]); // one text-only member demotes the combo
		expect(m.reasoning).toBe(true);
		expect(m.cost).toEqual({ input: 1.0, output: 5.0, cacheRead: 0, cacheWrite: 0 });
	});

	it("falls back to slug when name is blank; empty name whitespace counts", () => {
		const [m] = combosToModels([combo([{ kind: "model", model: "croc/glm-5.3" }], { name: "  " })], catalog);
		expect(m.name).toBe("my-combo");
	});

	it("skips unresolvable members and alias members; alias-only combo gets safe defaults", () => {
		const aliasOnly = combosToModels([combo([{ kind: "alias", alias: "glm-5" }])], catalog);
		expect(aliasOnly[0].input).toEqual(["text"]);
		expect(aliasOnly[0].reasoning).toBe(true);
		expect(aliasOnly[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(aliasOnly[0].contextWindow).toBe(128_000);
		expect(aliasOnly[0].maxTokens).toBe(8_192);

		const partial = combosToModels([combo([{ kind: "model", model: "ghost/gone" }, { kind: "model", model: "croc/glm-5.3" }])], catalog);
		expect(partial[0].contextWindow).toBe(200_000);
		expect(partial[0].input).toEqual(["text", "image"]);
	});

	it("preserves combo order and handles empty combo list", () => {
		const models = combosToModels([
			combo([{ kind: "model", model: "ag/claude-opus" }], { slug: "b-combo", name: "B" }),
			combo([{ kind: "model", model: "croc/glm-5.3" }], { slug: "a-combo", name: "A" }),
		], catalog);
		expect(models.map((m) => m.id)).toEqual(["combo/b-combo", "combo/a-combo"]);
		expect(combosToModels([], catalog)).toEqual([]);
	});

	it("reasoning false when no member advertises levels", () => {
		const noLevels: CatalogModel = { id: "x/plain", modality: "text" };
		const [m] = combosToModels([combo([{ kind: "model", model: "x/plain" }])], [noLevels]);
		expect(m.reasoning).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/catalog.test.ts`
Expected: FAIL — `src/catalog.js` does not exist.

- [ ] **Step 3: Implement `src/catalog.ts`**

Schemas with typebox per Interfaces; `combosToModels` is a pure function implementing the mapping rules; `fetchComboCatalog` runs the two GETs (Promise.all — independent), then `combosToModels(combos, models)`. `thinkingLevelMap`: build from the union of resolvable members' `reasoning_levels` — map each advertised level through `LOW_LEVEL_MAP`-style identity where the level string matches a pi thinking level (`minimal|low|medium|high|xhigh|max`), else `null` for unsupported pi levels. (Concrete: `{ off: "off", minimal: <"minimal"|"null">, low: ..., ... max }` — a level the combo advertises maps to itself, one it doesn't advertise maps to `null`.) Set `thinkingLevelMap` only when `reasoning` is true.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/catalog.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/catalog.ts test/catalog.test.ts
git commit -m "feat: combo -> pi model catalog mapping"
```

### Task 4: Provider registration

**Files:**
- Create: `src/index.ts`
- Test: `test/index.test.ts`

**Interfaces:**
- Consumes: everything above; pi-ai `createProvider`, `envApiKeyAuth` (via `inferhubApiKeyAuth`), `openAICompletionsApi` from `@earendil-works/pi-ai/compat`; `ProviderAuthInteraction` type from pi-ai.
- Produces: default-export extension factory `export default function (pi: ExtensionAPI): void` that registers the provider and the `/login inferhub` command. `fetchModels(context: RefreshModelsContext): Promise<readonly ProviderModel<"openai-completions">[]>` = `fetchComboCatalog(token, context.signal)` with the token resolved from `context.credential` (`type === "api_key" ? credential.key : undefined`).

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { createProviderHarness } from "./harness.js";

describe("extension registration", () => {
	it("registers the inferhub provider with openai-completions api and combo fetch", async () => {
		const { pi, providers, commands } = createProviderHarness();
		const mod = await import("../src/index.js");
		mod.default(pi);
		expect(providers.has("inferhub")).toBe(true);
		expect(commands.has("login inferhub") || commands.has("/login inferhub")).toBe(true);
	});
});
```

(The harness shape is decided in Step 3 — the test asserts against whatever `createProviderHarness` records; if a mockable `ExtensionAPI` proves impractical, replace this test with a thin unit test over an exported `registerInferhubProvider(pi)` helper that takes a minimal `{ registerProvider, registerCommand }` interface. The assertion contract is: provider registered under `inferhub` with the combo fetch and env+login auth; `/login inferhub` command registered.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/index.test.ts`
Expected: FAIL — `src/index.js` does not exist.

- [ ] **Step 3: Implement `src/index.ts`**

Wire per the hyper-provider pattern:

```ts
import { createProvider, type ApiKeyCredential } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
```

`registerInferhubProvider(pi)` calls `pi.registerProvider(createProvider({ id: PROVIDER_NAME, name: PROVIDER_DISPLAY_NAME, baseUrl: INFERENCE_BASE_URL, auth: { apiKey: inferhubApiKeyAuth }, models: [], fetchModels: async (context) => { const credential = context.credential; const token = credential?.type === "api_key" ? credential.key : undefined; if (!token) return []; return fetchComboCatalog(token, context.signal); }, api: openAICompletionsApi() }))` — note `models: []` baseline with the combo list arriving via `fetchModels`. Register `pi.registerCommand("inferhub-login", ...)` if pi's command API takes a single name (check `ExtensionAPI.registerCommand`'s signature at implementation time; if it supports a single command name only, the command is `inferhub-login`, not `/login inferhub` — the `/login <provider>` surface is provided by pi's auth system via `envApiKeyAuth`'s built-in `login` + our custom `loginInferhub` wired as `auth.apiKey.login`). Wire `inferhubApiKeyAuth`'s `login` to `loginInferhub` so `/login inferhub` routes through the prompt-validate-store flow.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/index.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/index.ts test/index.test.ts
git commit -m "feat: register inferhub provider"
```

### Task 5: Live smoke test + README

**Files:**
- Create: `README.md`
- Modify: `~/.pi/agent/settings.json` (add `"pi-inferhub"` to packages — done manually by the user, not in code)

**Interfaces:**
- Consumes: the installed extension.
- Produces: a verified-live registration; README documenting install, `/login inferhub`, model selection, refresh behavior, and the catalog-derivation rules (link to the spec).

- [ ] **Step 1: Install the extension locally for pi to discover**

Run: `cd ~/repos/pi-inferhub && npm install && npm pack --dry-run` (verify pack contents), then either register as a discovered extension for the smoke test: `pi -e ~/repos/pi-inferhub` (pi loads the extension via `pi.extensions` in package.json).

- [ ] **Step 2: Live catalog refresh against the real account**

Run: `pi -e ~/repos/pi-inferhub --list-models 2>&1 | head -50` (or the equivalent list-models invocation; check `pi --help` for the exact flag).
Expected: `inferhub` provider appears; models are exactly `combo/<slug>` entries matching the account's combos at https://inferhub.dev/dashboard (cross-check combo count and slugs against the dashboard).

- [ ] **Step 3: One cheap live inference through a combo**

Run: start `pi -e ~/repos/pi-inferhub`, pick the cheapest combo, send "Reply with the single word: ok".
Expected: a reply streams back; `usage.cost` reflects in the session (verify pi's cost display shows a nonzero estimate; the authoritative check is that the request completes with text output).

- [ ] **Step 4: Negative check — no key, clear error**

Run: `INFERHUB_API_KEY= pi -e ~/repos/pi-inferhub --list-models` (env unset, no stored credential).
Expected: provider appears with zero models or a clear auth-required error — never a crash or a silent empty catalog masquerading as "no combos".

- [ ] **Step 5: Write README**

Document: what the provider exposes (combos only), install (`npm:pi-inferhub` in settings.json packages, or `pi -e` for local dev), auth (env var or `/login inferhub`), refresh semantics (on-demand, no persistence), cost estimate semantics (cheapest-member official rates; real `usage.cost` runs at-or-under), combo fallback limits, and a link to the spec.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: README"
```

---

## Execution notes

- pi subagent dispatch policy: do NOT pin models; `~/.pi/agent/settings.json` `subagents.agentOverrides` is authoritative (worker=gateway/glm-5.3, reviewer=gateway/kimi-k3).
- Task 4's test may collapse to the `registerInferhubProvider` thin-helper variant if mocking `ExtensionAPI` is impractical — the implementer decides and records why in the task report.
- The full-suite runs (vitest) are fast (< 5s); no watchdog concerns.
- Live smoke (Task 5) needs the user's real `INFERHUB_API_KEY` or a stored credential; the executor should hand off to the user for the interactive `/login` step if no credential is stored.
