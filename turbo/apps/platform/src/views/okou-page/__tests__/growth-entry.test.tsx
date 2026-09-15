import { screen, waitFor, within } from "@testing-library/react";
import {
  billingStatusContract,
  billingUsagePackCreditsContract,
  type BillingStatusResponse,
  type UsagePackCreditsResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
  integrationsSlackContract,
  type SlackOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-slack";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

const GROWTH_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const context = testContext();

type GrowthActionRole = "button" | "link" | "menuitem";

function normalizedText(element: Element): string {
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function actionNamed(
  role: GrowthActionRole,
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const action = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      normalizedText(candidate) === name
    );
  });
  if (!action) {
    throw new Error(`Could not find ${role} named ${name}`);
  }
  return action;
}

function menuItemContaining(menu: ParentNode, text: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return normalizedText(candidate).includes(text);
  });
  if (!item) {
    throw new Error(`Could not find menu item containing ${text}`);
  }
  return item;
}

function growthChatPath(): string {
  return `/agents/${GROWTH_AGENT_ID}/chat`;
}

function slackStatus(options: {
  readonly connected: boolean;
  readonly installed: boolean;
  readonly workspaceAdmin: boolean;
}): SlackOrgStatus {
  return {
    isConnected: options.connected,
    isInstalled: options.installed,
    isAdmin: options.workspaceAdmin,
    workspaceName: options.installed ? "Growth Workspace" : null,
    installUrl: options.installed
      ? null
      : "https://slack.com/oauth/v2/authorize?client_id=growth-test",
    connectUrl:
      options.installed && !options.connected
        ? "https://slack.com/oauth/v2/authorize?client_id=growth-connect"
        : null,
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
}

function billingStatus(): BillingStatusResponse {
  return {
    showUsagePack: false,
    tier: "pro",
    ...billingPlanCapabilities("pro"),
    credits: 0,
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

function usagePackCredits(): UsagePackCreditsResponse {
  return {
    totalCredits: 1600,
    purchasedCredits: 1200,
    bonusCredits: 400,
    creditGrants: [],
    hasUsagePack: true,
    memberCredits: [],
  };
}

function configureGrowthPage(
  context: TestContext,
  options: {
    readonly role: "admin" | "member";
    readonly slack: SlackOrgStatus;
    readonly withCreditBalance?: boolean;
  },
): void {
  context.mocks.data.org({
    id: "org_default",
    name: "Growth Workspace",
    role: options.role,
  });
  context.mocks.data.agents([
    {
      agentId: GROWTH_AGENT_ID,
      ownerId: "test-user-123",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "private",
    },
  ]);
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, options.slack);
  });
  if (options.withCreditBalance) {
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus());
    });
    context.mocks.api(billingUsagePackCreditsContract.get, ({ respond }) => {
      return respond(200, usagePackCredits());
    });
  }
}

test("An admin can choose another connection channel", async () => {
  configureGrowthPage(context, {
    role: "admin",
    slack: slackStatus({
      connected: false,
      installed: false,
      workspaceAdmin: true,
    }),
  });
  await setupPage({ context, path: growthChatPath() });

  const primaryEntry = await waitFor(() => {
    return actionNamed("button", "Add Okou in Slack");
  });
  const moreActions = await waitFor(() => {
    return actionNamed("button", "More actions");
  });
  expect(primaryEntry).toBeVisible();
  expect(moreActions).toBeVisible();

  click(moreActions);

  const menu = await screen.findByRole("menu");
  const slack = menuItemContaining(menu, "Add Okou in Slack");
  expect(slack).toBeVisible();
  expect(slack).toHaveTextContent("Connect");
  expect(within(menu).getByText("Telegram and phone")).toBeVisible();

  click(slack);

  await waitFor(() => {
    expect(pathname()).toBe("/works");
  });
  await expect(
    waitFor(() => {
      return actionNamed("button", "Install to Slack");
    }),
  ).resolves.toBeVisible();
});

test("An admin is guided to add Okou to Slack first", async () => {
  configureGrowthPage(context, {
    role: "admin",
    slack: slackStatus({
      connected: false,
      installed: false,
      workspaceAdmin: true,
    }),
  });
  await setupPage({ context, path: growthChatPath() });

  const addToSlack = await waitFor(() => {
    return actionNamed("button", "Add Okou in Slack");
  });
  expect(addToSlack).toBeVisible();

  click(addToSlack);

  await waitFor(() => {
    expect(pathname()).toBe("/works");
  });
  await expect(
    waitFor(() => {
      return actionNamed("button", "Install to Slack");
    }),
  ).resolves.toBeVisible();
});

test("The growth menu credit balance opens Usage settings", async () => {
  configureGrowthPage(context, {
    role: "admin",
    slack: slackStatus({
      connected: true,
      installed: true,
      workspaceAdmin: true,
    }),
    withCreditBalance: true,
  });
  await setupPage({ context, path: growthChatPath() });

  const primaryEntry = await waitFor(() => {
    return actionNamed("button", "Invite humans 🤝");
  });
  const moreActions = await waitFor(() => {
    return actionNamed("button", "More actions");
  });
  expect(primaryEntry).toBeVisible();
  expect(moreActions).toBeVisible();

  click(moreActions);

  const menu = await screen.findByRole("menu");
  const credits = await waitFor(() => {
    return menuItemContaining(menu, "Credits");
  });
  expect(credits).toHaveTextContent("1,600");

  click(credits);

  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await expect(
    within(settings).findByRole("heading", { name: "Credit balance" }),
  ).resolves.toBeVisible();
});

test("Installed Slack shifts the growth entry to inviting people", async () => {
  configureGrowthPage(context, {
    role: "admin",
    slack: slackStatus({
      connected: false,
      installed: true,
      workspaceAdmin: true,
    }),
  });
  await setupPage({ context, path: growthChatPath() });

  const invitePeople = await waitFor(() => {
    return actionNamed("button", "Invite humans 🤝");
  });
  expect(invitePeople).toBeVisible();

  click(invitePeople);

  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await expect(
    within(settings).findByRole("heading", { name: "People" }),
  ).resolves.toBeVisible();
  await expect(
    waitFor(() => {
      return actionNamed("button", "Add member", settings);
    }),
  ).resolves.toBeVisible();
});

test("The growth menu reflects installed Slack and offers invitations", async () => {
  configureGrowthPage(context, {
    role: "admin",
    slack: slackStatus({
      connected: false,
      installed: true,
      workspaceAdmin: true,
    }),
  });
  await setupPage({ context, path: growthChatPath() });

  const primaryEntry = await waitFor(() => {
    return actionNamed("button", "Invite humans 🤝");
  });
  const moreActions = await waitFor(() => {
    return actionNamed("button", "More actions");
  });
  expect(primaryEntry).toBeVisible();
  expect(moreActions).toBeVisible();

  click(moreActions);

  const menu = await screen.findByRole("menu");
  const slack = menuItemContaining(menu, "Okou is in Slack");
  expect(slack).toBeVisible();
  expect(slack).not.toHaveTextContent("Connect");
  const invite = actionNamed("menuitem", "Invite humans 🤝", menu);
  expect(invite).toBeVisible();

  click(invite);

  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await expect(
    within(settings).findByRole("heading", { name: "People" }),
  ).resolves.toBeVisible();
});

test("A non-admin does not see the workspace growth entry", async () => {
  configureGrowthPage(context, {
    role: "member",
    slack: slackStatus({
      connected: false,
      installed: false,
      workspaceAdmin: false,
    }),
  });
  await setupPage({ context, path: growthChatPath() });

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();

  expect(
    queryAllByRoleFast("button").find((candidate) => {
      return normalizedText(candidate) === "Add Okou in Slack";
    }),
  ).toBeUndefined();
  expect(
    queryAllByRoleFast("button").find((candidate) => {
      return normalizedText(candidate) === "Invite humans 🤝";
    }),
  ).toBeUndefined();
});
