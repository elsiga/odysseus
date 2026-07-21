import { describe, it, expect } from "vitest";
import { compareHlc, hlcTimestamp } from "./hlc";

describe("hlc", () => {
  it("orders by ts then deviceId, strict", () => {
    const a = { ts: hlcTimestamp("2026-07-21T00:00:00.000Z", 2), deviceId: "d1" };
    const b = { ts: hlcTimestamp("2026-07-21T00:00:00.000Z", 1), deviceId: "d9" };
    expect(compareHlc(a, b)).toBe(1);
    expect(compareHlc(a, a)).toBe(0);
  });
});
