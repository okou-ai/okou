import type {
  AvailableRunModel,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  MOCK_SYSTEM_DEFAULT_MODEL,
  mockCatalogDisplayName,
} from "../../../mocks/handlers/api-model-catalog.ts";
import {
  findModelMenuOption,
  queryModelMenuOption,
} from "./chat-model-menu-test-helpers.ts";
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
    credentialScope,
    modelProviderId:
      credentialScope === "member"
        ? `e4000000-0000-4000-a000-${String(index).padStart(12, "0")}`
        : null,
    routeStatus: "valid",
    routeStatusReason: null,
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
    updatedAt: POLICY_DATE,
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
  await user.click(await modelPicker(currentLabel));
  await user.click(await findModelMenuOption(optionName));
}

test("Edit only the model for an existing thread", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({ selectedModel: "claude-opus-5" });
  configureRunModels(["claude-opus-5", "claude-sonnet-5"]);

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ComposerModelPanel]: false,
      [FeatureSwitchKey.ChatPreference]: true,
    },
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
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
  });

  await readyComposer();
  await expect(modelPicker("Claude Opus 5.5")).resolves.toBeVisible();
});

test("Show Auto when an existing thread's model is no longer selectable", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({ selectedModel: "deepseek-v4.1-flash" });
  context.mocks.data.availableRunModels([
    runModelFixture("okou-1.0", 1),
    {
      ...runModelFixture("gpt-6-sol", 2, {
        providerType: "codex-oauth-token",
        credentialScope: "member",
      }),
      subscriptionOptions: { efforts: ["low", "high"], serviceTier: null },
    },
  ]);

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
  });

  await readyChat();
  await user.click(await modelPicker("Auto"));
  await expect(findModelMenuOption(/^GPT 6 Sol/iu)).resolves.toBeVisible();
  expect(queryModelMenuOption(/DeepSeek/iu)).not.toBeInTheDocument();
});

test("Keep an existing thread's explicit model", async () => {
  installRunChat({ selectedModel: "claude-opus-5" });
  configureRunModels(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5"]);
  preference("claude-opus-5-5");

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
  });

  await readyChat();
  await expect(modelPicker("Claude Opus 5")).resolves.toBeVisible();
});

test("Start a new chat on Auto without a saved preference", async () => {
  configureRunModels(["claude-fable-5-1", "claude-opus-5-5"]);

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
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
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
  });

  await readyComposer();
  await expect(modelPicker("Auto")).resolves.toBeVisible();
});
