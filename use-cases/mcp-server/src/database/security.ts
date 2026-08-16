import type { SqlValidationResult } from "../types";

const WRITE_KEYWORDS = new Set([
	"ALTER",
	"ANALYZE",
	"CALL",
	"COPY",
	"CREATE",
	"DELETE",
	"DO",
	"DROP",
	"EXECUTE",
	"GRANT",
	"INSERT",
	"INTO",
	"MERGE",
	"REFRESH",
	"REINDEX",
	"REVOKE",
	"TRUNCATE",
	"UPDATE",
	"VACUUM",
]);

const SIDE_EFFECT_FUNCTIONS = new Set([
	"DBLINK_EXEC",
	"LO_IMPORT",
	"LO_UNLINK",
	"NEXTVAL",
	"PG_CANCEL_BACKEND",
	"PG_TERMINATE_BACKEND",
	"SET_CONFIG",
	"SETVAL",
]);

type ScannedSql = {
	error?: string;
	normalized: string;
	tokens: string[];
};

/**
 * Remove comments and quoted values before inspecting SQL structure. This is a
 * defense-in-depth lexer, not the primary read-only boundary: queryDatabase also
 * uses a dedicated read-only PostgreSQL role and a READ ONLY transaction.
 */
function scanSql(sql: string): ScannedSql {
	let normalized = "";
	let index = 0;
	let blockCommentDepth = 0;

	while (index < sql.length) {
		const current = sql[index];
		const next = sql[index + 1];

		if (blockCommentDepth > 0) {
			if (current === "/" && next === "*") {
				blockCommentDepth += 1;
				index += 2;
				continue;
			}
			if (current === "*" && next === "/") {
				blockCommentDepth -= 1;
				index += 2;
				continue;
			}
			index += 1;
			continue;
		}

		if (current === "-" && next === "-") {
			index += 2;
			while (index < sql.length && sql[index] !== "\n") index += 1;
			normalized += " ";
			continue;
		}

		if (current === "/" && next === "*") {
			blockCommentDepth = 1;
			index += 2;
			normalized += " ";
			continue;
		}

		if (current === "'" || current === '"') {
			const quote = current;
			index += 1;
			let closed = false;
			while (index < sql.length) {
				if (sql[index] === quote) {
					if (sql[index + 1] === quote) {
						index += 2;
						continue;
					}
					index += 1;
					closed = true;
					break;
				}
				index += 1;
			}
			if (!closed) return { error: "SQL contains an unterminated quoted value", normalized, tokens: [] };
			normalized += " VALUE ";
			continue;
		}

		if (current === "$") {
			const delimiterMatch = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
			if (delimiterMatch) {
				const delimiter = delimiterMatch[0];
				const contentStart = index + delimiter.length;
				const contentEnd = sql.indexOf(delimiter, contentStart);
				if (contentEnd === -1) {
					return { error: "SQL contains an unterminated dollar-quoted value", normalized, tokens: [] };
				}
				index = contentEnd + delimiter.length;
				normalized += " VALUE ";
				continue;
			}
		}

		normalized += current;
		index += 1;
	}

	if (blockCommentDepth > 0) {
		return { error: "SQL contains an unterminated block comment", normalized, tokens: [] };
	}

	const trimmed = normalized.trim();
	const firstSemicolon = trimmed.indexOf(";");
	if (firstSemicolon !== -1 && trimmed.slice(firstSemicolon + 1).trim() !== "") {
		return { error: "Only one SQL statement is allowed", normalized, tokens: [] };
	}
	if (firstSemicolon !== -1 && trimmed.indexOf(";", firstSemicolon + 1) !== -1) {
		return { error: "Only one SQL statement is allowed", normalized, tokens: [] };
	}

	const statement = firstSemicolon === -1 ? trimmed : trimmed.slice(0, firstSemicolon).trim();
	const tokens = statement.match(/[A-Za-z_][A-Za-z0-9_$]*/g)?.map((token) => token.toUpperCase()) ?? [];
	return { normalized: statement, tokens };
}

/** Validate general SQL input before a privileged execution path. */
export function validateSqlQuery(sql: string): SqlValidationResult {
	if (!sql.trim()) return { isValid: false, error: "SQL query cannot be empty" };
	const scanned = scanSql(sql);
	if (scanned.error) return { isValid: false, error: scanned.error };
	if (scanned.tokens.length === 0) return { isValid: false, error: "SQL query cannot be empty" };
	return { isValid: true };
}

/**
 * Validate a single read-only SELECT/CTE statement. PostgreSQL still enforces
 * the definitive boundary through a read-only credential and transaction.
 */
export function validateReadOnlySqlQuery(sql: string): SqlValidationResult {
	const base = validateSqlQuery(sql);
	if (!base.isValid) return base;

	const scanned = scanSql(sql);
	const firstToken = scanned.tokens[0];
	if (firstToken !== "SELECT" && firstToken !== "WITH") {
		return { isValid: false, error: "Only SELECT and read-only WITH queries are allowed" };
	}

	const forbidden = scanned.tokens.find(
		(token) => WRITE_KEYWORDS.has(token) || SIDE_EFFECT_FUNCTIONS.has(token),
	);
	if (forbidden) {
		return { isValid: false, error: "Query contains a write operation or side-effecting function" };
	}

	return { isValid: true };
}

/** Check whether SQL contains a write-capable operation anywhere in one statement. */
export function isWriteOperation(sql: string): boolean {
	const scanned = scanSql(sql);
	if (scanned.error) return true;
	return scanned.tokens.some((token) => WRITE_KEYWORDS.has(token) || SIDE_EFFECT_FUNCTIONS.has(token));
}
