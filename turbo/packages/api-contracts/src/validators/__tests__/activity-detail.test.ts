import { expect, it } from "vitest";
import { logsByIdContract } from "../../contracts/logs";
import { activityDetailSchema } from "../logs";

it.each([undefined, "private diagnostic"])(
  "reads current Activity facts from old and new HTTP responses: %s",
  (error) => {
    const wire = logsByIdContract.getById.responses[200].parse({
      id: "a0000000-0000-4000-a000-000000000001",
      sessionId: null,
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
    const displayed = activityDetailSchema.parse(wire);
    expect(displayed).toStrictEqual({
      id: wire.id,
      sessionId: null,
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
