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

/** Bare alias row shape observed live 2026-10-15: id without prefix, owned_by "alias",
 *  no limits/pricing/reasoning fields at all. */
const aliasRow = (name: string): CatalogModel => ({ id: name, owned_by: "alias" });

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
		expect(m.cost).toEqual({ input: 2.0, output: 10.0, cacheRead: 0, cacheWrite: 0 });
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

	it("reasoning false when no member advertises levels", () => {
		const noLevels: CatalogModel = { id: "x/plain", modality: "text" };
		const [m] = combosToModels([combo([{ kind: "model", model: "x/plain" }])], [noLevels]);
		expect(m.reasoning).toBe(false);
	});
});
