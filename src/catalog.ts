import type { Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import { fetchJson, type FetchJsonOptions } from "./http.js";
import { INFERENCE_BASE_URL, MGMT_BASE_URL, PROVIDER_NAME } from "./inferhub.js";

/** pi thinking levels, in ladder order; `off` is handled separately. */
const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

const CONTEXT_WINDOW_FALLBACK = 128_000;
const MAX_TOKENS_FALLBACK = 8_192;

export const MemberSchema = Type.Union([
	Type.Object({ kind: Type.Literal("model"), model: Type.String() }),
	Type.Object({ kind: Type.Literal("alias"), alias: Type.String() }),
]);
export type Member = Static<typeof MemberSchema>;

export const ComboSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	slug: Type.String(),
	members: Type.Array(MemberSchema),
});
export type Combo = Static<typeof ComboSchema>;

export const CatalogModelSchema = Type.Object({
	id: Type.String(),
	modality: Type.Optional(Type.String()),
	input_token_limit: Type.Optional(Type.Number()),
	max_output_tokens: Type.Optional(Type.Number()),
	reasoning_levels: Type.Optional(Type.Array(Type.String())),
	pricing: Type.Optional(
		Type.Object({
			official_in: Type.Number(),
			official_out: Type.Number(),
			min_ask_in: Type.Optional(Type.Number()),
			min_ask_out: Type.Optional(Type.Number()),
		}),
	),
});
export type CatalogModel = Static<typeof CatalogModelSchema>;

/**
 * Wire envelopes as observed 2026-10-06: `GET /combos` returns a bare array;
 * `GET /v1/models` returns the OpenAI list shape. Unknown extra fields pass
 * validation (no additionalProperties restrictions).
 */
const CombosEnvelope = Type.Array(ComboSchema);
const ModelsEnvelope = Type.Object({ data: Type.Array(CatalogModelSchema) });

const CombosValidator = Compile(CombosEnvelope);
const ModelsValidator = Compile(ModelsEnvelope);

/** GET /combos + GET /v1/models (independent), then map combos to pi models. */
export async function fetchComboCatalog(
	token: string,
	signal?: AbortSignal,
	opts?: FetchJsonOptions,
): Promise<Model<"openai-completions">[]> {
	const [combos, models] = await Promise.all([
		fetchJson<Combo[]>(`${MGMT_BASE_URL}/combos`, token, CombosValidator, signal, opts),
		fetchJson<Static<typeof ModelsEnvelope>>(`${INFERENCE_BASE_URL}/models`, token, ModelsValidator, signal, opts),
	]);
	return combosToModels(combos, models.data);
}

/** Pure combo → Model mapping; output order follows `combos` order. */
export function combosToModels(
	combos: Combo[],
	catalogModels: CatalogModel[],
): Model<"openai-completions">[] {
	const catalogById = new Map(catalogModels.map((model) => [model.id, model]));
	return combos.map((combo) => comboToModel(combo, catalogById));
}

function comboToModel(
	combo: Combo,
	catalogById: Map<string, CatalogModel>,
): Model<"openai-completions"> {
	const resolvable: CatalogModel[] = [];
	for (const member of combo.members) {
		if (member.kind !== "model") continue;
		const entry = catalogById.get(member.model);
		if (entry !== undefined) resolvable.push(entry);
	}

	// Alias-only / all-missed-join combos reason optimistically: a false
	// negative hides thinking levels, a false positive shows an inert knob.
	const advertised = new Set<string>();
	for (const model of resolvable) {
		for (const level of model.reasoning_levels ?? []) advertised.add(level);
	}
	const reasoning = resolvable.length === 0 || advertised.size > 0;

	const image = resolvable.length > 0 && resolvable.every((model) => (model.modality ?? "").includes("image"));

	const priced = resolvable.flatMap((model) => (model.pricing ? [model.pricing] : []));

	const model: Model<"openai-completions"> = {
		id: `combo/${combo.slug}`,
		name: combo.name.trim().length > 0 ? combo.name : combo.slug,
		api: "openai-completions",
		provider: PROVIDER_NAME,
		baseUrl: INFERENCE_BASE_URL,
		input: image ? ["text", "image"] : ["text"],
		cost: {
			input: minOf(priced.map((pricing) => pricing.official_in)) ?? 0,
			output: minOf(priced.map((pricing) => pricing.official_out)) ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		reasoning,
		contextWindow: minOf(resolvable.map((m) => m.input_token_limit)) ?? CONTEXT_WINDOW_FALLBACK,
		maxTokens: minOf(resolvable.map((m) => m.max_output_tokens)) ?? MAX_TOKENS_FALLBACK,
	};
	// thinkingLevelMap: built only from an advertised union; an empty union
	// (alias-only combos) omits the map so pi defaults keep thinking levels
	// selectable — marking them all `null` would hide the knob entirely.
	if (reasoning && advertised.size > 0) model.thinkingLevelMap = buildThinkingLevelMap(advertised);
	return model;
}

/** Each pi level maps to itself when the combo advertises it, else `null`. */
function buildThinkingLevelMap(advertised: ReadonlySet<string>): ThinkingLevelMap {
	const map: ThinkingLevelMap = { off: "off" };
	for (const level of PI_THINKING_LEVELS) {
		map[level] = advertised.has(level) ? level : null;
	}
	return map;
}

function minOf(values: Array<number | undefined>): number | undefined {
	const present = values.filter((value): value is number => value !== undefined);
	return present.length > 0 ? Math.min(...present) : undefined;
}
