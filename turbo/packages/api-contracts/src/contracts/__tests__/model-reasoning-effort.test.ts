import { describe, expect, it } from "vitest";
import {
  chatThreadModelSelectionContract,
  chatEventsContract,
} from "../chat-threads";
import {
  modelSettingsSchema,
  withModelReasoningEffort,
  resolveRouteReasoningEffort,
  piThinkingLevelForEffort,
} from "../model-reasoning-effort";

const CODEX_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
const CLAUDE_EFFORTS = [
  "low",
  "medium",
  "high",
  "extra",
  "max",
  "ultracode",
] as const;

describe("chat reasoning effort capabilities", () => {
  it("keeps each model's override independent", () => {
    const settings = withModelReasoningEffort(
      { "gpt-6-astra": { effort: "ultra" } },
      { model: "claude-sonnet-5", effort: "extra" },
    );
    expect(settings).toStrictEqual({
      "gpt-6-astra": { effort: "ultra" },
      "claude-sonnet-5": { effort: "extra" },
    });
  });

  it("parses persisted settings of any catalog model in the effort vocabulary", () => {
    const stored = {
      "claude-sonnet-4-6": { effort: "max" },
      "claude-opus-4-8": { effort: "extra" },
      "deepseek-v4-pro": { effort: "high" },
      "gpt-5.5": { effort: "xhigh" },
      "future-model": { effort: "medium" },
    };
    expect(modelSettingsSchema.parse(stored)).toStrictEqual(stored);
  });

  it("preserves omission and Fast while rejecting reset on the wire", () => {
    const schema = chatThreadModelSelectionContract.update.body;
    expect(schema.parse({ model: "gpt-5.6-sol" })).not.toHaveProperty(
      "reasoningEffort",
    );
    expect(
      schema.safeParse({
        model: "gpt-5.6-sol",
        reasoningEffort: null,
        codexServiceTier: "fast",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ model: "gpt-5.6-sol", reasoningEffort: "none" })
        .success,
    ).toBe(false);
    expect(
      schema.parse({ model: "gpt-6-astra", reasoningEffort: "ultra" }),
    ).toMatchObject({ reasoningEffort: "ultra" });
    const message = {
      agentId: "agent-1",
      prompt: "Task",
      hasTextContent: true,
      userMessage: { version: 1, parts: [{ type: "text", text: "Task" }] },
    };
    expect(chatEventsContract.send.body.parse(message)).not.toHaveProperty(
      "runOptions",
    );
    expect(
      chatEventsContract.send.body.parse({
        ...message,
        runOptions: { reasoningEffort: "low", codexServiceTier: "fast" },
      }),
    ).toMatchObject({
      runOptions: { reasoningEffort: "low", codexServiceTier: "fast" },
    });
  });
});

describe("route effort preferences", () => {
  it.each([
    {
      model: "gpt-5.6-sol",
      effort: "ultra",
      efforts: CODEX_EFFORTS,
      defaultEffort: "max",
      piExecution: true,
      runtimeProviderType: "openai-api-key",
      expected: "max",
    },
    {
      model: "gpt-6-astra",
      effort: "ultra",
      efforts: CODEX_EFFORTS,
      defaultEffort: "max",
      piExecution: false,
      runtimeProviderType: "openai-api-key",
      expected: "ultra",
    },
    {
      model: "claude-sonnet-5",
      effort: "extra",
      efforts: CLAUDE_EFFORTS,
      defaultEffort: "high",
      piExecution: true,
      runtimeProviderType: "claude-code-oauth-token",
      expected: "extra",
    },
    {
      model: "claude-sonnet-5",
      effort: "ultracode",
      efforts: CLAUDE_EFFORTS,
      defaultEffort: "high",
      piExecution: true,
      runtimeProviderType: "claude-code-oauth-token",
      expected: "high",
    },
  ] as const)(
    "resolves $model $effort on $runtimeProviderType",
    ({ expected, ...args }) => {
      expect(resolveRouteReasoningEffort(args)).toBe(expected);
    },
  );

  it("follows the route's efforts and default", () => {
    const args = {
      model: "gpt-6-luna",
      effort: "medium",
      piExecution: false,
      runtimeProviderType: "openai-api-key",
    } as const;
    expect(
      resolveRouteReasoningEffort({
        ...args,
        efforts: ["low", "medium"],
        defaultEffort: "low",
      }),
    ).toBe("medium");
    expect(
      resolveRouteReasoningEffort({
        ...args,
        efforts: ["low", "high"],
        defaultEffort: "high",
      }),
    ).toBe("high");
  });

  it("maps Claude's product effort to Pi's level", () => {
    expect(piThinkingLevelForEffort("extra")).toBe("xhigh");
  });
});
