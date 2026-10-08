import { createProvider, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
// Pi's extension loader doesn't virtualize lazy API implementation subpaths yet
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { inferhubApiKeyAuth, loginInferhub } from "./auth.js";
import { fetchComboCatalog } from "./catalog.js";
import { INFERENCE_BASE_URL, PROVIDER_DISPLAY_NAME, PROVIDER_NAME } from "./inferhub.js";

/**
 * Minimal registration surface `registerInferhubProvider` needs from
 * `ExtensionAPI` — the two methods the extension actually calls. Kept as an
 * exported type so the provider wiring is unit-testable without a full pi
 * runtime.
 */
export interface InferhubRegistrationPi {
	registerProvider(provider: Provider): void;
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }): void;
}

function inferhubProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: PROVIDER_NAME,
		name: PROVIDER_DISPLAY_NAME,
		baseUrl: INFERENCE_BASE_URL,
		// envApiKeyAuth's plain prompt-only default login is replaced by our
		// prompt-validate flow so `/login inferhub` checks the key against
		// GET /me before it is stored. Resolution (stored key, then
		// INFERHUB_API_KEY) comes from envApiKeyAuth unchanged.
		auth: { apiKey: { ...inferhubApiKeyAuth, login: loginInferhub } },
		models: [],
		// Models.refresh() only reaches fetchModels after auth resolution
		// succeeds, so `credential` carries either the stored key or the
		// env-resolved one. Guarding on it keeps the unconfigured case a
		// no-op empty list instead of an unauthenticated upstream call.
		fetchModels: async (context) => {
			const credential = context.credential;
			const token = credential?.type === "api_key" ? credential.key : undefined;
			if (!token) return [];
			return fetchComboCatalog(token, context.signal);
		},
		api: openAICompletionsApi(),
	});
}

/** Register the InferHub provider and its companion command. */
export function registerInferhubProvider(pi: InferhubRegistrationPi): void {
	pi.registerProvider(inferhubProvider());

	// pi's registerCommand takes a single command name; `/login inferhub` is
	// provided by pi's auth system through the apiKey login wired above. This
	// command only reports auth status and points users there.
	pi.registerCommand("inferhub-login", {
		description: "Show InferHub auth status and how to sign in",
		handler: async (_args, ctx) => {
			const status = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_NAME);
			if (status?.configured) {
				const source = status.label ? ` (${status.label})` : "";
				ctx.ui.notify(`InferHub is configured${source}. Run /model to pick a combo.`, "info");
				return;
			}
			ctx.ui.notify(
				`InferHub is not configured. Run /login inferhub to enter an API key, or set INFERHUB_API_KEY.`,
				"warning",
			);
		},
	});
}

export default function (pi: ExtensionAPI): void {
	registerInferhubProvider(pi);
}
