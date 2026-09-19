import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  agentRunApiUsageProjectionSchema,
  initialAgentRunApiUsageProjection,
} from "../agent-run-api-usage";

function attempt() {
  return {
    id: randomUUID(),
    registeredAtMs: 1,
    observedAtMs: null,
    terminal: false,
    coverage: "unavailable" as const,
    tokens: { input: null, cacheRead: null, cacheCreation: null, output: null },
    evidenceLost: false,
    ambiguous: [],
  };
}

describe("agent Run API usage projection", () => {
  it("accepts explicit admission phases and a bounded attempted projection", () => {
    expect(
      agentRunApiUsageProjectionSchema.parse(
        initialAgentRunApiUsageProjection("no-inference"),
      ),
    ).toMatchObject({ phase: "no-inference", attempts: [] });
    expect(
      agentRunApiUsageProjectionSchema.parse({
        schemaVersion: 1,
        phase: "attempted",
        attempts: Array.from({ length: 8 }, attempt),
        overflow: true,
      }).attempts,
    ).toHaveLength(8);
  });

  it("rejects attempts in pre-provider phases and the ninth retained identity", () => {
    for (const projection of [
      {
        schemaVersion: 1,
        phase: "pending",
        attempts: [attempt()],
        overflow: false,
      },
      {
        schemaVersion: 1,
        phase: "attempted",
        attempts: [],
        overflow: false,
      },
      {
        schemaVersion: 1,
        phase: "attempted",
        attempts: Array.from({ length: 9 }, attempt),
        overflow: false,
      },
      {
        schemaVersion: 1,
        phase: "attempted",
        attempts: [
          { ...attempt(), id: "00000000-0000-4000-8000-000000000001" },
          { ...attempt(), id: "00000000-0000-4000-8000-000000000001" },
        ],
        overflow: false,
      },
      {
        schemaVersion: 1,
        phase: "attempted",
        attempts: [{ ...attempt(), terminal: true }],
        overflow: false,
      },
    ]) {
      expect(
        agentRunApiUsageProjectionSchema.safeParse(projection).success,
      ).toBe(false);
    }
  });
});
