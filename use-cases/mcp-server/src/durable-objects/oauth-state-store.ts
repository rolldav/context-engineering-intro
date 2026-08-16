import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { DurableObject } from "cloudflare:workers";

export type OAuthFlowRecord = {
	oauthReqInfo: AuthRequest;
	bindingHash: string;
};

type StoredRow = {
	payload: string;
	expires_at: number;
};

const FLOW_TTL_SECONDS = 600;

export class OAuthStateStore extends DurableObject<Env> {
	private ensureSchema(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS oauth_flow (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				payload TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			)
		`);
	}

	async put(record: OAuthFlowRecord, ttlSeconds: number): Promise<void> {
		if (ttlSeconds !== FLOW_TTL_SECONDS) {
			throw new Error(`OAuth flow TTL must be ${FLOW_TTL_SECONDS} seconds`);
		}
		this.ensureSchema();
		const expiresAt = Date.now() + ttlSeconds * 1000;
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO oauth_flow (id, payload, expires_at) VALUES (1, ?, ?)",
			JSON.stringify(record),
			expiresAt,
		);
		await this.ctx.storage.setAlarm(expiresAt);
	}

	async consume(bindingHash: string): Promise<AuthRequest | null> {
		if (!this.hasFlowTable()) return null;
		const row = this.ctx.storage.sql.exec<StoredRow>("SELECT payload, expires_at FROM oauth_flow WHERE id = 1").toArray()[0];
		if (!row) return null;
		if (row.expires_at <= Date.now()) {
			await this.clearStorage();
			return null;
		}

		let record: OAuthFlowRecord;
		try {
			record = JSON.parse(row.payload) as OAuthFlowRecord;
		} catch {
			await this.clearStorage();
			return null;
		}
		if (record.bindingHash !== bindingHash) return null;

		this.ctx.storage.sql.exec("DELETE FROM oauth_flow WHERE id = 1");
		await this.clearStorage();
		return record.oauthReqInfo;
	}

	async alarm(): Promise<void> {
		await this.clearStorage();
	}

	private async clearStorage(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	private hasFlowTable(): boolean {
		return (
			this.ctx.storage.sql
				.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_flow'")
				.toArray().length === 1
		);
	}
}
