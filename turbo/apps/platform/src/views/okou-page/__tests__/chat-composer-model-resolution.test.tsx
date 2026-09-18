import {
  getCanonicalModelDisplayName,
  type ModelProviderType,
  type OrgModelPolicy,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

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
    id: `e3000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
    model,
    modelLabel: getCanonicalModelDisplayName(model),
    isDefault: options.default ?? false,
    defaultProviderType: providerType,
    credentialScope,
    modelProviderId:
      credentialScope === "member"
        ? `e4000000-0000-4000-a000-${String(index).padStart(12, "0")}`
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
  options: Readonly<Partial<Record<SupportedRunModel, PolicyOptions>>> = {},
): void {
  context.mocks.data.orgModelPolicies(
    models.map((model, index) => {
      return modelPolicy(model, index + 1, {
        ...options[model],
        default: model === defaultModel,
      });
    }),
  );
}

function preference(
  selectedModel: SupportedRunModel,
  serviceTier: "priority" | null = null,
): void {
  context.mocks.data.userModelPreference({
    selectedModel,
    serviceTier,
    modelSettings: {},
    selectedVideoModel: null,
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
  await user.click(await screen.findByRole("option", { name: optionName }));
}

test("Edit only the model for an existing thread", async () => {
  const user = userEvent.setup({ delay: null });
  installRunChat({ selectedModel: "claude-opus-5" });
  configurePolicies(["claude-opus-5", "claude-sonnet-4-6"], "claude-opus-5");

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
    },
  });

  await readyChat();
  await expect(modelPicker("Claude Opus 5")).resolves.toBeVisible();

  await chooseModel(user, "Claude Opus 5", /^Claude Sonnet 4\.6/iu);

  await expect(modelPicker("Claude Sonnet 4.6")).resolves.toBeVisible();
  expect(
    screen.queryByRole("group", { name: "Model for this chat" }),
  ).not.toBeInTheDocument();
});

test("Resolve the model shown for a chat", async () => {
  installRunChat({ selectedModel: "claude-fable-5-1" });
  configurePolicies(
    ["claude-fable-5-1", "claude-opus-4-8"],
    "claude-fable-5-1",
  );
  preference("claude-opus-4-8");

  await setupPage({ context, path: NEW_CHAT_PATH });

  await readyComposer();
  await expect(modelPicker("Claude Opus 4.8")).resolves.toBeVisible();
});

test("Keep an existing thread's explicit model", async () => {
  installRunChat({ selectedModel: "claude-opus-5" });
  configurePolicies(
    ["claude-fable-5-1", "claude-opus-4-8", "claude-opus-5"],
    "claude-fable-5-1",
  );
  preference("claude-opus-4-8");

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(modelPicker("Claude Opus 5")).resolves.toBeVisible();
});
