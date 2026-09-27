import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
  getCanonicalModelDisplayName,
  type ModelProviderResponse,
  type OrgModelPolicy,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE } from "@okouai/api-contracts/contracts/errors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatThreadModelSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import type { KnownRunFailureReason } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  context,
  findButton,
  findEnabledButton,
  installRunChat,
  NEW_CHAT_PATH,
  promptEvent,
  queryButton,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000301";
const RUN_B = "a0000000-0000-4000-a000-000000000302";
const RUN_C = "a0000000-0000-4000-a000-000000000303";
const RUN_D = "a0000000-0000-4000-a000-000000000304";
const PROVIDER_ID = "e0000000-0000-4000-a000-000000000301";

function configureCodexSubscriptionPolicies(
  models: readonly SupportedRunModel[],
): void {
  configureModelPolicies(models, {
    credentialScope: "member",
    defaultModel: models[0],
    defaultProviderType: "codex-oauth-token",
    modelProviderId: PROVIDER_ID,
  });
}

function codexSubscriptionAccount(
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id: PROVIDER_ID,
    type: "codex-oauth-token",
    framework: "codex",
    secretName: "CHATGPT_ACCESS_TOKEN",
    authMethod: "oauth",
    secretNames: ["CHATGPT_ACCESS_TOKEN"],
    isDefault: true,
    selectedModel: null,
    subscriptionResetCredits: 1,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

function recoveryCard(): Promise<HTMLElement> {
  return screen.findByTestId("assistant-error-recovery");
}

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
    ...billingPlanCapabilities("limited-free-1"),
    supportByok: true,
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
    concurrencyLimit: 2,
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

interface StructuredFailureExpectation {
  readonly title: string;
  readonly action?: string;
  readonly picker?: boolean;
}

const STRUCTURED_FAILURE_EXPECTATIONS = {
  session_history_limit: {
    title: "This chat has reached its limit",
    action: "New chat",
  },
  guest_root_filesystem_full: {
    title: "This run ran out of space",
    action: "Try again",
  },
  execution_timeout: { title: "Time limit reached", action: "Continue" },
  insufficient_credits: {
    title: "Upgrade to Pro to run",
    action: "Upgrade to Pro",
  },
  provider_insufficient_credits: {
    title: "Your provider account needs more credit",
    action: "Open Model Providers",
  },
  invalid_api_key: {
    title: "The API key needs updating",
    action: "Open Model Providers",
  },
  invalid_credentials: {
    title: "Your model connection needs attention",
    action: "Open Model Providers",
  },
  terms_acceptance_required: {
    title: "Claude terms need acceptance",
    action: "Open Claude",
  },
  context_window_exceeded: {
    title: "This chat is too long",
    action: "New chat",
  },
  input_too_large: { title: "Your message is too large" },
  output_token_limit: {
    title: "The response reached its length limit",
    action: "Continue",
  },
  provider_rate_limited: {
    title: "Too many model requests right now",
    action: "Try again",
    picker: true,
  },
  provider_overloaded: {
    title: "This model is busy right now",
    action: "Try again",
    picker: true,
  },
  provider_stream_timeout: {
    title: "The model response timed out",
    action: "Try again",
    picker: true,
  },
  provider_queue_timeout: {
    title: "The model didn't start in time",
    action: "Try again",
    picker: true,
  },
  codex_access_program_unavailable: {
    title: "Codex access is temporarily unavailable",
    action: "Try again",
  },
  provider_server_error: {
    title: "The model provider had a temporary error",
    action: "Try again",
    picker: true,
  },
  response_connection_lost: {
    title: "The response was interrupted",
    action: "Try again",
    picker: true,
  },
  safety_policy_refusal: {
    title: "The model couldn't help with this request",
    picker: true,
  },
  reconnect_required: {
    title: "Reconnect your model account",
    action: "Open Model Providers",
  },
  unsupported_model: {
    title: "Selected model isn't available",
    action: "Try again",
    picker: true,
  },
  usage_limit: {
    title: "Model provider limit reached",
    action: "Try again",
    picker: true,
  },
} satisfies Record<KnownRunFailureReason, StructuredFailureExpectation>;

const STRUCTURED_FAILURE_CASES = Object.entries(
  STRUCTURED_FAILURE_EXPECTATIONS,
) as [KnownRunFailureReason, StructuredFailureExpectation][];

/** Every backend-owned failure gets concise copy and recovery on the card. */
test.each(STRUCTURED_FAILURE_CASES)(
  "Render structured failure %s without a recovery details dialog",
  async (failureReason, expected) => {
    configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
    if (failureReason === "insufficient_credits") {
      context.mocks.data.org({
        id: "org_structured_failure",
        name: "Structured Failure Workspace",
        role: "admin",
      });
      context.mocks.api(billingStatusContract.get, ({ respond }) => {
        return respond(200, limitedFreeBillingStatus());
      });
    }
    const providerMessage = `Raw provider diagnostic for ${failureReason}`;
    installRunChat({
      selectedModel: "gpt-5.6-sol",
      chatEvents: failedRunEvents(
        providerMessage,
        "gpt-5.6-sol",
        failureReason,
      ),
    });

    await setupPage({ context, path: RUN_PATH });
    await readyChat();
    await screen.findByText((text) => {
      return text.includes(expected.title);
    });
    const card = screen.getByTestId("assistant-error-card-shell");

    expect(card).toHaveTextContent(expected.title);
    expect(card).not.toHaveTextContent(providerMessage);
    expect(queryButton("View details", card)).not.toBeInTheDocument();
    const actionLabels = [
      ...queryAllByRoleFast("button", card).filter((control) => {
        return control.getAttribute("role") !== "combobox";
      }),
      ...queryAllByRoleFast("link", card),
    ].map((control) => {
      return control.textContent?.replace(/\s+/gu, " ").trim();
    });
    expect(actionLabels).toStrictEqual(
      expected.action === undefined ? [] : [expected.action],
    );
    expect(queryButton("Try again", card) !== null).toBe(
      expected.action === "Try again",
    );
    expect(queryButton("Continue", card) !== null).toBe(
      expected.action === "Continue",
    );
    expect(within(card).queryByRole("combobox") !== null).toBe(
      expected.picker === true,
    );
    const description = within(card).queryByTestId(
      "assistant-error-description",
    );
    expect(Boolean(description?.textContent?.trim())).toBe(
      failureReason !== "insufficient_credits",
    );
  },
);

test("shows configured Okou models when the Add Model switch is off", async () => {
  configureModelPolicies(
    ["okou-1.0-max", "okou-1.0-pro", "okou-1.0", "gpt-5.6-luna"],
    { defaultModel: "gpt-5.6-luna" },
  );
  installRunChat({ selectedModel: "gpt-5.6-luna" });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouModels]: false },
  });
  await readyChat();

  const user = userEvent.setup({ delay: null });
  await user.click(await composerModelTrigger("GPT 5.6 Luna"));
  const chatModels = await screen.findByRole("menu", {
    name: "Chat models",
  });
  const optionNames = queryAllByRoleFast("menuitemradio", chatModels).map(
    (option) => {
      return option.textContent ?? "";
    },
  );
  expect(
    optionNames.filter((name) => {
      return name.includes("Okou 1.0");
    }),
  ).toHaveLength(3);
  expect(
    optionNames.some((name) => {
      return name.includes("GPT 5.6 Luna");
    }),
  ).toBeTruthy();
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
  let sentDocument: MockChatEventInput["userMessage"];
  configureModelPolicies(["claude-sonnet-5"]);
  installRunChat({
    selectedModel: "claude-sonnet-5",
    onRunCreate: (body) => {
      sentDocument = body.userMessage;
    },
  });

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyChat();
  await expect(
    composerModelTrigger("Claude Sonnet 5"),
  ).resolves.toHaveTextContent("Claude Sonnet 5");
  await sendText("Preserve this model attribution");
  await expect(
    screen.findByText("Preserve this model attribution"),
  ).resolves.toBeVisible();
  expect(
    sentDocument?.parts.some((part) => {
      return part.type === "model" && part.selectedModel === "claude-sonnet-5";
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
  });

  await readyChat();
  expect(screen.getByText("Model changed to GPT 5.6 Luna")).toBeVisible();
  expect(screen.getByText("Fast mode on")).toBeVisible();
  expect(screen.getByText("Fast mode off")).toBeVisible();
  expect(
    screen.getAllByText(/Model changed to|Fast mode (?:on|off)/u),
  ).toHaveLength(3);
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
  const recovery = await recoveryCard();
  expect(recovery).toHaveTextContent("This model is busy right now");
  expect(queryButton("Try again", recovery)).toBeVisible();
  expect(recovery).not.toHaveTextContent(providerError);
});

test.each([
  [
    "BYOK balance",
    "provider_insufficient_credits",
    "Your connected model provider account has insufficient balance.",
    "Your provider account needs more credit",
    "Open Model Providers",
  ],
] as const)(
  "A structured provider failure (%s) shows concise inline recovery",
  async (_owner, failureReason, message, title, action) => {
    configureModelPolicies(["gpt-5.6-sol"]);
    installRunChat({
      selectedModel: "gpt-5.6-sol",
      chatEvents: failedRunEvents(message, "gpt-5.6-sol", failureReason),
    });

    await setupPage({ context, path: RUN_PATH });

    await readyChat();
    const card = await screen.findByRole("status");
    expect(card).toHaveTextContent(title);
    expect(queryButton(action, card)).toBeVisible();
    expect(queryButton("View details", card)).not.toBeInTheDocument();
    expect(queryButton("Upgrade to Pro")).not.toBeInTheDocument();
  },
);

test("Recover from a personal model account limit", async () => {
  const user = userEvent.setup({ delay: null });
  mockNow(new Date("2026-08-01T10:00:00.000Z"), context.signal);
  configureCodexSubscriptionPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
  context.mocks.data.personalModelProviders([
    codexSubscriptionAccount({
      selectedModel: "gpt-5.6-sol",
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 100,
          remainingPercent: 0,
          resetAt: "2026-08-02T12:00:00.000Z",
          windowSeconds: 18_000,
        },
        weekly: {
          usedPercent: 100,
          remainingPercent: 0,
          resetAt: "2026-08-08T12:00:00.000Z",
          windowSeconds: 604_800,
        },
      },
      subscriptionResetCredits: 2,
    }),
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
  const recovery = await recoveryCard();
  expect(recovery).toHaveTextContent("Codex limit reached");
  expect(recovery).toHaveTextContent(/5h resets/iu);
  expect(recovery).toHaveTextContent(/Week resets/iu);
  const description = within(recovery).getByTestId(
    "assistant-error-description",
  );
  expect(within(description).getByText(/5h resets/iu)).toBeVisible();
  expect(within(description).getByText(/Week resets/iu)).toBeVisible();
  const picker = within(recovery).getByRole("combobox");
  expect(picker).toBeVisible();

  // A usage limit keeps its retry whichever model is selected: another model on
  // the same exhausted account would hit the same limit, so the card cannot
  // treat a model switch as the way out.
  await expect(findEnabledButton("Try again", recovery)).resolves.toBeVisible();
  await user.click(picker);
  await user.click(await screen.findByRole("option", { name: "GPT 5.6 Luna" }));
  await expect(findEnabledButton("Try again", recovery)).resolves.toBeVisible();

  click(await findButton("Reset · 2 left"));

  await expect(screen.findByText("continue")).resolves.toBeVisible();
  await expect(findButton("Stop")).resolves.toBeVisible();
});

// Opening the thread reads the subscription before the limit exists. The card
// reports the usage the account has once the limit arrives, not that read.
test("Show the reset time for a limit reached while the thread is open", async () => {
  mockNow(new Date("2026-08-01T10:00:00.000Z"), context.signal);
  const runCreated = context.mocks.deferred<void>();
  configureCodexSubscriptionPolicies(["gpt-5.6-sol"]);
  context.mocks.data.personalModelProviders([
    codexSubscriptionAccount({ accountEmail: "current@example.com" }),
  ]);
  const lifecycle = installRunChat({
    selectedModel: "gpt-5.6-sol",
    onRunCreate: () => {
      runCreated.resolve();
    },
  });

  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await sendText("Keep analysing");
  await runCreated.promise;

  context.mocks.data.personalModelProviders([
    codexSubscriptionAccount({
      accountEmail: "current@example.com",
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 100,
          remainingPercent: 0,
          resetAt: "2026-08-01T12:00:00.000Z",
          windowSeconds: 18_000,
        },
        weekly: null,
      },
    }),
  ]);
  lifecycle.failRun("You've hit your usage limit.");

  const recovery = await recoveryCard();
  await expect(
    within(recovery).findByText(/^resets /iu),
  ).resolves.toBeInTheDocument();
  expect(recovery).toHaveTextContent(
    "Personal subscription current@example.com",
  );
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
  const recovery = await recoveryCard();
  const picker = within(recovery).getByRole("combobox");
  await user.click(picker);
  // Fast-capable models always carry their own Fast row, so each plain row is
  // addressed by its exact label rather than a shared prefix.
  await expect(
    screen.findByRole("option", { name: "GPT 5.6 Luna" }),
  ).resolves.toBeVisible();
  expect(
    screen.getByRole("option", { name: /^DeepSeek V4 Flash/iu }),
  ).toBeVisible();
  const paidOnlyOption = screen.getByRole("option", { name: "GPT 5.6 Sol" });
  expect(within(paidOnlyOption).getByText("Pro")).toBeVisible();
  await user.keyboard("{Escape}");

  click(await findButton("Try again"));

  await expect(screen.findByText("continue")).resolves.toBeVisible();
  await expect(findButton("Stop")).resolves.toBeVisible();
});

test("Reset the current route's active subscription account", async () => {
  const resets: string[] = [];
  const sent: unknown[] = [];
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(
      "You've hit your usage limit.",
      "gpt-5.6-sol",
      "usage_limit",
    ),
    onRunCreate: (body) => {
      sent.push(body);
    },
  });
  configureCodexSubscriptionPolicies(["gpt-5.6-sol"]);
  context.mocks.data.personalModelProviders([
    codexSubscriptionAccount({
      isActive: true,
      accountEmail: "current@example.com",
    }),
  ]);
  context.mocks.api(
    personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    ({ params, respond }) => {
      resets.push(params.id);
      return respond(200, { outcome: "reset" });
    },
  );
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: false },
  });
  await readyChat();
  await recoveryCard();
  await expect(
    screen.findByText("Personal subscription current@example.com"),
  ).resolves.toBeInTheDocument();
  expect(sent).toStrictEqual([]);
  click(await findButton("Reset · 1 left"));
  await expect(screen.findByText("continue")).resolves.toBeInTheDocument();
  expect(resets).toStrictEqual([PROVIDER_ID]);
  await waitFor(() => {
    expect(sent).toHaveLength(1);
  });
});

test("Show a disconnected subscription on the current route", async () => {
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(
      "You've hit your usage limit.",
      "gpt-5.6-sol",
      "usage_limit",
    ),
  });
  configureCodexSubscriptionPolicies(["gpt-5.6-sol"]);
  context.mocks.data.personalModelProviders([
    codexSubscriptionAccount({ needsReconnect: true }),
  ]);
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: false },
  });
  await readyChat();
  await recoveryCard();
  await expect(
    screen.findByText("Personal subscription disconnected"),
  ).resolves.toBeInTheDocument();
  expect(queryButton("Reset · 1 left")).toBeNull();
  await expect(findButton("Try again")).resolves.toBeEnabled();
});

test("Leave a usage limit neutral once the thread leaves the subscription", async () => {
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(
      "You've hit your usage limit.",
      "gpt-5.6-sol",
      "usage_limit",
    ),
  });
  configureModelPolicies(["gpt-5.6-sol"]);
  context.mocks.data.personalModelProviders([codexSubscriptionAccount()]);
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: false },
  });
  await readyChat();
  const recovery = await recoveryCard();
  expect(recovery).toHaveTextContent("Codex limit reached");
  expect(recovery).not.toHaveTextContent(/Personal subscription/iu);
  expect(queryButton("Reset · 1 left")).toBeNull();
  await expect(findButton("Try again")).resolves.toBeEnabled();
});

test("A failed subscription reset keeps the thread idle", async () => {
  const sent: unknown[] = [];
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents("You've hit your usage limit.", "gpt-5.6-sol"),
    onRunCreate: (body) => {
      sent.push(body);
    },
  });
  configureCodexSubscriptionPolicies(["gpt-5.6-sol"]);
  context.mocks.data.personalModelProviders([codexSubscriptionAccount()]);
  context.mocks.api(
    personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    ({ respond }) => {
      return respond(404, {
        error: {
          code: "NOT_FOUND",
          message: "This subscription account is unavailable.",
        },
      });
    },
  );
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: false },
  });
  await readyChat();
  await recoveryCard();
  click(await findButton("Reset · 1 left"));
  await expect(
    screen.findByText("This subscription account is unavailable."),
  ).resolves.toBeInTheDocument();
  expect(sent).toStrictEqual([]);
  expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
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
  const recovery = await recoveryCard();
  expect(recovery).toHaveTextContent("Time limit reached");
  expect(within(recovery).queryByRole("combobox")).toBeNull();
  expect(queryButton("Reset · 1 left", recovery)).toBeNull();

  const continueButton = queryButton("Continue", recovery);
  if (!continueButton) {
    throw new Error("Continue button was not visible");
  }
  click(continueButton);

  await waitFor(() => {
    expect(retriedPrompts).toStrictEqual(["continue"]);
    // The continue run carries the thread's model the same way a composer
    // message does, so the transcript can place it against the run history
    // without waiting for the server's copy of the event.
    expect(retriedMessages).toStrictEqual([
      expect.objectContaining({
        version: 1,
        parts: [
          { type: "text", text: "continue" },
          { type: "model", selectedModel: "gpt-5.6-sol" },
        ],
      }),
    ]);
  });
});

test.each(["AUTONOMY_BUDGET_EXHAUSTED"])(
  "Confirm continuation after an automatic run limit (%s)",
  async (error) => {
    const sentMessages: unknown[] = [];
    configureModelPolicies(["gpt-5.6-sol"]);
    installRunChat({
      selectedModel: "gpt-5.6-sol",
      chatEvents: [
        {
          id: "autonomy-error",
          eventType: "output.error",
          role: "assistant",
          content:
            "Maximum autonomous delegation depth reached. Send a new human message or confirm a permission request to continue.",
          error,
          seqId: 1,
          createdAt: "2026-08-01T10:00:01.000Z",
        },
      ],
      onRunCreate: (body) => {
        sentMessages.push(body.userMessage);
      },
    });

    await setupPage({ context, path: RUN_PATH });

    await readyChat();
    const recovery = await recoveryCard();
    expect(recovery).toHaveTextContent("Automatic run limit reached");
    expect(within(recovery).queryByRole("combobox")).toBeNull();
    expect(queryButton("Reset · 1 left", recovery)).toBeNull();

    const continueButton = queryButton("Continue", recovery);
    if (!continueButton) {
      throw new Error("Continue button was not visible");
    }
    click(continueButton);

    await expect(screen.findByText("continue")).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(sentMessages).toStrictEqual([
        {
          version: 1,
          parts: [
            { type: "text", text: "continue" },
            { type: "model", selectedModel: "gpt-5.6-sol" },
          ],
        },
      ]);
    });
  },
);

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
  // The card spins until the classification settles, so the preserved provider
  // text is what it settles on rather than what it starts from.
  await expect(screen.findByText(providerError)).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("This model is busy right now"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Switch model" }),
  ).not.toBeInTheDocument();
});

const UNSUPPORTED_MODEL_ERROR = JSON.stringify({
  type: "error",
  status: 400,
  error: {
    type: "invalid_request_error",
    message:
      "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
  },
});

// The card does not track which model failed. It offers the picker and a
// retry on whatever the thread selects, and holds the retry back while a model
// switch is still being written, because the retry runs on the persisted model.
test("Continue on a replacement model after the connected account rejects one", async () => {
  const user = userEvent.setup({ delay: null });
  const sentModels: (string | undefined)[] = [];
  const selectionWritten = context.mocks.deferred<void>();
  configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(UNSUPPORTED_MODEL_ERROR, "gpt-5.6-sol"),
    onRunCreate: (body) => {
      const model = body.userMessage?.parts.find((part) => {
        return part.type === "model";
      });
      sentModels.push(
        model?.type === "model" ? model.selectedModel : undefined,
      );
    },
  });
  context.mocks.api(
    chatThreadModelSelectionContract.update,
    async ({ respond }) => {
      await selectionWritten.promise;
      return respond(204);
    },
  );

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByText("Selected model isn't available"),
  ).resolves.toBeVisible();
  expect(queryButton("Reset · 1 left")).toBeNull();
  const recovery = await recoveryCard();
  await expect(findEnabledButton("Try again", recovery)).resolves.toBeVisible();

  const picker = within(recovery).getByRole("combobox");
  await user.click(picker);
  await user.click(await screen.findByRole("option", { name: "GPT 5.6 Luna" }));

  expect(picker).toHaveTextContent("GPT 5.6 Luna");
  await waitFor(() => {
    expect(queryButton("Try again", recovery)).toBeDisabled();
  });
  expect(sentModels).toHaveLength(0);

  selectionWritten.resolve();
  click(await findEnabledButton("Try again", recovery));

  await expect(screen.findByText("continue")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(sentModels).toStrictEqual(["gpt-5.6-luna"]);
  });
});
