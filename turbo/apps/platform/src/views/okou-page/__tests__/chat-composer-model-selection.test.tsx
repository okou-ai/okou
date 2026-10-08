import {
  chatThreadsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import type {
  AvailableRunModel,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  userModelPreferenceContract,
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
} from "@okouai/api-contracts/contracts/user-model-preference";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { mockCatalogDisplayName } from "../../../mocks/handlers/api-model-catalog.ts";
import {
  closeModelPanel,
  modelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
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
import {
  buildRunModel,
  composerModelTrigger,
} from "./chat-composer-test-helpers.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const FIXTURE_DATE = "2026-08-12T09:00:00.000Z";

function runModelFixture(
  model: string,
  index: number,
  options: { readonly providerType?: ModelProviderType } = {},
): AvailableRunModel {
  return buildRunModel({
    model,
    ...options,
    modelProviderId: `e2000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
  });
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
    updatedAt: FIXTURE_DATE,
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

async function effortSlider(panel: HTMLElement): Promise<HTMLElement> {
  return await within(panel).findByRole("slider", { name: "Effort" });
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
  const panel = await openModelPanel(currentLabel);
  await user.click(modelOption(optionName, panel));
  await closeModelPanel();
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
  });

  await readyComposer();
  await expect(modelPicker("Claude Fable 5.1")).resolves.toBeVisible();

  context.mocks.data.userModelPreference(preference("claude-opus-5-5"));
  triggerAblyEvent("userPreferenceChanged", {
    kinds: ["defaultModel", "futurePreferenceKind"],
  });

  await expect(modelPicker("Claude Opus 5.5")).resolves.toBeVisible();
});

test("Switch chat models immediately and adjust Fast in the same panel", async () => {
  installNewChat(["gpt-5.6-sol", "gpt-5.6-luna"], "gpt-5.6-sol");
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });
  await readyComposer();
  const panel = await openModelPanel("GPT 5.6 Sol");
  const options = queryAllByRoleFast("radio", panel);
  // The server projects the catalog system default (Auto) for every org;
  // rows follow catalog sortOrder.
  expect(options).toHaveLength(3);
  expect(options[0]).toHaveTextContent(/^Auto/u);
  expect(options[1]).toHaveTextContent(/^GPT 5\.6 Sol/u);
  expect(options[2]).toHaveTextContent(/^GPT 5\.6 Luna/u);
  click(modelOption(/^GPT 5\.6 Luna/u, panel));
  await expect(modelPicker("GPT 5.6 Luna")).resolves.toBeVisible();
  expect(
    within(panel).getByText("2.5× subscription usage"),
  ).toBeInTheDocument();
  click(within(panel).getByRole("switch", { name: "Fast mode" }));
  await expect(findButton("GPT 5.6 Luna, xHigh, Fast")).resolves.toBeVisible();
  expect(
    within(panel).getByRole("switch", { name: "Fast mode" }),
  ).toBeChecked();
  // Choosing the checked model again keeps Fast.
  click(modelOption(/^GPT 5\.6 Luna/u, panel));
  await expect(findButton("GPT 5.6 Luna, xHigh, Fast")).resolves.toBeVisible();
  expect(
    within(panel).getByRole("switch", { name: "Fast mode" }),
  ).toBeChecked();
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
  });
  const composer = await readyComposer();
  const panel = await openModelPanel("GPT 5.6 Sol, Max");
  const slider = await effortSlider(panel);
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
  click(within(panel).getByRole("switch", { name: "Fast mode" }));
  await expect(findButton("GPT 5.6 Sol, Max, Fast")).resolves.toBeVisible();
  expect(slider).toHaveAttribute("aria-valuetext", "Max");
  await closeModelPanel();
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
  });
  await readyChat();
  const panel = await openModelPanel("GPT 5.6 Sol, High, Fast");
  const slider = await effortSlider(panel);
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
  expect(
    within(panel).getByRole("switch", { name: "Fast mode" }),
  ).toBeChecked();
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
  });
  await readyComposer();
  const panel = await openModelPanel("Claude Sonnet 5, High");
  let slider = await effortSlider(panel);
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
  expect(screen.queryByText("ultracode")).not.toBeInTheDocument();
  await expect(findButton("Claude Sonnet 5, Extra")).resolves.toBeVisible();
  click(modelOption(/^GPT 5\.6 Sol/u, panel));
  await expect(findButton("GPT 5.6 Sol, Max")).resolves.toBeVisible();
  slider = await effortSlider(panel);
  expect(slider).toHaveAttribute("aria-valuetext", "Max");
  slider.focus();
  await user.keyboard("{End}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "Max");
  });
  click(modelOption(/^GPT 5\.6 Luna/u, panel));
  await expect(findButton("GPT 5.6 Luna, xHigh")).resolves.toBeVisible();
  slider = await effortSlider(panel);
  expect(slider).toHaveAttribute("aria-valuetext", "xHigh");
  slider.focus();
  await user.keyboard("{End}");
  await waitFor(() => {
    expect(slider).toHaveAttribute("aria-valuetext", "xHigh");
  });
  click(modelOption(/^Claude Sonnet 5/u, panel));
  await expect(findButton("Claude Sonnet 5, Extra")).resolves.toBeVisible();
  await expect(effortSlider(panel)).resolves.toHaveAttribute(
    "aria-valuetext",
    "Extra",
  );
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
    });
    await readyChat();
    const label = mockCatalogDisplayName(model);
    const panel = await openModelPanel(`${label}, xHigh`);
    const slider = await effortSlider(panel);
    expect(slider).toHaveAttribute("aria-valuetext", "xHigh");
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
  });
  await readyChat();
  const panel = await openModelPanel("GPT 5.6 Sol, Max");
  const slider = await effortSlider(panel);
  expect(slider).toHaveAttribute("aria-valuetext", "Max");
  expect(panel).not.toHaveTextContent("Restore model default");
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
  });
  const composer = await readyComposer();
  const panel = await openModelPanel("Claude Sonnet 5");
  click(modelOption(/^GPT 5\.6 Sol/u, panel));
  await expect(findButton("GPT 5.6 Sol, Max")).resolves.toBeVisible();
  await expect(effortSlider(panel)).resolves.toHaveAttribute(
    "aria-valuetext",
    "Max",
  );
  await closeModelPanel();
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
  });
  await readyChat();
  const panel = await openModelPanel("Claude Sonnet 5, High");
  const slider = await effortSlider(panel);
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
      createdAt: FIXTURE_DATE,
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
    });
    await readyChat();
    const panel = await openModelPanel(mockCatalogDisplayName(model));
    const slider = await effortSlider(panel);
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
