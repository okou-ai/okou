import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
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
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

const context = testContext();

function activationButton(
  name: string | RegExp,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    const accessibleName =
      candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
    return typeof name === "string"
      ? accessibleName.trim() === name
      : name.test(accessibleName);
  });
  if (!button) {
    throw new Error(`Activation button not found: ${String(name)}`);
  }
  return button;
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
      ...billingPlanCapabilities("pro"),
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
  locale?: SupportedLocale,
): Promise<void> {
  await setupPage({
    context,
    path: "/?settings=model",
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
    return (
      (
        candidate.getAttribute("aria-label") ?? candidate.textContent
      )?.trim() === label
    );
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

async function setupPersonalSubscriptionIdentityReview() {
  mockBrowserTimeZone("America/New_York");
  mockNow(new Date("2030-01-01T00:48:00.000Z"), context.signal);
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "member" });
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
  await openModelSettings("Models");
  return {
    accountA,
    rowA: await screen.findByTestId(`oauth-account-${accountA.id}`),
    rowB: await screen.findByTestId(`oauth-account-${accountB.id}`),
    rowC: await screen.findByTestId(`oauth-account-${accountC.id}`),
  };
}

test("Review personal subscription identity and usage", async () => {
  const { rowA, rowB, rowC } = await setupPersonalSubscriptionIdentityReview();
  expect(within(rowA).getByText("account-a@example.com")).toBeInTheDocument();
  expect(within(rowB).getByText("account-b@example.com")).toBeInTheDocument();
  expect(within(rowA).getByText("2 resets left")).toBeVisible();
  expect(within(rowB).queryByText(/resets? left/u)).not.toBeInTheDocument();
  expect(within(rowC).getByText("Resets —")).toBeVisible();
  expect(
    within(rowC).getByLabelText("Resets left unavailable"),
  ).toBeInTheDocument();
  expect(
    activationButton(
      "Active: account-a@example.com (Account A Organization)",
      rowA,
    ),
  ).toHaveAttribute("aria-pressed", "true");
  expect(activationButton("Use: account-b@example.com", rowB)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const usageRings = within(rowA).getAllByRole("progressbar");
  expect(usageRings).toHaveLength(2);
  expect(usageRings[0]).toHaveAttribute("aria-valuenow", "82");
  expect(usageRings[1]).toHaveAttribute("aria-valuenow", "55");
});

test("Show no 5h availability when the weekly allowance is exhausted", async () => {
  mockBrowserTimeZone("America/New_York");
  mockNow(new Date("2030-01-01T00:48:00.000Z"), context.signal);
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "member" });
  const account = connectedPersonalCodexAccount({
    id: "00000000-0000-4000-a000-000000000314",
    email: "exhausted@example.com",
    isActive: true,
    createdAt: "2026-03-01T00:00:00Z",
  });
  context.mocks.data.personalModelProviders([
    {
      ...account,
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetAt: null,
          windowSeconds: 18_000,
        },
        weekly: {
          usedPercent: 100,
          remainingPercent: 0,
          resetAt: "2030-01-07T00:00:00.000Z",
          windowSeconds: 604_800,
        },
      },
    },
  ]);
  await openModelSettings("Models");

  const row = await screen.findByTestId(`oauth-account-${account.id}`);
  const [fiveHour, week] = within(row).getAllByRole("progressbar");
  expect(fiveHour).toHaveAttribute("aria-valuenow", "0");
  expect(week).toHaveAttribute("aria-valuenow", "0");
  await userEvent.setup().hover(fiveHour);
  await waitFor(() => {
    expect(screen.getByText("0% left")).toBeVisible();
    expect(screen.getByText("Resets in 5d 23h")).toBeVisible();
    expect(
      screen.getByText(
        formatResetInTimeZone(
          "2030-01-07T00:00:00.000Z",
          "America/New_York",
        ).replace(/^resets /u, ""),
      ),
    ).toBeVisible();
  });
});

test("Organize personal subscriptions in accessible provider tables", async () => {
  const { accountA, rowA } = await setupPersonalSubscriptionIdentityReview();
  const claudeTable = screen.getByRole("table", { name: "Claude" });
  const codexTable = screen.getByRole("table", { name: "ChatGPT (Codex)" });
  const claudeHeading = screen.getByRole("heading", {
    name: "Claude",
  });
  const codexHeading = screen.getByRole("heading", { name: "ChatGPT (Codex)" });
  for (const [table, heading] of [
    [claudeTable, claudeHeading],
    [codexTable, codexHeading],
  ] as const) {
    expect(table.parentElement).toContainElement(heading);
    expect(table).toHaveAttribute("aria-labelledby", heading.id);
  }
  expect(
    within(claudeTable).getByText("No accounts connected."),
  ).toBeInTheDocument();
  expect(within(codexTable).getByTestId(`oauth-account-${accountA.id}`)).toBe(
    rowA,
  );
  expect(
    within(claudeTable).queryByTestId(`oauth-account-${accountA.id}`),
  ).toBeNull();
});

test("Reset personal Codex account usage from the reset count", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  const account = connectedPersonalCodexAccount({
    id: "00000000-0000-4000-a000-000000000311",
    email: "account-a@example.com",
    isActive: true,
    createdAt: "2026-03-01T00:00:00Z",
  });
  context.mocks.data.personalModelProviders([account]);

  await openModelSettings("Models");

  const row = await screen.findByTestId(`oauth-account-${account.id}`);
  click(within(row).getByLabelText("2 resets left"));

  const confirmDialog = await screen.findByRole("dialog", {
    name: "Reset Codex usage?",
  });
  expect(within(confirmDialog).getByText(/2 resets left/u)).toBeInTheDocument();
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
  expect(screen.getByText("Codex usage reset")).toBeInTheDocument();
});

test("Disconnect an active personal subscription account", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  const account = connectedPersonalCodexAccount({
    id: "00000000-0000-4000-a000-000000000311",
    email: "account-a@example.com",
    isActive: true,
    createdAt: "2026-03-01T00:00:00Z",
  });
  context.mocks.data.personalModelProviders([account]);

  await openModelSettings("Models");

  const row = await screen.findByTestId(`oauth-account-${account.id}`);
  click(within(row).getByLabelText("More options"));
  click(await screen.findByText("Disconnect account"));

  const confirmation = await screen.findByRole("dialog", {
    name: "Disconnect account-a@example.com?",
  });
  expect(
    within(confirmation).getByText(
      "This removes the account from Okou. It won’t cancel your subscription with the provider.",
    ),
  ).toBeInTheDocument();
  const disconnectButton = queryAllByRoleFast("button", confirmation).find(
    (button) => {
      return button.textContent?.trim() === "Disconnect account";
    },
  );
  if (!disconnectButton) {
    throw new Error("Disconnect account button not found");
  }
  click(disconnectButton);

  await waitFor(() => {
    expect(screen.queryByTestId(`oauth-account-${account.id}`)).toBeNull();
    expect(
      screen.queryByRole("dialog", {
        name: "Disconnect account-a@example.com?",
      }),
    ).toBeNull();
  });
  expect(screen.getByText("Account disconnected")).toBeInTheDocument();
});

test("Review personal subscriptions through account switching", async () => {
  const { rowA, rowB } = await setupPersonalSubscriptionIdentityReview();
  click(activationButton("Use: account-b@example.com", rowB));
  await waitFor(() => {
    expect(
      activationButton("Active: account-b@example.com", rowB),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      activationButton(
        "Use: account-a@example.com (Account A Organization)",
        rowA,
      ),
    ).toHaveAttribute("aria-pressed", "false");
  });
});

test("Offer Pro from personal account groups when BYOK is unavailable", async () => {
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

  const upgradeButton = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Upgrade Pro to use";
  });
  if (!upgradeButton) {
    throw new Error("Upgrade Pro button not found");
  }
  click(upgradeButton);

  await expect(
    screen.findByRole("heading", { name: "Choose a plan" }),
  ).resolves.toBeInTheDocument();
});

test("View personal account groups by default in an external workspace", async () => {
  context.mocks.data.org({
    id: "org_external",
    name: "External workspace",
    role: "member",
  });
  context.mocks.data.personalModelProviders([]);
  await setupPage({
    context,
    path: "/?settings=model",
    auth: {
      user: { id: "user_external", fullName: "External member" },
      organization: {
        activeOrg: {
          id: "org_external",
          name: "External workspace",
        },
        memberships: [{ id: "org_external" }],
      },
    },
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  for (const name of ["Claude", "ChatGPT (Codex)"]) {
    const section = within(settings)
      .getByRole("heading", { name })
      .closest("section");
    if (!section) {
      throw new Error(`Provider section not found: ${name}`);
    }
    expect(connectButtonInRow(section, "Connect account")).toBeEnabled();
    expect(
      within(section).getByText("No accounts connected."),
    ).toBeInTheDocument();
  }
});

test("Start and close personal Claude login directly from its account group", async () => {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "member",
  });
  context.mocks.data.personalModelProviders([]);
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ body, respond }) => {
    expect(body).toStrictEqual({ scope: "personal", mode: "add" });
    return respond(200, {
      sessionToken: "mock-personal-claude-code-session",
      type: "claude-code",
      status: "pending",
      scope: "personal",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 30,
    });
  });

  await openModelSettings("Models");

  const claudeSection = screen
    .getByRole("heading", { name: "Claude" })
    .closest("section");
  if (!claudeSection) {
    throw new Error("Claude account group not found");
  }
  const connectAccountButton = connectButtonInRow(
    claudeSection,
    "Connect account",
  );
  click(connectAccountButton);

  const authorizationCodeInputs = await screen.findAllByTestId(
    "claude-code-device-auth-code",
  );
  const connectDialog = authorizationCodeInputs[0]?.closest('[role="dialog"]');
  if (!(connectDialog instanceof HTMLElement)) {
    throw new Error("Claude connection dialog not found");
  }
  expect(
    within(connectDialog).getByText(
      "Sign in with your Claude subscription to use Claude models with Claude Code-backed agents.",
    ),
  ).toBeVisible();
  closeClaudeCodeDialogs();
  await waitFor(() => {
    expect(
      screen.queryAllByTestId("claude-code-device-auth-code"),
    ).toHaveLength(0);
    expect(connectAccountButton).toBeEnabled();
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

  const claudeSection = screen
    .getByRole("heading", { name: "Claude" })
    .closest("section");
  if (!claudeSection) {
    throw new Error("Claude account section not found");
  }
  click(connectButtonInRow(claudeSection, "Connect account"));

  const codeInput = await findLatestClaudeCodeInput();
  const deviceAuthDialog = dialogContaining(codeInput);
  await fill(codeInput, "claude-auth-code");
  click(within(deviceAuthDialog).getByTestId("claude-code-device-auth-submit"));

  const row = await screen.findByTestId(
    `oauth-account-${connectedPersonalClaudeCodeProvider().id}`,
  );
  await waitFor(() => {
    expect(screen.getByText("Claude connected")).toBeInTheDocument();
    expect(
      within(row).getByText("claude.user@example.com"),
    ).toBeInTheDocument();
    expect(within(row).getByText("Pro")).toBeInTheDocument();
    expect(
      within(row).getByRole("progressbar", {
        name: "claude.user@example.com 5h remaining",
      }),
    ).toHaveAttribute("aria-valuenow", "88");
    expect(
      within(row).getByRole("progressbar", {
        name: "claude.user@example.com Week remaining",
      }),
    ).toHaveAttribute("aria-valuenow", "76");
  });
});
