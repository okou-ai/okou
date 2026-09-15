import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import {
  getCanonicalModelDisplayName,
  type ModelProviderType,
  type OrgModelPolicy,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { fillComposer } from "./chat-test-helpers.ts";
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

async function modelPicker(name: string): Promise<HTMLElement> {
  return await screen.findByRole("combobox", { name });
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

async function sendMessage(text: string): Promise<void> {
  const user = userEvent.setup({ delay: null });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fillComposer(composer, text);
  const mountedComposer = await screen.findByRole("textbox", {
    name: "Message",
  });
  const composerCard = mountedComposer.closest(
    "[data-slot='chat-composer-card']",
  );
  if (!composerCard) {
    throw new Error("Mounted composer card was not found");
  }
  const sendButton = await waitFor(() => {
    const button = buttonNamed("Send", composerCard);
    expect(button).toBeEnabled();
    return button;
  });
  await user.click(sendButton);
  await waitFor(() => {
    const currentComposer = screen.getByRole("textbox", { name: "Message" });
    expect(currentComposer).not.toHaveTextContent(text);
  });
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

test("Ignore Fast mode when it is unavailable", async () => {
  const user = userEvent.setup({ delay: null });
  const serviceTiers: (CodexServiceTier | undefined)[] = [];
  installRunChat({
    selectedModel: "gpt-5.6-sol",
    codexServiceTier: "fast",
    onRunCreate: (body) => {
      serviceTiers.push(body.runOptions?.codexServiceTier);
    },
  });
  configurePolicies(["gpt-5.6-sol"], "gpt-5.6-sol");

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.CodexFastMode]: false,
    },
  });

  await readyComposer();
  const picker = await modelPicker("GPT 5.6 Sol");
  await user.click(picker);
  await expect(
    screen.findByRole("option", { name: /^GPT 5\.6 Sol/iu }),
  ).resolves.toBeVisible();
  expect(
    screen.queryByRole("option", { name: "GPT 5.6 Sol Fast" }),
  ).not.toBeInTheDocument();
  await user.keyboard("{Escape}");

  await sendMessage("Run this in standard mode");

  await waitFor(() => {
    expect(serviceTiers).toStrictEqual([undefined]);
  });
  await expect(
    screen.findByText("Run this in standard mode"),
  ).resolves.toBeVisible();
});
