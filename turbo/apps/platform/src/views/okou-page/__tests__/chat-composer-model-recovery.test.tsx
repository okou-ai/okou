import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
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
  OrgModelPolicy,
  SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { fillComposer } from "./chat-test-helpers.ts";
import {
  context,
  findButton,
  findLink,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

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

function policy(args: {
  readonly isDefault?: boolean;
  readonly model: SupportedRunModel;
  readonly modelLabel: string;
  readonly providerType: PersonalProviderType;
  readonly modelProviderId: string | null;
}): OrgModelPolicy {
  return {
    id: crypto.randomUUID(),
    model: args.model,
    modelLabel: args.modelLabel,
    isDefault: args.isDefault ?? true,
    defaultProviderType: args.providerType,
    credentialScope: "member",
    modelProviderId: args.modelProviderId,
    modelProviderSurfaceId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: FIXTURE_DATE,
    updatedAt: FIXTURE_DATE,
  };
}

function builtInPolicy(
  model: SupportedRunModel,
  modelLabel: string,
  isDefault: boolean,
): OrgModelPolicy {
  return {
    id: crypto.randomUUID(),
    model,
    modelLabel,
    isDefault,
    defaultProviderType: "built-in",
    credentialScope: "org",
    modelProviderId: null,
    modelProviderSurfaceId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: FIXTURE_DATE,
    updatedAt: FIXTURE_DATE,
  };
}

function billingStatus(args: {
  readonly restrictedBuiltInModels: boolean;
  readonly supportByok: boolean;
  readonly tier: "limited-free-1" | "pro";
}): BillingStatusResponse {
  return {
    showUsagePack: false,
    tier: args.tier,
    supportByok: args.supportByok,
    restrictedBuiltInModels: args.restrictedBuiltInModels,
    credits: 20_000,
    onboardingPaymentPending: false,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

function configurePersonalRoute(args: {
  readonly model: SupportedRunModel;
  readonly modelLabel: string;
  readonly providerType: PersonalProviderType;
  readonly modelProviderId?: string | null;
}): void {
  context.mocks.data.orgModelPolicies([
    policy({
      ...args,
      modelProviderId: args.modelProviderId ?? null,
    }),
  ]);
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
    secretName: isCodex ? null : "CLAUDE_CODE_OAUTH_TOKEN",
    authMethod: isCodex ? "auth_json" : null,
    secretNames: isCodex ? ["CODEX_AUTH_JSON"] : null,
    isDefault: false,
    selectedModel: null,
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
  readonly replace: (providers: readonly ModelProviderResponse[]) => void;
} {
  let providers = [...initialProviders];
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    return respond(200, { modelProviders: providers });
  });
  return {
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
  const opened = context.mocks.browser.open(context.mocks.browser.authWindow());
  installRunChat({ selectedModel: "gpt-5.5" });
  configurePersonalRoute({
    model: "gpt-5.5",
    modelLabel: "GPT 5.5",
    providerType: "codex-oauth-token",
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

  await setupPage({ context, path: NEW_CHAT_PATH });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await expect(
    screen.findByRole("combobox", { name: "GPT 5.5" }),
  ).resolves.toBeVisible();

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
  click(within(dialog).getByTestId("codex-device-auth-open"));

  await expect(
    within(dialog).findByText("Device code copied. Waiting for approval..."),
  ).resolves.toBeVisible();

  expect(clipboard.writes).toStrictEqual(["ABCD-EFGH"]);
  expect(opened.calls).toStrictEqual([
    {
      url: "https://auth.openai.com/codex/device",
      target: "_blank",
      features: null,
    },
  ]);

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
  installRunChat({ selectedModel: "claude-opus-4-8" });
  configurePersonalRoute({
    model: "claude-opus-4-8",
    modelLabel: "Claude Opus 4.8",
    providerType: "claude-code-oauth-token",
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

  await setupPage({ context, path: NEW_CHAT_PATH });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await expect(
    screen.findByRole("combobox", { name: "Claude Opus 4.8" }),
  ).resolves.toBeVisible();
  await fillComposer(composer, "Explain this failure");
  const sendButton = await findButton("Send");
  expect(sendButton).toBeDisabled();
  click(sendButton);
  click(await findButton("Configure model"));

  const dialog = await screen.findByRole("dialog", {
    name: "Connect Claude Code",
  });
  const authorizationCode = await screen.findByLabelText("Authorization code");

  click(buttonNamed("Connect", dialog));

  await expect(
    screen.findByText("Paste the Claude Code authorization code to continue."),
  ).resolves.toBeVisible();

  click(buttonNamed("Open Claude approval page", dialog));

  await expect(
    screen.findByText(
      "The approval page could not be opened. Use the link manually and paste the code here.",
    ),
  ).resolves.toBeVisible();
  expect(authorizationCode).toBeVisible();

  await fill(authorizationCode, "claude-valid-authorization-code");
  click(buttonNamed("Connect", dialog));

  await expect(
    screen.findByText("Claude Code connected"),
  ).resolves.toBeVisible();
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
  installPersonalProviders([inactiveProvider, activeProvider]);
  installRunChat({ selectedModel: "gpt-5.6-sol" });
  configurePersonalRoute({
    model: "gpt-5.6-sol",
    modelLabel: "GPT 5.6 Sol",
    providerType: "codex-oauth-token",
    modelProviderId: CODEX_ROUTE_ID,
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

  await setupPage({ context, path: NEW_CHAT_PATH });

  await expect(
    screen.findByRole("combobox", { name: "GPT 5.6 Sol" }),
  ).resolves.toBeVisible();
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
  installPersonalProviders([inactiveProvider, activeProvider]);
  installRunChat({ selectedModel: "claude-opus-4-8" });
  configurePersonalRoute({
    model: "claude-opus-4-8",
    modelLabel: "Claude Opus 4.8",
    providerType: "claude-code-oauth-token",
    modelProviderId: CLAUDE_ROUTE_ID,
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

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByRole("combobox", { name: "Claude Opus 4.8" }),
  ).resolves.toBeVisible();
  const configureButton = await findButton("Configure model");

  click(configureButton);

  const dialog = await screen.findByRole("dialog", {
    name: "Re-connect Claude Code",
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

test("Refresh model availability without losing useful options", async () => {
  type BillingMode = "failed" | "limited" | "upgraded";
  let billingMode: BillingMode = "limited";
  const failedRefresh = context.mocks.deferred<void>();
  installRunChat({ selectedModel: "gpt-5.6-luna" });
  context.mocks.data.orgModelPolicies([
    builtInPolicy("gpt-5.6-luna", "GPT 5.6 Luna", true),
    policy({
      isDefault: false,
      model: "claude-opus-4-8",
      modelLabel: "Claude Opus 4.8",
      providerType: "claude-code-oauth-token",
      modelProviderId: CLAUDE_ROUTE_ID,
    }),
  ]);
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    if (billingMode === "failed") {
      failedRefresh.resolve();
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Model availability could not be refreshed",
        },
      });
    }
    if (billingMode === "upgraded") {
      return respond(
        200,
        billingStatus({
          tier: "pro",
          supportByok: true,
          restrictedBuiltInModels: false,
        }),
      );
    }
    return respond(
      200,
      billingStatus({
        tier: "limited-free-1",
        supportByok: false,
        restrictedBuiltInModels: true,
      }),
    );
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const picker = await screen.findByRole("combobox", {
    name: "GPT 5.6 Luna",
  });
  click(picker);
  await expect(
    screen.findByRole("option", { name: /GPT 5\.6 Luna/iu }),
  ).resolves.toBeVisible();
  const gatedPersonalOption = await screen.findByRole("option", {
    name: /Claude Opus 4\.8/iu,
  });
  expect(within(gatedPersonalOption).getByText("Pro")).toBeVisible();
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("billing:changed")).toBeTruthy();
  });

  billingMode = "upgraded";
  context.mocks.ably.trigger("billing:changed");

  const personalOption = await screen.findByRole("option", {
    name: /Claude Opus 4\.8/iu,
  });
  expect(personalOption).toBeVisible();
  expect(within(personalOption).queryByText("Pro")).toBeNull();

  billingMode = "failed";
  context.mocks.ably.trigger("billing:changed");
  await failedRefresh.promise;

  await expect(
    screen.findByText("Model availability could not be refreshed"),
  ).resolves.toBeVisible();
  expect(
    screen.getByRole("option", { name: /Claude Opus 4\.8/iu }),
  ).toBeVisible();
  expect(screen.queryByText("Loading models...")).toBeNull();
});

test("Show the last resolved chat model after visiting Agents", async () => {
  let refreshPending = false;
  const refreshStarted = context.mocks.deferred<void>();
  const releaseRefresh = context.mocks.deferred<void>();
  installRunChat({ selectedModel: "claude-opus-4-8" });
  context.mocks.data.orgModelPolicies([
    builtInPolicy("claude-opus-4-8", "Claude Opus 4.8", true),
  ]);
  context.mocks.api(
    billingStatusContract.get,
    async ({ respond, withSignal }) => {
      if (refreshPending) {
        refreshStarted.resolve();
        await withSignal(releaseRefresh.promise);
      }
      return respond(
        200,
        billingStatus({
          tier: "pro",
          supportByok: true,
          restrictedBuiltInModels: false,
        }),
      );
    },
  );

  await setupPage({ context, path: NEW_CHAT_PATH });

  await expect(
    screen.findByRole("combobox", { name: "Claude Opus 4.8" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("billing:changed")).toBeTruthy();
  });

  click(await findLink("Agents"));

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  refreshPending = true;
  context.mocks.ably.trigger("billing:changed");
  await refreshStarted.promise;
  click(await findLink("Chat"));

  await expect(
    screen.findByRole("combobox", { name: "Claude Opus 4.8" }),
  ).resolves.toBeVisible();
  releaseRefresh.resolve();
});
