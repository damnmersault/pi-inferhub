import type { Api, Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import { fetchJson, type FetchJsonOptions } from "./http.js";
import { ANTHROPIC_BASE_URL, INFERENCE_BASE_URL, MGMT_BASE_URL, PROVIDER_NAME } from "./inferhub.js";

/** pi thinking levels, in ladder order; `off` is handled separately. */
const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

const CONTEXT_WINDOW_FALLBACK = 262_144;
const MAX_TOKENS_FALLBACK = 131_072;
/**
 * Owner-confirmed 2026-10-18 (and matching the marketplace cache rule): InferHub
 * bills cached input at 0.1x the input rate. Cache WRITES have no published
 * rate, so they stay 0 rather than being guessed.
 */
const CACHE_READ_MULTIPLIER = 0.1;

type ChatModel = Model<Api>;

/** Which native surface a model name belongs to. */
export type NativeFamily = "anthropic" | "openai" | "other";

/**
 * Family of the model NAME (last path segment), never the serving prefix:
 * live catalog 2026-10-18 shows `kiro/` serving both claude-* and gpt-* rows.
 * `gpt-oss` is an open-weight model, not an [OI] native one, so it stays other.
 */
export function nativeFamily(id: string): NativeFamily {
	const name = (id.split("/").pop() ?? id).toLowerCase();
	if (name.includes("claude")) return "anthropic";
	if (/^(gpt(?!-oss)|o\d|codex)/.test(name)) return "openai";
	return "other";
}

interface Surface {
	api: Api;
	baseUrl: string;
}

/**
 * One native family present → its own surface. Both native families present
 * (or none) → chat completions, which InferHub translates for every model.
 */
export function selectSurface(names: readonly string[]): Surface {
	const families = new Set(names.map(nativeFamily));
	const anthropic = families.has("anthropic");
	const openai = families.has("openai");
	if (anthropic && !openai) return { api: "anthropic-messages", baseUrl: ANTHROPIC_BASE_URL };
	if (openai && !anthropic) return { api: "openai-responses", baseUrl: INFERENCE_BASE_URL };
	return { api: "openai-completions", baseUrl: INFERENCE_BASE_URL };
}

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

/** Live-pinned 2026-10-15: bare (prefix-less) catalog rows are aliases served by
 *  prefixed upstream rows — they carry owned_by "alias" and NO limits/pricing/
 *  reasoning fields at all. Unknown extra fields pass validation regardless. */
export const CatalogModelSchema = Type.Object({
	id: Type.String(),
	owned_by: Type.Optional(Type.String()),
	modality: Type.Optional(Type.String()),
	output_modality: Type.Optional(Type.String()),
	upstream_label: Type.Optional(Type.String()),
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
/** Bare (prefix-less) alias row shape observed live 2026-10-15:
 *  {id, object:"model", created, owned_by:"alias", supports_cache} — no limits,
 *  pricing, modality, or reasoning fields at all. Prefixed servings of the same
 *  model carry the data; catalog.ts resolves aliases through them (sibling join). */
const ModelsEnvelope = Type.Object({ data: Type.Array(CatalogModelSchema) });

const CombosValidator = Compile(CombosEnvelope);
const ModelsValidator = Compile(ModelsEnvelope);

export interface FetchCatalogOptions extends FetchJsonOptions {
	/** Also publish direct-selectable upstream models from /v1/models. */
	publishUpstream?: boolean;
}

/** GET /combos + GET /v1/models (independent), then map combos to pi models. */
export async function fetchComboCatalog(
	token: string,
	signal?: AbortSignal,
	opts?: FetchCatalogOptions,
): Promise<ChatModel[]> {
	const [combos, models] = await Promise.all([
		fetchJson<Combo[]>(`${MGMT_BASE_URL}/combos`, token, CombosValidator, signal, opts),
		fetchJson<Static<typeof ModelsEnvelope>>(`${INFERENCE_BASE_URL}/models`, token, ModelsValidator, signal, opts),
	]);
	const comboModels = combosToModels(combos, models.data);
	// Combos are the product: they stay first. The upstream catalog only widens
	// the list when the operator opts in.
	return opts?.publishUpstream ? [...comboModels, ...catalogToModels(models.data)] : comboModels;
}

/** Pure combo → Model mapping; output order follows `combos` order. */
export function combosToModels(
	combos: Combo[],
	catalogModels: CatalogModel[],
): ChatModel[] {
	const catalogById = new Map(catalogModels.map((model) => [model.id, model]));
	return combos.map((combo) => comboToModel(combo, catalogById, catalogModels));
}

function comboToModel(
	combo: Combo,
	catalogById: Map<string, CatalogModel>,
	catalogModels: CatalogModel[],
): ChatModel {
	// Alias rows (`owned_by: "alias"`, no data) and alias-kind members resolve
	// through prefixed sibling servings of the same model name; min-of over the
	// siblings bounds the combo exactly like directly-joined members.
	//
	// Live shape 2026-10-18: combos reference multi-segment prefixes
	// (cp/cline-pass/<model>, cp/zai/<model>) that have no exact serving, while
	// the same model is served under another prefix (zai/<model>,
	// cmc/moonshotai/<model>). Exact suffix matches win; the normalized
	// last-segment name is the recovery path, never a wider net.
	const resolvable: CatalogModel[] = [];
	for (const member of combo.members) {
		const name = member.kind === "model" ? member.model : member.alias;
		const entry = member.kind === "model" ? catalogById.get(member.model) : undefined;
		if (entry !== undefined && entry.owned_by !== "alias") {
			resolvable.push(entry);
			continue;
		}
		const exact = catalogModels.filter(
			(sibling) => sibling.owned_by !== "alias" && sibling.id.endsWith(`/${name}`),
		);
		if (exact.length > 0) {
			resolvable.push(...exact);
			continue;
		}
		const normalized = normalizeModelName(name);
		if (normalized.length > 0) {
			resolvable.push(
				...catalogModels.filter(
					(sibling) => sibling.owned_by !== "alias" && normalizeModelName(sibling.id) === normalized,
				),
			);
		}
	}

	// Optimistic by design: a false negative hides thinking levels (the worse
	// error); a false positive shows an inert knob. Applies to every combo,
	// including level-less resolved members (live-verified 2026-10-18 on
	// combo/deepseek-v4-pro: no advertised levels, honors reasoning_effort).
	const name = combo.name.trim().length > 0 ? combo.name : combo.slug;
	const surface = selectSurface(combo.members.map((member) => (member.kind === "model" ? member.model : member.alias)));
	return buildModel(`combo/${combo.slug}`, name, resolvable, surface);
}

/**
 * Direct-selectable upstream models from `/v1/models`, in catalog order.
 * Skipped: alias rows (information-free duplicates of a prefixed serving),
 * image-output rows (not chat models), and blank ids (live shape `cc/`).
 */
export function catalogToModels(catalogModels: CatalogModel[]): ChatModel[] {
	return catalogModels
		.filter(
			(row) =>
				row.owned_by !== "alias" &&
				// AGENTS.md product rule: never surface image/video generation or
				// `free/` tier models, even when the upstream catalog is published.
				row.output_modality !== "image" &&
				row.output_modality !== "video" &&
				!row.id.startsWith("free/") &&
				// Live shape `cc/`: prefix with an empty model segment — not selectable.
				(row.id.split("/").pop() ?? "").trim().length > 0,
		)
		.map((row) => {
			const label = row.upstream_label?.trim();
			return buildModel(row.id, label && label.length > 0 ? label : row.id, [row], selectSurface([row.id]));
		});
}

/** Shared pi-model construction for combo and direct-catalog entries. */
function buildModel(id: string, name: string, sources: CatalogModel[], surface: Surface): ChatModel {
	const advertised = new Set<string>();
	for (const model of sources) {
		for (const level of model.reasoning_levels ?? []) advertised.add(level);
	}

	const image = sources.length > 0 && sources.every((model) => (model.modality ?? "").includes("image"));

	const priced = sources.flatMap((model) => (model.pricing ? [model.pricing] : []));
	const inputRate = minOf(priced.map((pricing) => pricing.official_in)) ?? 0;

	const model: ChatModel = {
		id,
		name,
		api: surface.api,
		provider: PROVIDER_NAME,
		baseUrl: surface.baseUrl,
		input: image ? ["text", "image"] : ["text"],
		cost: {
			input: inputRate,
			output: minOf(priced.map((pricing) => pricing.official_out)) ?? 0,
			cacheRead: roundRate(inputRate * CACHE_READ_MULTIPLIER),
			cacheWrite: 0,
		},
		reasoning: true,
		contextWindow: minPositiveOf(sources.map((source) => source.input_token_limit)) ?? CONTEXT_WINDOW_FALLBACK,
		maxTokens: minPositiveOf(sources.map((source) => source.max_output_tokens)) ?? MAX_TOKENS_FALLBACK,
	};

	if (surface.api === "openai-completions") {
		// InferHub's [OI]-compatible surface ignores max_completion_tokens (verified
		// live 2026-10-18: a 20-token cap sent that way produced 107 tokens; the
		// same cap as max_tokens stopped at 20). pi-ai auto-detects per-provider
		// and inferhub is not on its list, so pin the field explicitly.
		model.compat = { maxTokensField: "max_tokens" };
	}

	// thinkingLevelMap: built only from an advertised union; a level-less union
	// omits the level keys so pi defaults keep thinking levels selectable —
	// marking them all `null` would hide the knob entirely.
	if (surface.api === "anthropic-messages") {
		// These Claude models reject thinking:{type:"disabled"} (400, live
		// 2026-10-18) and require adaptive thinking. `off: null` makes pi-ai omit
		// the field instead; the map is therefore always present, even when no
		// ladder is advertised.
		model.compat = { forceAdaptiveThinking: true };
		// With no advertised ladder only `off` is pinned: the level keys stay
		// absent so pi keeps every level selectable (optimistic by design).
		model.thinkingLevelMap = advertised.size > 0 ? buildThinkingLevelMap(advertised, null) : { off: null };
	} else if (surface.api === "openai-responses") {
		// [OI] reasoning-off is effort "none"; the value "off" is accepted but
		// leaves the effort unset (live-verified 2026-10-18).
		if (advertised.size > 0) model.thinkingLevelMap = buildThinkingLevelMap(advertised, "none");
		else model.thinkingLevelMap = { off: "none" };
	} else if (advertised.size > 0) {
		model.thinkingLevelMap = buildThinkingLevelMap(advertised, "off");
	}

	return model;
}

/** Cache rates are derived; trim float noise (3 * 0.1 = 0.30000000000000004). */
function roundRate(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

/** Each pi level maps to itself when the combo advertises it, else `null`. */
function buildThinkingLevelMap(advertised: ReadonlySet<string>, off: "off" | "none" | null): ThinkingLevelMap {
	const map: ThinkingLevelMap = { off };
	for (const level of PI_THINKING_LEVELS) {
		map[level] = advertised.has(level) ? level : null;
	}
	return map;
}

/** Last path segment, lowercased, alphanumerics only: "cp/cline-pass/Kimi-K3" → "kimik3". */
function normalizeModelName(id: string): string {
	return (id.split("/").pop() ?? id).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function minOf(values: Array<number | undefined>): number | undefined {
	const present = values.filter((value): value is number => value !== undefined);
	return present.length > 0 ? Math.min(...present) : undefined;
}

/** Limits: 0 (or non-finite) is missing data, never a real ceiling. Prices keep 0. */
function minPositiveOf(values: Array<number | undefined>): number | undefined {
	const present = values.filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
	return present.length > 0 ? Math.min(...present) : undefined;
}
