import {
  chatThreadsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  isBuiltInModelProviderType,
  type AvailableRunModel,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  userModelPreferenceContract,
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
} from "@okouai/api-contracts/contracts/user-model-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  mockCatalogBuiltInProvider,
  mockCatalogDisplayName,
} from "../../../mocks/handlers/api-model-catalog.ts";
import {
  findModelMenuOption,
  modelMenuOption,
} from "./chat-model-menu-test-helpers.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
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
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const POLICY_DATE = "2026-08-12T09:00:00.000Z";

interface PolicyOptions {
  readonly providerType?: ModelProviderType;
  readonly credentialScope?: "member" | "org";
}

function runModelFixture(
  model: string,
  index: number,
  options: PolicyOptions = {},
): AvailableRunModel {
  const providerType =
    options.providerType ??
    (model === "okou-1.0"
      ? "built-in"
      : model.startsWith("claude-")
        ? "claude-code-oauth-token"
        : "codex-oauth-token");
  const credentialScope =
    options.credentialScope ?? (model === "okou-1.0" ? "org" : "member");
  return {
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
    routeStatus: "valid",
    routeStatusReason: null,
  };
}

function configureRunModels(models: readonly string[]): void {
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.availableRunModels(
    models.map((model, index) => {
      return runModelFixture(model, index + 1);
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
  configureRunModels(models);
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
      [FeatureSwitchKey.ComposerModelPanel]: false,
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
      [FeatureSwitchKey.ComposerModelPanel]: false,
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

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
  });

  await readyComposer();
  await expect(modelPicker("Claude Fable 5.1")).resolves.toBeVisible();

  context.mocks.data.userModelPreference(preference("claude-opus-5-5"));
  triggerAblyEvent("userPreferenceChanged", {
    kinds: ["defaultModel", "futurePreferenceKind"],
  });

  await expect(modelPicker("Claude Opus 5.5")).resolves.toBeVisible();
});

test("Switch chat models immediately and adjust Fast from settings", async () => {
  const user = userEvent.setup({ delay: null });
  installNewChat(["gpt-5.6-sol", "gpt-5.6-luna"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ComposerModelPanel]: false,
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
  expect(
    within(settings).getByText("2.5× subscription usage"),
  ).toBeInTheDocument();
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

test("Adjust effort from the composer without opening the model picker", async () => {
  const user = userEvent.setup({ delay: null });
  installNewChat(["gpt-5.6-sol"], "gpt-5.6-sol");
  configureRunModels(["gpt-5.6-sol"]);
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ComposerModelPanel]: false,
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
  configureRunModels(["gpt-5.6-sol"]);
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ComposerModelPanel]: false,
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
  configureRunModels(["gpt-5.6-sol"]);
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
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
      [FeatureSwitchKey.ComposerModelPanel]: false,
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
  expect(slider).toHaveAttribute("aria-valuetext", "xHigh");
  slider.focus();
  await user.keyboard("{End}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "xHigh");
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

test.each(["gpt-5.6-luna", "gpt-6-luna"])(
  "Cap %s at xHigh even with a saved Max preference",
  async (model) => {
    const user = userEvent.setup({ delay: null });
    const updates: { reasoningEffort?: string | null }[] = [];
    installRunChat({
      selectedModel: model,
      reasoningEffort: "max",
      onModelSelectionUpdate: (body) => {
        updates.push(body);
      },
    });
    configureRunModels([model]);
    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
    });
    await readyChat();
    const settings = await openEffortPanel();
    const slider = await screen.findByRole("slider", { name: "Effort" });
    expect(slider).toHaveAttribute("aria-valuetext", "xHigh");
    expect(
      within(settings).queryByText("Max", { exact: true }),
    ).not.toBeInTheDocument();
    expect(updates).toStrictEqual([]);
    slider.focus();
    await user.keyboard("{End}{ArrowRight}");
    expect(slider).toHaveAttribute("aria-valuetext", "xHigh");
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => {
      expect(slider).toHaveAttribute("aria-valuetext", "High");
    });
    await user.keyboard("{End}");
    await waitFor(() => {
      expect(updates).toContainEqual(
        expect.objectContaining({ reasoningEffort: "xhigh" }),
      );
    });
  },
);

test("Show the Pi fallback without overwriting a saved native preference", async () => {
  const updates: { reasoningEffort?: string | null }[] = [];
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    onModelSelectionUpdate: (body) => {
      updates.push(body);
    },
  });
  configureRunModels(["gpt-5.6-sol"]);
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
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
      [FeatureSwitchKey.ComposerModelPanel]: false,
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
  configureRunModels(["claude-sonnet-5"]);
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
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
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
    providerType: "codex-oauth-token",
    first: "Low",
    last: "Ultra",
  },
] as const)(
  "Offer $model efforts for $providerType with Pi enabled",
  async ({ model, providerType, first, last }) => {
    const user = userEvent.setup({ delay: null });
    installRunChat({ selectedModel: model });
    installConnectedPersonalSubscriptions(context);
    context.mocks.data.availableRunModels([
      runModelFixture(model, 1, { providerType }),
    ]);
    await setupPage({
      context,
      path: RUN_PATH,
      featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
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
