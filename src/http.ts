import { createRequire } from "node:module";
import type { TProperties, TSchema } from "typebox";
import type { Validator } from "typebox/compile";

const require = createRequire(import.meta.url);

function packageVersion(): string {
	const payload: unknown = require("../package.json");
	if (typeof payload === "object" && payload !== null) {
		const version = (payload as { version?: unknown }).version;
		if (typeof version === "string" && version.length > 0) return version;
	}
	return "0.0.0";
}

const INFERHUB_USER_AGENT = `pi-inferhub/${packageVersion()}`;

export class InferhubHttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "InferhubHttpError";
	}
}

export interface FetchJsonOptions {
	fetchImpl?: typeof fetch;
}

interface ErrorBody {
	error?: { code?: unknown; message?: unknown };
}

/**
 * GET `url` with Bearer auth and validate the JSON body with `validator`.
 * Non-2xx responses throw InferhubHttpError carrying the upstream
 * `error.code`/`error.message` when present. Abort errors propagate untouched.
 */
export async function fetchJson<T>(
	url: string,
	token: string,
	validator: Validator<TProperties, TSchema>,
	signal?: AbortSignal,
	opts?: FetchJsonOptions,
): Promise<T> {
	const doFetch = opts?.fetchImpl ?? globalThis.fetch;
	const response = await doFetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			"User-Agent": INFERHUB_USER_AGENT,
			Accept: "application/json",
		},
		signal,
	});

	const body = await response.text();

	if (!response.ok) {
		const { status, code, message } = parseErrorBody(response.status, body);
		throw new InferhubHttpError(status, code, message);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch (error) {
		throw new InferhubHttpError(response.status, "schema_mismatch", `invalid JSON from ${url}: ${String(error)}`);
	}

	if (!validator.Check(parsed)) {
		const detail = validator
			.Errors(parsed)
			.map((e) => `${e.instancePath}: ${e.message}`)
			.join("; ");
		throw new InferhubHttpError(response.status, "schema_mismatch", `schema mismatch from ${url}: ${detail}`);
	}

	return validator.Decode(parsed) as T;
}

function parseErrorBody(status: number, body: string): { status: number; code: string; message: string } {
	try {
		const payload = JSON.parse(body) as ErrorBody;
		const error = payload?.error;
		if (typeof error === "object" && error !== null && typeof error.message === "string") {
			return {
				status,
				code: typeof error.code === "string" ? error.code : "unknown",
				message: error.message,
			};
		}
	} catch {
		// non-JSON error body — fall through to raw text
	}
	return { status, code: `http_${status}`, message: body };
}
