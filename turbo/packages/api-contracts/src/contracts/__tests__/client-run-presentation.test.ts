import { expect, expectTypeOf, it } from "vitest";
import { logDetailForDisplay } from "../client-run-presentation";
import { logsByIdContract } from "../logs";

it.each([undefined, "private diagnostic"])(
  "projects Activity HTTP responses into the same structured business detail: %s",
  (error) => {
    const wire = logsByIdContract.getById.responses[200].parse({
      id: "a0000000-0000-4000-a000-000000000001",
      sessionId: null,
      agentId: null,
      displayName: "Failed task",
      framework: "codex",
      modelProvider: "codex-oauth-token",
      selectedModel: null,
      triggerSource: "web",
      status: "failed",
      prompt: "Research",
      appendSystemPrompt: null,
      error,
      failureReason: "usage_limit",
      createdAt: "2026-11-17T00:00:00Z",
      startedAt: null,
      completedAt: null,
    });
    const original = JSON.stringify(wire);
    const displayed = logDetailForDisplay(wire);
    expectTypeOf(displayed).not.toHaveProperty("error");
    expect(displayed).toStrictEqual({
      id: wire.id,
      sessionId: null,
      agentId: null,
      displayName: "Failed task",
      framework: "codex",
      modelProvider: "codex-oauth-token",
      selectedModel: null,
      triggerSource: "web",
      status: "failed",
      prompt: "Research",
      appendSystemPrompt: null,
      failureReason: "usage_limit",
      createdAt: wire.createdAt,
      startedAt: null,
      completedAt: null,
    });
    expect(JSON.stringify(wire)).toBe(original);
  },
);
