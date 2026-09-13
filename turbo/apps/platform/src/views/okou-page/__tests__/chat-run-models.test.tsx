import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
  getCanonicalModelDisplayName,
  type OrgModelPolicy,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE } from "@okouai/api-contracts/contracts/errors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import {
  parseChatClipboardPayload,
  readClipboardItemText,
  readSingleRichClipboardWrite,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  context,
  findButton,
  installRunChat,
  NEW_CHAT_PATH,
  promptEvent,
  queryButton,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000301";
const RUN_B = "a0000000-0000-4000-a000-000000000302";
const RUN_C = "a0000000-0000-4000-a000-000000000303";
const RUN_D = "a0000000-0000-4000-a000-000000000304";
const PROVIDER_ID = "e0000000-0000-4000-a000-000000000301";

function configureModelPolicies(
  models: readonly SupportedRunModel[],
  options: {
    readonly credentialScope?: "member" | "org";
    readonly defaultModel?: SupportedRunModel;
    readonly defaultProviderType?: "built-in" | "codex-oauth-token";
    readonly modelProviderId?: string | null;
  } = {},
): void {
  const createdAt = "2026-08-01T09:00:00.000Z";
  const policies: OrgModelPolicy[] = models.map((model, index) => {
    return {
      id: `e0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
      model,
      modelLabel: getCanonicalModelDisplayName(model),
      isDefault: model === (options.defaultModel ?? models[0]),
      defaultProviderType: options.defaultProviderType ?? "built-in",
      credentialScope: options.credentialScope ?? "org",
      modelProviderId: options.modelProviderId ?? null,
      modelProviderSurfaceId: null,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt,
      updatedAt: createdAt,
    };
  });
  context.mocks.data.orgModelPolicies(policies);
}

function limitedFreeBillingStatus(): BillingStatusResponse {
  return {
    showUsagePack: false,
    tier: "limited-free-1",
    supportByok: false,
    restrictedBuiltInModels: true,
    credits: 0,
    onboardingPaymentPending: false,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

function failedRunEvents(
  error: string,
  model: SupportedRunModel,
  failureReason?: MockChatEventInput["failureReason"],
): MockChatEventInput[] {
  return [
    promptEvent({
      id: "failed-user",
      runId: RUN_A,
      seqId: 1,
      text: "Continue the analysis",
      model,
    }),
    {
      id: "failed-error",
      eventType: "run.failed",
      role: "assistant",
      content: null,
      runId: RUN_A,
      error,
      ...(failureReason === undefined ? {} : { failureReason }),
      runLifecycleEvent: "failed",
      seqId: 2,
      createdAt: "2026-08-01T10:00:02.000Z",
    },
  ];
}

async function selectComposerModel(
  user: ReturnType<typeof userEvent.setup>,
  currentModelName: string,
  nextModelName: string,
): Promise<void> {
  const picker = await screen.findByRole("combobox", {
    name: currentModelName,
  });
  await user.click(picker);
  await user.click(await screen.findByRole("option", { name: nextModelName }));
}

test("Explain a model or speed change that will apply next", async () => {
  const user = userEvent.setup({ delay: null });
  configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "next-model-user",
        runId: RUN_A,
        seqId: 1,
        text: "Active Sol request",
        model: "gpt-5.6-sol",
      }),
      assistantEvent({
        id: "next-model-progress",
        runId: RUN_A,
        seqId: 2,
        text: "Sol is still working.",
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
  });

  await readyChat();
  expect(screen.getByText("Sol is still working.")).toBeVisible();
  await selectComposerModel(user, "GPT 5.6 Sol", "GPT 5.6 Luna");

  await expect(
    screen.findByText("Next run will use GPT 5.6 Luna"),
  ).resolves.toBeVisible();
  expect(screen.getByText("Active Sol request")).toBeVisible();
});

test("Keep a next-run model choice through active-run steering", async () => {
  const runModels: (string | undefined)[] = [];
  configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
  const lifecycle = installRunChat({
    selectedModel: "gpt-5.6-luna",
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "steering-active-user",
        runId: RUN_A,
        seqId: 1,
        text: "Active Sol request",
        model: "gpt-5.6-sol",
      }),
      assistantEvent({
        id: "steering-active-progress",
        runId: RUN_A,
        seqId: 2,
        text: "Sol is still working.",
      }),
    ],
    onRunCreate: (body) => {
      const model = body.userMessage?.parts.find((part) => {
        return part.type === "model";
      });
      runModels.push(model?.type === "model" ? model.selectedModel : undefined);
    },
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
  });

  await readyChat();
  expect(screen.getByText("Sol is still working.")).toBeVisible();
  await expect(findButton("Stop")).resolves.toBeVisible();
  await expect(
    screen.findByText("Next run will use GPT 5.6 Luna"),
  ).resolves.toBeVisible();

  await sendText("Steer the current Sol work");

  await expect(
    screen.findByText("Steer the current Sol work"),
  ).resolves.toBeVisible();
  expect(screen.getByText("Next run will use GPT 5.6 Luna")).toBeVisible();
  expect(
    screen.queryByText("Model changed to GPT 5.6 Luna"),
  ).not.toBeInTheDocument();

  lifecycle.completeRun("Sol finished the current task.");
  await expect(
    screen.findByText("Sol finished the current task."),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(queryButton("Stop")).toBeNull();
  });
  await sendText("Start the next task");

  await expect(screen.findByText("Start the next task")).resolves.toBeVisible();
  await expect(
    screen.findByText("Model changed to GPT 5.6 Luna"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(runModels.at(-1)).toBe("gpt-5.6-luna");
  });
});

test("Preserve the current execution mode for an active-run follow-up", async () => {
  let followupFastMode: string | undefined;
  let followupModelChoice: string | null | undefined;
  configureModelPolicies(["gpt-5.6-sol"]);
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    codexServiceTier: "fast",
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "fast-active-user",
        runId: RUN_A,
        seqId: 1,
        text: "Active fast request",
        model: "gpt-5.6-sol",
        serviceTier: "priority",
      }),
      assistantEvent({
        id: "fast-active-progress",
        runId: RUN_A,
        seqId: 2,
        text: "Fast work is underway.",
      }),
    ],
    onQueuedEventAppend: (body) => {
      followupFastMode = body.runOptions?.codexServiceTier;
      followupModelChoice = body.modelSelection?.selectedModel;
    },
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
  });

  await readyChat();
  await sendText("Follow up in the same mode");

  await expect(
    screen.findByText("Follow up in the same mode"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(followupFastMode).toBe("fast");
  });
  expect(followupModelChoice).toBeUndefined();
  expect(
    screen.queryByText("Selected model isn't available"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Model changed to GPT 5.6 Sol"),
  ).not.toBeInTheDocument();
});

test("Preserve which model a message was sent with", async () => {
  const clipboard = context.mocks.browser.clipboardWrite();
  let sentDocument: MockChatEventInput["userMessage"];
  configureModelPolicies(["claude-sonnet-4-6"]);
  installRunChat({
    selectedModel: "claude-sonnet-4-6",
    onRunCreate: (body) => {
      sentDocument = body.userMessage;
    },
  });

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyChat();
  await expect(
    screen.findByRole("combobox", { name: "Claude Sonnet 4.6" }),
  ).resolves.toHaveTextContent("Claude Sonnet 4.6");
  await sendText("Preserve this model attribution");
  await expect(
    screen.findByText("Preserve this model attribution"),
  ).resolves.toBeVisible();
  expect(
    sentDocument?.parts.some((part) => {
      return (
        part.type === "model" && part.selectedModel === "claude-sonnet-4-6"
      );
    }),
  ).toBeTruthy();

  click(await findButton("Copy message"));

  const clipboardItem = await readSingleRichClipboardWrite(clipboard);
  const html = await readClipboardItemText(clipboardItem, "text/html");
  const copied = parseChatClipboardPayload(html);
  expect(copied.text).toContain("Preserve this model attribution");
  expect(
    copied.userMessage?.parts.some((part) => {
      return (
        part.type === "model" && part.selectedModel === "claude-sonnet-4-6"
      );
    }),
  ).toBeTruthy();
});

test("Mark model and speed transitions between runs", async () => {
  configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
  installRunChat({
    selectedModel: "gpt-5.6-luna",
    chatEvents: [
      promptEvent({
        id: "transition-a-user",
        runId: RUN_A,
        seqId: 1,
        text: "Run A",
        model: "gpt-5.6-sol",
      }),
      assistantEvent({
        id: "transition-a-answer",
        runId: RUN_A,
        seqId: 2,
        text: "Answer A",
      }),
      completedEvent({ id: "transition-a-complete", runId: RUN_A, seqId: 3 }),
      promptEvent({
        id: "transition-b-user",
        runId: RUN_B,
        seqId: 4,
        text: "Run B",
        model: "gpt-5.6-luna",
      }),
      assistantEvent({
        id: "transition-b-answer",
        runId: RUN_B,
        seqId: 5,
        text: "Answer B",
      }),
      completedEvent({ id: "transition-b-complete", runId: RUN_B, seqId: 6 }),
      promptEvent({
        id: "transition-c-user",
        runId: RUN_C,
        seqId: 7,
        text: "Run C",
        model: "gpt-5.6-luna",
        serviceTier: "priority",
      }),
      assistantEvent({
        id: "transition-c-answer",
        runId: RUN_C,
        seqId: 8,
        text: "Answer C",
      }),
      completedEvent({ id: "transition-c-complete", runId: RUN_C, seqId: 9 }),
      promptEvent({
        id: "transition-d-user",
        runId: RUN_D,
        seqId: 10,
        text: "Run D",
        model: "gpt-5.6-luna",
      }),
      assistantEvent({
        id: "transition-d-answer",
        runId: RUN_D,
        seqId: 11,
        text: "Answer D",
      }),
      completedEvent({ id: "transition-d-complete", runId: RUN_D, seqId: 12 }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.CodexFastMode]: true },
  });

  await readyChat();
  expect(screen.getByText("Model changed to GPT 5.6 Luna")).toBeVisible();
  expect(screen.getByText("Fast mode on")).toBeVisible();
  expect(screen.getByText("Fast mode off")).toBeVisible();
  expect(
    screen.getAllByText(/Model changed to|Fast mode (?:on|off)/u),
  ).toHaveLength(3);
});

test("A Codex capacity failure offers a neutral retry", async () => {
  configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(
      "Selected model is at capacity. Please try a different model.",
      "gpt-5.6-sol",
    ),
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  const recovery = await screen.findByRole("status");
  expect(recovery).toHaveTextContent("This model is busy right now");
  expect(recovery).toHaveTextContent("Try again shortly, or switch models.");
  expect(queryButton("Try again", recovery)).toBeVisible();
  expect(recovery).not.toHaveTextContent(
    "Selected model is at capacity. Please try a different model.",
  );
});

test("A structured capacity failure offers recovery despite generic provider text", async () => {
  const providerError = "The provider could not complete this run.";
  configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(
      providerError,
      "gpt-5.6-sol",
      "provider_overloaded",
    ),
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  const recovery = await screen.findByRole("status");
  expect(recovery).toHaveTextContent("This model is busy right now");
  expect(queryButton("Try again", recovery)).toBeVisible();
  expect(recovery).not.toHaveTextContent(providerError);
});

test("An unknown structured failure does not infer recovery from provider text", async () => {
  const providerError =
    "Selected model is at capacity. Please try a different model.";
  configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(
      providerError,
      "gpt-5.6-sol",
      "future_provider_condition",
    ),
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  expect(screen.getByText(providerError)).toBeVisible();
  expect(
    screen.queryByText("This model is busy right now"),
  ).not.toBeInTheDocument();
});

test("A Claude Code capacity failure offers a neutral retry", async () => {
  configureModelPolicies(["claude-opus-4-8", "gpt-5.6-luna"]);
  installRunChat({
    selectedModel: "claude-opus-4-8",
    chatEvents: failedRunEvents(
      "Claude is overloaded and temporarily at capacity.",
      "claude-opus-4-8",
    ),
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  const recovery = await screen.findByRole("status");
  expect(recovery).toHaveTextContent("This model is busy right now");
  expect(recovery).toHaveTextContent("Try again shortly, or switch models.");
  expect(queryButton("Try again", recovery)).toBeVisible();
  expect(recovery).not.toHaveTextContent(
    "Claude is overloaded and temporarily at capacity.",
  );
});

test("Recover from a personal model account limit", async () => {
  configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"], {
    credentialScope: "member",
    defaultModel: "gpt-5.6-sol",
    defaultProviderType: "codex-oauth-token",
    modelProviderId: PROVIDER_ID,
  });
  context.mocks.data.personalModelProviders([
    {
      id: PROVIDER_ID,
      type: "codex-oauth-token",
      framework: "codex",
      secretName: "CHATGPT_ACCESS_TOKEN",
      authMethod: "oauth",
      secretNames: ["CHATGPT_ACCESS_TOKEN"],
      isDefault: true,
      selectedModel: "gpt-5.6-sol",
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T09:00:00.000Z",
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 100,
          remainingPercent: 0,
          resetAt: "2026-08-02T12:00:00.000Z",
          windowSeconds: 18_000,
        },
        weekly: null,
      },
      subscriptionResetCredits: 1,
      needsReconnect: false,
      lastRefreshErrorCode: null,
    },
  ]);
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(
      "You've hit your usage limit. Try again at tomorrow noon.",
      "gpt-5.6-sol",
    ),
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  const recovery = await screen.findByRole("status");
  expect(recovery).toHaveTextContent("Codex limit reached");
  expect(recovery).toHaveTextContent(/resets/iu);
  expect(within(recovery).getByRole("combobox")).toBeVisible();

  click(await findButton("Reset and try again"));

  await expect(screen.findByText("continue")).resolves.toBeVisible();
  await expect(findButton("Stop")).resolves.toBeVisible();
});

test("Recover when a model is at capacity", async () => {
  const user = userEvent.setup({ delay: null });
  configureModelPolicies(["gpt-5.6-luna", "deepseek-v4-flash", "gpt-5.6-sol"]);
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, limitedFreeBillingStatus());
  });
  installRunChat({
    selectedModel: "gpt-5.6-luna",
    chatEvents: failedRunEvents(
      "Selected model is at capacity. Please try a different model.",
      "gpt-5.6-luna",
    ),
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  const recovery = await screen.findByRole("status");
  const picker = within(recovery).getByRole("combobox");
  await user.click(picker);
  await expect(
    screen.findByRole("option", { name: /^GPT 5\.6 Luna/iu }),
  ).resolves.toBeVisible();
  expect(
    screen.getByRole("option", { name: /^DeepSeek V4 Flash/iu }),
  ).toBeVisible();
  const paidOnlyOption = screen.getByRole("option", {
    name: /^GPT 5\.6 Sol/iu,
  });
  expect(within(paidOnlyOption).getByText("Pro")).toBeVisible();
  await user.keyboard("{Escape}");

  click(await findButton("Try again"));

  await expect(screen.findByText("continue")).resolves.toBeVisible();
  await expect(findButton("Stop")).resolves.toBeVisible();
});

test("Continue a run that reached its execution time limit", async () => {
  const retriedPrompts: (string | undefined)[] = [];
  const retriedMessages: unknown[] = [];
  configureModelPolicies(["gpt-5.6-sol"]);
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(
      CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE,
      "gpt-5.6-sol",
    ),
    onRunCreate: (body) => {
      retriedPrompts.push(body.prompt);
      retriedMessages.push(body.userMessage);
    },
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  const recovery = await screen.findByRole("status");
  expect(recovery).toHaveTextContent("Time limit reached");
  expect(recovery).toHaveTextContent(
    "This run reached its time limit. Continue to keep working.",
  );
  expect(within(recovery).queryByRole("combobox")).toBeNull();
  expect(queryButton("Reset and try again", recovery)).toBeNull();

  const continueButton = queryButton("Continue", recovery);
  if (!continueButton) {
    throw new Error("Continue button was not visible");
  }
  click(continueButton);

  await waitFor(() => {
    expect(retriedPrompts).toStrictEqual(["continue"]);
    expect(retriedMessages).toStrictEqual([
      expect.objectContaining({
        version: 1,
        parts: [{ type: "text", text: "continue" }],
      }),
    ]);
  });
});

test("Continue a run classified by a structured execution timeout reason", async () => {
  configureModelPolicies(["gpt-5.6-sol"]);
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(
      "execution: Agent execution timed out after 7200 seconds",
      "gpt-5.6-sol",
      "execution_timeout",
    ),
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  const recovery = await screen.findByRole("status");
  expect(recovery).toHaveTextContent("Time limit reached");
  expect(recovery).toHaveTextContent(
    "This run reached its time limit. Continue to keep working.",
  );
  expect(within(recovery).queryByRole("combobox")).toBeNull();
  expect(queryButton("Continue", recovery)).toBeVisible();
});

test("Preserve provider errors that have no guided recovery", async () => {
  const providerError =
    "Selected model capacity warning from a custom gateway; contact its operator.";
  configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(providerError, "gpt-5.6-sol"),
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  expect(screen.getByText(providerError)).toBeVisible();
  expect(
    screen.queryByText("This model is busy right now"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Switch model" }),
  ).not.toBeInTheDocument();
});

test("Switch away from a model rejected by the connected account", async () => {
  const user = userEvent.setup({ delay: null });
  const sentModels: (string | undefined)[] = [];
  const unsupportedError = JSON.stringify({
    type: "error",
    status: 400,
    error: {
      type: "invalid_request_error",
      message:
        "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    },
  });
  configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(unsupportedError, "gpt-5.6-sol"),
    onRunCreate: (body) => {
      const model = body.userMessage?.parts.find((part) => {
        return part.type === "model";
      });
      sentModels.push(
        model?.type === "model" ? model.selectedModel : undefined,
      );
    },
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByText("Selected model isn't available"),
  ).resolves.toBeVisible();
  expect(queryButton("Reset and try again")).toBeNull();
  expect(queryButton("Continue")).toBeNull();
  const recovery = await screen.findByRole("status");
  const picker = within(recovery).getByRole("combobox");
  await user.click(picker);
  expect(
    screen.queryByRole("option", { name: /^GPT 5\.6 Sol/iu }),
  ).not.toBeInTheDocument();
  await user.click(
    await screen.findByRole("option", { name: /^GPT 5\.6 Luna/iu }),
  );

  expect(picker).toHaveTextContent("GPT 5.6 Luna");
  expect(screen.getAllByText("Continue the analysis")).toHaveLength(1);
  expect(sentModels).toHaveLength(0);

  await sendText("Try a new instruction with Luna");

  await expect(
    screen.findByText("Try a new instruction with Luna"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(sentModels).toStrictEqual(["gpt-5.6-luna"]);
  });
});
