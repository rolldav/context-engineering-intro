import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/workers-oauth-provider", () => ({
	default: class MockOAuthProvider {
		constructor(_options: unknown) {}
	},
}));

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {},
}));

import {
	McpApiHandler,
} from "../../src/index";
import type { Props } from "../../src/types";
import { mockPrivilegedProps, mockProps } from "../fixtures/auth.fixtures";
import { mockEnv } from "../mocks/oauth.mock";

function oauthExecutionContext(props?: Props): ExecutionContext {
	return {
		passThroughOnException: vi.fn(),
		props: props ?? {},
		waitUntil: vi.fn(),
	} as unknown as ExecutionContext;
}

function mcpRequest(method: string, params?: Record<string, unknown>): Request {
	return new Request("http://localhost:8792/mcp", {
		body: JSON.stringify({ id: crypto.randomUUID(), jsonrpc: "2.0", method, params }),
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			host: "localhost:8792",
			"mcp-protocol-version": "2025-06-18",
		},
		method: "POST",
	});
}

async function mcpJson(
	props: typeof mockProps,
	method: string,
	params?: Record<string, unknown>,
): Promise<Record<string, any>> {
	// OAuthProvider authenticates the bearer token and passes its decrypted app
	// claims through ExecutionContext.props to apiHandler.fetch.
	const response = await McpApiHandler.fetch(mcpRequest(method, params), mockEnv as any, oauthExecutionContext(props));
	const body = await response.text();
	expect(response.status, body).toBe(200);
	if (response.headers.get("content-type")?.includes("text/event-stream")) {
		const data = body
			.split("\n")
			.find((line) => line.startsWith("data: "))
			?.slice("data: ".length);
		expect(data).toBeDefined();
		return JSON.parse(data!);
	}
	return JSON.parse(body);
}

describe("stateless MCP v2 handler", () => {
	it("fails closed when OAuth application props are absent", async () => {
		const response = await McpApiHandler.fetch(
			mcpRequest("tools/list"),
			mockEnv as any,
			oauthExecutionContext(),
		);

		expect(response.status).toBe(401);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("lists only the tools authorized for each isolated principal", async () => {
		const [regular, arbitraryLogin, privileged] = await Promise.all([
			mcpJson(mockProps, "tools/list"),
			mcpJson({ ...mockProps, login: "coleam00", permissions: [] }, "tools/list"),
			mcpJson(mockPrivilegedProps, "tools/list"),
		]);

		const regularNames = regular.result.tools.map((tool: { name: string }) => tool.name);
		const privilegedNames = privileged.result.tools.map((tool: { name: string }) => tool.name);
		expect(regularNames).toEqual(["listTables", "queryDatabase"]);
		expect(arbitraryLogin.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["listTables", "queryDatabase"]);
		expect(privilegedNames).toEqual(["listTables", "queryDatabase", "executeDatabase"]);
	});

	it("calls a registered tool and preserves the read-only permission boundary", async () => {
		const response = await mcpJson(mockProps, "tools/call", {
			arguments: { sql: "DELETE FROM users" },
			name: "queryDatabase",
		});

		expect(response.result.isError).toBe(true);
		expect(response.result.content[0].text).toContain("Invalid SQL query");
	});

	it("does not expose the removed SSE route and rejects unsupported methods", async () => {
		const [sse, put] = await Promise.all([
			McpApiHandler.fetch(
				new Request("http://localhost:8792/sse", { headers: { host: "localhost:8792" }, method: "GET" }),
				mockEnv as any,
				oauthExecutionContext(mockProps),
			),
			McpApiHandler.fetch(
				new Request("http://localhost:8792/mcp", { headers: { host: "localhost:8792" }, method: "PUT" }),
				mockEnv as any,
				oauthExecutionContext(mockProps),
			),
		]);

		expect(sse.status).toBe(404);
		expect(put.status).toBe(405);
	});
});
