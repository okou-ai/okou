import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  context,
  mockTemplateChat,
} from "./chat-composer-template-gallery-test-helpers.ts";

function connectedCodex(): ModelProviderResponse {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "codex-oauth-token",
    framework: "codex",
    secretName: null,
    authMethod: "auth_json",
    secretNames: ["CODEX_AUTH_JSON"],
    isDefault: false,
    isActive: true,
    selectedModel: null,
    accountEmail: "member@example.com",
    workspaceName: "member@example.com",
    planType: "pro",
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

/** Serves the member's personal accounts; `replace` stands in for a connect. */
function installPersonalAccounts(initial: readonly ModelProviderResponse[]): {
  readonly replace: (next: readonly ModelProviderResponse[]) => void;
} {
  let accounts = [...initial];
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    return respond(200, { modelProviders: accounts });
  });
  return {
    replace: (next) => {
      accounts = [...next];
    },
  };
}

async function setupStartCards(
  accounts: readonly ModelProviderResponse[] = [],
  search = "",
  tier = "pro",
): Promise<{
  readonly replaceAccounts: (next: readonly ModelProviderResponse[]) => void;
}> {
  mockTemplateChat();
  installPlan(tier);
  const personalAccounts = installPersonalAccounts(accounts);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat${search}`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerTaskChips]: false,
    },
  });
  await findComposerEditor();
  return { replaceAccounts: personalAccounts.replace };
}

/** Serves the requested real plan capabilities. */
function installPlan(tier: string): void {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    const status: BillingStatusResponse = {
      showUsagePack: false,
      tier,
      ...billingPlanCapabilities(tier),
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
    return respond(200, status);
  });
}

/**
 * Settings > Models renders the member's accounts from the same list the card
 * reads, so its Codex row settling is the point the card has decided too.
 */
async function findSettledCodexRow(status: string): Promise<void> {
  await waitFor(() => {
    expect(
      within(
        screen.getByTestId(`oauth-account-${connectedCodex().id}`),
      ).getByText(status),
    ).toBeInTheDocument();
  });
}

function subscriptionCard(): HTMLElement {
  return screen.getByTestId("start-card-subscription");
}

function subscriptionButton(label: string): HTMLElement {
  const button = queryAllByRoleFast("button", subscriptionCard()).find(
    (item) => {
      return item.textContent?.trim() === label;
    },
  );
  if (!button) {
    throw new Error(`Expected subscription button ${label}`);
  }
  return button;
}

test("The subscription card leads the start cards without growing the row", async () => {
  await setupStartCards();
  await screen.findByTestId("start-card-subscription");
  const row = screen.getByTestId("start-cards");
  expect(row.children).toHaveLength(3);
  expect(row.firstElementChild).toHaveAttribute(
    "data-testid",
    "start-card-subscription",
  );
  expect(subscriptionCard()).toHaveTextContent("Run tasks for free");
});

test("The Codex button opens the Codex sign-in from the start card", async () => {
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "start-card-codex-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      expiresIn: 60,
      interval: 1,
    });
  });
  await setupStartCards();
  await screen.findByTestId("start-card-subscription");

  click(subscriptionButton("Codex"));

  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  expect(dialog).toHaveTextContent("ABCD-EFGH");
  const link = within(dialog).getByTestId("codex-device-auth-open");
  expect(queryAllByRoleFast("link", dialog)).toContain(link);
  expect(link).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(link).toHaveTextContent("Open approval page");
});

test("The Claude button opens the Claude sign-in from the start card", async () => {
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "start-card-claude-session",
      type: "claude-code",
      status: "pending",
      scope: "personal",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 30,
    });
  });
  await setupStartCards();
  await screen.findByTestId("start-card-subscription");

  click(subscriptionButton("Claude"));

  const inputs = await screen.findAllByTestId("claude-code-device-auth-code");
  expect(inputs).not.toHaveLength(0);
  const dialog = inputs[0]?.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) {
    throw new Error("Expected Claude sign-in dialog");
  }
  const link = within(dialog).getByTestId("claude-code-device-auth-open");
  expect(queryAllByRoleFast("link", dialog)).toContain(link);
  expect(link).toHaveAttribute("href", "https://claude.ai/oauth/authorize");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("The subscription card stays out while the account list is in flight", async () => {
  const accountsRequested = context.mocks.deferred<void>();
  const accountsListed = context.mocks.deferred<void>();
  mockTemplateChat();
  context.mocks.api(
    personalModelProvidersMainContract.list,
    async ({ respond, withSignal }) => {
      accountsRequested.resolve();
      await withSignal(accountsListed.promise);
      return respond(200, { modelProviders: [] });
    },
  );
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerTaskChips]: false,
    },
  });
  await findComposerEditor();
  await accountsRequested.promise;

  expect(screen.getByTestId("start-cards").children).toHaveLength(3);
  expect(screen.queryByTestId("start-card-subscription")).toBeNull();
});

test("A member with a personal model account does not see the subscription card", async () => {
  await setupStartCards([connectedCodex()], "?settings=model");
  await findSettledCodexRow("Connected");

  expect(screen.getByTestId("start-cards").children).toHaveLength(3);
  expect(screen.queryByTestId("start-card-subscription")).toBeNull();
});

test("Connecting Codex from the card retires it for a regular start card", async () => {
  const approval = context.mocks.deferred<void>();
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "start-card-codex-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      expiresIn: 60,
      interval: 1,
    });
  });
  const { replaceAccounts } = await setupStartCards();
  context.mocks.api(
    codexDeviceAuthContract.complete,
    async ({ respond, withSignal }) => {
      await withSignal(approval.promise);
      replaceAccounts([connectedCodex()]);
      return respond(200, {
        status: "complete",
        provider: connectedCodex(),
        created: true,
      });
    },
  );
  await screen.findByTestId("start-card-subscription");

  click(subscriptionButton("Codex"));
  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  expect(within(dialog).getByTestId("codex-device-auth-open")).toHaveAttribute(
    "href",
    "https://auth.openai.com/codex/device",
  );
  approval.resolve();

  await waitFor(() => {
    expect(screen.queryByTestId("start-card-subscription")).toBeNull();
  });
  expect(screen.getByTestId("start-cards").children).toHaveLength(3);
});

test("Limited Free members can connect their personal subscription", async () => {
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "limited-free-personal-subscription",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "FREE-PLUS",
      expiresIn: 60,
      interval: 1,
    });
  });
  await setupStartCards([], "", "limited-free-1");
  await screen.findByTestId("start-card-subscription");
  click(subscriptionButton("Codex"));
  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  expect(dialog).toHaveTextContent("FREE-PLUS");
});

test("The card body opens Settings on Models", async () => {
  await setupStartCards();
  await screen.findByTestId("start-card-subscription");

  const openSettings = queryAllByRoleFast("button", subscriptionCard()).find(
    (item) => {
      return item.getAttribute("aria-label") === "Open model settings";
    },
  );
  if (!openSettings) {
    throw new Error("Expected the card's settings button");
  }
  click(openSettings);

  await expect(
    screen.findByRole("region", { name: "ChatGPT (Codex)" }),
  ).resolves.toBeInTheDocument();
});
