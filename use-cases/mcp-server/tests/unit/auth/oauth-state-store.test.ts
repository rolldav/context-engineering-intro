import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;

    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { OAuthStateStore, type OAuthFlowRecord } from "../../../src/durable-objects/oauth-state-store";

type Row = { payload: string; expires_at: number };

class FakeSql {
  row: Row | undefined;
  tableExists = false;
  createCount = 0;

  exec<T>(query: string, ...params: unknown[]): { toArray: () => T[] } {
    if (query.includes("CREATE TABLE")) {
      this.tableExists = true;
      this.createCount += 1;
    } else if (query.includes("INSERT OR REPLACE")) {
      this.row = { payload: params[0] as string, expires_at: params[1] as number };
    } else if (query.includes("DELETE FROM oauth_flow")) {
      const expiry = params[0] as number | undefined;
      if (expiry === undefined || (this.row && this.row.expires_at <= expiry)) this.row = undefined;
    }
    return {
      toArray: () => {
        if (query.includes("sqlite_master")) return this.tableExists ? ([{ name: "oauth_flow" }] as T[]) : [];
        return query.includes("SELECT payload") && this.row ? [this.row as T] : [];
      },
    };
  }
}

const oauthRequest: AuthRequest = {
  responseType: "code",
  clientId: "client-123",
  redirectUri: "https://client.example/callback",
  scope: ["mcp"],
  state: "client-state",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
};

describe("OAuthStateStore", () => {
  let sql: FakeSql;
  let setAlarm: ReturnType<typeof vi.fn>;
  let deleteAlarm: ReturnType<typeof vi.fn>;
  let deleteAll: ReturnType<typeof vi.fn>;
  let store: OAuthStateStore;
  const record: OAuthFlowRecord = { oauthReqInfo: oauthRequest, bindingHash: "binding-hash" };

  beforeEach(() => {
    sql = new FakeSql();
    setAlarm = vi.fn().mockResolvedValue(undefined);
    deleteAlarm = vi.fn().mockResolvedValue(undefined);
    deleteAll = vi.fn().mockImplementation(async () => {
      sql.row = undefined;
      sql.tableExists = false;
    });
    store = new OAuthStateStore({ storage: { sql, setAlarm, deleteAlarm, deleteAll } } as unknown as DurableObjectState, {} as Env);
  });

  it("requires the fixed ten-minute TTL and schedules expiry", async () => {
    const now = Date.now();
    await expect(store.put(record, 599)).rejects.toThrow("600 seconds");
    await store.put(record, 600);
    expect(setAlarm).toHaveBeenCalledOnce();
    expect(setAlarm.mock.calls[0][0]).toBeGreaterThanOrEqual(now + 600_000);
  });

  it("returns a record to exactly one consumer", async () => {
    await store.put(record, 600);
    const results = await Promise.all([
      store.consume("binding-hash"),
      store.consume("binding-hash"),
    ]);
    expect(results).toEqual([oauthRequest, null]);
    expect(deleteAlarm).toHaveBeenCalledOnce();
    expect(deleteAll).toHaveBeenCalledOnce();
  });

  it("does not create storage for a forged state or a replay", async () => {
    expect(await store.consume("forged-binding")).toBeNull();
    expect(sql.createCount).toBe(0);
    expect(deleteAll).not.toHaveBeenCalled();

    await store.put(record, 600);
    expect(sql.createCount).toBe(1);
    expect(await store.consume("binding-hash")).toEqual(oauthRequest);
    expect(await store.consume("binding-hash")).toBeNull();
    expect(sql.createCount).toBe(1);
  });

  it("preserves state after a wrong binding and removes expired state", async () => {
    await store.put(record, 600);
    expect(await store.consume("wrong-binding")).toBeNull();
    expect(await store.consume("binding-hash")).toEqual(oauthRequest);

    sql.tableExists = true;
    sql.row = { payload: JSON.stringify(record), expires_at: Date.now() - 1 };
    expect(await store.consume("binding-hash")).toBeNull();
    expect(sql.row).toBeUndefined();
  });
});
