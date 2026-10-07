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
