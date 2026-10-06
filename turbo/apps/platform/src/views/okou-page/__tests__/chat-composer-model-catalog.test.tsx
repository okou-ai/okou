import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { AvailableRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import { findModelMenuOption } from "./chat-model-menu-test-helpers.ts";
import {
  context,
  installRunChat,
  NEW_CHAT_PATH,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const POLICY_DATE = "2026-09-30T09:00:00.000Z";

function personalRunModel(model: string): AvailableRunModel {
  return {
    model,
    modelLabel: model,
    defaultProviderType:
      model === "okou-1.0"
        ? "built-in"
        : model.startsWith("claude-")
          ? "claude-code-oauth-token"
          : "codex-oauth-token",
    credentialScope: model === "okou-1.0" ? "org" : "member",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
  };
}

function configureRunModels(models: readonly string[]): void {
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.availableRunModels(
    models.map((model) => {
      return personalRunModel(model);
    }),
  );
}

function preference(selectedModel: string): void {
  context.mocks.data.userModelPreference({
    selectedModel,
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: POLICY_DATE,
  } as Parameters<typeof context.mocks.data.userModelPreference>[0]);
}

async function readyComposer(): Promise<void> {
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();
}

test("Offer the active catalog models in catalog order with catalog names", async () => {
  const user = userEvent.setup({ delay: null });
  configureRunModels([
    "gpt-6-luna",
    "claude-fable-5",
    "claude-sonnet-5",
    "okou-1.0",
  ]);

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
  });
  await readyComposer();

  await user.click(await composerModelTrigger("Auto"));
  await expect(findModelMenuOption(/^GPT 6 Luna/u)).resolves.toBeVisible();
  const names = queryAllByRoleFast("menuitemradio").map((option) => {
    return option.getAttribute("aria-label") ?? option.textContent?.trim();
  });
  expect(names).toStrictEqual([
    "Auto",
    "Claude Sonnet 5Claude Code (OAuth Token)",
    "GPT 6 LunaChatGPT (Codex)",
  ]);
});

test("Show the replacement for a thread pinned to a retired model", async () => {
  installRunChat({ selectedModel: "claude-fable-5" });
  configureRunModels(["okou-1.0", "claude-fable-5-1"]);

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
  });
  await readyChat();

  await expect(composerModelTrigger("Claude Fable 5.1")).resolves.toBeVisible();
});

test("Resolve a member preference of a retired model to its replacement", async () => {
  configureRunModels(["okou-1.0", "gpt-6-luna", "claude-sonnet-5"]);
  preference("deepseek-v4-pro");

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: { [FeatureSwitchKey.ComposerModelPanel]: false },
  });
  await readyComposer();

  await expect(composerModelTrigger("GPT 6 Luna")).resolves.toBeVisible();
});

test("Default a new chat to the catalog system default", async () => {
  context.mocks.data.modelCatalogSystemDefault("claude-sonnet-5");
  configureRunModels(["okou-1.0", "claude-sonnet-5", "gpt-6-luna"]);

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyComposer();

  await expect(composerModelTrigger("Claude Sonnet 5")).resolves.toBeVisible();
});
