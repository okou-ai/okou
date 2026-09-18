import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { webhookUsageEventContract } from "./webhooks";

function observation() {
  return {
    protocol: "x-resource-v1",
    idempotencyKey: randomUUID(),
    kind: "connector",
    provider: "x",
    category: "posts.read",
    quantity: 5,
    observedAt: "2026-09-16T23:59:59.999Z",
    resources: [
      { id: "9007199254740993", occurrences: 2 },
      { id: "0002", occurrences: 1 },
    ],
    remainder: [{ reason: "missing_id", quantity: 2 }],
  };
}

function parse(events: unknown[]) {
  return webhookUsageEventContract.send.body.safeParse({
    runId: randomUUID(),
    events,
  });
}

describe("X resource observation wire contract", () => {
  it("preserves exact IDs and counts repeated occurrences before remainder", () => {
    const event = observation();
    const parsed = parse([event]);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.events).toEqual([event]);
    }
    expect(parse([{ ...event, quantity: 4 }]).success).toBe(false);
  });

  it("accepts empty zero observations and count-only explained quantities", () => {
    expect(
      parse([{ ...observation(), quantity: 0, resources: [], remainder: [] }])
        .success,
    ).toBe(true);
    expect(
      parse([
        {
          ...observation(),
          category: "user.read",
          resources: [],
          remainder: [{ reason: "parse_fallback", quantity: 5 }],
        },
      ]).success,
    ).toBe(true);
  });

  it("requires normalized entries without losing multiplicity", () => {
    expect(
      parse([
        {
          ...observation(),
          resources: [
            { id: "1", occurrences: 2 },
            { id: "1", occurrences: 1 },
          ],
        },
      ]).success,
    ).toBe(false);
    expect(
      parse([
        {
          ...observation(),
          remainder: [
            { reason: "missing_id", quantity: 1 },
            { reason: "missing_id", quantity: 1 },
          ],
        },
      ]).success,
    ).toBe(false);
  });

  it.each(["", "1\n", "1\r", " 1", "1.0", "1e3", "１２", "1".repeat(33), 123])(
    "rejects non-exact resource identity %j",
    (id) => {
      expect(
        parse([
          {
            ...observation(),
            quantity: 1,
            resources: [{ id, occurrences: 1 }],
            remainder: [],
          },
        ]).success,
      ).toBe(false);
    },
  );

  it("checks conservation exactly even when component sums exceed safe integers", () => {
    const event = {
      ...observation(),
      quantity: Number.MAX_SAFE_INTEGER,
      resources: [{ id: "1", occurrences: Number.MAX_SAFE_INTEGER }],
      remainder: [],
    };
    expect(parse([event]).success).toBe(true);
    expect(
      parse([{ ...event, remainder: [{ reason: "missing_id", quantity: 1 }] }])
        .success,
    ).toBe(false);
    for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        parse([{ ...event, quantity: count, resources: [] }]).success,
      ).toBe(false);
    }
  });

  it.each([
    { protocol: "x-resource-v2" },
    { kind: "model" },
    { provider: "other" },
    { category: "tweet.read" },
    { category: "followers.read" },
    { scopeId: randomUUID() },
    { netQuantity: 0 },
    { observedAt: "2026-09-16T00:00:00+08:00" },
    { observedAt: "2026-02-30T00:00:00.000Z" },
    { observedAt: "2026-09-16T00:00:00.0001Z" },
    { remainder: [{ reason: "unverified_scope", quantity: 2 }] },
    { resources: [{ id: "1", occurrences: 3, namespace: "post" }] },
  ])("rejects unsupported or caller-authoritative fields %j", (override) => {
    expect(parse([{ ...observation(), ...override }]).success).toBe(false);
  });

  it("bounds identities over the whole batch, not only per event", () => {
    const event = {
      ...observation(),
      quantity: 500,
      resources: Array.from({ length: 500 }, (_, index) => {
        return {
          id: String(index),
          occurrences: 1,
        };
      }),
      remainder: [],
    };
    expect(
      parse([event, { ...event, idempotencyKey: randomUUID() }]).success,
    ).toBe(true);
    expect(parse([event, event, event]).success).toBe(false);
    expect(parse(Array.from({ length: 101 }, observation)).success).toBe(false);
  });

  it("retains the legacy protocol and requires a bounded UUID run for v1", () => {
    for (const kind of ["connector", "model", "image"]) {
      expect(
        parse([
          {
            idempotencyKey: randomUUID(),
            kind,
            provider: "x",
            category: "any",
            quantity: 2,
          },
        ]).success,
      ).toBe(true);
    }
    expect(
      webhookUsageEventContract.send.body.safeParse({
        runId: "unbounded-run-name",
        events: [observation()],
      }).success,
    ).toBe(false);
  });
});
