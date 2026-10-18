import { describe, expect, it } from "vitest";
import type { CatalogModel, Combo } from "../src/catalog.js";
import { combosToModels, catalogToModels } from "../src/catalog.js";
import { ANTHROPIC_BASE_URL, INFERENCE_BASE_URL, PROVIDER_NAME } from "../src/inferhub.js";

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

/** Bare alias row shape observed live 2026-10-15: id without prefix, owned_by "alias",
 *  no limits/pricing/reasoning fields at all. */
const aliasRow = (name: string): CatalogModel => ({ id: name, owned_by: "alias" });

describe("catalogToModels", () => {
	it("maps chat rows and skips alias rows, image/video outputs, free tiers, and empty ids", () => {
		const rows: CatalogModel[] = [
			{
				id: "zai/glm-5.3",
				owned_by: "zai",
				modality: "text,image",
				input_token_limit: 200_000,
				max_output_tokens: 32_000,
				reasoning_levels: ["low", "high"],
				upstream_label: "GLM 5.3",
				pricing: { official_in: 3, official_out: 15 },
			},
			{ id: "glm-5.3", owned_by: "alias" },
			{ id: "cx/gpt-image-2-codex", owned_by: "cx", output_modality: "image", modality: "text" },
			{ id: "vid/gen", owned_by: "vid", output_modality: "video", modality: "text" },
			{ id: "free/promo", owned_by: "free", modality: "text" },
			{ id: "cc/" + "", owned_by: "cc", modality: "text" },
		];
		const models = catalogToModels(rows);
		expect(models.map((m) => m.id)).toEqual(["zai/glm-5.3"]);
		const [m] = models;
		expect(m.name).toBe("GLM 5.3");
		expect(m.provider).toBe(PROVIDER_NAME);
		expect(m.input).toEqual(["text", "image"]);
		expect(m.reasoning).toBe(true);
		expect(m.thinkingLevelMap).toMatchObject({ low: "low", high: "high" });
		expect(m.contextWindow).toBe(200_000);
		expect(m.maxTokens).toBe(32_000);
		expect(m.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
		expect(m.compat).toMatchObject({ maxTokensField: "max_tokens" });
	});

	it("uses the id as name, falls back on missing or zero limits, and omits the map without levels", () => {
		const [m] = catalogToModels([
			{ id: "x/plain", owned_by: "x", modality: "text", input_token_limit: 0, max_output_tokens: 0 },
		]);
		expect(m.name).toBe("x/plain");
		expect(m.input).toEqual(["text"]);
		expect(m.contextWindow).toBe(262_144);
		expect(m.maxTokens).toBe(131_072);
		expect(m.thinkingLevelMap).toBeUndefined();
		expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});

describe("surface selection", () => {
	// User ruling 2026-10-18: a combo whose members are all one native family
	// rides that family's surface; a combo mixing both native families falls
	// back to chat completions (InferHub translates there for everything).
	const row = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({
		id,
		owned_by: id.split("/")[0],
		modality: "text,image",
		input_token_limit: 200_000,
		max_output_tokens: 32_000,
		pricing: { official_in: 3, official_out: 15 },
		...extra,
	});

	it("routes an anthropic-only combo to messages on the bare host", () => {
		const [m] = combosToModels([combo([{ kind: "model", model: "cc/claude-opus-5-5" }])], [row("cc/claude-opus-5-5")]);
		expect(m.api).toBe("anthropic-messages");
		expect(m.baseUrl).toBe(ANTHROPIC_BASE_URL);
		expect(ANTHROPIC_BASE_URL.endsWith("/v1")).toBe(false);
		// pi-ai sends thinking:{type:"disabled"} unless off is null, and these
		// models reject it: verified live 2026-10-18, 400 invalid_request_error.
		expect(m.compat).toMatchObject({ forceAdaptiveThinking: true });
		expect(m.thinkingLevelMap?.off).toBeNull();
	});

	it("routes an openai-only combo to responses with an explicit reasoning-off", () => {
		const [m] = combosToModels([combo([{ kind: "model", model: "cx/gpt-6-astra" }])], [row("cx/gpt-6-astra")]);
		expect(m.api).toBe("openai-responses");
		expect(m.baseUrl).toBe(INFERENCE_BASE_URL);
		// "none" is the [OI] value that actually disables reasoning; "off" is
		// tolerated but leaves the effort field unset (verified live 2026-10-18).
		expect(m.thinkingLevelMap?.off).toBe("none");
	});

	it("falls back to chat completions when both native families are present", () => {
		const [m] = combosToModels(
			[combo([{ kind: "model", model: "cc/claude-opus-5-5" }, { kind: "model", model: "cx/gpt-6-astra" }])],
			[row("cc/claude-opus-5-5"), row("cx/gpt-6-astra")],
		);
		expect(m.api).toBe("openai-completions");
		expect(m.baseUrl).toBe(INFERENCE_BASE_URL);
		expect(m.compat).toMatchObject({ maxTokensField: "max_tokens" });
	});

	it("keeps chat completions for combos with no native family", () => {
		const [m] = combosToModels([combo([{ kind: "model", model: "zai/glm-5.3" }])], [row("zai/glm-5.3")]);
		expect(m.api).toBe("openai-completions");
	});

	it("classifies by model name, not serving prefix (kiro serves both families)", () => {
		// Live shape 2026-10-18: kiro/ serves claude-* AND gpt-* rows.
		const models = combosToModels(
			[
				combo([{ kind: "model", model: "kiro/gpt-5.6-luna" }], { slug: "gpt" }),
				combo([{ kind: "model", model: "kiro/claude-sonnet-5.5" }], { slug: "claude" }),
			],
			[row("kiro/gpt-5.6-luna"), row("kiro/claude-sonnet-5.5")],
		);
		expect(models[0].api).toBe("openai-responses");
		expect(models[1].api).toBe("anthropic-messages");
	});

	it("still maps thinking levels to messages models, keeping off null", () => {
		const [m] = combosToModels(
			[combo([{ kind: "model", model: "cc/claude-opus-5-5" }])],
			[row("cc/claude-opus-5-5", { reasoning_levels: ["low", "medium", "high"] })],
		);
		expect(m.thinkingLevelMap).toEqual({ off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null });
	});

	it("keeps a messages model's map even without advertised levels so off stays null", () => {
		// Without any map pi-ai sends thinking:{type:"disabled"} (400 on Claude),
		// so an empty ladder still needs the off entry.
		const [m] = combosToModels([combo([{ kind: "model", model: "cc/claude-opus-5-5" }])], [row("cc/claude-opus-5-5")]);
		expect(m.thinkingLevelMap).toEqual({ off: null });
	});

	it("assigns the surface to direct catalog models from their own name", () => {
		const models = catalogToModels([row("cc/claude-opus-5-5"), row("cx/gpt-6-astra"), row("zai/glm-5.3")]);
		expect(models.map((m) => m.api)).toEqual(["anthropic-messages", "openai-responses", "openai-completions"]);
	});
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
		expect(m.cost).toEqual({ input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 0 });
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
		expect(aliasOnly[0].contextWindow).toBe(262_144);
		expect(aliasOnly[0].maxTokens).toBe(131_072);

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

	it("raises bare alias rows and alias-kind members via prefixed sibling join (live combo/fast shape)", () => {
		// Members named like a user-built combo: bare names whose catalog rows are
		// information-free alias rows, but prefixed servings of the same model exist.
		const sibCatalog: CatalogModel[] = [
			aliasRow("qwen3.8-flash"),
			aliasRow("deepseek-v4.1-flash"),
			aliasRow("glm-5.3-flash"),
			{ id: "ocg/qwen3.8-flash", ...base },
			{ id: "ali/qwen3.8-flash", ...base },
			{ id: "ocg/deepseek-v4.1-flash", ...base, pricing: { official_in: 2.0, official_out: 10.0 } },
			{ id: "zai/glm-5.3-flash", ...base },
		];
		const [m] = combosToModels([combo([
			{ kind: "model", model: "qwen3.8-flash" },
			{ kind: "alias", alias: "deepseek-v4.1-flash" },
			{ kind: "model", model: "glm-5.3-flash" },
		])], sibCatalog);
		expect(m.contextWindow).toBe(200_000); // min over sibling servings, not the 128k fallback
		expect(m.maxTokens).toBe(32_000);
		expect(m.reasoning).toBe(true);
		expect(m.thinkingLevelMap).toMatchObject({ low: "low", high: "high" });
		expect(m.input).toEqual(["text", "image"]); // every sibling serving is vision-capable
		expect(m.cost).toEqual({ input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 0 });
	});

	it("does not cross-join a siblingless alias and keeps safe defaults (claude fable shape)", () => {
		// cc/ row exists but is null everywhere and has NO prefixed siblings carrying data.
		const [m] = combosToModels([combo([{ kind: "model", model: "claude-fable-5-1" }])], [aliasRow("claude-fable-5-1")]);
		expect(m.contextWindow).toBe(262_144);
		expect(m.maxTokens).toBe(131_072);
		expect(m.reasoning).toBe(true); // alias-only optimism invariant
		expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("prefers a direct row's real data over sibling join", () => {
		// A prefixed member resolves directly; siblings must not inflate its set.
		const sibCatalog: CatalogModel[] = [
			{ id: "croc/glm-5.3", ...base },
			{ id: "other/glm-5.3", ...base, input_token_limit: 1_000_000, max_output_tokens: 128_000 },
		];
		const [m] = combosToModels([combo([{ kind: "model", model: "croc/glm-5.3" }])], sibCatalog);
		expect(m.contextWindow).toBe(200_000); // only the directly-joined member counts
		expect(m.maxTokens).toBe(32_000);
	});

	it("pins max_tokens compat so advertised output limits are enforced upstream", () => {
		// InferHub ignores max_completion_tokens (verified live 2026-10-18: a
		// 20-token cap sent as max_completion_tokens produced 107 completion
		// tokens; the same cap sent as max_tokens stopped at 20).
		const [m] = combosToModels([combo([{ kind: "model", model: "croc/glm-5.3" }])], catalog);
		expect(m.compat).toMatchObject({ maxTokensField: "max_tokens" });
	});

	it("resolves multi-segment prefixes through normalized sibling names", () => {
		// Live shape 2026-10-18: combos reference cp/cline-pass/<model> and
		// cb/<model> rows that have no exact "<prefix>/<name>" serving; the same
		// model is served under a different prefix. Exact-suffix join misses it.
		const multiPrefix: CatalogModel[] = [
			{ id: "zai/glm-5.3", ...base },
			{ id: "cmc/moonshotai/Kimi-K3", ...base, input_token_limit: 500_000, max_output_tokens: 64_000 },
		];
		const [fromModel, fromAlias] = combosToModels([
			combo([{ kind: "model", model: "cp/cline-pass/glm-5.3" }], { slug: "a" }),
			combo([{ kind: "alias", alias: "kimi-k3" }], { slug: "b" }),
		], multiPrefix);
		expect(fromModel.contextWindow).toBe(200_000); // zai/glm-5.3, not the 262_144 fallback
		expect(fromModel.maxTokens).toBe(32_000);
		expect(fromAlias.contextWindow).toBe(500_000); // cmc/moonshotai/Kimi-K3
		expect(fromAlias.maxTokens).toBe(64_000);
	});

	it("prefers exact suffix servings over normalized matches", () => {
		// Normalization must be a recovery path, not a wider net: an exact sibling
		// set bounds the combo; same-named rows under other prefixes must not join.
		const exactFirst: CatalogModel[] = [
			{ id: "croc/glm-5.3", ...base },
			{ id: "other/glm-5.3", ...base, input_token_limit: 1_000_000, max_output_tokens: 128_000 },
		];
		const [m] = combosToModels([combo([{ kind: "alias", alias: "glm-5.3" }])], exactFirst);
		expect(m.contextWindow).toBe(200_000);
		expect(m.maxTokens).toBe(32_000);
	});

	it("treats zero limits as missing data while keeping zero prices real", () => {
		// A 0 limit is absent data (a real model always accepts some context);
		// a 0 price is a real price and must survive min-of untouched.
		const zero: CatalogModel = {
			id: "z/model",
			modality: "text",
			input_token_limit: 0,
			max_output_tokens: 0,
			pricing: { official_in: 0, official_out: 1.5 },
		};
		const [m] = combosToModels([combo([{ kind: "model", model: "z/model" }])], [zero]);
		expect(m.contextWindow).toBe(262_144);
		expect(m.maxTokens).toBe(131_072);
		expect(m.cost).toEqual({ input: 0, output: 1.5, cacheRead: 0, cacheWrite: 0 });
	});

	it("reasons optimistically when resolved members advertise no levels, omitting the map", () => {
		// Contract change 2026-10-18 (invariant 5 rationale extended to resolved
		// members): a false negative hides the thinking knob — the worse error —
		// while a false positive only shows an inert one. Live evidence:
		// combo/deepseek-v4-pro advertises no levels on any member yet honors
		// reasoning_effort (84 reasoning tokens at high, 0 at off).
		const noLevels: CatalogModel = { id: "x/plain", modality: "text" };
		const [m] = combosToModels([combo([{ kind: "model", model: "x/plain" }])], [noLevels]);
		expect(m.reasoning).toBe(true);
		expect(m.thinkingLevelMap).toBeUndefined(); // an all-null map would hide every level
	});
});
