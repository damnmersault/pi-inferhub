import type { ModelsPublication, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inferhubApiKeyAuth, loginInferhub } from "../src/auth.js";
import { registerInferhubProvider, type InferhubRegistrationPi } from "../src/index.js";
import { INFERENCE_BASE_URL } from "../src/inferhub.js";

function registrationHarness() {
	const providers = new Map<string, Provider>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const pi: InferhubRegistrationPi = {
		registerProvider: (provider) => void providers.set(provider.id, provider),
		registerCommand: (name, options) => void commands.set(name, options),
	};
	return { pi, providers, commands };
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}) {
	const publications: ModelsPublication[] = [];
	const context: RefreshModelsContext = {
		credential: { type: "api_key", key: "sk-test" },
		publish: async (publication) => {
			publications.push(publication);
			publication.update?.();
			return true;
		},
		allowNetwork: true,
		signal: new AbortController().signal,
		...overrides,
	};
	return { context, publications };
}

/** Stub GET /combos + GET /v1/models, recording Authorization headers per call. */
function stubCatalogFetch() {
	const authHeaders: string[] = [];
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		authHeaders.push(headers["Authorization"] ?? "");
		const body = String(url).includes("/combos")
			? [{ id: "c1", name: "Test Combo", slug: "test-combo", members: [{ kind: "model", model: "croc/glm-5.3" }] }]
			: {
					data: [
						{
							id: "croc/glm-5.3",
							modality: "text,image",
							input_token_limit: 200_000,
							max_output_tokens: 8_192,
							reasoning_levels: ["low"],
							pricing: { official_in: 3, official_out: 15 },
						},
					],
				};
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, authHeaders };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("registerInferhubProvider", () => {
	it("registers the inferhub provider with empty baseline, login+env auth, and dynamic model fetch", () => {
		const { pi, providers } = registrationHarness();
		registerInferhubProvider(pi);
		expect(providers.has("inferhub")).toBe(true);
		const provider = providers.get("inferhub")!;
		expect(provider.name).toBe("InferHub");
		expect(provider.baseUrl).toBe(INFERENCE_BASE_URL);
		expect(provider.getModels()).toEqual([]); // baseline; combos arrive via refreshModels
		expect(provider.refreshModels).toBeTypeOf("function");
		expect(typeof provider.streamSimple).toBe("function");
		// envApiKeyAuth resolution + our prompt-validate login overriding the plain default
		expect(provider.auth.apiKey?.login).toBe(loginInferhub);
		expect(provider.auth.apiKey?.resolve).toBe(inferhubApiKeyAuth.resolve);
	});

	it("the default export registers through the same surface", async () => {
		const { pi, providers, commands } = registrationHarness();
		const mod = await import("../src/index.js");
		mod.default(pi as unknown as ExtensionAPI);
		expect(providers.has("inferhub")).toBe(true);
		expect(commands.has("inferhub-login")).toBe(true);
	});

	it("refreshModels maps the combo catalog using the credential key", async () => {
		const { pi, providers } = registrationHarness();
		registerInferhubProvider(pi);
		const { authHeaders } = stubCatalogFetch();
		const { context, publications } = refreshContext();
		await providers.get("inferhub")!.refreshModels!(context);
		expect(providers.get("inferhub")!.getModels().map((m) => m.id)).toEqual(["combo/test-combo"]);
		const persisted = publications.at(-1)?.persist?.models ?? [];
		expect(persisted.map((m) => m.id)).toEqual(["combo/test-combo"]);
		expect(persisted[0]).toMatchObject({
			name: "Test Combo",
			api: "openai-completions",
			provider: "inferhub",
			baseUrl: INFERENCE_BASE_URL,
			input: ["text", "image"],
			contextWindow: 200_000,
		});
		expect(authHeaders).toEqual(["Bearer sk-test", "Bearer sk-test"]); // /combos + /v1/models
	});

	it("refreshModels keeps the empty baseline without a credential (no network)", async () => {
		const { pi, providers } = registrationHarness();
		registerInferhubProvider(pi);
		const { fetchMock } = stubCatalogFetch();
		const { context } = refreshContext({ credential: undefined });
		await providers.get("inferhub")!.refreshModels!(context);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(providers.get("inferhub")!.getModels()).toEqual([]);
	});

	it("auth resolves the env key when no stored credential exists", async () => {
		const { pi, providers } = registrationHarness();
		registerInferhubProvider(pi);
		const result = await providers.get("inferhub")!.auth.apiKey!.resolve({
			ctx: {
				env: async (name) => (name === "INFERHUB_API_KEY" ? "sk-env" : undefined),
				fileExists: async () => false,
			},
			credential: undefined,
			signal: new AbortController().signal,
		});
		expect(result).toMatchObject({ auth: { apiKey: "sk-env" }, source: "INFERHUB_API_KEY" });
	});

	it("registers the inferhub-login command pointing at /login inferhub", async () => {
		const { pi, commands } = registrationHarness();
		registerInferhubProvider(pi);
		expect(commands.has("inferhub-login")).toBe(true);
		const command = commands.get("inferhub-login")!;
		expect(command.description).toBeTruthy();

		const notified: string[] = [];
		const queried: string[] = [];
		const ctxFor = (configured: boolean) =>
			({
				modelRegistry: {
					getProviderAuthStatus: (provider: string) => {
						queried.push(provider);
						return { configured };
					},
				},
				ui: { notify: (message: string) => void notified.push(message) },
			}) as unknown as ExtensionCommandContext;

		await command.handler("", ctxFor(false));
		expect(queried).toEqual(["inferhub"]);
		expect(notified[0]).toContain("/login inferhub");

		await command.handler("", ctxFor(true));
		expect(notified[1]).not.toContain("not configured");
	});
});
