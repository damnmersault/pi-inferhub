import type { ApiKeyCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai/compat";
import { envApiKeyAuth } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { MGMT_BASE_URL } from "./inferhub.js";
import { fetchJson, InferhubHttpError, type FetchJsonOptions } from "./http.js";

/** GET /me succeeds with any JSON object for a valid key. */
const MeSchema = Compile(Type.Object({}));

const MAX_ATTEMPTS = 3;

/**
 * `/login inferhub`: prompt for the API key (secret, trimmed) and validate it
 * against GET /me. A 401 notifies the user and re-prompts; after three failed
 * attempts the login fails. The key is only ever returned to the caller —
 * never logged or persisted here.
 */
export async function loginInferhub(
	interaction: ProviderAuthInteraction,
	opts?: FetchJsonOptions,
): Promise<ApiKeyCredential> {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const key = (
			await interaction.prompt({
				type: "secret",
				message: "InferHub API key",
				placeholder: "sk-airo-…",
			})
		).trim();

		try {
			await fetchJson(`${MGMT_BASE_URL}/me`, key, MeSchema, interaction.signal, opts);
			return { type: "api_key", key };
		} catch (error) {
			if (error instanceof InferhubHttpError && error.status === 401) {
				if (attempt === MAX_ATTEMPTS) break;
				interaction.notify({ type: "info", message: "Key rejected (401). Check the key and try again." });
				continue;
			}
			throw error;
		}
	}
	throw new Error("InferHub login failed after three attempts");
}

/** Env + stored-credential resolution: stored key wins, then INFERHUB_API_KEY. */
export const inferhubApiKeyAuth = envApiKeyAuth("InferHub API key", ["INFERHUB_API_KEY"]);
