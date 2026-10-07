import {
  claudeCodeDeviceAuthContract,
  type ClaudeCodeDeviceAuthScope,
} from "@okouai/api-contracts/contracts/claude-code-device-auth";
import {
  codexDeviceAuthContract,
  type CodexDeviceAuthScope,
} from "@okouai/api-contracts/contracts/codex-device-auth";
import type {
  ModelProviderResponse,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockAutoRunModel,
  mockSubscriptionRunModel,
} from "../../../mocks/handlers/api-run-models.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import {
  context,
  findButton,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const FIXTURE_DATE = "2026-08-18T09:00:00.000Z";
const ACTIVE_CODEX_ID = "f1000000-0000-4000-a000-000000000101";
const INACTIVE_CODEX_ID = "f1000000-0000-4000-a000-000000000102";
const CODEX_ROUTE_ID = "f1000000-0000-4000-a000-000000000103";
const ACTIVE_CLAUDE_ID = "f1000000-0000-4000-a000-000000000201";
const INACTIVE_CLAUDE_ID = "f1000000-0000-4000-a000-000000000202";
const CLAUDE_ROUTE_ID = "f1000000-0000-4000-a000-000000000203";

type PersonalProviderType = Extract<
  ModelProviderType,
  "claude-code-oauth-token" | "codex-oauth-token"
>;

/**
 * The API projects a personal model's availability from the member's current
 * accounts: a usable active account makes it available, otherwise the member
 * must reconnect.
 */
function configurePersonalRoute(args: {
  readonly model: string;
  readonly modelLabel: string;
  readonly providerType: PersonalProviderType;
  readonly modelProviderId?: string | null;
  readonly providers: () => readonly ModelProviderResponse[];
}): void {
  context.mocks.api(runModelsMainContract.list, ({ respond }) => {
    const usable = args.providers().some((candidate) => {
      return (
        candidate.type === args.providerType &&
        candidate.isActive !== false &&
        !candidate.needsReconnect
      );
    });
    return respond(200, {
      defaultModel: "okou-1.0",
      models: [
        mockAutoRunModel(),
        mockSubscriptionRunModel(args.model, {
          modelLabel: args.modelLabel,
          providerType: args.providerType,
          modelProviderId: args.modelProviderId ?? null,
          availability: usable ? "available" : "reconnect_required",
        }),
      ],
    });
  });
}

function provider(args: {
  readonly id: string;
  readonly type: PersonalProviderType;
  readonly email: string;
  readonly isActive?: boolean;
  readonly modelProviderId?: string;
  readonly needsReconnect?: boolean;
}): ModelProviderResponse {
  const isCodex = args.type === "codex-oauth-token";
  return {
    id: args.id,
    ...(args.modelProviderId === undefined
      ? {}
      : { modelProviderId: args.modelProviderId }),
    ...(args.isActive === undefined ? {} : { isActive: args.isActive }),
    type: args.type,
    framework: isCodex ? "codex" : "claude-code",
    accountEmail: args.email,
    workspaceName: args.email,
    planType: "pro",
    needsReconnect: args.needsReconnect ?? false,
    lastRefreshErrorCode:
      args.needsReconnect === true ? "refresh_token_expired" : null,
    createdAt: FIXTURE_DATE,
    updatedAt: FIXTURE_DATE,
  };
}

function installPersonalProviders(
  initialProviders: readonly ModelProviderResponse[],
): {
  readonly current: () => readonly ModelProviderResponse[];
  readonly replace: (providers: readonly ModelProviderResponse[]) => void;
} {
  let providers = [...initialProviders];
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    return respond(200, { modelProviders: providers });
  });
  return {
    current: () => {
      return providers;
    },
    replace: (nextProviders) => {
      providers = [...nextProviders];
    },
  };
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

test("Connect Codex before sending with a personal route", async () => {
  const connectedProvider = provider({
    id: ACTIVE_CODEX_ID,
    type: "codex-oauth-token",
    email: "active.codex@example.com",
    isActive: true,
    modelProviderId: CODEX_ROUTE_ID,
  });
  const personalProviders = installPersonalProviders([]);
  const approval = context.mocks.deferred<void>();
  const user = userEvent.setup({ delay: null });
  const clipboard = context.mocks.browser.clipboardWriteText();
  installRunChat({ selectedModel: "gpt-5.6-luna" });
  configurePersonalRoute({
    model: "gpt-5.6-luna",
    modelLabel: "GPT 5.6 Luna",
    providerType: "codex-oauth-token",
    providers: personalProviders.current,
  });
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "personal-codex-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      expiresIn: 60,
      interval: 1,
    });
  });
  context.mocks.api(
    codexDeviceAuthContract.complete,
    async ({ respond, withSignal }) => {
      await withSignal(approval.promise);
      personalProviders.replace([connectedProvider]);
      return respond(200, {
        status: "complete",
        provider: connectedProvider,
        created: true,
      });
    },
  );

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await expect(composerModelTrigger("GPT 5.6 Luna")).resolves.toBeVisible();

  await user.click(composer);
  await user.keyboard("Hello");
  const sendButton = await findButton("Send");
  expect(sendButton).toBeDisabled();
  click(sendButton);

  const configureButton = await findButton("Configure model");
  expect(configureButton).toHaveAccessibleName(
    "Configure model: The selected model is not available. Configure it before sending.",
  );

  click(configureButton);

  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  expect(dialog).toHaveTextContent("ABCD-EFGH");
  const approvalLink = within(dialog).getByTestId("codex-device-auth-open");
  expect(queryAllByRoleFast("link", dialog)).toContain(approvalLink);
  expect(approvalLink).toHaveAttribute(
    "href",
    "https://auth.openai.com/codex/device",
  );
  expect(clipboard.writes).toStrictEqual([]);

  click(buttonNamed("Copy to clipboard", dialog));
  await waitFor(() => {
    expect(buttonNamed("Copied", dialog)).toBeInTheDocument();
  });
  expect(clipboard.writes).toStrictEqual(["ABCD-EFGH"]);

  approval.resolve();

  await expect(screen.findByText("ChatGPT connected")).resolves.toBeVisible();
  await waitFor(() => {
    expect(queryButton("Configure model")).toBeNull();
  });
});

test("Complete Claude Code login from a blocked message", async () => {
  const connectedProvider = provider({
    id: ACTIVE_CLAUDE_ID,
    type: "claude-code-oauth-token",
    email: "active.claude@example.com",
    isActive: true,
    modelProviderId: CLAUDE_ROUTE_ID,
  });
  const personalProviders = installPersonalProviders([]);
  context.mocks.browser.open(null);
  installRunChat({ selectedModel: "claude-opus-5-5" });
  configurePersonalRoute({
    model: "claude-opus-5-5",
    modelLabel: "Claude Opus 5.5",
    providerType: "claude-code-oauth-token",
    providers: personalProviders.current,
  });
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "personal-claude-session",
      type: "claude-code",
      status: "pending",
      scope: "personal",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 60,
    });
  });
  context.mocks.api(claudeCodeDeviceAuthContract.complete, ({ respond }) => {
    personalProviders.replace([connectedProvider]);
    return respond(200, {
      status: "complete",
      provider: connectedProvider,
      created: true,
    });
  });

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await expect(composerModelTrigger("Claude Opus 5.5")).resolves.toBeVisible();
  await fillComposer(composer, "Explain this failure");
  const sendButton = await findButton("Send");
  expect(sendButton).toBeDisabled();
  click(sendButton);
  click(await findButton("Configure model"));

  const dialog = await screen.findByRole("dialog", {
    name: "Connect Claude",
  });
  const authorizationCode = await screen.findByLabelText("Authorization code");

  await fill(authorizationCode, "claude-valid-authorization-code");
  click(buttonNamed("Connect", dialog));

  await expect(screen.findByText("Claude connected")).resolves.toBeVisible();
  await waitFor(() => {
    expect(queryButton("Configure model")).toBeNull();
  });
});

test("Reconnect the personal provider used by the selected model", async () => {
  let startBody: unknown;
  const activeProvider = provider({
    id: ACTIVE_CODEX_ID,
    type: "codex-oauth-token",
    email: "active.codex@example.com",
    isActive: true,
    modelProviderId: CODEX_ROUTE_ID,
    needsReconnect: true,
  });
  const inactiveProvider = provider({
    id: INACTIVE_CODEX_ID,
    type: "codex-oauth-token",
    email: "inactive.codex@example.com",
    isActive: false,
    modelProviderId: CODEX_ROUTE_ID,
  });
  const personalProviders = installPersonalProviders([
    inactiveProvider,
    activeProvider,
  ]);
  installRunChat({ selectedModel: "gpt-5.6-sol" });
  configurePersonalRoute({
    model: "gpt-5.6-sol",
    modelLabel: "GPT 5.6 Sol",
    providerType: "codex-oauth-token",
    modelProviderId: CODEX_ROUTE_ID,
    providers: personalProviders.current,
  });
  context.mocks.api(codexDeviceAuthContract.start, ({ body, respond }) => {
    startBody = body;
    return respond(200, {
      sessionToken: "reconnect-codex-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "RCNX-CODE",
      expiresIn: 60,
      interval: 1,
    });
  });
  context.mocks.api(codexDeviceAuthContract.complete, ({ respond }) => {
    return respond(200, { status: "pending", errorMessage: null });
  });

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });

  await expect(composerModelTrigger("GPT 5.6 Sol")).resolves.toBeVisible();
  const configureButton = await findButton("Configure model");

  click(configureButton);

  const dialog = await screen.findByRole("dialog", {
    name: "Re-connect Codex",
  });
  expect(dialog).toBeVisible();
  await waitFor(() => {
    expect(startBody).toStrictEqual({
      scope: "personal" satisfies CodexDeviceAuthScope,
      mode: "reconnect",
      modelProviderId: ACTIVE_CODEX_ID,
    });
  });
  expect(dialog).not.toHaveTextContent("inactive.codex@example.com");
});

test("Reconnect Claude Code for an existing chat", async () => {
  let startBody: unknown;
  const activeProvider = provider({
    id: ACTIVE_CLAUDE_ID,
    type: "claude-code-oauth-token",
    email: "active.claude@example.com",
    isActive: true,
    modelProviderId: CLAUDE_ROUTE_ID,
    needsReconnect: true,
  });
  const inactiveProvider = provider({
    id: INACTIVE_CLAUDE_ID,
    type: "claude-code-oauth-token",
    email: "inactive.claude@example.com",
    isActive: false,
    modelProviderId: CLAUDE_ROUTE_ID,
  });
  const personalProviders = installPersonalProviders([
    inactiveProvider,
    activeProvider,
  ]);
  installRunChat({ selectedModel: "claude-opus-5-5" });
  configurePersonalRoute({
    model: "claude-opus-5-5",
    modelLabel: "Claude Opus 5.5",
    providerType: "claude-code-oauth-token",
    modelProviderId: CLAUDE_ROUTE_ID,
    providers: personalProviders.current,
  });
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ body, respond }) => {
    startBody = body;
    return respond(200, {
      sessionToken: "reconnect-claude-session",
      type: "claude-code",
      status: "pending",
      scope: "personal",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 60,
    });
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });

  await readyChat();
  await expect(composerModelTrigger("Claude Opus 5.5")).resolves.toBeVisible();
  const configureButton = await findButton("Configure model");

  click(configureButton);

  const dialog = await screen.findByRole("dialog", {
    name: "Reconnect Claude",
  });
  expect(dialog).toBeVisible();
  await waitFor(() => {
    expect(startBody).toStrictEqual({
      scope: "personal" satisfies ClaudeCodeDeviceAuthScope,
      mode: "reconnect",
      modelProviderId: ACTIVE_CLAUDE_ID,
    });
  });
  expect(dialog).not.toHaveTextContent("inactive.claude@example.com");
});
