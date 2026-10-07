import type { AvailableRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  MOCK_SYSTEM_DEFAULT_MODEL,
  mockCatalogDisplayName,
} from "../../../mocks/handlers/api-model-catalog.ts";
import {
  closeModelPanel,
  findModelOption,
  modelOption,
  openModelPanel,
  queryModelOption,
} from "./chat-model-panel-test-helpers.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import {
  context,
  installRunChat,
  NEW_CHAT_PATH,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const FIXTURE_DATE = "2026-08-12T09:00:00.000Z";

function runModelFixture(model: string, index: number): AvailableRunModel {
  const providerType =
    model === "okou-1.0"
      ? "built-in"
      : model.startsWith("claude-")
        ? "claude-code-oauth-token"
        : "codex-oauth-token";
  const credentialScope = model === "okou-1.0" ? "org" : "member";
  return {
    model,
    modelLabel: mockCatalogDisplayName(model),
    defaultProviderType: providerType,
    credentialScope,
    modelProviderId:
      credentialScope === "member"
        ? `e4000000-0000-4000-a000-${String(index).padStart(12, "0")}`
        : null,
    routeStatus: "valid",
  };
}

function configureRunModels(models: readonly string[]): void {
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.availableRunModels(
    [...models, MOCK_SYSTEM_DEFAULT_MODEL].map((model, index) => {
      return runModelFixture(model, index + 1);
    }),
  );
}

function preference(
  selectedModel: string,
  serviceTier: "priority" | null = null,
): void {
  context.mocks.data.userModelPreference({
    selectedModel,
    serviceTier,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: FIXTURE_DATE,
  });
}

async function modelPicker(name: string): Promise<HTMLElement> {
  return await composerModelTrigger(name);
}

async function readyComposer(name = "Message"): Promise<HTMLElement> {
  const composer = await screen.findByRole("textbox", { name });
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

test("Edit only the model for an existing thread", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({ selectedModel: "claude-opus-5" });
  configureRunModels(["claude-opus-5", "claude-sonnet-5"]);

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  await expect(modelPicker("Claude Opus 5")).resolves.toBeVisible();

  await chooseModel(user, "Claude Opus 5", /^Claude Sonnet 5/iu);

  await expect(modelPicker("Claude Sonnet 5")).resolves.toBeVisible();
  expect(
    screen.queryByRole("group", { name: "Model for this chat" }),
  ).not.toBeInTheDocument();
});

test("Resolve the model shown for a chat", async () => {
  installRunChat({ selectedModel: "claude-fable-5-1" });
  configureRunModels(["claude-fable-5-1", "claude-opus-5-5"]);
  preference("claude-opus-5-5");

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });

  await readyComposer();
  await expect(modelPicker("Claude Opus 5.5")).resolves.toBeVisible();
});

test("Show Auto when an existing thread's model is no longer selectable", async () => {
  installRunChat({ selectedModel: "deepseek-v4.1-flash" });
  context.mocks.data.availableRunModels([
    runModelFixture("okou-1.0", 1),
    {
      ...runModelFixture("gpt-6-sol", 2),
      subscriptionOptions: { efforts: ["low", "high"], serviceTier: null },
    },
  ]);

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  const panel = await openModelPanel("Auto");
  await expect(findModelOption(/^GPT 6 Sol/iu, panel)).resolves.toBeVisible();
  expect(queryModelOption(/DeepSeek/iu, panel)).not.toBeInTheDocument();
});

test("Keep an existing thread's explicit model", async () => {
  installRunChat({ selectedModel: "claude-opus-5" });
  configureRunModels(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5"]);
  preference("claude-opus-5-5");

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  await expect(modelPicker("Claude Opus 5")).resolves.toBeVisible();
});

test("Start a new chat on Auto without a saved preference", async () => {
  configureRunModels(["claude-fable-5-1", "claude-opus-5-5"]);

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });

  await readyComposer();
  await expect(modelPicker("Auto")).resolves.toBeVisible();
});

test("Start a new chat on Auto when the saved preference has no route", async () => {
  configureRunModels(["claude-fable-5-1"]);
  preference("claude-opus-5-5");

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });

  await readyComposer();
  await expect(modelPicker("Auto")).resolves.toBeVisible();
});
