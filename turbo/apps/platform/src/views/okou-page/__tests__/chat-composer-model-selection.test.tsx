import {
  findModelMenuOption,
  modelMenuOption,
} from "./chat-model-menu-test-helpers.ts";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
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

import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { fillComposer } from "./chat-test-helpers.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

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
  return await composerModelTrigger(name);
}

/**
 * The menu's pages are the narrow viewport's layout: a desktop has the room the
 * flyout's two panels need, so it takes those instead.
 */
function setNarrowViewport(): void {
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)";
  });
}

/**
 * Effort and Fast live on the composer now, so every test reaches them the way
 * a user does: through the control beside the model, not through a page inside
 * the model picker.
 */
async function openEffortPanel(label = "Effort"): Promise<HTMLElement> {
  await waitFor(() => {
    expect(effortTrigger(label)).toBeVisible();
  });
  click(effortTrigger(label));
  return await screen.findByRole("dialog");
}

/** The composer's effort control, named for the level it currently carries. */
function effortTrigger(label = "Effort"): HTMLElement {
  const trigger = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label")?.startsWith(`${label}, `);
  });
  if (!trigger) {
    throw new Error("Effort control was not visible");
  }
  return trigger;
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
  await user.click(await findModelMenuOption(optionName));
}

function buttonNamed(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = [
    ...queryAllByRoleFast("button", container),
    ...queryAllByRoleFast("menuitem", container),
    ...queryAllByRoleFast("menuitemradio", container),
  ].find((candidate) => {
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
      modelSettingsPatch: { model: "claude-sonnet-4-6", effort: "high" },
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

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });

  await readyComposer();
  await user.click(await modelPicker("DeepSeek V4 Flash"));
  await expect(
    findModelMenuOption(/^DeepSeek V4 Flash/iu),
  ).resolves.toBeVisible();
  // A row carries its cost glyphs and plan badge beside the model name, so it
  // is addressed by that name as a prefix.
  expect(modelMenuOption(/^GPT 5\.6 Luna/iu)).toBeVisible();
  expect(modelMenuOption(/^GPT 6 Astra.*Pro/iu)).toBeVisible();
  expect(screen.getAllByText("Pro")).toHaveLength(3);
  expect(screen.getByText("BYOK")).toBeVisible();

  const byokOption = modelMenuOption(/^Claude Sonnet 4\.6/iu);
  expect(within(byokOption).queryByText("Pro")).toBeNull();
  await user.click(byokOption);
  await expect(modelPicker("Claude Sonnet 4.6")).resolves.toBeVisible();
  expect(
    screen.queryByRole("dialog", { name: "Choose a plan" }),
  ).not.toBeInTheDocument();

  await user.click(await modelPicker("Claude Sonnet 4.6"));
  await user.click(modelMenuOption(/^Claude Fable 5\.1/iu));
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
  await expect(modelPicker("Claude Sonnet 4.6")).resolves.toBeVisible();
});

test("Switch chat models immediately and adjust Fast from settings", async () => {
  setNarrowViewport();
  const user = userEvent.setup({ delay: null });
  installNewChat(["gpt-5.6-sol", "gpt-5.6-luna"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
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
  const settings = await openEffortPanel();
  // The row carries Fast's speed and cost in the bolt's tooltip rather than as
  // a second line of small print under the label.
  await user.hover(within(settings).getByText("Fast"));
  await expect(
    screen.findByText("Faster model responses · 2× Okou model credits"),
  ).resolves.toBeVisible();
  click(screen.getByRole("switch", { name: "Fast" }));
  await expect(findButton("GPT 5.6 Luna Fast")).resolves.toBeVisible();
  expect(screen.getByRole("switch", { name: "Fast" })).toBeChecked();
  await user.keyboard("{Escape}");
  click(await findButton("GPT 5.6 Luna Fast"));
  const models = await screen.findByRole("region", { name: "Models" });
  expect(
    buttonNamed("Change Chat model, GPT 5.6 Luna", models),
  ).toHaveTextContent("Fast");
  click(buttonNamed("Change Chat model, GPT 5.6 Luna", models));
  const sameModelList = await screen.findByRole("region", {
    name: "Chat models",
  });
  click(buttonNamed("GPT 5.6 Luna", sameModelList));
  await expect(findButton("GPT 5.6 Luna Fast")).resolves.toBeVisible();
  await user.keyboard("{Escape}");
  await openEffortPanel();
  expect(screen.getByRole("switch", { name: "Fast" })).toBeChecked();
});

test("Keep unavailable routes disabled and open plan comparison from the compact menu", async () => {
  setNarrowViewport();
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
  });
  await readyComposer();
  click(await findButton("DeepSeek V4 Flash"));
  const overview = await screen.findByRole("region", { name: "Models" });
  click(buttonNamed("Change Chat model, DeepSeek V4 Flash", overview));
  const list = await screen.findByRole("region", { name: "Chat models" });
  expect(buttonNamed("GPT 5.6 Sol", list)).toHaveAttribute(
    "aria-disabled",
    "true",
  );
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

test("Adjust effort from the composer without opening the model picker", async () => {
  const user = userEvent.setup({ delay: null });
  installNewChat(["gpt-5.6-sol"], "gpt-5.6-sol");
  configurePolicies(["gpt-5.6-sol"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });
  await readyComposer();
  // The composer names the effort at rest, so the choice is visible without
  // opening anything.
  const trigger = await findButton("Effort, Max");
  await user.click(trigger);
  const slider = await screen.findByRole("slider", { name: "Effort" });
  slider.focus();
  await user.keyboard("{Home}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "Low");
  });
  await expect(findButton("Effort, Low")).resolves.toBeVisible();
  // The bolt is the Fast state rather than decoration, so it is absent until
  // Fast is on.
  expect(within(trigger).queryByRole("img", { hidden: true })).toBeNull();
  click(screen.getByRole("switch", { name: "Fast" }));
  await waitFor(() => {
    expect(screen.getByRole("switch", { name: "Fast" })).toBeChecked();
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
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });
  const composer = await readyComposer();
  click(await findButton("GPT 5.6 Sol"));
  await openEffortPanel();
  const slider = await screen.findByRole("slider", {
    name: "Effort",
  });
  expect(slider).toHaveAttribute("aria-valuetext", "Max");
  slider.focus();
  await user.keyboard("{Home}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "Low");
  });
  for (const effort of ["Medium", "High", "Xhigh", "Max"]) {
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(slider).toHaveAttribute("aria-valuetext", effort);
    });
  }
  click(screen.getByRole("switch", { name: "Fast" }));
  await expect(findButton("GPT 5.6 Sol Fast")).resolves.toBeVisible();
  expect(slider).toHaveAttribute("aria-valuetext", "Max");
  await user.click(composer);
  await fillComposer(composer, "Use this effort for the new task");
  click(await findButton("Send"));
  await waitFor(() => {
    expect(creates).toContainEqual(
      expect.objectContaining({
        reasoningEffort: "max",
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
  });
  await readyChat();
  click(await findButton("GPT 5.6 Sol Fast"));
  await openEffortPanel();
  const slider = await screen.findByRole("slider", {
    name: "Effort",
  });
  expect(slider).toHaveAttribute("aria-valuetext", "High");
  slider.focus();
  await user.keyboard("{ArrowRight}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "Xhigh");
  });
  await user.keyboard("{ArrowRight}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "Max");
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
  setNarrowViewport();
  const user = userEvent.setup({ delay: null });
  installNewChat(
    ["claude-sonnet-5", "gpt-5.6-sol", "gpt-5.6-luna"],
    "claude-sonnet-5",
  );
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });
  await readyComposer();
  await openEffortPanel();
  let slider = await screen.findByRole("slider", { name: "Effort" });
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
  // The composer names the effort too, so scope this to the settings page.
  expect(
    within(screen.getByRole("dialog")).getByText("Extra"),
  ).toBeInTheDocument();
  expect(screen.queryByText("ultracode")).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  click(await findButton("Claude Sonnet 5"));
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
  await openEffortPanel();
  slider = await screen.findByRole("slider", { name: "Effort" });
  expect(slider).toHaveAttribute("aria-valuetext", "Max");
  slider.focus();
  await user.keyboard("{End}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "Max");
  });
  await user.keyboard("{Escape}");
  click(await findButton("GPT 5.6 Sol"));
  click(
    buttonNamed(
      "Change Chat model, GPT 5.6 Sol",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  click(
    buttonNamed(
      "GPT 5.6 Luna",
      await screen.findByRole("region", { name: "Chat models" }),
    ),
  );
  await openEffortPanel();
  slider = await screen.findByRole("slider", { name: "Effort" });
  expect(slider).toHaveAttribute("aria-valuetext", "Max");
  slider.focus();
  await user.keyboard("{End}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "Max");
  });
  await user.keyboard("{Escape}");
  click(await findButton("GPT 5.6 Luna"));
  click(
    buttonNamed(
      "Change Chat model, GPT 5.6 Luna",
      await screen.findByRole("region", { name: "Models" }),
    ),
  );
  click(
    buttonNamed(
      "Claude Sonnet 5",
      await screen.findByRole("region", { name: "Chat models" }),
    ),
  );
  await openEffortPanel();
  await expect(
    screen.findByRole("slider", { name: "Effort" }),
  ).resolves.toHaveAttribute("aria-valuetext", "Extra");
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
  });
  await readyChat();
  const settings = await openEffortPanel();
  const slider = await screen.findByRole("slider", {
    name: "Effort",
  });
  expect(slider).toHaveAttribute("aria-valuetext", "Max");
  expect(settings).not.toHaveTextContent("Restore model default");
  expect(updates).toStrictEqual([]);
});

test("Save the preferred effort for future chats when Pi displays a fallback", async () => {
  setNarrowViewport();
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
  await openEffortPanel();
  await expect(
    screen.findByRole("slider", { name: "Effort" }),
  ).resolves.toHaveAttribute("aria-valuetext", "Max");
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
  });
  await readyChat();
  click(await findButton("Claude Sonnet 5"));
  await openEffortPanel();
  const slider = await screen.findByRole("slider", {
    name: "Effort",
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

test.each([
  {
    model: "gpt-6-astra",
    providerType: "openai-api-key",
    first: "Low",
    last: "Ultra",
  },
  {
    model: "deepseek-v4-pro",
    providerType: "deepseek",
    first: "High",
    last: "Max",
  },
  {
    model: "deepseek-v4-flash",
    providerType: "openrouter-codex",
    first: "High",
    last: "Xhigh",
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
    });
    await readyChat();
    const label = getCanonicalModelDisplayName(model);
    click(await findButton(label));
    await openEffortPanel();
    const slider = await screen.findByRole("slider", {
      name: "Effort",
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
