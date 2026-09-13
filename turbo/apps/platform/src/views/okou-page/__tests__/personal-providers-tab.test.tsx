import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  click,
  setupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import type { SupportedLocale } from "../../../i18n/resources.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function radioByName(
  name: string | RegExp,
  container: ParentNode = document.body,
): HTMLElement {
  const radio = queryAllByRoleFast("radio", container).find((candidate) => {
    const accessibleName =
      candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
    return typeof name === "string"
      ? accessibleName.trim() === name
      : name.test(accessibleName);
  });
  if (!radio) {
    throw new Error(`Radio not found: ${String(name)}`);
  }
  return radio;
}

function stalePersonalCodexProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000301",
    type: "codex-oauth-token",
    framework: "codex",
    secretName: null,
    authMethod: "auth_json",
    secretNames: ["CODEX_AUTH_JSON"],
    isDefault: false,
    selectedModel: null,
    workspaceName: "Personal ChatGPT",
    planType: "pro",
    subscriptionResetPeriod: "Weekly",
    subscriptionNextResetAt: "2030-01-01T00:00:00.000Z",
    accountEmail: "codex.user@example.com",
    needsReconnect: true,
    lastRefreshErrorCode: "refresh_token_expired",
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function connectedPersonalCodexProvider(
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    ...stalePersonalCodexProvider(),
    subscriptionUsage: {
      fiveHour: {
        usedPercent: 18,
        remainingPercent: 82,
        resetAt: "2030-01-01T05:00:00.000Z",
        windowSeconds: 18_000,
      },
      weekly: {
        usedPercent: 45,
        remainingPercent: 55,
        resetAt: "2030-01-07T00:00:00.000Z",
        windowSeconds: 604_800,
      },
    },
    subscriptionResetCredits: 2,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    ...overrides,
  };
}

function connectedPersonalCodexAccount(args: {
  readonly id: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly createdAt: string;
}): ModelProviderResponse {
  return {
    ...connectedPersonalCodexProvider(),
    id: args.id,
    modelProviderId: "00000000-0000-4000-a000-000000000300",
    isActive: args.isActive,
    accountEmail: args.email,
    workspaceName: args.email,
    createdAt: args.createdAt,
  };
}

function connectedPersonalClaudeCodeProvider(): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000302",
    type: "claude-code-oauth-token",
    framework: "claude-code",
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    workspaceName: "claude.user@example.com",
    planType: "pro",
    subscriptionResetPeriod: "weekly",
    subscriptionNextResetAt: "2030-01-07T00:00:00.000Z",
    subscriptionUsage: {
      fiveHour: {
        usedPercent: 12,
        remainingPercent: 88,
        resetAt: "2030-01-01T05:00:00.000Z",
        windowSeconds: 18_000,
      },
      weekly: {
        usedPercent: 24,
        remainingPercent: 76,
        resetAt: "2030-01-07T00:00:00.000Z",
        windowSeconds: 604_800,
      },
    },
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function mockBillingCapabilities(modelCapabilities: {
  readonly supportByok: boolean;
  readonly restrictedBuiltInModels: boolean;
}): void {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    const status: BillingStatusResponse = {
      showUsagePack: false,
      tier: "pro",
      ...modelCapabilities,
      credits: 20_000,
      onboardingPaymentPending: false,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: false,
      autoRecharge: { enabled: false, threshold: null, amount: null },
      creditExpiry: {
        expiringNextCycle: 0,
        nextExpiryDate: null,
      },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 0,
      concurrencySubscriptions: [],
    };
    return respond(200, status);
  });
}

async function openModelSettings(
  heading = "Models",
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>> = {},
  locale?: SupportedLocale,
): Promise<void> {
  await setupPage({
    context,
    path: "/?settings=model",
    featureSwitches,
    locale,
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
  });
}

function dialogContaining(element: HTMLElement): HTMLElement {
  const dialog = element.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Containing dialog not found");
  }
  return dialog;
}

async function findLatestClaudeCodeInput(): Promise<HTMLInputElement> {
  const inputs = await screen.findAllByTestId("claude-code-device-auth-code");
  const input = inputs.at(-1);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Claude Code authorization code input not found");
  }
  return input;
}

function closeDialogsContainingTestId(testId: string): void {
  const dialogs = new Set(
    screen.queryAllByTestId(testId).map((input) => {
      return dialogContaining(input);
    }),
  );
  for (const dialog of dialogs) {
    if (document.body.contains(dialog)) {
      click(within(dialog).getByLabelText("Close"));
    }
  }
}

function closeClaudeCodeDialogs(): void {
  closeDialogsContainingTestId("claude-code-device-auth-code");
}

function connectButtonInRow(row: HTMLElement, label: string): HTMLElement {
  const button = queryAllByRoleFast("button", row).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

function formatResetInTimeZone(resetAt: string, timeZone: string): string {
  return `resets ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(resetAt))}`;
}

function mockBrowserTimeZone(timeZone: string): void {
  const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...resolvedOptions,
    timeZone,
  });
}

test("Review personal subscriptions through account identity", async () => {
  const user = userEvent.setup();
  mockBrowserTimeZone("America/New_York");
  mockNow(new Date("2030-01-01T00:48:00.000Z"), context.signal);
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  const accountA = {
    ...connectedPersonalCodexAccount({
      id: "00000000-0000-4000-a000-000000000311",
      email: "account-a@example.com",
      isActive: true,
      createdAt: "2026-03-01T00:00:00Z",
    }),
    workspaceName: "Account A Organization",
    subscriptionResetCreditsNextExpiresAt: "2030-01-04T00:48:00.000Z",
  };
  const accountB = {
    ...connectedPersonalCodexAccount({
      id: "00000000-0000-4000-a000-000000000312",
      email: "account-b@example.com",
      isActive: false,
      createdAt: "2026-03-02T00:00:00Z",
    }),
    subscriptionResetCredits: 0,
  };
  const accountC = {
    ...connectedPersonalCodexAccount({
      id: "00000000-0000-4000-a000-000000000313",
      email: "account-c@example.com",
      isActive: false,
      createdAt: "2026-03-03T00:00:00Z",
    }),
    subscriptionResetCredits: null,
  };
  context.mocks.data.personalModelProviders([accountA, accountB, accountC]);
  await openModelSettings("Models", {
    [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
  });
  const rowA = await screen.findByTestId(`oauth-account-${accountA.id}`);
  const rowB = await screen.findByTestId(`oauth-account-${accountB.id}`);
  const rowC = await screen.findByTestId(`oauth-account-${accountC.id}`);
  expect(within(rowA).getByText("account-a@example.com")).toBeInTheDocument();
  expect(within(rowB).getByText("account-b@example.com")).toBeInTheDocument();
  expect(within(rowA).getByText("2 resets left")).toBeVisible();
  expect(within(rowB).getByText("0 resets left")).toBeVisible();
  expect(within(rowC).getByText("Resets —")).toBeVisible();
  expect(
    within(rowC).getByLabelText("Resets left unavailable"),
  ).toBeInTheDocument();
  expect(within(rowA).queryByText("Active")).not.toBeInTheDocument();
  expect(within(rowB).queryByText("Active")).not.toBeInTheDocument();
  expect(within(rowB).queryByText("Use")).not.toBeInTheDocument();
  expect(radioByName("Active", rowA)).toHaveAttribute("aria-checked", "true");
  expect(radioByName("Use", rowB)).toHaveAttribute("aria-checked", "false");
  const usageRings = within(rowA).getAllByRole("progressbar");
  expect(usageRings).toHaveLength(2);
  expect(usageRings[0]).toHaveAttribute("aria-valuenow", "82");
  expect(usageRings[1]).toHaveAttribute("aria-valuenow", "55");
  expect(within(rowA).queryByText("82% left")).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.textContent?.trim() === "Add account";
    }),
  ).toHaveLength(2);
  const accountIdentity = within(rowA).getByText("account-a@example.com");
  await user.hover(accountIdentity);
  await expect(
    screen.findAllByText("Account A Organization"),
  ).resolves.not.toHaveLength(0);
  click(within(rowA).getByLabelText("More options"));
  expect(
    queryAllByRoleFast("menuitem").some((item) => {
      return item.textContent?.trim() === "Remove";
    }),
  ).toBeFalsy();
  click(within(rowA).getByLabelText("More options"));
});

test("Review personal subscriptions through usage details", async () => {
  const user = userEvent.setup();
  mockBrowserTimeZone("America/New_York");
  mockNow(new Date("2030-01-01T00:48:00.000Z"), context.signal);
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  const accountA = {
    ...connectedPersonalCodexAccount({
      id: "00000000-0000-4000-a000-000000000311",
      email: "account-a@example.com",
      isActive: true,
      createdAt: "2026-03-01T00:00:00Z",
    }),
    workspaceName: "Account A Organization",
    subscriptionResetCreditsNextExpiresAt: "2030-01-04T00:48:00.000Z",
  };
  const accountB = {
    ...connectedPersonalCodexAccount({
      id: "00000000-0000-4000-a000-000000000312",
      email: "account-b@example.com",
      isActive: false,
      createdAt: "2026-03-02T00:00:00Z",
    }),
    subscriptionResetCredits: 0,
  };
  const accountC = {
    ...connectedPersonalCodexAccount({
      id: "00000000-0000-4000-a000-000000000313",
      email: "account-c@example.com",
      isActive: false,
      createdAt: "2026-03-03T00:00:00Z",
    }),
    subscriptionResetCredits: null,
  };
  context.mocks.data.personalModelProviders([accountA, accountB, accountC]);
  await openModelSettings("Models", {
    [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
  });
  const rowA = await screen.findByTestId(`oauth-account-${accountA.id}`);
  const rowB = await screen.findByTestId(`oauth-account-${accountB.id}`);
  const rowC = await screen.findByTestId(`oauth-account-${accountC.id}`);
  expect(within(rowA).getByText("account-a@example.com")).toBeInTheDocument();
  expect(within(rowB).getByText("account-b@example.com")).toBeInTheDocument();
  expect(within(rowA).getByText("2 resets left")).toBeVisible();
  expect(within(rowB).getByText("0 resets left")).toBeVisible();
  expect(within(rowC).getByText("Resets —")).toBeVisible();
  expect(
    within(rowC).getByLabelText("Resets left unavailable"),
  ).toBeInTheDocument();
  expect(within(rowA).queryByText("Active")).not.toBeInTheDocument();
  expect(within(rowB).queryByText("Active")).not.toBeInTheDocument();
  expect(within(rowB).queryByText("Use")).not.toBeInTheDocument();
  expect(radioByName("Active", rowA)).toHaveAttribute("aria-checked", "true");
  expect(radioByName("Use", rowB)).toHaveAttribute("aria-checked", "false");
  const usageRings = within(rowA).getAllByRole("progressbar");
  expect(usageRings).toHaveLength(2);
  expect(usageRings[0]).toHaveAttribute("aria-valuenow", "82");
  expect(usageRings[1]).toHaveAttribute("aria-valuenow", "55");
  expect(within(rowA).queryByText("82% left")).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.textContent?.trim() === "Add account";
    }),
  ).toHaveLength(2);
  await user.hover(within(rowA).getByLabelText("2 resets left"));
  await expect(
    screen.findAllByText("2 resets left · expires in 3d"),
  ).resolves.not.toHaveLength(0);
  usageRings[0].focus();
  await expect(screen.findAllByText("82% left")).resolves.not.toHaveLength(0);
  expect(
    screen.getAllByText(
      formatResetInTimeZone(
        "2030-01-01T05:00:00.000Z",
        "America/New_York",
      ).replace(/^resets /u, ""),
    ),
  ).not.toHaveLength(0);
  usageRings[1]?.focus();
  await expect(
    screen.findAllByText(
      formatResetInTimeZone(
        "2030-01-07T00:00:00.000Z",
        "America/New_York",
      ).replace(/^resets /u, ""),
    ),
  ).resolves.not.toHaveLength(0);
});

test("Review personal subscriptions through account switching", async () => {
  mockBrowserTimeZone("America/New_York");
  mockNow(new Date("2030-01-01T00:48:00.000Z"), context.signal);
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  const accountA = {
    ...connectedPersonalCodexAccount({
      id: "00000000-0000-4000-a000-000000000311",
      email: "account-a@example.com",
      isActive: true,
      createdAt: "2026-03-01T00:00:00Z",
    }),
    workspaceName: "Account A Organization",
    subscriptionResetCreditsNextExpiresAt: "2030-01-04T00:48:00.000Z",
  };
  const accountB = {
    ...connectedPersonalCodexAccount({
      id: "00000000-0000-4000-a000-000000000312",
      email: "account-b@example.com",
      isActive: false,
      createdAt: "2026-03-02T00:00:00Z",
    }),
    subscriptionResetCredits: 0,
  };
  const accountC = {
    ...connectedPersonalCodexAccount({
      id: "00000000-0000-4000-a000-000000000313",
      email: "account-c@example.com",
      isActive: false,
      createdAt: "2026-03-03T00:00:00Z",
    }),
    subscriptionResetCredits: null,
  };
  context.mocks.data.personalModelProviders([accountA, accountB, accountC]);
  await openModelSettings("Models", {
    [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
  });
  const rowA = await screen.findByTestId(`oauth-account-${accountA.id}`);
  const rowB = await screen.findByTestId(`oauth-account-${accountB.id}`);
  const rowC = await screen.findByTestId(`oauth-account-${accountC.id}`);
  expect(within(rowA).getByText("account-a@example.com")).toBeInTheDocument();
  expect(within(rowB).getByText("account-b@example.com")).toBeInTheDocument();
  expect(within(rowA).getByText("2 resets left")).toBeVisible();
  expect(within(rowB).getByText("0 resets left")).toBeVisible();
  expect(within(rowC).getByText("Resets —")).toBeVisible();
  expect(
    within(rowC).getByLabelText("Resets left unavailable"),
  ).toBeInTheDocument();
  expect(within(rowA).queryByText("Active")).not.toBeInTheDocument();
  expect(within(rowB).queryByText("Active")).not.toBeInTheDocument();
  expect(within(rowB).queryByText("Use")).not.toBeInTheDocument();
  expect(radioByName("Active", rowA)).toHaveAttribute("aria-checked", "true");
  expect(radioByName("Use", rowB)).toHaveAttribute("aria-checked", "false");
  const usageRings = within(rowA).getAllByRole("progressbar");
  expect(usageRings).toHaveLength(2);
  expect(usageRings[0]).toHaveAttribute("aria-valuenow", "82");
  expect(usageRings[1]).toHaveAttribute("aria-valuenow", "55");
  expect(within(rowA).queryByText("82% left")).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.textContent?.trim() === "Add account";
    }),
  ).toHaveLength(2);
  click(radioByName("Use", rowB));
  await waitFor(() => {
    expect(radioByName("Active", rowB)).toHaveAttribute("aria-checked", "true");
    expect(radioByName("Use", rowA)).toHaveAttribute("aria-checked", "false");
    expect(within(rowA).queryByText("Active")).not.toBeInTheDocument();
  });
});

test("Offer Pro when personal subscription providers are unavailable", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.data.personalModelProviders([]);
  mockBillingCapabilities({
    supportByok: false,
    restrictedBuiltInModels: false,
  });

  await openModelSettings("Models");

  const claudeCodeRow = await screen.findByTestId(
    "oauth-card-claude-code-oauth-token",
  );
  const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
  const claudeUpgrade = connectButtonInRow(
    claudeCodeRow,
    "Upgrade Pro to use Claude Code OAuth",
  );
  expect(claudeUpgrade).toHaveTextContent("Upgrade Pro to use");
  expect(
    connectButtonInRow(codexRow, "Upgrade Pro to use ChatGPT (Codex)"),
  ).toHaveTextContent("Upgrade Pro to use");

  click(claudeUpgrade);

  await expect(
    screen.findByRole("heading", { name: "Choose a plan" }),
  ).resolves.toBeInTheDocument();
});

test("Start and close personal Claude login", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  context.mocks.data.personalModelProviders([]);
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "mock-personal-claude-code-session",
      type: "claude-code",
      status: "pending",
      scope: "personal",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 30,
    });
  });

  await openModelSettings();

  const claudeCodeRow = await screen.findByTestId(
    "oauth-card-claude-code-oauth-token",
  );
  expect(
    within(claudeCodeRow).getByText("Claude Code OAuth"),
  ).toBeInTheDocument();
  const connectButton = connectButtonInRow(
    claudeCodeRow,
    "Connect Claude Code OAuth",
  );
  click(connectButton);

  const authorizationCodeInputs = await screen.findAllByTestId(
    "claude-code-device-auth-code",
  );
  expect(authorizationCodeInputs).not.toHaveLength(0);
  expect(screen.getAllByText("Connect Claude Code")).not.toHaveLength(0);
  closeClaudeCodeDialogs();
  await waitFor(() => {
    expect(
      screen.queryAllByTestId("claude-code-device-auth-code"),
    ).toHaveLength(0);
    expect(
      connectButtonInRow(claudeCodeRow, "Connect Claude Code OAuth"),
    ).toBeEnabled();
  });
});

test("Connect a personal Claude subscription", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  context.mocks.data.personalModelProviders([]);
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "mock-personal-claude-code-session",
      type: "claude-code",
      status: "pending",
      scope: "personal",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 30,
    });
  });
  context.mocks.api(claudeCodeDeviceAuthContract.complete, ({ respond }) => {
    const provider = connectedPersonalClaudeCodeProvider();
    context.mocks.data.personalModelProviders([provider]);
    return respond(200, {
      status: "complete",
      provider,
      created: true,
    });
  });

  await openModelSettings();

  const claudeCodeRow = await screen.findByTestId(
    "oauth-card-claude-code-oauth-token",
  );
  const connectButton = connectButtonInRow(
    claudeCodeRow,
    "Connect Claude Code OAuth",
  );
  click(connectButton);

  const codeInput = await findLatestClaudeCodeInput();
  const deviceAuthDialog = dialogContaining(codeInput);
  await fill(codeInput, "claude-auth-code");
  click(within(deviceAuthDialog).getByTestId("claude-code-device-auth-submit"));

  await waitFor(() => {
    expect(screen.getByText("Claude Code connected")).toBeInTheDocument();
    expect(
      within(claudeCodeRow).getByText("Connected (Pro)"),
    ).toBeInTheDocument();
    expect(
      within(claudeCodeRow).queryByText(/claude\.user@example\.com/),
    ).not.toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("88% left")).toBeInTheDocument();
    expect(within(claudeCodeRow).getByText("76% left")).toBeInTheDocument();
    expect(
      within(claudeCodeRow).queryByText(/Unavailable|Unknown/),
    ).not.toBeInTheDocument();
  });
});

test("Review Claude and Codex personal subscription usage", async () => {
  mockBrowserTimeZone("America/New_York");
  mockNow(new Date("2030-01-01T00:48:00.000Z"), context.signal);
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  context.mocks.data.personalModelProviders([
    connectedPersonalClaudeCodeProvider(),
    connectedPersonalCodexProvider({
      subscriptionResetCreditsNextExpiresAt: "2030-01-04T00:48:00.000Z",
    }),
  ]);

  await openModelSettings();

  const claudeCodeRow = await screen.findByTestId(
    "oauth-card-claude-code-oauth-token",
  );
  expect(
    within(claudeCodeRow).getByText("Connected (Pro)"),
  ).toBeInTheDocument();
  expect(
    within(claudeCodeRow).queryByText(/claude\.user@example\.com/),
  ).not.toBeInTheDocument();
  expect(within(claudeCodeRow).getByText("5h")).toBeInTheDocument();
  expect(within(claudeCodeRow).getByText("88% left")).toBeInTheDocument();
  expect(within(claudeCodeRow).getByText("in 4h 12m")).toBeInTheDocument();
  expect(within(claudeCodeRow).getByText("Week")).toBeInTheDocument();
  expect(within(claudeCodeRow).getByText("76% left")).toBeInTheDocument();
  expect(within(claudeCodeRow).getByText("in 5d 23h")).toBeInTheDocument();
  expect(
    within(claudeCodeRow).getByText(
      formatResetInTimeZone("2030-01-01T05:00:00.000Z", "America/New_York"),
    ),
  ).toBeInTheDocument();
  expect(
    within(claudeCodeRow).queryByText(/Unavailable|Unknown|Account:|Reset:/),
  ).not.toBeInTheDocument();

  const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
  expect(within(codexRow).getByText("Connected (Pro)")).toBeInTheDocument();
  expect(
    within(codexRow).queryByText(/Personal ChatGPT/),
  ).not.toBeInTheDocument();
  expect(
    within(codexRow).queryByText(/codex\.user@example\.com/),
  ).not.toBeInTheDocument();
  expect(within(codexRow).getByText("82% left")).toBeInTheDocument();
  expect(within(codexRow).getByText("in 4h 12m")).toBeInTheDocument();
  expect(within(codexRow).getByText("55% left")).toBeInTheDocument();
  expect(within(codexRow).getByText("in 5d 23h")).toBeInTheDocument();
  click(within(codexRow).getByLabelText("More options"));
  const codexMenu = await screen.findByRole("menu");
  expect(
    within(codexMenu).getByText("2 resets left · expires in 3d"),
  ).toBeInTheDocument();
  expect(
    within(codexRow).getByText(
      formatResetInTimeZone("2030-01-07T00:00:00.000Z", "America/New_York"),
    ),
  ).toBeInTheDocument();
  expect(
    within(codexRow).queryByText(/Account:|Plan:|Reset:|Connected .*resets/),
  ).not.toBeInTheDocument();
});

test("Do not show a reset-credit expiry after Codex resets are exhausted", async () => {
  mockNow(new Date("2030-01-01T00:48:00.000Z"), context.signal);
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  context.mocks.data.personalModelProviders([
    connectedPersonalCodexProvider({
      subscriptionResetCredits: 0,
      subscriptionResetCreditsNextExpiresAt: "2030-01-04T00:48:00.000Z",
    }),
  ]);

  await openModelSettings();

  const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
  click(within(codexRow).getByLabelText("More options"));
  const codexMenu = await screen.findByRole("menu");
  expect(within(codexMenu).getByText("0 resets left")).toBeInTheDocument();
  expect(within(codexMenu).queryByText(/expires/u)).not.toBeInTheDocument();
});

test("Reset personal Codex usage with confirmation", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  context.mocks.data.personalModelProviders([connectedPersonalCodexProvider()]);

  await openModelSettings();

  const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
  expect(
    within(codexRow).queryByText(/codex\.user@example\.com/),
  ).not.toBeInTheDocument();

  click(within(codexRow).getByLabelText("More options"));
  await expect(screen.findByText("2 resets left")).resolves.toBeInTheDocument();
  click(screen.getByText("Reset usage"));

  const confirmDialog = await screen.findByRole("dialog", {
    name: "Reset Codex usage?",
  });
  expect(within(confirmDialog).getByText(/2 resets left/)).toBeInTheDocument();
  const resetButton = queryAllByRoleFast("button", confirmDialog).find(
    (button) => {
      return button.textContent === "Reset usage";
    },
  );
  if (!resetButton) {
    throw new Error("Reset usage button not found");
  }
  click(resetButton);

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Reset Codex usage?" }),
    ).not.toBeInTheDocument();
  });

  click(within(codexRow).getByLabelText("More options"));
  await expect(screen.findByText("1 reset left")).resolves.toBeInTheDocument();
  expect(screen.getByText("Codex usage reset")).toBeVisible();
});

test("Show the saved Codex reset date when live usage is unavailable", async () => {
  mockBrowserTimeZone("America/New_York");
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  context.mocks.data.personalModelProviders([
    {
      ...connectedPersonalCodexProvider(),
      subscriptionUsage: undefined,
    },
  ]);

  await openModelSettings();

  const codexRow = await screen.findByTestId("oauth-card-codex-oauth-token");
  expect(within(codexRow).getByText("Connected (Pro)")).toBeInTheDocument();
  expect(
    within(codexRow).getByText(
      formatResetInTimeZone("2030-01-01T00:00:00.000Z", "America/New_York"),
    ),
  ).toBeInTheDocument();
  expect(within(codexRow).queryByText(/% left/u)).toBeNull();
});
