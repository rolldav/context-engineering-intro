import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
	captureException: vi.fn(() => "event-id"),
	captureMessage: vi.fn(() => "event-id"),
	setUser: vi.fn(),
	startNewTrace: vi.fn(async (callback: Function) => callback()),
	startSpan: vi.fn(async (_options: unknown, callback: Function) => callback({ setStatus: vi.fn() })),
}));

const database = vi.hoisted(() => ({
	unsafe: vi.fn(async () => [{ id: 1 }]),
}));

vi.mock("@sentry/cloudflare", () => sentry);
vi.mock("../../../src/database/utils", () => ({
	withDatabase: vi.fn(async (_url: string, operation: Function) => operation(database)),
	withReadOnlyDatabase: vi.fn(async (_url: string, operation: Function) => operation(database)),
}));

import { McpServer } from "@modelcontextprotocol/server";
import { registerDatabaseToolsWithSentry } from "../../../examples/database-tools-sentry";
import { mockEnv } from "../../mocks/oauth.mock";
import { mockProps } from "../../fixtures/auth.fixtures";

describe("Sentry database tool telemetry", () => {
	beforeEach(() => vi.clearAllMocks());

	it("records only non-reversible operation metadata and never raw SQL or identity", async () => {
		const server = new McpServer({ name: "test", version: "1.0.0" });
		const register = vi.spyOn(server, "registerTool");
		registerDatabaseToolsWithSentry(server, mockEnv as any, mockProps);
		const handler = register.mock.calls.find((call) => call[0] === "queryDatabase")?.[2] as Function;
		const sensitiveSql = "SELECT * FROM patients WHERE secret = 'do-not-log'";

		await handler({ sql: sensitiveSql });

		const telemetry = JSON.stringify(sentry.startSpan.mock.calls.map(([options]) => options));
		expect(telemetry).toContain("queryDatabase");
		expect(telemetry).toContain("operation_class");
		expect(telemetry).not.toContain(sensitiveSql);
		expect(telemetry).not.toContain("do-not-log");
		expect(telemetry).not.toContain(mockProps.login);
		expect(sentry.setUser).not.toHaveBeenCalled();
	});

	it("scrubs every Postgres error field before console and Sentry sinks", async () => {
		const server = new McpServer({ name: "test", version: "1.0.0" });
		const register = vi.spyOn(server, "registerTool");
		registerDatabaseToolsWithSentry(server, mockEnv as any, mockProps);
		const handler = register.mock.calls.find((call) => call[0] === "queryDatabase")?.[2] as Function;
		const markers = ["secret-message", "secret-detail", "secret-query", "secret-parameter", "secret-login", "secret-email"];
		const postgresError = Object.assign(new Error(markers[0]), {
			code: "23505",
			detail: markers[1],
			query: markers[2],
			parameters: [markers[3]],
			login: markers[4],
			email: markers[5],
		});
		database.unsafe.mockRejectedValueOnce(postgresError);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await handler({ sql: "SELECT * FROM patients" });

		const captured = JSON.stringify(sentry.captureMessage.mock.calls);
		for (const marker of markers) expect(captured).not.toContain(marker);
		expect(captured).toContain("database_operation_failed");
		expect(captured).toContain("23505");
		expect(sentry.captureException).not.toHaveBeenCalled();
		expect(consoleError).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Event ID");
		for (const marker of markers) expect(result.content[0].text).not.toContain(marker);
		consoleError.mockRestore();
	});
});
