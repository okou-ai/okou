import { modelMenuOption } from "./chat-model-menu-test-helpers.ts";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
  getCanonicalModelDisplayName,
  type OrgModelPolicy,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  CHAT_RUN_CODEX_ACCESS_PROGRAM_UNAVAILABLE_MESSAGE,
  CHAT_RUN_EXECUTION_TIMEOUT_MESSAGE,
} from "@okouai/api-contracts/contracts/errors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { runsByIdContract } from "@okouai/api-contracts/contracts/run-routes";
import type { KnownRunFailureReason } from "@okouai/api-contracts/contracts/run-failure-reasons";
import type { GetRunResponse } from "@okouai/api-contracts/contracts/runs";
import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersByTypeContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
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

function installRecoverySource(source: NonNullable<GetRunResponse["source"]>) {
  context.mocks.api(runsByIdContract.getById, ({ params, respond }) => {
    return respond(200, {
      runId: params.id,
      status: "failed",
      prompt: "Continue the analysis",
      appendSystemPrompt: null,
      createdAt: "2026-08-01T10:00:02.000Z",
      source,
    });
  });
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
    picker: true,
  },
  usage_limit: {
    title: "Codex limit reached",
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
    installRecoverySource({
      providerType: "built-in",
      runtimeProviderType: "openai-api-key",
      model: "gpt-5.6-sol",
      credentialScope: "org",
      account: { status: "unknown" },
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
    if (failureReason !== "insufficient_credits") {
      expect(description).toHaveTextContent(/\S/u);
    }
    expect(
      description?.classList.contains("line-clamp-2") ?? false,
    ).toBeFalsy();
    expect(description?.classList.contains("h-10") ?? false).toBeFalsy();
  },
);

async function selectComposerModel(
  user: ReturnType<typeof userEvent.setup>,
  currentModelName: string,
  nextModelName: string,
): Promise<void> {
  await user.click(await composerModelTrigger(currentModelName));
  const chatModels = await screen.findByRole("menu", {
    name: "Chat models",
  });
  await user.click(
    modelMenuOption((name) => {
      return name.includes(nextModelName);
    }, chatModels),
  );
}

test.each([{ enabled: false }, { enabled: true }])(
  "shows configured Okou models when the Add Model switch is $enabled",
  async ({ enabled }) => {
    configureModelPolicies(
      ["okou-1.0-max", "okou-1.0-pro", "okou-1.0", "gpt-5.6-luna"],
      { defaultModel: "gpt-5.6-luna" },
    );
    installRunChat({ selectedModel: "gpt-5.6-luna" });
    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.OkouModels]: enabled },
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
  },
);

describe("a model or speed change during an active run", () => {
  beforeEach(async () => {
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
    });

    await readyChat();
  });

  it("explains a model or speed change that will apply next", async () => {
    const user = userEvent.setup({ delay: null });
    expect(screen.getByText("Sol is still working.")).toBeVisible();
    await selectComposerModel(user, "GPT 5.6 Sol", "GPT 5.6 Luna");

    await expect(
      screen.findByText("Next run will use GPT 5.6 Luna"),
    ).resolves.toBeVisible();
    expect(screen.getByText("Active Sol request")).toBeVisible();
  });
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
    composerModelTrigger("Claude Sonnet 4.6"),
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
  const recovery = await recoveryCard();
  expect(recovery).toHaveTextContent("This model is busy right now");
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
  installRecoverySource({
    providerType: "built-in",
    runtimeProviderType: "openai-api-key",
    model: "gpt-5.6-sol",
    credentialScope: "org",
    account: { status: "unknown" },
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
  [
    "queue expiry",
    "provider_queue_timeout",
    "Oops, something went wrong. Please try again later.",
    "The model didn't start in time",
    "Try again",
  ],
  [
    "Codex access program",
    "codex_access_program_unavailable",
    CHAT_RUN_CODEX_ACCESS_PROGRAM_UNAVAILABLE_MESSAGE,
    "Codex access is temporarily unavailable",
    "Try again",
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

test("An unstructured terminal failure preserves its original diagnostic", async () => {
  const message = "The current model is unavailable.";
  configureModelPolicies(["gpt-5.6-sol"]);
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents(message, "gpt-5.6-sol"),
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  expect(screen.getByText(message)).toBeInTheDocument();
  expect(queryButton("Try again")).not.toBeInTheDocument();
  expect(queryButton("View details")).not.toBeInTheDocument();
});

test.each([
  [
    "provider_insufficient_credits",
    "Your connected model provider account has insufficient balance.",
    "Le compte du fournisseur de modèles manque de crédit",
  ],
  [
    undefined,
    "The current model is unavailable.",
    "Le modèle actuel est indisponible.",
  ],
  [
    undefined,
    "Oops, something went wrong. Please try again later.",
    "Une erreur s’est produite. Veuillez réessayer plus tard.",
  ],
  [
    "reconnect_required",
    "ChatGPT session needs reconnection. Reconnect ChatGPT (Codex) in Model Providers, then retry.",
    "Reconnectez votre compte de modèle",
  ],
  [
    "safety_policy_refusal",
    "The model provider rejected this request under its content safety policy. Retrying the same input will fail again. Try rephrasing the request, starting a new conversation, or switching to a different model.",
    "Le modèle n’a pas pu répondre à cette demande",
  ],
  [
    undefined,
    "Every built-in model route for this model is temporarily unavailable",
    "Toutes les routes intégrées de ce modèle sont temporairement indisponibles. Veuillez réessayer plus tard.",
  ],
  [
    undefined,
    "The model provider is temporarily unavailable. Please try again later.",
    "Le fournisseur de modèle est temporairement indisponible. Veuillez réessayer plus tard.",
  ],
] as const)(
  "Localize known run failures in French: %s / %s",
  async (failureReason, message, expected) => {
    configureModelPolicies(["gpt-5.6-sol"]);
    installRunChat({
      selectedModel: "gpt-5.6-sol",
      chatEvents: failedRunEvents(message, "gpt-5.6-sol", failureReason),
    });

    await setupPage({ context, path: RUN_PATH, locale: "fr-FR" });

    const card = await screen.findByRole("status");
    expect(card).toHaveTextContent(expected);
    expect(
      card.textContent?.includes("Cette exécution n’a pas pu se terminer"),
    ).toBe(failureReason === undefined);
    expect(queryButton("Voir les détails", card)).not.toBeInTheDocument();
    expect(queryButton("Réessayer", card)).not.toBeInTheDocument();
  },
);

test.each([
  [
    "invalid_credentials",
    "Claude Code subscription authentication failed. Reconnect Claude Code in Model Providers, then retry.\n\nReconnect Claude Code: https://app.example.test/?settings=model",
    "La connexion au modèle doit être vérifiée",
    "Ouvrir les fournisseurs de modèles",
    null,
  ],
  [
    "invalid_credentials",
    "Claude Code could not authenticate with the configured Anthropic API key. Update or replace the API key in Model Providers, then retry.\n\nOpen Model Providers: https://app.example.test/?settings=model",
    "La connexion au modèle doit être vérifiée",
    "Ouvrir les fournisseurs de modèles",
    null,
  ],
  [
    "invalid_credentials",
    "Claude Code could not authenticate with the configured Anthropic API key. Ask a workspace admin to update or replace the API key.\n\nShare with an admin: https://app.example.test/?settings=model",
    "La connexion au modèle doit être vérifiée",
    "Ouvrir les fournisseurs de modèles",
    null,
  ],
  [
    "terms_acceptance_required",
    "Claude Code requires acceptance of updated Consumer Terms and Privacy Policy. Sign in to https://claude.ai with the Claude account connected in Model Providers, accept the updated terms and policy, then retry.",
    "Les conditions de Claude doivent être acceptées",
    "Ouvrir Claude",
    "https://claude.ai",
  ],
] as const)(
  "Localize credential recovery inline in French: %s",
  async (reason, message, expected, action, url) => {
    configureModelPolicies(["gpt-5.6-sol"]);
    installRunChat({
      selectedModel: "gpt-5.6-sol",
      chatEvents: failedRunEvents(message, "gpt-5.6-sol", reason),
    });
    await setupPage({ context, path: RUN_PATH, locale: "fr-FR" });
    const card = await screen.findByRole("status");
    expect(card).toHaveTextContent(expected);
    expect(queryButton("Voir les détails", card)).not.toBeInTheDocument();
    const actionControl = [
      ...queryAllByRoleFast("button", card),
      ...queryAllByRoleFast("link", card),
    ].find((element) => {
      return element.textContent === action;
    });
    expect(actionControl).toBeInTheDocument();
    expect(actionControl?.getAttribute("href")).toBe(url);
    expect(queryButton("Réessayer", card)).not.toBeInTheDocument();
  },
);

test.each([
  ["The current model is unavailable.", "Le modèle actuel est indisponible."],
  [
    "Your connected model provider account has insufficient balance.",
    "Le solde du compte de votre fournisseur de modèle connecté est insuffisant.",
  ],
])(
  "Localize a balance error before the run completes: %s",
  async (error, expected) => {
    installRunChat({
      chatEvents: [
        promptEvent({
          id: "stream-prompt",
          runId: RUN_A,
          seqId: 1,
          text: "Hello",
        }),
        {
          ...assistantEvent({
            id: "stream-error",
            runId: RUN_A,
            seqId: 2,
            text: error,
          }),
          eventType: "output.error",
          content: null,
          error,
        },
      ],
    });
    await setupPage({ context, path: RUN_PATH, locale: "fr-FR" });
    const card = await screen.findByRole("status");
    expect(card).toHaveTextContent(expected);
    expect(queryButton("Voir les détails", card)).not.toBeInTheDocument();
    expect(queryButton("Réessayer", card)).not.toBeInTheDocument();
    expect(
      queryButton("Réinitialiser et réessayer", card),
    ).not.toBeInTheDocument();
  },
);

test("A Japanese chat keeps ordinary assistant output unchanged", async () => {
  const message = "The current model is unavailable.";
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "quote-prompt",
        runId: RUN_A,
        seqId: 1,
        text: "Quote this sentence",
      }),
      assistantEvent({
        id: "quote-answer",
        runId: RUN_A,
        seqId: 2,
        text: message,
      }),
      completedEvent({ id: "quote-completed", runId: RUN_A, seqId: 3 }),
    ],
  });
  await setupPage({ context, path: RUN_PATH, locale: "ja-JP" });
  await expect(screen.findByText(message)).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("現在のモデルは利用できません。"),
  ).not.toBeInTheDocument();
});

test.each([
  [
    "usage_limit",
    "You've hit your usage limit. Try again tomorrow.",
    "Limite Codex atteinte",
  ],
  [
    "provider_overloaded",
    "Selected model is at capacity. Please try a different model.",
    "Ce modèle est saturé pour le moment",
  ],
] as const)(
  "Keep inline recovery localized for %s",
  async (reason, message, title) => {
    configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
    installRunChat({
      selectedModel: "gpt-5.6-sol",
      chatEvents: failedRunEvents(message, "gpt-5.6-sol", reason),
    });
    await setupPage({ context, path: RUN_PATH, locale: "fr-FR" });
    const card = await screen.findByTestId("assistant-error-recovery");
    expect(card).toHaveTextContent(title);
    expect(queryButton("Voir les détails", card)).not.toBeInTheDocument();
    expect(queryButton("Réessayer", card)).toBeInTheDocument();
    expect(within(card).getByRole("combobox")).toBeInTheDocument();
  },
);

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
  const recovery = await recoveryCard();
  expect(recovery).toHaveTextContent("This model is busy right now");
  expect(queryButton("Try again", recovery)).toBeVisible();
  expect(recovery).not.toHaveTextContent(
    "Claude is overloaded and temporarily at capacity.",
  );
});

test("Recover from a personal model account limit", async () => {
  const user = userEvent.setup({ delay: null });
  mockNow(new Date("2026-08-01T10:00:00.000Z"), context.signal);
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
        weekly: {
          usedPercent: 100,
          remainingPercent: 0,
          resetAt: "2026-08-08T12:00:00.000Z",
          windowSeconds: 604_800,
        },
      },
      subscriptionResetCredits: 2,
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
  installRecoverySource({
    providerType: "codex-oauth-token",
    runtimeProviderType: null,
    model: "gpt-5.6-sol",
    credentialScope: "member",
    account: { status: "connected", id: PROVIDER_ID },
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
  expect(description).not.toHaveClass("line-clamp-2", "h-10");
  expect(within(description).getByText(/5h resets/iu)).toBeVisible();
  expect(within(description).getByText(/Week resets/iu)).toBeVisible();
  const picker = within(recovery).getByRole("combobox");
  expect(picker).toBeVisible();
  const actionGroup = picker.parentElement;
  expect(actionGroup).not.toBeNull();
  expect(actionGroup).toHaveClass("justify-end");
  const actionSlot = actionGroup?.parentElement;
  expect(actionSlot).toHaveClass("min-h-8", "justify-end");
  expect(actionSlot).not.toHaveClass("h-[72px]");
  expect(queryButton("Try again", recovery)).toBeNull();

  await user.click(picker);
  await user.click(await screen.findByRole("option", { name: "GPT 5.6 Luna" }));
  await expect(findEnabledButton("Try again", recovery)).resolves.toBeVisible();

  await user.click(picker);
  await user.click(await screen.findByRole("option", { name: "GPT 5.6 Sol" }));
  await waitFor(() => {
    expect(queryButton("Try again", recovery)).toBeNull();
  });

  click(await findButton("Reset · 2 left"));

  await expect(screen.findByText("continue")).resolves.toBeVisible();
  await expect(findButton("Stop")).resolves.toBeVisible();
});

// The divider is the only place the transcript says a recovery switch took
// effect, and it reads the run-model annotation on the input event. The
// continue run therefore has to carry the selection the card just wrote:
// without it the reader sees the new run start under the old model's history
// and waits for the server's copy of the event to say otherwise.
test("Announce a recovery model switch on the continue run", async () => {
  const user = userEvent.setup({ delay: null });
  const sentModels: (string | undefined)[] = [];
  configureModelPolicies(["gpt-5.6-luna", "gpt-5.6-sol"]);
  installRunChat({
    selectedModel: "gpt-5.6-luna",
    chatEvents: failedRunEvents(
      "Selected model is at capacity. Please try a different model.",
      "gpt-5.6-luna",
    ),
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
  const recovery = await recoveryCard();
  await user.click(within(recovery).getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: "GPT 5.6 Sol" }));

  click(await findButton("Try again"));

  await expect(screen.findByText("continue")).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("Model changed to GPT 5.6 Sol"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(sentModels).toStrictEqual(["gpt-5.6-sol"]);
  });
});

// The transcript's scroll result when this card resolves is a layout contract:
// jsdom reports the scroller as zero-height, so `isAtBottom` is trivially true
// here. `e2e/playwright/regressions/chat-card-scroll.ts` owns that result for
// the recovery card in Chromium and WebKit, including that the card keeps one
// mounted frame across this transition. This case covers what the page shows:
// a spinner while the run detail is held, then the resolved recovery copy.
// Showing the generic failure copy during the wait is what this replaced — it
// offered a details dialog whose contents, and whose model switch, changed
// once the classification landed.
test("Replace the failure card copy when recovery resolves", async () => {
  configureModelPolicies(["gpt-5.6-luna"]);
  installRunChat({
    selectedModel: "gpt-5.6-luna",
    chatEvents: failedRunEvents(
      "Selected model is at capacity. Please try a different model.",
      "gpt-5.6-luna",
    ),
  });
  const detailRequested = context.mocks.deferred<void>();
  const releaseDetail = context.mocks.deferred<void>();
  context.mocks.api(runsByIdContract.getById, async ({ params, respond }) => {
    detailRequested.resolve();
    await releaseDetail.promise;
    return respond(200, {
      runId: params.id,
      status: "failed",
      prompt: "Continue the analysis",
      appendSystemPrompt: null,
      source: {
        providerType: null,
        runtimeProviderType: null,
        model: null,
        credentialScope: null,
        account: { status: "unknown" },
      },
      createdAt: "2026-08-01T10:00:02.000Z",
    });
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await detailRequested.promise;
  const shell = await screen.findByTestId("assistant-error-card-shell");
  await expect(
    within(shell).findByTestId("assistant-error-card-loading"),
  ).resolves.toBeInTheDocument();
  // Neither copy is readable yet, and no dialog is reachable, so nothing the
  // reader can act on changes when the classification lands.
  expect(screen.getByText("This run couldn't finish")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(screen.queryByText("This model is busy right now")).toBeNull();
  expect(queryButton("View details", shell)).toBeNull();
  expect(screen.queryByTestId("assistant-error-recovery")).toBeNull();

  releaseDetail.resolve();

  const recovery = await within(shell).findByTestId("assistant-error-recovery");
  expect(
    within(recovery).getByText("This model is busy right now"),
  ).toBeInTheDocument();
  expect(screen.queryByText("This run couldn't finish")).toBeNull();
  expect(screen.queryByTestId("assistant-error-card-loading")).toBeNull();
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

test.each([false, true])(
  "Reset captured A with current API policy and accounts UI=%s",
  async (accountsEnabled) => {
    const resets: {
      readonly id: string;
      readonly runId: string | undefined;
    }[] = [];
    const reads: { readonly id: string; readonly runId: string | undefined }[] =
      [];
    const wrongResets: string[] = [];
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
    configureModelPolicies(["gpt-5.6-sol"]);
    installRecoverySource({
      providerType: "codex-oauth-token",
      runtimeProviderType: null,
      model: "gpt-5.6-sol",
      credentialScope: "member",
      account: { status: "connected", id: PROVIDER_ID },
    });
    context.mocks.api(
      personalModelProviderAccountsByIdContract.getById,
      ({ params, query, respond }) => {
        reads.push({ id: params.id, runId: query.runId });
        return respond(200, {
          id: PROVIDER_ID,
          modelProviderId: "e0000000-0000-4000-a000-000000000302",
          isActive: false,
          type: "codex-oauth-token",
          framework: "codex",
          secretName: "CHATGPT_ACCESS_TOKEN",
          authMethod: "oauth",
          secretNames: ["CHATGPT_ACCESS_TOKEN"],
          isDefault: false,
          selectedModel: null,
          accountEmail: "original-a@example.com",
          subscriptionResetCredits: 1,
          needsReconnect: false,
          lastRefreshErrorCode: null,
          createdAt: "2026-08-01T09:00:00.000Z",
          updatedAt: "2026-08-01T09:00:00.000Z",
        });
      },
    );
    context.mocks.api(
      personalModelProviderAccountsByIdContract.resetFailedRunSubscriptionUsage,
      ({ params, respond }) => {
        resets.push({ id: params.id, runId: params.runId });
        return respond(200, { outcome: "reset" });
      },
    );
    context.mocks.api(
      personalModelProvidersByTypeContract.resetSubscriptionUsage,
      ({ params, respond }) => {
        wrongResets.push(params.type);
        return respond(200, { outcome: "reset" });
      },
    );
    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: {
        [FeatureSwitchKey.OkouDebug]: false,
        [FeatureSwitchKey.PersonalModelProviderAccounts]: accountsEnabled,
      },
    });
    await readyChat();
    await recoveryCard();
    await expect(
      screen.findByText("Personal subscription original-a@example.com"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByLabelText("View Langfuse trace"),
    ).not.toBeInTheDocument();
    expect(sent).toStrictEqual([]);
    expect(resets).toStrictEqual([]);
    click(await findButton("Reset · 1 left"));
    await expect(screen.findByText("continue")).resolves.toBeInTheDocument();
    expect(resets).toStrictEqual([{ id: PROVIDER_ID, runId: RUN_A }]);
    expect(wrongResets).toStrictEqual([]);
    expect(
      reads.every((request) => {
        return request.id === PROVIDER_ID && request.runId === RUN_A;
      }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
  },
);

test.each(["unknown", "unavailable"] as const)(
  "Keep historical subscription failure with %s account neutral",
  async (status) => {
    const accountReads: string[] = [];
    installRunChat({
      selectedModel: "gpt-5.6-sol",
      chatEvents: failedRunEvents(
        "You've hit your usage limit.",
        "gpt-5.6-sol",
        "usage_limit",
      ),
    });
    configureModelPolicies(["gpt-5.6-sol"]);
    installRecoverySource({
      providerType: "codex-oauth-token",
      runtimeProviderType: null,
      model: "gpt-5.6-sol",
      credentialScope: "member",
      account: { status },
    });
    context.mocks.api(
      personalModelProviderAccountsByIdContract.getById,
      ({ params, respond }) => {
        accountReads.push(params.id);
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Resource not found" },
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
    await expect(
      screen.findByText(
        status === "unknown"
          ? "Personal subscription unverified"
          : "Personal subscription disconnected",
      ),
    ).resolves.toBeInTheDocument();
    expect(queryButton("Reset · 1 left")).toBeNull();
    expect(accountReads).toStrictEqual([]);
    await expect(findButton("Try again")).resolves.toBeEnabled();
  },
);

test("An old API cannot downgrade a verified recovery to a settings reset", async () => {
  const sent: unknown[] = [];
  const settingsResets: string[] = [];
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: failedRunEvents("You've hit your usage limit.", "gpt-5.6-sol"),
    onRunCreate: (body) => {
      sent.push(body);
    },
  });
  configureModelPolicies(["gpt-5.6-sol"]);
  context.mocks.data.personalModelProviders([
    {
      id: PROVIDER_ID,
      type: "codex-oauth-token",
      framework: "codex",
      secretName: "CHATGPT_ACCESS_TOKEN",
      authMethod: "oauth",
      secretNames: ["CHATGPT_ACCESS_TOKEN"],
      isDefault: false,
      selectedModel: null,
      subscriptionResetCredits: 1,
      needsReconnect: false,
      lastRefreshErrorCode: null,
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T09:00:00.000Z",
    },
  ]);
  installRecoverySource({
    providerType: "codex-oauth-token",
    runtimeProviderType: null,
    model: "gpt-5.6-sol",
    credentialScope: "member",
    account: { status: "connected", id: PROVIDER_ID },
  });
  context.mocks.api(
    personalModelProviderAccountsByIdContract.resetFailedRunSubscriptionUsage,
    ({ respond }) => {
      return respond(404, {
        error: {
          code: "NOT_FOUND",
          message: "This recovery endpoint is unavailable.",
        },
      });
    },
  );
  context.mocks.api(
    personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    ({ params, respond }) => {
      settingsResets.push(params.id);
      return respond(200, { outcome: "reset" });
    },
  );
  context.mocks.api(
    personalModelProvidersByTypeContract.resetSubscriptionUsage,
    ({ params, respond }) => {
      settingsResets.push(params.type);
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
  click(await findButton("Reset · 1 left"));
  await expect(
    screen.findByText("This recovery endpoint is unavailable."),
  ).resolves.toBeInTheDocument();
  expect(settingsResets).toStrictEqual([]);
  expect(sent).toStrictEqual([]);
  expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
});

test("A held or missing run detail leaves chat usable and reads only the latest failure", async () => {
  const detailGate = context.mocks.deferred<void>();
  const reads: string[] = [];
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    chatEvents: [
      promptEvent({
        id: "past-user",
        runId: RUN_B,
        seqId: 1,
        text: "Earlier work",
      }),
      assistantEvent({
        id: "past-answer",
        runId: RUN_B,
        seqId: 2,
        text: "Earlier answer",
      }),
      ...failedRunEvents("You've hit your usage limit.", "gpt-5.6-sol").map(
        (event) => {
          return { ...event, seqId: (event.seqId ?? 0) + 2 };
        },
      ),
    ],
  });
  configureModelPolicies(["gpt-5.6-sol"]);
  context.mocks.api(
    runsByIdContract.getById,
    async ({ params, respond, withSignal }) => {
      reads.push(params.id);
      await withSignal(detailGate.promise);
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Resource not found" },
      });
    },
  );
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: false },
  });
  await readyChat();
  expect(screen.getByText("Earlier answer")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
  expect(screen.getAllByLabelText("Copy message").length).toBeGreaterThan(0);
  await waitFor(() => {
    expect(reads).toStrictEqual([RUN_A]);
  });
  // The card waits on this read rather than showing copy it would replace.
  expect(
    screen.getByTestId("assistant-error-card-loading"),
  ).toBeInTheDocument();
  expect(screen.getByText("This run couldn't finish")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  detailGate.resolve();
  await expect(
    screen.findByText("Codex limit reached"),
  ).resolves.toBeInTheDocument();
  expect(queryButton("Reset · 1 left")).toBeNull();
  expect(reads).toStrictEqual([RUN_A]);
  const recovery = await recoveryCard();
  expect(queryButton("Try again", recovery)).toBeEnabled();
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
  const recovery = await recoveryCard();
  expect(recovery).toHaveTextContent("Time limit reached");
  expect(within(recovery).queryByRole("combobox")).toBeNull();
  expect(queryButton("Continue", recovery)).toBeVisible();
});

test.each(["AUTONOMY_BUDGET_EXHAUSTED", "autonomy_budget_exhausted"])(
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

test.each(["AUTONOMY_BUDGET_EXHAUSTED", "autonomy_budget_exhausted"])(
  "Retire an automatic run limit after the conversation continues (%s)",
  async (error) => {
    configureModelPolicies(["gpt-5.6-sol"]);
    installRunChat({
      selectedModel: "gpt-5.6-sol",
      chatEvents: [
        {
          id: "past-autonomy-error",
          eventType: "output.error",
          role: "assistant",
          content:
            "Maximum autonomous delegation depth reached. Send a new human message or confirm a permission request to continue.",
          error,
          seqId: 1,
          createdAt: "2026-08-01T10:00:01.000Z",
        },
        promptEvent({
          id: "continued-user",
          runId: RUN_A,
          seqId: 2,
          text: "Continue the analysis",
        }),
        assistantEvent({
          id: "continued-answer",
          runId: RUN_A,
          seqId: 3,
          text: "The analysis is complete.",
        }),
        completedEvent({ id: "continued-done", runId: RUN_A, seqId: 4 }),
      ],
    });

    await setupPage({ context, path: RUN_PATH });

    await readyChat();
    await expect(
      screen.findByText("The analysis is complete."),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByTestId("assistant-error-card-shell")).toBeNull();
    expect(screen.queryByTestId("assistant-error-recovery")).toBeNull();
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

// The rejection is permanent for the model that produced it, so the card holds
// the retry action back until the thread points at a different supported model.
// Both halves of that transition are the contract: the picker alone while the
// rejected model is still selected, and a working continue once it is not.
test("Continue on a replacement model after the connected account rejects one", async () => {
  const user = userEvent.setup({ delay: null });
  const sentModels: (string | undefined)[] = [];
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

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByText("Selected model isn't available"),
  ).resolves.toBeVisible();
  expect(queryButton("Reset · 1 left")).toBeNull();
  const recovery = await recoveryCard();
  expect(queryButton("Try again", recovery)).toBeNull();

  const picker = within(recovery).getByRole("combobox");
  await user.click(picker);
  expect(
    screen.queryByRole("option", { name: /^GPT 5\.6 Sol/iu }),
  ).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option", { name: "GPT 5.6 Luna" }));

  expect(picker).toHaveTextContent("GPT 5.6 Luna");
  expect(sentModels).toHaveLength(0);

  click(await findEnabledButton("Try again", recovery));

  await expect(screen.findByText("continue")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(sentModels).toStrictEqual(["gpt-5.6-luna"]);
  });
});

// A thread that never pinned a model is not a thread that switched away from
// one: continuing would re-resolve the same default the run already failed on,
// so a selection that merely differs from `failedModel` must not open the gate.
test("Withhold continue while the rejected run has no replacement selection", async () => {
  configureModelPolicies(["gpt-5.6-sol", "gpt-5.6-luna"]);
  installRunChat({
    selectedModel: null,
    chatEvents: failedRunEvents(UNSUPPORTED_MODEL_ERROR, "gpt-5.6-sol"),
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByText("Selected model isn't available"),
  ).resolves.toBeVisible();
  const recovery = await recoveryCard();
  expect(within(recovery).getByRole("combobox")).toBeVisible();
  expect(queryButton("Try again", recovery)).toBeNull();
  expect(queryButton("Reset · 1 left", recovery)).toBeNull();
});
