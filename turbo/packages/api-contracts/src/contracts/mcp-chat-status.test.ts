import { describe, expect, it } from "vitest";

import { mcpChatLifecycleSchema } from "./mcp-chat-status";

const validLifecycles = [
  { phase: "idle", outcome: null, output: "none" },
  { phase: "queued", outcome: null, output: "pending" },
  { phase: "queued", outcome: null, output: "partial" },
  { phase: "running", outcome: null, output: "pending" },
  { phase: "running", outcome: null, output: "partial" },
  { phase: "finalizing", outcome: "completed", output: "pending" },
  { phase: "finalizing", outcome: "failed", output: "partial" },
  { phase: "finalizing", outcome: "timeout", output: "pending" },
  { phase: "finalizing", outcome: "cancelled", output: "partial" },
  { phase: "settled", outcome: "completed", output: "ready" },
  { phase: "settled", outcome: "failed", output: "none" },
  { phase: "settled", outcome: "timeout", output: "ready" },
  { phase: "settled", outcome: "cancelled", output: "none" },
  { phase: "settled", outcome: "rejected", output: "none" },
  { phase: "settled", outcome: "revoked", output: "none" },
  { phase: "unavailable", outcome: null, output: "unavailable" },
] as const;

const invalidLifecycles = [
  { phase: "idle", outcome: "failed", output: "none" },
  { phase: "queued", outcome: null, output: "ready" },
  { phase: "running", outcome: "completed", output: "partial" },
  { phase: "finalizing", outcome: "completed", output: "ready" },
  { phase: "settled", outcome: null, output: "none" },
  { phase: "settled", outcome: "rejected", output: "ready" },
  { phase: "unavailable", outcome: null, output: "pending" },
] as const;

describe("MCP chat lifecycle contract", () => {
  it.each(validLifecycles)("accepts $phase/$outcome/$output", (lifecycle) => {
    expect(mcpChatLifecycleSchema.parse(lifecycle)).toStrictEqual(lifecycle);
  });

  it.each(invalidLifecycles)("rejects $phase/$outcome/$output", (lifecycle) => {
    expect(mcpChatLifecycleSchema.safeParse(lifecycle).success).toBeFalsy();
  });
});
