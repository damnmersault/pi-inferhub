import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Canonical config file for this package, under pi's agent dir. */
export const CONFIG_FILE_NAME = "pi-inferhub.json";

/** Env override for `publishUpstream`; wins over the file when set. */
export const PUBLISH_UPSTREAM_ENV = "INFERHUB_PUBLISH_UPSTREAM";

export interface InferhubConfig {
	/**
	 * Also publish every chat model from `/v1/models` as a direct-selectable
	 * `prefix/model` entry, alongside the `combo/<slug>` models. Combos stay
	 * first; this only widens the catalog. Default: false.
	 */
	publishUpstream: boolean;
	/** Human-readable problems found while loading; never fatal. */
	issues: string[];
}

/** pi's agent dir: `PI_AGENT_DIR` when set, else `~/.pi/agent`. */
export function defaultAgentDir(): string {
	return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function parseEnvBoolean(raw: string): boolean | undefined {
	const value = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off"].includes(value)) return false;
	return undefined;
}

/**
 * Load `<agentDir>/pi-inferhub.json`. Missing file = defaults; malformed file =
 * defaults + issue; unknown keys are ignored, wrong-typed values are reported
 * and leave the default in place. Never throws for file content problems.
 */
export function loadInferhubConfig(agentDir: string = defaultAgentDir()): InferhubConfig {
	const issues: string[] = [];
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(agentDir, CONFIG_FILE_NAME), "utf8"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return { publishUpstream: false, issues };
		const message = error instanceof Error ? error.message : String(error);
		issues.push(`${CONFIG_FILE_NAME} is not valid JSON (${message}); using defaults`);
		return { publishUpstream: false, issues };
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		issues.push(`${CONFIG_FILE_NAME} must contain a JSON object; using defaults`);
		return { publishUpstream: false, issues };
	}

	let publishUpstream = false;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (key !== "publishUpstream") continue;
		if (typeof value === "boolean") publishUpstream = value;
		else issues.push(`publishUpstream must be a boolean (got ${typeof value}); using false`);
	}

	const envRaw = process.env[PUBLISH_UPSTREAM_ENV];
	if (envRaw !== undefined) {
		const envValue = parseEnvBoolean(envRaw);
		if (envValue === undefined) {
			issues.push(`${PUBLISH_UPSTREAM_ENV} must be a boolean-like value; ignoring`);
		} else {
			publishUpstream = envValue;
		}
	}

	return { publishUpstream, issues };
}
