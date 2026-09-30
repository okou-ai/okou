import {
  mockCatalogBuiltInProvider,
  mockCatalogDisplayName,
} from "../../../mocks/handlers/api-model-catalog.ts";
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
  readonly providerType?: ModelProviderType;
  readonly credentialScope?: "member" | "org";
}

function modelPolicy(
  model: string,
  index: number,
  options: PolicyOptions = {},
): OrgModelPolicy {
  const providerType = options.providerType ?? "built-in";
  const credentialScope = options.credentialScope ?? "org";
  return {
    id: `e1000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
    model,
    modelLabel: mockCatalogDisplayName(model),
    defaultProviderType: providerType,
    ...(isBuiltInModelProviderType(providerType)
      ? { runtimeProviderType: mockCatalogBuiltInProvider(model) }
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

function configurePolicies(models: readonly string[]): void {
  context.mocks.data.orgModelPolicies(
    models.map((model, index) => {
      return modelPolicy(model, index + 1);
    }),
  );
}

function preference(
  selectedModel: string,
  serviceTier: "priority" | null = null,
): UserModelPreferenceResponse {
  return {
    selectedModel,
    serviceTier,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: POLICY_DATE,
  };
}

function installNewChat(
  models: readonly string[],
  selectedModel: string,
): void {
  installRunChat({ selectedModel });
  configurePolicies(models);
  context.mocks.data.userModelPreference(preference(selectedModel));
}

async function modelPicker(name: string): Promise<HTMLElement> {
  return await composerModelTrigger(name);
}

/**
 * The composer's model menu. It lists only the chat models at every width:
 * images and video follow the member's settings, not the chat.
 */
async function openModelMenu(currentLabel: string): Promise<HTMLElement> {
  click(await modelPicker(currentLabel));
  return await screen.findByRole("menu", { name: "Chat models" });
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
  installNewChat(["claude-fable-5-1", "claude-sonnet-5"], "claude-fable-5-1");
  context.mocks.api(userModelPreferenceContract.update, ({ body, respond }) => {
    update = body;
    const nextPreference = preference("claude-sonnet-5");
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
  await chooseModel(user, "Claude Fable 5.1", /^Claude Sonnet 5/iu);
  await waitFor(() => {
    expect(update).toStrictEqual({
      selectedModel: "claude-sonnet-5",
      serviceTier: null,
    });
  });
  await expect(modelPicker("Claude Sonnet 5")).resolves.toBeVisible();
  expect(
    screen.queryByRole("group", { name: "Model for this chat" }),
  ).not.toBeInTheDocument();
});

test("Temporarily choose a model for a new chat", async () => {
  const user = userEvent.setup({ delay: null });
  const updateGate = createDeferredPromise<void>(context.signal);
  const responsePrepared = createDeferredPromise<void>(context.signal);
  let update: UpdateUserModelPreferenceRequest | undefined;
  installNewChat(["claude-fable-5-1", "claude-sonnet-5"], "claude-fable-5-1");
  context.mocks.api(
    userModelPreferenceContract.update,
    async ({ body, respond }) => {
      update = body;
      await updateGate.promise;
      const nextPreference = preference("claude-sonnet-5");
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
  await chooseModel(user, "Claude Fable 5.1", /^Claude Sonnet 5/iu);
  expect(update).toBeUndefined();
  const scopeCard = await screen.findByRole("group", {
    name: "Model for this chat",
  });
  expect(scopeCard).toHaveTextContent("Temporarily switch to Claude Sonnet 5");
  const futureChats = buttonNamed("Use this for future chats", scopeCard);

  click(futureChats);
  await waitFor(() => {
    expect(update).toStrictEqual({
      selectedModel: "claude-sonnet-5",
      serviceTier: null,
      modelSettingsPatch: { model: "claude-sonnet-5", effort: "high" },
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
  await expect(modelPicker("Claude Sonnet 5")).resolves.toBeVisible();
});

test("Follow model preference changes made in another session", async () => {
  installNewChat(["claude-fable-5-1", "claude-opus-5-5"], "claude-fable-5-1");

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyComposer();
  await expect(modelPicker("Claude Fable 5.1")).resolves.toBeVisible();

  context.mocks.data.userModelPreference(preference("claude-opus-5-5"));
  triggerAblyEvent("userPreferenceChanged", {
    kinds: ["defaultModel", "futurePreferenceKind"],
  });

  await expect(modelPicker("Claude Opus 5.5")).resolves.toBeVisible();
});

test("Explain model availability by plan and provider", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({ selectedModel: "deepseek-v4-flash" });
  context.mocks.data.userModelPreference(preference("deepseek-v4-flash"));
  context.mocks.data.orgModelPolicies([
    modelPolicy("deepseek-v4-flash", 1),
    modelPolicy("gpt-5.6-luna", 2),
    modelPolicy("gpt-5.6-sol", 3),
    modelPolicy("claude-fable-5-1", 4),
    modelPolicy("gpt-6-astra", 5),
    modelPolicy("claude-sonnet-5", 6, {
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
  // The free plan runs only the catalog's free Built-in model; every listed
  // Built-in model and the member's own API-key route ask for a paid plan.
  expect(screen.getAllByText("Pro")).toHaveLength(6);
  expect(screen.getByText("BYOK")).toBeVisible();
  const byokOption = modelMenuOption(/^Claude Sonnet 5/iu);
  expect(within(byokOption).getByText("Pro")).toBeVisible();

  await user.click(byokOption);
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
  await expect(modelPicker("DeepSeek V4 Flash")).resolves.toBeVisible();
});

test("Switch chat models immediately and adjust Fast from settings", async () => {
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
  const list = await openModelMenu("GPT 5.6 Sol");
  // Only chat models: there is no Image or Video category to step into.
  expect(queryAllByRoleFast("menuitem", list)).toHaveLength(0);
  const options = queryAllByRoleFast("menuitemradio", list);
  // The server projects the catalog system default (Auto) for every org;
  // rows follow catalog sortOrder.
  expect(options).toHaveLength(3);
  expect(options[0]).toHaveTextContent(/^Auto/u);
  expect(options[1]).toHaveTextContent(/^GPT 5\.6 Sol/u);
  expect(options[2]).toHaveTextContent(/^GPT 5\.6 Luna/u);
  click(modelMenuOption(/^GPT 5\.6 Luna/u, list));
  await expect(findButton("GPT 5.6 Luna")).resolves.toBeVisible();
  await waitFor(() => {
    expect(
      screen.queryByRole("menu", { name: "Chat models" }),
    ).not.toBeInTheDocument();
  });
  const settings = await openEffortPanel();
  expect(within(settings).getByText("2× credit cost")).toBeInTheDocument();
  click(screen.getByRole("switch", { name: "Fast mode" }));
  await expect(findButton("GPT 5.6 Luna Fast")).resolves.toBeVisible();
  expect(screen.getByRole("switch", { name: "Fast mode" })).toBeChecked();
  await user.keyboard("{Escape}");
  // Choosing the checked model again keeps Fast.
  const sameModelList = await openModelMenu("GPT 5.6 Luna Fast");
  click(modelMenuOption(/^GPT 5\.6 Luna/u, sameModelList));
  await expect(findButton("GPT 5.6 Luna Fast")).resolves.toBeVisible();
  await user.keyboard("{Escape}");
  await openEffortPanel();
  expect(screen.getByRole("switch", { name: "Fast mode" })).toBeChecked();
});

test("Keep unavailable routes disabled and open plan comparison from the menu", async () => {
  installNewChat(
    ["deepseek-v4-flash", "claude-fable-5-1", "gpt-5.6-sol"],
    "deepseek-v4-flash",
  );
  context.mocks.data.orgModelPolicies([
    modelPolicy("deepseek-v4-flash", 1),
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
  const list = await openModelMenu("DeepSeek V4 Flash");
  expect(modelMenuOption(/^GPT 5\.6 Sol/u, list)).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(modelMenuOption(/^Claude Fable 5\.1/u, list)).toHaveTextContent("Pro");
  click(modelMenuOption(/^Claude Fable 5\.1/u, list));
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
  configurePolicies(["gpt-5.6-sol"]);
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
  click(screen.getByRole("switch", { name: "Fast mode" }));
  await waitFor(() => {
    expect(screen.getByRole("switch", { name: "Fast mode" })).toBeChecked();
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
  configurePolicies(["gpt-5.6-sol"]);
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });
  const composer = await readyComposer();
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
  for (const effort of ["Medium", "High", "xHigh", "Max"]) {
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(slider).toHaveAttribute("aria-valuetext", effort);
    });
  }
  click(screen.getByRole("switch", { name: "Fast mode" }));
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
  configurePolicies(["gpt-5.6-sol"]);
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
    expect(slider).toHaveAttribute("aria-valuetext", "xHigh");
  });
  await user.keyboard("{ArrowRight}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "Max");
  });
  expect(screen.getByRole("switch", { name: "Fast mode" })).toBeChecked();
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
  await expect(findButton("Effort, Extra")).resolves.toBeVisible();
  click(
    modelMenuOption(/^GPT 5\.6 Sol/u, await openModelMenu("Claude Sonnet 5")),
  );
  await expect(findButton("GPT 5.6 Sol")).resolves.toBeVisible();
  await openEffortPanel();
  slider = await screen.findByRole("slider", { name: "Effort" });
  expect(slider).toHaveAttribute("aria-valuetext", "Max");
  slider.focus();
  await user.keyboard("{End}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "Max");
  });
  await user.keyboard("{Escape}");
  click(modelMenuOption(/^GPT 5\.6 Luna/u, await openModelMenu("GPT 5.6 Sol")));
  await expect(findButton("GPT 5.6 Luna")).resolves.toBeVisible();
  await openEffortPanel();
  slider = await screen.findByRole("slider", { name: "Effort" });
  expect(slider).toHaveAttribute("aria-valuetext", "Max");
  slider.focus();
  await user.keyboard("{End}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "Max");
  });
  await user.keyboard("{Escape}");
  click(
    modelMenuOption(/^Claude Sonnet 5/u, await openModelMenu("GPT 5.6 Luna")),
  );
  await expect(findButton("Claude Sonnet 5")).resolves.toBeVisible();
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
  configurePolicies(["gpt-5.6-sol"]);
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
  click(
    modelMenuOption(/^GPT 5\.6 Sol/u, await openModelMenu("Claude Sonnet 5")),
  );
  await expect(findButton("GPT 5.6 Sol")).resolves.toBeVisible();
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
  configurePolicies(["claude-sonnet-5"]);
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
    model: "deepseek-v4-flash",
    providerType: "deepseek",
    first: "Low",
    last: "Max",
  },
  {
    model: "deepseek-v4-flash",
    providerType: "openrouter-codex",
    first: "High",
    last: "xHigh",
  },
] as const)(
  "Offer $model efforts for $providerType with Pi enabled",
  async ({ model, providerType, first, last }) => {
    const user = userEvent.setup({ delay: null });
    installRunChat({ selectedModel: model });
    context.mocks.data.orgModelPolicies([
      modelPolicy(model, 1, { providerType }),
    ]);
    await setupPage({
      context,
      path: RUN_PATH,
    });
    await readyChat();
    const label = mockCatalogDisplayName(model);
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
