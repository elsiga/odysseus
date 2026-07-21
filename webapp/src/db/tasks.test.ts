import { describe, it, expect, beforeEach } from "vitest";
import { db } from "./db";
import { createTask, updateTask, deleteTask, liveTodayTasks } from "./repo/tasks";

beforeEach(async () => { await db.delete(); await db.open(); });

describe("task repo", () => {
  it("create journals to outbox with a dirty row + field ts", async () => {
    const t = await createTask({ title: "Buy milk", bucket: "today" });
    const row = await db.tasks.get(t.id);
    expect(row!._dirty).toBe(1);
    expect(row!._fieldTs?.title).toBeDefined();
    expect(await db.outbox.count()).toBeGreaterThan(0);
  });

  it("delete tombstones and drops from live list", async () => {
    const t = await createTask({ title: "X", bucket: "today" });
    await deleteTask(t.id);
    const live = await liveTodayTasks();
    expect(live.find((r) => r.id === t.id)).toBeUndefined();
  });

  it("never journals updatedAt/id/owner as synced fields (CRITICAL invariant)", async () => {
    const t = await createTask({ title: "Buy milk", bucket: "today" });
    const row = await db.tasks.get(t.id);
    const fieldTsKeys = Object.keys(row!._fieldTs ?? {});
    expect(fieldTsKeys).not.toContain("updatedAt");
    expect(fieldTsKeys).not.toContain("id");
    expect(fieldTsKeys).not.toContain("owner");

    const outboxRows = await db.outbox.where("entityId").equals(t.id).toArray();
    const patchFieldKeys = outboxRows.flatMap((r) => Object.keys(r.fields));
    expect(patchFieldKeys).not.toContain("updatedAt");
    expect(patchFieldKeys).not.toContain("id");
    expect(patchFieldKeys).not.toContain("owner");

    // Also verify updateTask (which always injects updatedAt into the patch) still
    // keeps updatedAt/id/owner out of the journaled fields.
    await updateTask(t.id, { title: "Buy oat milk" });
    const updatedRow = await db.tasks.get(t.id);
    const updatedFieldTsKeys = Object.keys(updatedRow!._fieldTs ?? {});
    expect(updatedFieldTsKeys).not.toContain("updatedAt");
    expect(updatedFieldTsKeys).not.toContain("id");
    expect(updatedFieldTsKeys).not.toContain("owner");
  });
});
