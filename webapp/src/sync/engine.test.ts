import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db/db";
import { createTask } from "../db/repo/tasks";
import { createSyncClient } from "./engine";

beforeEach(async () => { await db.delete(); await db.open(); });

function fake(handlers: Record<string, (u: URL, i?: RequestInit) => any>) {
  return async (input: string, init?: RequestInit) => {
    const u = new URL(input, "http://t");
    const body = handlers[`${init?.method ?? "GET"} ${u.pathname}`](u, init);
    return { ok: true, status: 200, json: async () => body } as Response;
  };
}

describe("sync engine", () => {
  it("pushes dirty rows then clears outbox", async () => {
    const t = await createTask({ title: "Buy milk", bucket: "today" });
    let pushed: any = null;
    const fetchFn = fake({
      "POST /api/sync/push": (_u, i) => { pushed = JSON.parse(i!.body as string); return { applied: 1, serverSeq: 1 }; },
      "GET /api/sync/pull": () => ({ changes: [], cursor: 0, hasMore: false }),
    });
    const client = createSyncClient({ apiBase: "/api/sync", getToken: async () => null, fetchFn });
    await client.syncOnce();
    expect(pushed.patches[0].entityId).toBe(t.id);
    expect(pushed.patches[0].fields.title.v).toBe("Buy milk");
    expect(await db.outbox.count()).toBe(0);
  });

  it("applies a remote field only when its ts is newer (strict LWW)", async () => {
    const t = await createTask({ title: "local", bucket: "today" });
    // make the local row clean so pull may apply
    const row = await db.tasks.get(t.id); await db.tasks.put({ ...row!, _dirty: 0 });
    const newTs = "2999-01-01T00:00:00.000Z-000001";
    const fetchFn = fake({
      "POST /api/sync/push": () => ({ applied: 0, serverSeq: 0 }),
      "GET /api/sync/pull": (u) => Number(u.searchParams.get("cursor")) > 0
        ? { changes: [], cursor: 1, hasMore: false }
        : { changes: [{ seq: 1, entity: "task", entityId: t.id, fields: { title: { v: "remote wins", ts: newTs } } }], cursor: 1, hasMore: false },
    });
    const client = createSyncClient({ apiBase: "/api/sync", getToken: async () => null, fetchFn });
    await client.syncOnce();
    expect((await db.tasks.get(t.id))!.title).toBe("remote wins");
  });
});
