import type { AvailableRunModel } from "@okouai/api-contracts/contracts/model-providers";
import {
  userModelPreferenceContract,
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
} from "@okouai/api-contracts/contracts/user-model-preference";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  composerModelTrigger,
  queryComposerModelTrigger,
} from "./chat-composer-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";
import {
  closeModelPanel,
  modelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import {
  NEW_CHAT_PATH,
  RUN_PATH,
  createChatRunFixtures,
  findButton,
  readyChat,
} from "./chat-run-test-fixtures.ts";
import { fillComposer } from "./chat-test-helpers.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const FIXTURE_DATE = "2026-08-12T09:00:00.000Z";

function runModelFixture(model: string, index: number): AvailableRunModel {
  return buildRunModel({
    model,
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

function preference(selectedModel: string): UserModelPreferenceResponse {
  return {
    selectedModel,
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: FIXTURE_DATE,
  };
}

async function openNewChat(
  models: readonly string[],
  selectedModel: string,
): Promise<HTMLElement> {
  installRunChat({ selectedModel });
  configureRunModels(models);
  context.mocks.data.userModelPreference(preference(selectedModel));
  await setupPage({ context, path: NEW_CHAT_PATH });
  return await screen.findByRole("textbox", { name: "Message" });
}

async function effortSlider(panel: HTMLElement): Promise<HTMLElement> {
  return await within(panel).findByRole("slider", { name: "Effort" });
}

function buttonNamed(name: string, container: ParentNode): HTMLElement {
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
  let update: UpdateUserModelPreferenceRequest | undefined;
  context.mocks.api(userModelPreferenceContract.update, ({ body, respond }) => {
    update = body;
    const next = preference("claude-sonnet-5");
    context.mocks.data.userModelPreference(next);
    return respond(200, next);
  });
  await openNewChat(
    ["claude-fable-5-1", "claude-sonnet-5"],
    "claude-fable-5-1",
  );

  const panel = await openModelPanel("Claude Fable 5.1");
  await user.click(modelOption(/^Claude Sonnet 5/iu, panel));
  await closeModelPanel();

  const scopeCard = await screen.findByRole("group", {
    name: "Model for this chat",
  });
  expect(scopeCard).toHaveTextContent("Temporarily switch to Claude Sonnet 5");
  expect(update).toBeUndefined();

  click(buttonNamed("Use this for future chats", scopeCard));
  await waitFor(() => {
    expect(update).toStrictEqual(
      expect.objectContaining({
        selectedModel: "claude-sonnet-5",
        modelSettingsPatch: { model: "claude-sonnet-5", effort: "high" },
      }),
    );
  });

  context.mocks.ably.trigger("userPreferenceChanged", {
    kinds: ["defaultModel"],
  });
  await waitFor(() => {
    expect(
      screen.queryByRole("group", { name: "Model for this chat" }),
    ).not.toBeInTheDocument();
  });
  await expect(composerModelTrigger("Claude Sonnet 5")).resolves.toBeVisible();
});

test("Follow model preference changes made in another session", async () => {
  await openNewChat(
    ["claude-fable-5-1", "claude-opus-5-5"],
    "claude-fable-5-1",
  );
  await expect(composerModelTrigger("Claude Fable 5.1")).resolves.toBeVisible();

  context.mocks.data.userModelPreference(preference("claude-opus-5-5"));
  context.mocks.ably.trigger("userPreferenceChanged", {
    kinds: ["defaultModel", "futurePreferenceKind"],
  });

  await expect(composerModelTrigger("Claude Opus 5.5")).resolves.toBeVisible();
});

test("Switch chat models immediately and adjust Fast in the same panel", async () => {
  await openNewChat(["gpt-5.6-sol", "gpt-5.6-luna"], "gpt-5.6-sol");
  const panel = await openModelPanel("GPT 5.6 Sol");
  expect(modelOption(/^GPT 5\.6 Sol/u, panel)).toBeInTheDocument();

  click(modelOption(/^GPT 5\.6 Luna/u, panel));
  expect(queryComposerModelTrigger("GPT 5.6 Luna")).toBeVisible();
  expect(within(panel).getByText("2.5× subscription usage")).toBeVisible();
  await expect(findButton("GPT 5.6 Luna, xHigh")).resolves.toBeVisible();

  click(within(panel).getByRole("switch", { name: "Fast mode" }));
  await expect(findButton("GPT 5.6 Luna, xHigh, Fast")).resolves.toBeVisible();
  expect(
    within(panel).getByRole("switch", { name: "Fast mode" }),
  ).toBeChecked();

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
  await setupPage({ context, path: NEW_CHAT_PATH });
  const composer = await screen.findByRole("textbox", { name: "Message" });
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

test("Keep independent effort selections when changing models", async () => {
  const user = userEvent.setup({ delay: null });
  await openNewChat(
    ["claude-sonnet-5", "gpt-5.6-sol", "gpt-5.6-luna"],
    "claude-sonnet-5",
  );
  const panel = await openModelPanel("Claude Sonnet 5, High");
  const sonnetEffort = await effortSlider(panel);
  expect(sonnetEffort).toHaveAttribute("aria-valuetext", "High");
  sonnetEffort.focus();
  await user.keyboard("{End}");
  await waitFor(() => {
    expect(sonnetEffort).toHaveAttribute("aria-valuetext", "Max");
  });
  await user.keyboard("{ArrowLeft}");
  await expect(findButton("Claude Sonnet 5, Extra")).resolves.toBeVisible();

  click(modelOption(/^GPT 5\.6 Sol/u, panel));
  await expect(findButton("GPT 5.6 Sol, Max")).resolves.toBeVisible();
  await expect(effortSlider(panel)).resolves.toHaveAttribute(
    "aria-valuetext",
    "Max",
  );

  click(modelOption(/^GPT 5\.6 Luna/u, panel));
  await expect(findButton("GPT 5.6 Luna, xHigh")).resolves.toBeVisible();
  await expect(effortSlider(panel)).resolves.toHaveAttribute(
    "aria-valuetext",
    "xHigh",
  );

  click(modelOption(/^Claude Sonnet 5/u, panel));
  await expect(findButton("Claude Sonnet 5, Extra")).resolves.toBeVisible();
  await expect(effortSlider(panel)).resolves.toHaveAttribute(
    "aria-valuetext",
    "Extra",
  );
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
  configureRunModels(["gpt-5.6-sol"]);
  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  const panel = await openModelPanel("GPT 5.6 Sol, Max");

  await expect(effortSlider(panel)).resolves.toHaveAttribute(
    "aria-valuetext",
    "Max",
  );
  expect(updates).toStrictEqual([]);
});

test("Save the preferred effort for future chats when Pi displays a fallback", async () => {
  const user = userEvent.setup({ delay: null });
  const updates: UpdateUserModelPreferenceRequest[] = [];
  installRunChat({ selectedModel: "claude-sonnet-5" });
  configureRunModels(["claude-sonnet-5", "gpt-5.6-sol"]);
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
  await setupPage({ context, path: NEW_CHAT_PATH });
  const composer = await screen.findByRole("textbox", { name: "Message" });

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
    expect(updates).toContainEqual(
      expect.objectContaining({
        selectedModel: "gpt-5.6-sol",
        modelSettingsPatch: { model: "gpt-5.6-sol", effort: "ultra" },
      }),
    );
  });
});
