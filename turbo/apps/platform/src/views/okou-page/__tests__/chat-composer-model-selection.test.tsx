import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
  chatThreadDraftContract,
  chatThreadsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  type ModelProviderType,
  type OrgModelPolicy,
  type SupportedRunModel,
  getCanonicalModelDisplayName,
  getBuiltInConcreteProviderType,
  isBuiltInModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import {
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
  userModelPreferenceContract,
} from "@okouai/api-contracts/contracts/user-model-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  findButton,
  installRunChat,
  NEW_CHAT_PATH,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const POLICY_DATE = "2026-08-12T09:00:00.000Z";

interface PolicyOptions {
  readonly default?: boolean;
  readonly providerType?: ModelProviderType;
  readonly credentialScope?: "member" | "org";
}

function modelPolicy(
  model: SupportedRunModel,
  index: number,
  options: PolicyOptions = {},
): OrgModelPolicy {
  const providerType = options.providerType ?? "built-in";
  const credentialScope = options.credentialScope ?? "org";
  return {
    id: `e1000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
    model,
    modelLabel: getCanonicalModelDisplayName(model),
    isDefault: options.default ?? false,
    defaultProviderType: providerType,
    ...(isBuiltInModelProviderType(providerType)
      ? { runtimeProviderType: getBuiltInConcreteProviderType(model) }
      : {}),
    credentialScope,
    modelProviderId:
      credentialScope === "member"
        ? `e2000000-0000-4000-a000-${String(index).padStart(12, "0")}`
        : null,
    modelProviderSurfaceId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: POLICY_DATE,
    updatedAt: POLICY_DATE,
  };
}

function configurePolicies(
  models: readonly SupportedRunModel[],
  defaultModel: SupportedRunModel,
): void {
  context.mocks.data.orgModelPolicies(
    models.map((model, index) => {
      return modelPolicy(model, index + 1, {
        default: model === defaultModel,
      });
    }),
  );
}

function preference(
  selectedModel: SupportedRunModel,
  serviceTier: "priority" | null = null,
): UserModelPreferenceResponse {
  return {
    selectedModel,
    serviceTier,
    modelSettings: {},
    selectedVideoModel: null,
    selectedImageModel: null,
    updatedAt: POLICY_DATE,
  };
}

function installNewChat(
  models: readonly SupportedRunModel[],
  selectedModel: SupportedRunModel,
): void {
  installRunChat({ selectedModel });
  configurePolicies(models, models[0] ?? selectedModel);
  context.mocks.data.userModelPreference(preference(selectedModel));
}

async function modelPicker(name: string): Promise<HTMLElement> {
  return await screen.findByRole("combobox", { name });
}

async function readyComposer(): Promise<HTMLElement> {
  const composer = await screen.findByRole("textbox", { name: "Message" });
  expect(composer).toBeVisible();
  return composer;
}

async function chooseModel(
  user: ReturnType<typeof userEvent.setup>,
  currentLabel: string,
  optionName: string | RegExp,
): Promise<void> {
  await user.click(await modelPicker(currentLabel));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

function buttonNamed(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`Button ${name} was not visible`);
  }
  return button;
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

async function openCodexExecutionChat(): Promise<void> {
  installNewChat(["gpt-5.6-sol", "gpt-5.6-luna"], "gpt-5.6-sol");

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.CodexFastMode]: true,
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });

  await readyComposer();
}

test("Show and dismiss Fast Codex speed and credit guidance on hover", async () => {
  const user = userEvent.setup({ delay: null });
  await openCodexExecutionChat();
  await user.click(await modelPicker("GPT 5.6 Sol"));
  const fastOption = await screen.findByRole("option", {
    name: "GPT 5.6 Sol Fast",
  });
  await user.hover(fastOption);
  await expect(
    screen.findByText("Fast · 1.5× model speed · 2.5× credit usage"),
  ).resolves.toBeVisible();
  await user.unhover(fastOption);
  await waitFor(() => {
    expect(
      screen.queryByText("Fast · 1.5× model speed · 2.5× credit usage"),
    ).not.toBeInTheDocument();
  });
});

test("Choose Fast then Standard Codex execution before changing models", async () => {
  const user = userEvent.setup({ delay: null });
  await openCodexExecutionChat();
  await chooseModel(user, "GPT 5.6 Sol", "GPT 5.6 Sol Fast");
  await expect(modelPicker("GPT 5.6 Sol Fast")).resolves.toBeVisible();

  await user.click(await modelPicker("GPT 5.6 Sol Fast"));
  await user.click(
    await screen.findByRole("option", { name: "GPT 5.6 Sol Fast" }),
  );
  await expect(modelPicker("GPT 5.6 Sol")).resolves.toBeVisible();

  await chooseModel(user, "GPT 5.6 Sol", "GPT 5.6 Luna");
  await expect(modelPicker("GPT 5.6 Luna")).resolves.toBeVisible();
});

test("Make a temporary Codex speed the default", async () => {
  const user = userEvent.setup({ delay: null });
  const updateGate = createDeferredPromise<void>(context.signal);
  const responsePrepared = createDeferredPromise<void>(context.signal);
  let update: UpdateUserModelPreferenceRequest | undefined;
  installNewChat(["gpt-5.6-sol"], "gpt-5.6-sol");
  context.mocks.api(
    userModelPreferenceContract.update,
    async ({ body, respond }) => {
      update = body;
      await updateGate.promise;
      const nextPreference = preference("gpt-5.6-sol", "priority");
      context.mocks.data.userModelPreference(nextPreference);
      responsePrepared.resolve(undefined);
      return respond(200, nextPreference);
    },
  );

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.CodexFastMode]: true,
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });

  await readyComposer();
  await chooseModel(user, "GPT 5.6 Sol", "GPT 5.6 Sol Fast");
  const scopeCard = await screen.findByRole("group", {
    name: "Model for this chat",
  });
  expect(scopeCard).toHaveTextContent(
    "Temporarily switch to GPT 5.6 Sol · Fast",
  );
  const futureChats = buttonNamed("Use this for future chats", scopeCard);

  click(futureChats);
  await waitFor(() => {
    expect(update).toStrictEqual({
      selectedModel: "gpt-5.6-sol",
      serviceTier: "priority",
    });
    expect(futureChats).toHaveAttribute("aria-busy", "true");
  });

  updateGate.resolve(undefined);
  await responsePrepared.promise;
  triggerAblyEvent("userPreferenceChanged", { kinds: ["defaultModel"] });
  await waitFor(() => {
    expect(
      screen.queryByRole("group", { name: "Model for this chat" }),
    ).not.toBeInTheDocument();
  });
  await expect(modelPicker("GPT 5.6 Sol Fast")).resolves.toBeVisible();
});

test("Make a new-chat model choice the default immediately", async () => {
  const user = userEvent.setup({ delay: null });
  let update: UpdateUserModelPreferenceRequest | undefined;
  installNewChat(["claude-fable-5-1", "claude-sonnet-4-6"], "claude-fable-5-1");
  context.mocks.api(userModelPreferenceContract.update, ({ body, respond }) => {
    update = body;
    const nextPreference = preference("claude-sonnet-4-6");
    context.mocks.data.userModelPreference(nextPreference);
    return respond(200, nextPreference);
  });

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: false,
    },
  });

  await readyComposer();
  await chooseModel(user, "Claude Fable 5.1", /^Claude Sonnet 4\.6/iu);
  await waitFor(() => {
    expect(update).toStrictEqual({
      selectedModel: "claude-sonnet-4-6",
      serviceTier: null,
    });
  });
  await expect(modelPicker("Claude Sonnet 4.6")).resolves.toBeVisible();
  expect(
    screen.queryByRole("group", { name: "Model for this chat" }),
  ).not.toBeInTheDocument();
});

test("Temporarily choose a model for a new chat", async () => {
  const user = userEvent.setup({ delay: null });
  const updateGate = createDeferredPromise<void>(context.signal);
  const responsePrepared = createDeferredPromise<void>(context.signal);
  let update: UpdateUserModelPreferenceRequest | undefined;
  installNewChat(["claude-fable-5-1", "claude-sonnet-4-6"], "claude-fable-5-1");
  context.mocks.api(
    userModelPreferenceContract.update,
    async ({ body, respond }) => {
      update = body;
      await updateGate.promise;
      const nextPreference = preference("claude-sonnet-4-6");
      context.mocks.data.userModelPreference(nextPreference);
      responsePrepared.resolve(undefined);
      return respond(200, nextPreference);
    },
  );

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });

  await readyComposer();
  await chooseModel(user, "Claude Fable 5.1", /^Claude Sonnet 4\.6/iu);
  expect(update).toBeUndefined();
  const scopeCard = await screen.findByRole("group", {
    name: "Model for this chat",
  });
  expect(scopeCard).toHaveTextContent(
    "Temporarily switch to Claude Sonnet 4.6",
  );
  const futureChats = buttonNamed("Use this for future chats", scopeCard);

  click(futureChats);
  await waitFor(() => {
    expect(update).toStrictEqual({
      selectedModel: "claude-sonnet-4-6",
      serviceTier: null,
    });
    expect(futureChats).toHaveAttribute("aria-busy", "true");
  });

  updateGate.resolve(undefined);
  await responsePrepared.promise;
  triggerAblyEvent("userPreferenceChanged", { kinds: ["defaultModel"] });
  await waitFor(() => {
    expect(
      screen.queryByRole("group", { name: "Model for this chat" }),
    ).not.toBeInTheDocument();
  });
  await expect(modelPicker("Claude Sonnet 4.6")).resolves.toBeVisible();
});

test("Keep the model picker stable while settings refresh", async () => {
  const user = userEvent.setup({ delay: null });
  const refreshGate = createDeferredPromise<void>(context.signal);
  let preferenceRequestCount = 0;
  installNewChat(["claude-fable-5-1", "claude-sonnet-4-6"], "claude-fable-5-1");
  context.mocks.api(userModelPreferenceContract.get, async ({ respond }) => {
    preferenceRequestCount += 1;
    if (preferenceRequestCount > 1) {
      await refreshGate.promise;
    }
    return respond(200, preference("claude-fable-5-1"));
  });

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyComposer();
  await user.click(await modelPicker("Claude Fable 5.1"));
  await expect(
    screen.findByRole("option", { name: /^Claude Sonnet 4\.6/iu }),
  ).resolves.toBeVisible();

  triggerAblyEvent("userPreferenceChanged", { kinds: ["defaultModel"] });
  await waitFor(() => {
    expect(preferenceRequestCount).toBeGreaterThan(1);
  });
  expect(
    screen.getByRole("option", { name: /^Claude Sonnet 4\.6/iu }),
  ).toBeVisible();
  await expect(modelPicker("Claude Fable 5.1")).resolves.toHaveAttribute(
    "aria-expanded",
    "true",
  );

  refreshGate.resolve(undefined);
  await waitFor(() => {
    expect(
      screen.getByRole("option", { name: /^Claude Sonnet 4\.6/iu }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Claude Fable 5.1" }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});

test("Follow model preference changes made in another session", async () => {
  installNewChat(["claude-fable-5-1", "claude-opus-4-8"], "claude-fable-5-1");

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyComposer();
  await expect(modelPicker("Claude Fable 5.1")).resolves.toBeVisible();

  context.mocks.data.userModelPreference({
    ...preference("claude-opus-4-8"),
    selectedImageModel: "gpt-image-1",
  });
  triggerAblyEvent("userPreferenceChanged", {
    kinds: ["defaultModel", "defaultImageModel", "futurePreferenceKind"],
  });

  await expect(modelPicker("Claude Opus 4.8")).resolves.toBeVisible();
});

test("Explain model availability by plan and provider", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({ selectedModel: "deepseek-v4-flash" });
  context.mocks.data.userModelPreference(preference("deepseek-v4-flash"));
  context.mocks.data.orgModelPolicies([
    modelPolicy("deepseek-v4-flash", 1, { default: true }),
    modelPolicy("gpt-5.6-luna", 2),
    modelPolicy("gpt-5.6-sol", 3),
    modelPolicy("claude-fable-5-1", 4),
    modelPolicy("gpt-6-astra", 5),
    modelPolicy("claude-sonnet-4-6", 6, {
      providerType: "anthropic-api-key",
      credentialScope: "member",
    }),
  ]);
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, limitedFreeBillingStatus());
  });

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyComposer();
  await user.click(await modelPicker("DeepSeek V4 Flash"));
  await expect(
    screen.findByRole("option", { name: /^DeepSeek V4 Flash/iu }),
  ).resolves.toBeVisible();
  expect(
    screen.getByRole("option", { name: /^GPT 5\.6 Luna/iu }),
  ).toBeVisible();
  expect(
    screen.getByRole("option", { name: /^GPT 6 Astra.*Pro/iu }),
  ).toBeVisible();
  expect(screen.getAllByText("Pro")).toHaveLength(4);
  expect(screen.getByText("BYOK")).toBeVisible();

  await user.click(
    screen.getByRole("option", { name: /^Claude Fable 5\.1/iu }),
  );
  const planDialog = await screen.findByRole("dialog", {
    name: "Choose a plan",
  });
  expect(planDialog).toBeVisible();
  // The composer opened the upgrade flow, so dismissing it returns to the
  // composer instead of leaving the Settings billing tab open underneath.
  click(buttonNamed("Close", planDialog));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();
  });
  expect(
    screen.queryByRole("dialog", { name: "Settings" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "DeepSeek V4 Flash" }),
  ).toBeVisible();
});

test("Let an existing thread send while model availability is reconciling", async () => {
  const policyGate = createDeferredPromise<void>(context.signal);
  const sentPrompts: string[] = [];
  installRunChat({
    selectedModel: "claude-opus-5",
    onRunCreate: (body) => {
      if (body.prompt !== undefined) {
        sentPrompts.push(body.prompt);
      }
    },
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "Continue the saved analysis" }],
      },
      draftAttachments: null,
    });
  });
  context.mocks.api(modelPoliciesMainContract.list, async ({ respond }) => {
    await policyGate.promise;
    return respond(200, {
      policies: [],
      workspaceDefaultModel: null,
      workspaceDefaultPolicyId: null,
    });
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(composer).toHaveTextContent("Continue the saved analysis");
  });
  expect(
    screen.queryByText(
      "The selected model is not available. Configure it before sending.",
    ),
  ).not.toBeInTheDocument();

  click(await findButton("Send"));
  await waitFor(() => {
    expect(sentPrompts).toStrictEqual(["Continue the saved analysis"]);
  });

  policyGate.resolve(undefined);
  await expect(
    screen.findByText("Continue the saved analysis"),
  ).resolves.toBeVisible();
  expect(sentPrompts).toHaveLength(1);
});

test("Switch chat models immediately and adjust Fast from settings", async () => {
  installNewChat(["gpt-5.6-sol", "gpt-5.6-luna"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ModelPickerMenu]: true,
      [FeatureSwitchKey.CodexFastMode]: false,
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });
  await readyComposer();
  click(await findButton("GPT 5.6 Sol"));
  const overview = await screen.findByRole("region", { name: "Models" });
  click(buttonNamed("Change Chat model, GPT 5.6 Sol", overview));
  const list = await screen.findByRole("region", { name: "Chat models" });
  click(buttonNamed("GPT 5.6 Luna", list));
  await expect(findButton("GPT 5.6 Luna")).resolves.toBeVisible();
  const updated = screen.getByRole("region", { name: "Models" });
  expect(
    buttonNamed("Change Chat model, GPT 5.6 Luna", updated),
  ).toHaveTextContent("Standard");
  click(buttonNamed("Adjust GPT 5.6 Luna settings", updated));
  await screen.findByRole("region", { name: "Chat settings" });
  click(screen.getByRole("switch", { name: "Fast" }));
  await expect(findButton("GPT 5.6 Luna Fast")).resolves.toBeVisible();
  expect(screen.getByRole("switch", { name: "Fast" })).toBeChecked();
  click(
    buttonNamed(
      "Back to models",
      screen.getByRole("region", { name: "Chat settings" }),
    ),
  );
  const models = await screen.findByRole("region", { name: "Models" });
  expect(
    buttonNamed("Change Chat model, GPT 5.6 Luna", models),
  ).toHaveTextContent("Fast");
  click(buttonNamed("Change Chat model, GPT 5.6 Luna", models));
  const sameModelList = await screen.findByRole("region", {
    name: "Chat models",
  });
  click(buttonNamed("GPT 5.6 Luna", sameModelList));
  const selected = await screen.findByRole("region", { name: "Models" });
  await expect(findButton("GPT 5.6 Luna Fast")).resolves.toBeVisible();
  click(buttonNamed("Adjust GPT 5.6 Luna settings", selected));
  await screen.findByRole("region", { name: "Chat settings" });
  expect(screen.getByRole("switch", { name: "Fast" })).toBeChecked();
});

test("Keep immediate Fast changes when navigating back through the menu", async () => {
  const user = userEvent.setup({ delay: null });
  installNewChat(["gpt-5.6-sol", "gpt-5.6-luna"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ModelPickerMenu]: true,
      [FeatureSwitchKey.CodexFastMode]: false,
    },
  });
  await readyComposer();
  click(await findButton("GPT 5.6 Sol"));
  let overview = await screen.findByRole("region", { name: "Models" });
  click(buttonNamed("Adjust GPT 5.6 Sol settings", overview));
  await screen.findByRole("region", { name: "Chat settings" });
  click(screen.getByRole("switch", { name: "Fast" }));
  await expect(findButton("GPT 5.6 Sol Fast")).resolves.toBeVisible();
  await user.keyboard("{Escape}");
  overview = await screen.findByRole("region", { name: "Models" });
  expect(
    buttonNamed("Change Chat model, GPT 5.6 Sol", overview),
  ).toHaveTextContent("Fast");
  click(buttonNamed("Adjust GPT 5.6 Sol settings", overview));
  await screen.findByRole("region", { name: "Chat settings" });
  expect(screen.getByRole("switch", { name: "Fast" })).toBeChecked();
  click(screen.getByRole("switch", { name: "Fast" }));
  await expect(findButton("GPT 5.6 Sol")).resolves.toBeVisible();
  expect(screen.getByRole("switch", { name: "Fast" })).not.toBeChecked();
  click(
    buttonNamed(
      "Back to models",
      screen.getByRole("region", { name: "Chat settings" }),
    ),
  );
  overview = await screen.findByRole("region", { name: "Models" });
  click(buttonNamed("Change Chat model, GPT 5.6 Sol", overview));
  const list = await screen.findByRole("region", { name: "Chat models" });
  click(buttonNamed("GPT 5.6 Luna", list));
  await expect(findButton("GPT 5.6 Luna")).resolves.toBeVisible();
  overview = screen.getByRole("region", { name: "Models" });
  click(buttonNamed("Change Chat model, GPT 5.6 Luna", overview));
  await screen.findByRole("region", { name: "Chat models" });
  await user.keyboard("{Escape}");
  await screen.findByRole("region", { name: "Models" });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Models" }),
    ).not.toBeInTheDocument();
  });
  click(await findButton("GPT 5.6 Luna"));
  overview = await screen.findByRole("region", { name: "Models" });
  click(buttonNamed("Adjust GPT 5.6 Luna settings", overview));
  await screen.findByRole("region", { name: "Chat settings" });
  expect(screen.getByRole("switch", { name: "Fast" })).not.toBeChecked();
});

test("Keep unavailable routes disabled and open plan comparison from the compact menu", async () => {
  installNewChat(
    ["deepseek-v4-flash", "claude-fable-5-1", "gpt-5.6-sol"],
    "deepseek-v4-flash",
  );
  context.mocks.data.orgModelPolicies([
    modelPolicy("deepseek-v4-flash", 1, { default: true }),
    modelPolicy("claude-fable-5-1", 2),
    {
      ...modelPolicy("gpt-5.6-sol", 3),
      routeStatus: "missing_provider",
      routeStatusReason: "No provider available",
    },
  ]);
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, limitedFreeBillingStatus());
  });
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: { [FeatureSwitchKey.ModelPickerMenu]: true },
  });
  await readyComposer();
  click(await findButton("DeepSeek V4 Flash"));
  const overview = await screen.findByRole("region", { name: "Models" });
  click(buttonNamed("Change Chat model, DeepSeek V4 Flash", overview));
  const list = await screen.findByRole("region", { name: "Chat models" });
  expect(buttonNamed("GPT 5.6 Sol", list)).toBeDisabled();
  expect(buttonNamed("Claude Fable 5.1", list)).toHaveTextContent("Pro");
  click(buttonNamed("Claude Fable 5.1", list));
  const dialog = await screen.findByRole("dialog", { name: "Choose a plan" });
  click(buttonNamed("Close", dialog));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();
  });
  await expect(findButton("DeepSeek V4 Flash")).resolves.toBeVisible();
});

test("Navigate the compact menu by keyboard and retain Fast after dismissal", async () => {
  const user = userEvent.setup({ delay: null });
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 640px)";
  });
  installNewChat(["gpt-5.6-sol"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ModelPickerMenu]: true,
      [FeatureSwitchKey.CodexFastMode]: false,
    },
  });
  const composer = await readyComposer();
  click(await findButton("GPT 5.6 Sol"));
  const overview = await screen.findByRole("region", { name: "Models" });
  const modelButton = buttonNamed("Change Chat model, GPT 5.6 Sol", overview);
  const settingsButton = buttonNamed("Adjust GPT 5.6 Sol settings", overview);
  expect(modelButton).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(settingsButton).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByRole("region", { name: "Chat settings" });
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("switch", { name: "Fast" })).toHaveFocus();
  await user.keyboard(" ");
  await expect(findButton("GPT 5.6 Sol Fast")).resolves.toBeVisible();
  expect(screen.getByRole("switch", { name: "Fast" })).toBeChecked();
  await user.click(composer);
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Chat settings" }),
    ).not.toBeInTheDocument();
  });
  click(await findButton("GPT 5.6 Sol Fast"));
  const reopened = await screen.findByRole("region", { name: "Models" });
  click(buttonNamed("Adjust GPT 5.6 Sol settings", reopened));
  await screen.findByRole("region", { name: "Chat settings" });
  expect(screen.getByRole("switch", { name: "Fast" })).toBeChecked();
});

test("Choose a model from the flyout without leaving the type list", async () => {
  const user = userEvent.setup({ delay: null });
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 640px)";
  });
  installNewChat(["gpt-5.6-sol", "gpt-5.6-luna"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ModelPickerFlyout]: true,
      [FeatureSwitchKey.CodexFastMode]: false,
    },
  });
  await readyComposer();
  click(await findButton("GPT 5.6 Sol"));
  // One panel, no pages: every model is reachable without a drill-in step.
  const list = await screen.findByRole("listbox", { name: "Chat models" });
  expect(screen.queryByLabelText("Back to models")).not.toBeInTheDocument();
  const current = within(list).getByRole("option", { name: /GPT 5.6 Sol/u });
  expect(current).toHaveAttribute("aria-selected", "true");
  expect(current).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  const next = within(list).getByRole("option", { name: /GPT 5.6 Luna/u });
  expect(next).toHaveFocus();
  click(next);
  await expect(findButton("GPT 5.6 Luna")).resolves.toBeVisible();
  // Picking a model finishes the task, so the panel leaves with it.
  await waitFor(() => {
    expect(
      screen.queryByRole("listbox", { name: "Chat models" }),
    ).not.toBeInTheDocument();
  });
});

test("Choose effort for a new chat and keep Fast independent", async () => {
  const user = userEvent.setup({ delay: null });
  const creates: {
    reasoningEffort?: string | null;
    serviceTier?: string | null;
  }[] = [];
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    onThreadCreate: (body) => {
      creates.push(body);
    },
  });
  configurePolicies(["gpt-5.6-sol"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ModelPickerMenu]: true,
      [FeatureSwitchKey.ChatReasoningEffort]: true,
      [FeatureSwitchKey.CodexFastMode]: true,
      [FeatureSwitchKey.PiLoop]: false,
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });
  const composer = await readyComposer();
  click(await findButton("GPT 5.6 Sol"));
  click(
    buttonNamed(
      "Adjust GPT 5.6 Sol settings",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  const slider = await screen.findByRole("slider", {
    name: "Reasoning effort",
  });
  expect(slider).toHaveAttribute("aria-valuetext", "max");
  slider.focus();
  await user.keyboard("{Home}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "low");
  });
  for (const effort of ["medium", "high", "xhigh", "max", "ultra"]) {
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(slider).toHaveAttribute("aria-valuetext", effort);
    });
  }
  click(screen.getByRole("switch", { name: "Fast" }));
  await expect(findButton("GPT 5.6 Sol Fast")).resolves.toBeVisible();
  expect(slider).toHaveAttribute("aria-valuetext", "ultra");
  await user.click(composer);
  await fillComposer(composer, "Use this effort for the new task");
  click(await findButton("Send"));
  await waitFor(() => {
    expect(creates).toContainEqual(
      expect.objectContaining({
        reasoningEffort: "ultra",
        serviceTier: "priority",
      }),
    );
  });
});

test("Select the default effort on an existing thread without changing Fast", async () => {
  const user = userEvent.setup({ delay: null });
  const updates: {
    reasoningEffort?: string | null;
    codexServiceTier?: string | null;
  }[] = [];
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    reasoningEffort: "high",
    codexServiceTier: "fast",
    onModelSelectionUpdate: (body) => {
      updates.push(body);
    },
  });
  configurePolicies(["gpt-5.6-sol"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ModelPickerMenu]: true,
      [FeatureSwitchKey.ChatReasoningEffort]: true,
      [FeatureSwitchKey.CodexFastMode]: true,
      [FeatureSwitchKey.PiLoop]: false,
    },
  });
  await readyChat();
  click(await findButton("GPT 5.6 Sol Fast"));
  click(
    buttonNamed(
      "Adjust GPT 5.6 Sol settings",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  const slider = await screen.findByRole("slider", {
    name: "Reasoning effort",
  });
  expect(slider).toHaveAttribute("aria-valuetext", "high");
  slider.focus();
  await user.keyboard("{ArrowRight}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "xhigh");
  });
  await user.keyboard("{ArrowRight}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "max");
  });
  expect(screen.getByRole("switch", { name: "Fast" })).toBeChecked();
  await waitFor(() => {
    expect(updates).toContainEqual(
      expect.objectContaining({
        reasoningEffort: "max",
        codexServiceTier: "fast",
      }),
    );
  });
});

test("Keep independent effort selections when changing models", async () => {
  const user = userEvent.setup({ delay: null });
  installNewChat(
    ["claude-sonnet-5", "gpt-5.6-sol", "gpt-5.5"],
    "claude-sonnet-5",
  );
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ModelPickerMenu]: true,
      [FeatureSwitchKey.ChatReasoningEffort]: true,
      [FeatureSwitchKey.PiLoop]: false,
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });
  await readyComposer();
  click(await findButton("Claude Sonnet 5"));
  click(
    buttonNamed(
      "Adjust Claude Sonnet 5 settings",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  let slider = await screen.findByRole("slider", { name: "Reasoning effort" });
  expect(slider).toHaveAttribute("aria-valuetext", "High");
  slider.focus();
  await user.keyboard("{End}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "Max");
  });
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "Extra");
  });
  expect(screen.getByText("Extra")).toBeInTheDocument();
  expect(screen.queryByText("ultracode")).not.toBeInTheDocument();
  click(
    buttonNamed(
      "Back to models",
      screen.getByRole("region", { name: "Chat settings" }),
    ),
  );
  await expect(
    screen.findByRole("region", { name: "Models" }),
  ).resolves.toHaveTextContent("Extra");
  click(
    buttonNamed(
      "Change Chat model, Claude Sonnet 5",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  click(
    buttonNamed(
      "GPT 5.6 Sol",
      await screen.findByRole("region", { name: "Chat models" }),
    ),
  );
  click(
    buttonNamed(
      "Adjust GPT 5.6 Sol settings",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  slider = await screen.findByRole("slider", { name: "Reasoning effort" });
  expect(slider).toHaveAttribute("aria-valuetext", "max");
  slider.focus();
  await user.keyboard("{End}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "ultra");
  });
  click(
    buttonNamed(
      "Back to models",
      screen.getByRole("region", { name: "Chat settings" }),
    ),
  );
  click(
    buttonNamed(
      "Change Chat model, GPT 5.6 Sol",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  click(
    buttonNamed(
      "GPT 5.5",
      await screen.findByRole("region", { name: "Chat models" }),
    ),
  );
  click(
    buttonNamed(
      "Adjust GPT 5.5 settings",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  slider = await screen.findByRole("slider", { name: "Reasoning effort" });
  expect(slider).toHaveAttribute("aria-valuetext", "xhigh");
  slider.focus();
  await user.keyboard("{End}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "xhigh");
  });
  click(
    buttonNamed(
      "Back to models",
      screen.getByRole("region", { name: "Chat settings" }),
    ),
  );
  click(
    buttonNamed(
      "Change Chat model, GPT 5.5",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  click(
    buttonNamed(
      "Claude Sonnet 5",
      await screen.findByRole("region", { name: "Chat models" }),
    ),
  );
  click(
    buttonNamed(
      "Adjust Claude Sonnet 5 settings",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  await expect(
    screen.findByRole("slider", { name: "Reasoning effort" }),
  ).resolves.toHaveAttribute("aria-valuetext", "Extra");
});

test("Keep saved effort dormant when its feature is disabled", async () => {
  const updates: {
    codexServiceTier?: string | null;
    reasoningEffort?: string | null;
  }[] = [];
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    reasoningEffort: "high",
    onModelSelectionUpdate: (body) => {
      updates.push(body);
    },
  });
  configurePolicies(["gpt-5.6-sol"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ModelPickerMenu]: true,
      [FeatureSwitchKey.ChatReasoningEffort]: false,
      [FeatureSwitchKey.CodexFastMode]: true,
    },
  });
  await readyChat();
  click(await findButton("GPT 5.6 Sol"));
  click(
    buttonNamed(
      "Adjust GPT 5.6 Sol settings",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  await screen.findByRole("region", { name: "Chat settings" });
  expect(
    screen.queryByRole("slider", { name: "Reasoning effort" }),
  ).not.toBeInTheDocument();
  click(screen.getByRole("switch", { name: "Fast" }));
  await waitFor(() => {
    expect(screen.getByRole("switch", { name: "Fast" })).toBeChecked();
    expect(updates).toContainEqual(
      expect.objectContaining({ codexServiceTier: "fast" }),
    );
  });
  expect(
    updates.find((update) => {
      return update.codexServiceTier === "fast";
    })?.reasoningEffort,
  ).toBeUndefined();
});

test("Show the Pi fallback without overwriting a saved native preference", async () => {
  const updates: { reasoningEffort?: string | null }[] = [];
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    onModelSelectionUpdate: (body) => {
      updates.push(body);
    },
  });
  configurePolicies(["gpt-5.6-sol"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ModelPickerMenu]: true,
      [FeatureSwitchKey.ChatReasoningEffort]: true,
      [FeatureSwitchKey.PiLoop]: true,
    },
  });
  await readyChat();
  click(await findButton("GPT 5.6 Sol"));
  click(
    buttonNamed(
      "Adjust GPT 5.6 Sol settings",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  const settings = await screen.findByRole("region", { name: "Chat settings" });
  const slider = await screen.findByRole("slider", {
    name: "Reasoning effort",
  });
  expect(slider).toHaveAttribute("aria-valuetext", "max");
  expect(settings).not.toHaveTextContent("Restore model default");
  expect(updates).toStrictEqual([]);
});

test("Save the preferred effort for future chats when Pi displays a fallback", async () => {
  const user = userEvent.setup({ delay: null });
  const updates: UpdateUserModelPreferenceRequest[] = [];
  installNewChat(["claude-sonnet-5", "gpt-5.6-sol"], "claude-sonnet-5");
  context.mocks.data.userModelPreference({
    ...preference("claude-sonnet-5"),
    modelSettings: { "gpt-5.6-sol": { effort: "ultra" } },
  });
  context.mocks.api(userModelPreferenceContract.update, ({ body, respond }) => {
    updates.push(body);
    return respond(200, {
      ...preference("gpt-5.6-sol"),
      modelSettings: { "gpt-5.6-sol": { effort: "ultra" } },
    });
  });
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
      [FeatureSwitchKey.ModelPickerMenu]: true,
      [FeatureSwitchKey.ChatReasoningEffort]: true,
      [FeatureSwitchKey.PiLoop]: true,
    },
  });
  const composer = await readyComposer();
  click(await findButton("Claude Sonnet 5"));
  click(
    buttonNamed(
      "Change Chat model, Claude Sonnet 5",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  click(
    buttonNamed(
      "GPT 5.6 Sol",
      await screen.findByRole("region", { name: "Chat models" }),
    ),
  );
  click(
    buttonNamed(
      "Adjust GPT 5.6 Sol settings",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  await expect(
    screen.findByRole("slider", { name: "Reasoning effort" }),
  ).resolves.toHaveAttribute("aria-valuetext", "max");
  await user.click(composer);
  const scopeCard = await screen.findByRole("group", {
    name: "Model for this chat",
  });
  click(buttonNamed("Use this for future chats", scopeCard));
  await waitFor(() => {
    expect(updates).toContainEqual({
      selectedModel: "gpt-5.6-sol",
      serviceTier: null,
      modelSettingsPatch: { model: "gpt-5.6-sol", effort: "ultra" },
    });
  });
});

test("Follow model-scoped effort changes made in another session", async () => {
  const events: ChatThreadEvent[] = [];
  installRunChat({ selectedModel: "claude-sonnet-5", reasoningEffort: "high" });
  configurePolicies(["claude-sonnet-5"], "claude-sonnet-5");
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ModelPickerMenu]: true,
      [FeatureSwitchKey.ChatReasoningEffort]: true,
    },
  });
  await readyChat();
  click(await findButton("Claude Sonnet 5"));
  click(
    buttonNamed(
      "Adjust Claude Sonnet 5 settings",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  const slider = await screen.findByRole("slider", {
    name: "Reasoning effort",
  });
  expect(slider).toHaveAttribute("aria-valuetext", "High");
  for (const [reasoningEffort, displayValue] of [
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["extra", "Extra"],
    ["max", "Max"],
  ] as const) {
    events.push({
      id: crypto.randomUUID(),
      seqId: events.length + 1,
      kind: "model_selection_updated",
      chatThreadId: RUN_THREAD_ID,
      agentId: "c0000000-0000-4000-a000-000000000001",
      title: null,
      selectedModel: "claude-sonnet-5",
      modelSettingsPatch: {
        model: "claude-sonnet-5",
        effort: reasoningEffort,
      },
      serviceTier: null,
      computerUseHostId: null,
      selectedVideoModel: null,
      createdAt: POLICY_DATE,
    });
    changeChatThreadList();
    await waitFor(() => {
      expect(slider).toHaveAttribute("aria-valuetext", displayValue);
    });
  }
});

test("Adjust effort and Fast from the desktop flyout with keyboard controls", async () => {
  const user = userEvent.setup({ delay: null });
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 640px)";
  });
  installNewChat(["gpt-5.6-sol"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ModelPickerFlyout]: true,
      [FeatureSwitchKey.ChatReasoningEffort]: true,
      [FeatureSwitchKey.CodexFastMode]: true,
      [FeatureSwitchKey.PiLoop]: false,
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });
  await readyComposer();
  click(await findButton("GPT 5.6 Sol"));
  await screen.findByRole("listbox", { name: "Chat models" });
  click(await findButton("Adjust GPT 5.6 Sol settings"));
  const slider = await screen.findByRole("slider", {
    name: "Reasoning effort",
  });
  expect(slider).toHaveAttribute("aria-valuetext", "max");
  slider.focus();
  await user.keyboard("{End}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "ultra");
  });
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "max");
  });
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "xhigh");
  });
  click(screen.getByRole("switch", { name: "Fast" }));
  await expect(findButton("GPT 5.6 Sol Fast")).resolves.toBeVisible();
  expect(slider).toHaveAttribute("aria-valuetext", "xhigh");
  const settings = screen.getByRole("region", { name: "Chat settings" });
  slider.focus();
  await user.keyboard("{ArrowRight}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "max");
  });
  expect(screen.getByRole("switch", { name: "Fast" })).toBeChecked();
  click(buttonNamed("Back to models", settings));
  await screen.findByRole("listbox", { name: "Chat models" });
});

test.each([
  {
    model: "gpt-6-astra",
    providerType: "openai-api-key",
    first: "low",
    last: "ultra",
  },
  {
    model: "gpt-5.6-sol",
    providerType: "openai-api-key",
    first: "low",
    last: "max",
  },
  {
    model: "claude-sonnet-5",
    providerType: "anthropic-api-key",
    first: "Low",
    last: "Max",
  },
  {
    model: "deepseek-v4-flash",
    providerType: "deepseek",
    first: "low",
    last: "max",
  },
  {
    model: "deepseek-v4-pro",
    providerType: "deepseek",
    first: "high",
    last: "max",
  },
  {
    model: "deepseek-v4-flash",
    providerType: "openrouter-codex",
    first: "high",
    last: "xhigh",
  },
] as const)(
  "Offer $model efforts for $providerType with Pi enabled",
  async ({ model, providerType, first, last }) => {
    const user = userEvent.setup({ delay: null });
    installRunChat({ selectedModel: model });
    context.mocks.data.orgModelPolicies([
      modelPolicy(model, 1, { default: true, providerType }),
    ]);
    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: {
        [FeatureSwitchKey.ModelPickerMenu]: true,
        [FeatureSwitchKey.ChatReasoningEffort]: true,
        [FeatureSwitchKey.PiLoop]: true,
      },
    });
    await readyChat();
    const label = getCanonicalModelDisplayName(model);
    click(await findButton(label));
    click(
      buttonNamed(
        `Adjust ${label} settings`,
        await screen.findByRole("region", { name: "Models" }),
      ),
    );
    const slider = await screen.findByRole("slider", {
      name: "Reasoning effort",
    });
    slider.focus();
    await user.keyboard("{Home}");
    await waitFor(() => {
      return expect(slider).toHaveAttribute("aria-valuetext", first);
    });
    await user.keyboard("{End}");
    await waitFor(() => {
      return expect(slider).toHaveAttribute("aria-valuetext", last);
    });
  },
);
