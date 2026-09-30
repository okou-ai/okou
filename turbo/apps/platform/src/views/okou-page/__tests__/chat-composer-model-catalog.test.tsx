import type { OrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

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

function builtInPolicy(model: string, index: number): OrgModelPolicy {
  return {
    id: `e5000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
    model,
    modelLabel: model,
    isDefault: false,
    defaultProviderType: "built-in",
    credentialScope: "org",
    modelProviderId: null,
    modelProviderSurfaceId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: POLICY_DATE,
    updatedAt: POLICY_DATE,
  } as OrgModelPolicy;
}

function configurePolicies(models: readonly string[]): void {
  context.mocks.data.orgModelPolicies(
    models.map((model, index) => {
      return builtInPolicy(model, index + 1);
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

test("Offer only active catalog models in catalog order with catalog names", async () => {
  const user = userEvent.setup({ delay: null });
  configurePolicies([
    "gpt-6-luna",
    "claude-fable-5",
    "claude-sonnet-5",
    "okou-1.0",
  ]);

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyComposer();

  await user.click(await composerModelTrigger("Auto"));
  await expect(findModelMenuOption(/^GPT 6 Luna/u)).resolves.toBeVisible();
  const names = queryAllByRoleFast("menuitemradio").map((option) => {
    return option.getAttribute("aria-label") ?? option.textContent?.trim();
  });
  // Each row carries its catalog display price tier.
  expect(names).toStrictEqual(["Auto$", "Claude Sonnet 5$$", "GPT 6 Luna$"]);
});

test("Show the replacement for a thread pinned to a retired model", async () => {
  installRunChat({ selectedModel: "claude-fable-5" });
  configurePolicies(["okou-1.0", "claude-fable-5-1"]);

  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  await expect(composerModelTrigger("Claude Fable 5.1")).resolves.toBeVisible();
});

test("Resolve a member preference of a retired model to its replacement", async () => {
  configurePolicies(["okou-1.0", "gpt-6-luna", "claude-sonnet-5"]);
  preference("deepseek-v4-pro");

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyComposer();

  await expect(composerModelTrigger("GPT 6 Luna")).resolves.toBeVisible();
});

test("Default a new chat to the catalog system default", async () => {
  context.mocks.data.modelCatalogSystemDefault("claude-sonnet-5");
  configurePolicies(["okou-1.0", "claude-sonnet-5", "gpt-6-luna"]);

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyComposer();

  await expect(composerModelTrigger("Claude Sonnet 5")).resolves.toBeVisible();
});
