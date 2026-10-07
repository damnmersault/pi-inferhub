import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { fetchJson, InferhubHttpError } from "../src/http.js";

const Payload = Type.Object({ object: Type.String() });
const Validator = Compile(Payload);

function respond(status: number, body: string, headers: Record<string, string> = {}): Response {
	const h = new Headers({ "content-type": "application/json", ...headers });
	return new Response(body, { status, headers: h });
}

describe("fetchJson", () => {
	it("sends bearer auth and user agent, parses and validates JSON", async () => {
		const fetchMock = vi.fn(async () => respond(200, JSON.stringify({ object: "list" })));
		const result = await fetchJson("https://x/y", "sk-test", Validator, undefined, { fetchImpl: fetchMock as typeof fetch });
		expect(result).toEqual({ object: "list" });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://x/y");
		expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
		expect((init.headers as Record<string, string>)["User-Agent"]).toMatch(/^pi-inferhub\//);
	});

	it("throws InferhubHttpError with parsed code/message on error JSON", async () => {
		const fetchMock = vi.fn(async () => respond(403, JSON.stringify({ error: { code: "account_blocked", message: "banned: reason" } })));
		await expect(fetchJson("https://x/y", "k", Validator, undefined, { fetchImpl: fetchMock as typeof fetch }))
			.rejects.toMatchObject({ status: 403, code: "account_blocked", message: "banned: reason" });
	});

	it("aborts via signal and surfaces non-JSON error bodies as raw text", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			controller.abort();
			throw new DOMException("aborted", "AbortError");
		});
		await expect(fetchJson("https://x/y", "k", Validator, controller.signal, { fetchImpl: fetchMock as typeof fetch }))
			.rejects.toMatchObject({ name: "AbortError" });
		const fetchMock2 = vi.fn(async () => respond(500, "<html>oops</html>"));
		await expect(fetchJson("https://x/y", "k", Validator, undefined, { fetchImpl: fetchMock2 as typeof fetch }))
			.rejects.toMatchObject({ status: 500, code: "http_500" });
	});
});
