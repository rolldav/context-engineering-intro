import postgres from "postgres";
import { getDb } from "./connection";

/**
 * Execute a database operation with proper connection management
 * Following the pattern from BASIC-DB-MCP.md but adapted for PostgreSQL
 */
export async function withDatabase<T>(
	databaseUrl: string,
	operation: (db: postgres.Sql) => Promise<T>
): Promise<T> {
	const db = getDb(databaseUrl);
	const startTime = Date.now();
	try {
		const result = await operation(db);
		const duration = Date.now() - startTime;
		console.log(`Database operation completed successfully in ${duration}ms`);
		return result;
	} catch (error) {
		// Do not log database errors here: Postgres error objects can contain raw
		// SQL, parameters and row data. The caller may emit a separately scrubbed
		// generic signal before returning a client-safe error.
		throw error;
	}
	// Note: With PostgreSQL connection pooling, we don't close individual connections
	// They're returned to the pool automatically. The pool is closed when the Durable Object shuts down.
}

/**
 * Execute through a dedicated read-only database credential and a PostgreSQL
 * READ ONLY transaction. The caller must never pass DATABASE_URL here.
 */
export async function withReadOnlyDatabase<T>(
	databaseUrl: string,
	operation: (db: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
	if (!databaseUrl) throw new Error("READ_ONLY_DATABASE_URL is required");
	const db = getDb(databaseUrl);
	return await db.begin("read only", async (transaction) => operation(transaction)) as T;
}
