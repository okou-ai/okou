import { describe, expect, it } from "vitest";
import {
  chatThreadModelSelectionContract,
  chatEventsContract,
} from "../chat-threads";
import {
  defaultModelReasoningEffort,
  getModelReasoningEfforts,
  isModelReasoningEffortSupported,
  modelSettingsSchema,
  modelReasoningEffort,
  withModelReasoningEffort,
  resolveRouteReasoningEffort,
  piThinkingLevelForEffort,
} from "../model-reasoning-effort";

describe("chat reasoning effort capabilities", () => {
  it("keeps native CLI choices distinct from model defaults", () => {
    expect(getModelReasoningEfforts("gpt-5.6-sol")).toStrictEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(getModelReasoningEfforts("claude-fable-5-1")).toStrictEqual([
      "low",
      "medium",
      "high",
      "extra",
      "max",
      "ultracode",
    ]);
    expect(defaultModelReasoningEffort("gpt-5.6-sol")).toBe("max");
    expect(defaultModelReasoningEffort("deepseek-v4-flash")).toBe("high");
  });

  it("keeps each model's override independent", () => {
    const settings = withModelReasoningEffort(
      { "gpt-6-astra": { effort: "ultra" } },
      { model: "claude-sonnet-5", effort: "extra" },
    );
    expect(modelReasoningEffort("gpt-6-astra", settings)).toBe("ultra");
    expect(modelReasoningEffort("claude-sonnet-5", settings)).toBe("extra");
    expect(modelReasoningEffort("gpt-5.6-sol", settings)).toBe("max");
    expect(
      modelReasoningEffort("deepseek-v4.1-flash", settings),
    ).toBeUndefined();
    expect(modelReasoningEffort("deepseek-v4-flash", settings)).toBe("high");
    expect(
      modelSettingsSchema.safeParse({
        "deepseek-v4.1-flash": { effort: "high" },
      }).success,
    ).toBe(false);
    expect(
      modelSettingsSchema.safeParse({
        "deepseek-v4-flash": { effort: "low" },
      }).success,
    ).toBe(true);
    expect(
      modelSettingsSchema.safeParse({
        "gpt-5.6-sol": { effort: null },
      }).success,
    ).toBe(false);
  });

  it("recognizes native and provider-prefixed model identities", () => {
    expect(getModelReasoningEfforts("openai/gpt-5.6-terra")).toStrictEqual(
      getModelReasoningEfforts("gpt-5.6-terra"),
    );
    expect(
      getModelReasoningEfforts("anthropic/claude-fable-5.1"),
    ).toStrictEqual(getModelReasoningEfforts("claude-fable-5-1"));
    expect(
      isModelReasoningEffortSupported("anthropic/claude-sonnet-4.6", "max"),
    ).toBe(true);
    expect(getModelReasoningEfforts("claude-fable-5")).toStrictEqual([]);
    expect(getModelReasoningEfforts("future-model")).toStrictEqual([]);
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
      piExecution: true,
      runtimeProviderType: "openai-api-key",
      expected: "max",
    },
    {
      model: "gpt-6-astra",
      effort: "ultra",
      piExecution: false,
      runtimeProviderType: "openai-api-key",
      expected: "ultra",
    },
    {
      model: "claude-sonnet-5",
      effort: "extra",
      piExecution: true,
      runtimeProviderType: "anthropic-api-key",
      expected: "extra",
    },
    {
      model: "claude-sonnet-5",
      effort: "ultracode",
      piExecution: true,
      runtimeProviderType: "anthropic-api-key",
      expected: "high",
    },
    {
      model: "deepseek-v4-flash",
      effort: "low",
      piExecution: true,
      runtimeProviderType: "deepseek",
      expected: "low",
    },
    {
      model: "deepseek-v4-flash",
      effort: "low",
      piExecution: true,
      runtimeProviderType: "openrouter-codex",
      expected: "high",
    },
    {
      model: "deepseek-v4-pro",
      effort: "max",
      piExecution: true,
      runtimeProviderType: "openrouter-codex",
      expected: "high",
    },
    {
      model: "deepseek-v4-pro",
      effort: "xhigh",
      piExecution: true,
      runtimeProviderType: "openrouter-codex",
      expected: "xhigh",
    },
    {
      model: "deepseek-v4-pro",
      effort: "xhigh",
      piExecution: true,
      runtimeProviderType: "deepseek",
      expected: "high",
    },
    {
      model: "deepseek-v4-pro",
      effort: "max",
      piExecution: false,
      runtimeProviderType: "deepseek",
      expected: undefined,
    },
  ] as const)(
    "resolves $model $effort on $runtimeProviderType",
    ({ expected, ...args }) => {
      const settings = { [args.model]: { effort: args.effort } };
      expect(resolveRouteReasoningEffort(args)).toBe(expected);
      expect(modelReasoningEffort(args.model, settings)).toBe(args.effort);
    },
  );
  it("maps Claude's product effort to Pi's level", () => {
    expect(piThinkingLevelForEffort("extra")).toBe("xhigh");
  });
});
