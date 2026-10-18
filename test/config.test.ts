import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_FILE_NAME, loadInferhubConfig } from "../src/config.js";

const dirs: string[] = [];

function agentDir(files: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-inferhub-config-"));
	dirs.push(dir);
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	delete process.env.INFERHUB_PUBLISH_UPSTREAM;
});

describe("loadInferhubConfig", () => {
	it("defaults to combos only when no config file exists", () => {
		const config = loadInferhubConfig(agentDir());
		expect(config.publishUpstream).toBe(false);
		expect(config.issues).toEqual([]);
	});

	it("reads publishUpstream from the config file", () => {
		const config = loadInferhubConfig(agentDir({ [CONFIG_FILE_NAME]: JSON.stringify({ publishUpstream: true }) }));
		expect(config.publishUpstream).toBe(true);
		expect(config.issues).toEqual([]);
	});

	it("falls back to defaults with an issue when the file is malformed", () => {
		const config = loadInferhubConfig(agentDir({ [CONFIG_FILE_NAME]: "{ not json" }));
		expect(config.publishUpstream).toBe(false);
		expect(config.issues.join(" ")).toContain("not valid JSON");
	});

	it("reports wrong-typed values instead of silently enabling", () => {
		const config = loadInferhubConfig(agentDir({ [CONFIG_FILE_NAME]: JSON.stringify({ publishUpstream: "yes" }) }));
		expect(config.publishUpstream).toBe(false);
		expect(config.issues.join(" ")).toContain("must be a boolean");
	});

	it("lets INFERHUB_PUBLISH_UPSTREAM override the file in both directions", () => {
		const off = agentDir({ [CONFIG_FILE_NAME]: JSON.stringify({ publishUpstream: false }) });
		process.env.INFERHUB_PUBLISH_UPSTREAM = "1";
		expect(loadInferhubConfig(off).publishUpstream).toBe(true);

		const on = agentDir({ [CONFIG_FILE_NAME]: JSON.stringify({ publishUpstream: true }) });
		process.env.INFERHUB_PUBLISH_UPSTREAM = "false";
		expect(loadInferhubConfig(on).publishUpstream).toBe(false);
	});
});
