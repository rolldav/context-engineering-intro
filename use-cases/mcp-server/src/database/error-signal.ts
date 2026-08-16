const SAFE_POSTGRES_CODES = new Set(["08006", "23503", "23505", "40001", "40P01", "57014"]);

export type DatabaseErrorSignal = {
	category: "database_operation";
	code: string;
};

/** Extract only an allowlisted SQLSTATE; never serialize the driver error. */
export function databaseErrorSignal(error: unknown): DatabaseErrorSignal {
	let code = "unknown";
	try {
		if (typeof error === "object" && error !== null && "code" in error) {
			const candidate = Reflect.get(error, "code");
			if (typeof candidate === "string" && SAFE_POSTGRES_CODES.has(candidate)) code = candidate;
		}
	} catch {
		// Proxies/getters are untrusted; fail closed to the generic code.
	}
	return { category: "database_operation", code };
}

export function logDatabaseFailure(error: unknown): void {
	console.error("database_operation_failed", databaseErrorSignal(error));
}
