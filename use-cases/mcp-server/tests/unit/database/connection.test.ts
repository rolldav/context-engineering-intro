import { beforeEach, describe, expect, it, vi } from "vitest";

const { postgresMock, readPool, writePool } = vi.hoisted(() => {
	const readPool = Object.assign(vi.fn(), { end: vi.fn() });
	const writePool = Object.assign(vi.fn(), { end: vi.fn() });
	return {
		postgresMock: vi.fn((url: string) => url.includes("readonly") ? readPool : writePool),
		readPool,
		writePool,
	};
});

vi.mock("postgres", () => ({ default: postgresMock }));

import { closeDb, getDb } from "../../../src/database/connection";

describe("database connection pools", () => {
	beforeEach(async () => {
		await closeDb();
		vi.clearAllMocks();
	});

	it("keeps read-only and write credentials in distinct bounded pools", async () => {
		const readUrl = "postgresql://readonly@example/db";
		const writeUrl = "postgresql://writer@example/db";

		expect(getDb(readUrl)).toBe(readPool);
		expect(getDb(readUrl)).toBe(readPool);
		expect(getDb(writeUrl)).toBe(writePool);
		expect(postgresMock).toHaveBeenCalledTimes(2);
		expect(postgresMock).toHaveBeenNthCalledWith(1, readUrl, expect.objectContaining({ max: 2 }));
		expect(postgresMock).toHaveBeenNthCalledWith(2, writeUrl, expect.objectContaining({ max: 2 }));

		await closeDb();
		expect(readPool.end).toHaveBeenCalledOnce();
		expect(writePool.end).toHaveBeenCalledOnce();
	});

	it("emits only a scrubbed signal when pool close fails", async () => {
		getDb("postgresql://readonly@example/db");
		const markers = ["secret-message", "secret-detail", "secret-query"];
		readPool.end.mockRejectedValueOnce(Object.assign(new Error(markers[0]), {
			code: "08006",
			detail: markers[1],
			query: markers[2],
		}));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		await closeDb();

		const logged = JSON.stringify(consoleError.mock.calls);
		expect(logged).toContain("database_operation_failed");
		expect(logged).toContain("08006");
		for (const marker of markers) expect(logged).not.toContain(marker);
		consoleError.mockRestore();
	});
});
