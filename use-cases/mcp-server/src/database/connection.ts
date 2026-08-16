import postgres from "postgres";
import { logDatabaseFailure } from "./error-signal";

const dbInstances = new Map<string, postgres.Sql>();

/**
 * Get database connection singleton
 * Following the pattern from BASIC-DB-MCP.md but adapted for PostgreSQL with connection pooling
 */
export function getDb(databaseUrl: string): postgres.Sql {
	let dbInstance = dbInstances.get(databaseUrl);
	if (!dbInstance) {
		dbInstance = postgres(databaseUrl, {
			// Connection pool settings for Cloudflare Workers
			// Read and write credentials use separate pools. Two connections per
			// pool keeps the combined maximum (4) below the Worker limit of 6.
			max: 2,
			idle_timeout: 20,
			connect_timeout: 10,
			// Enable prepared statements for better performance
			prepare: true,
		});
		dbInstances.set(databaseUrl, dbInstance);
	}
	return dbInstance;
}

/** Close every cached pool during isolate teardown and in test cleanup. */
export async function closeDb(): Promise<void> {
	const instances = [...dbInstances.values()];
	dbInstances.clear();
	await Promise.all(instances.map(async (dbInstance) => {
		try {
			await dbInstance.end();
		} catch (error) {
			logDatabaseFailure(error);
		}
	}));
}
