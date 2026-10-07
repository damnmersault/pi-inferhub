import { describe, expect, it, vi } from "vitest";
import { loginInferhub } from "../src/auth.js";

function interaction(responses: string[], notified: string[] = []) {
	let i = 0;
	return {
		signal: new AbortController().signal,
		prompt: vi.fn(async () => {
			const v = responses[i++];
			if (v === undefined) throw new Error("prompt exhausted");
			return v;
		}),
		notify: (e: { type: string; message?: string }) => notified.push(`${e.type}: ${e.message}`),
	};
}

describe("loginInferhub", () => {
	it("validates the key against /me and returns an api_key credential", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
			new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
		const result = await loginInferhub(interaction(["sk-airo-abc"]), { fetchImpl: fetchMock as typeof fetch });
		expect(result).toEqual({ type: "api_key", key: "sk-airo-abc" });
		expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-airo-abc");
	});

	it("re-prompts after a 401 and notifies, up to 3 attempts", async () => {
		// Ruled fix (controller 2026-10-06): the brief's mock was always-401, contradicting
		// this test's intent and test 3. Mock returns 401 twice, then 200 on call 3.
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "bad key" } }), { status: 401 }))
			.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "bad key" } }), { status: 401 }))
			.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "bad key" } }), { status: 401 }))
			.mockImplementationOnce(async () => new Response(JSON.stringify({}), { status: 200 }));
		const notified: string[] = [];
		const result = await loginInferhub(interaction(["sk-bad", "sk-bad", "sk-airo-good"], notified), { fetchImpl: fetchMock as typeof fetch });
		expect(result.key).toBe("sk-airo-good");
		expect(notified.some((n) => n.startsWith("info:"))).toBe(true);
	});

	it("throws after 3 failed attempts", async () => {
		const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
		await expect(loginInferhub(interaction(["a", "b", "c"]), { fetchImpl: fetchMock as typeof fetch })).rejects.toThrow(/three/);
	});
});
