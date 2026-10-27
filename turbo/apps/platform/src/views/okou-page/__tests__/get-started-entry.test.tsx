import {
  catalogFixture,
  requireConnectorFixtureAccount,
} from "../../../mocks/handlers/connector-account-fixtures.ts";
import {
  GET_STARTED_REWARDS,
  GET_STARTED_REWARDS_CHANGED_EVENT,
  getStartedContract,
  type GetStartedStatus,
} from "@okouai/api-contracts/contracts/get-started";
import {
  connectorCatalogContract,
  isOneClickConnectorGrantKind,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  integrationsSlackContract,
  type SlackOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-slack";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { expect, test, vi } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { connectorCatalogConnectItem } from "../../../mocks/handlers/api-connectors.ts";
import { defaultBillingStatus } from "../../../mocks/handlers/api-billing.ts";
import { mockNow } from "../../../lib/time.ts";
import { pathname } from "../../../signals/location.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";

const QUEST_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const context = testContext();

function normalizedText(element: Element): string {
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function buttonNamed(name: string, container: ParentNode): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      normalizedText(candidate) === name
    );
  });
  if (!button) {
    throw new Error(`Could not find button named ${name}`);
  }
  return button;
}

function linkNamed(name: string, container: ParentNode): HTMLElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return normalizedText(candidate) === name;
  });
  if (!link) {
    throw new Error(`Could not find link named ${name}`);
  }
  return link;
}

async function expectBrowserActivationsKeepIntro(
  link: HTMLElement,
  dialog: HTMLElement,
) {
  const user = userEvent.setup({ delay: null });
  for (const modifier of ["Alt", "Control", "Meta", "Shift"]) {
    await user.keyboard(`{${modifier}>}`);
    await user.click(link);
    await user.keyboard(`{/${modifier}}`);
    expect(pathname()).toBe(questChatPath());
    expect(dialog).toBeInTheDocument();
  }
  for (const keys of ["[MouseMiddle]", "[MouseRight]"]) {
    await user.pointer({ target: link, keys });
    expect(pathname()).toBe(questChatPath());
    expect(dialog).toBeInTheDocument();
  }
}

function slackInstalled(): SlackOrgStatus {
  return {
    isConnected: true,
    isInstalled: true,
    isAdmin: true,
    workspaceName: "Quest Workspace",
    installUrl: null,
    connectUrl: null,
  };
}

/**
 * One connector of each half of the catalog: Gmail finishes in the browser and
 * earns the reward, OpenAI wants a key pasted in from another site and does
 * not.
 */
function catalogItem(
  slug: ConnectorSlug,
  label: string,
  grantKind: "auth-code" | "manual",
  connected = false,
  popularityRank?: number,
): PublicConnectorCatalogStatusItem {
  return catalogFixture({
    slug,
    label,
    description: `${label} test connector`,
    icon: {
      url: `https://icons.example.test/${slug}.svg`,
      invertInDarkMode: false,
    },
    category: "test",
    popularityRank,
    generation: [],
    tags: [],
    authMethods: [
      {
        supportsRefresh: true,
        id: grantKind === "auth-code" ? "oauth" : "key",
        label,
        description: null,
        grantKind,
        manualFields: [],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    singleAuthCodeAuthMethodId: grantKind === "auth-code" ? "oauth" : null,
    connectNotice: null,
    account: connected ? {} : undefined,
  });
}

/**
 * The one-click catalog the picker reads. Like the API, it only carries the
 * connectors that connect in one browser step, projected to their connect
 * items.
 */
function mockOneClickCatalog(
  items: readonly PublicConnectorCatalogStatusItem[],
  onRead?: () => void,
): void {
  context.mocks.api(connectorCatalogContract.oneClick, ({ respond }) => {
    onRead?.();
    return respond(200, {
      connectors: items.flatMap((item) => {
        return item.authMethods.some((method) => {
          return isOneClickConnectorGrantKind(method.grantKind);
        })
          ? [connectorCatalogConnectItem(item)]
          : [];
      }),
    });
  });
}

function mockQuestCatalog(): void {
  mockOneClickCatalog([
    catalogItem("gmail", "Gmail", "auth-code"),
    catalogItem("notion", "Notion", "auth-code"),
    catalogItem("openai", "OpenAI", "manual"),
  ]);
}

function configureQuestPage(
  context: TestContext,
  role: "admin" | "member",
  {
    claimedToday = true,
    imessage = false,
    slackClaimed = true,
  }: {
    claimedToday?: boolean;
    /** Whether the status lists the iMessage quest. */
    imessage?: boolean;
    /** Whether the org already holds a claim for the Slack quest. */
    slackClaimed?: boolean;
  } = {},
): GetStartedStatus {
  context.mocks.data.org({
    id: "org_default",
    name: "Quest Workspace",
    role,
  });
  context.mocks.data.agents([
    {
      agentId: QUEST_AGENT_ID,
      ownerId: "test-user-123",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "private",
    },
  ]);
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, slackInstalled());
  });
  const roleKeys =
    role === "admin"
      ? (["connector", "slack", "workflow", "invite", "checkin"] as const)
      : (["connector", "workflow", "checkin"] as const);
  const keys = imessage
    ? [...roleKeys.slice(0, 1), "imessage" as const, ...roleKeys.slice(1)]
    : roleKeys;
  const data: GetStartedStatus = {
    serverNow: "2026-09-15T12:00:00.000Z",
    nextResetAt: "2026-09-16T00:00:00.000Z",
    claimedToday,
    checkinStreak: claimedToday ? 1 : 0,
    quests: keys.map((key) => {
      const reward = GET_STARTED_REWARDS[key];
      const claimedCount =
        key === "connector"
          ? 3
          : (key === "slack" && slackClaimed) ||
              (key === "checkin" && claimedToday)
            ? 1
            : 0;
      return {
        key,
        claimedCount,
        rewardAmount: reward.amount,
        rewardTarget: reward.target,
        limit: reward.limit,
        earnedCredits: claimedCount * reward.amount,
        pendingCount: 0,
        canEarnMore:
          key === "slack" ? !slackClaimed : key !== "checkin" || !claimedToday,
      };
    }),
    recentGrants: [],
  };
  context.mocks.api(getStartedContract.status, ({ respond }) => {
    return respond(200, data);
  });
  context.mocks.api(getStartedContract.checkin, ({ respond }) => {
    const checkin = data.quests.find((q) => {
      return q.key === "checkin";
    });
    if (!checkin) {
      throw new Error("Missing check-in fixture");
    }
    if (!data.claimedToday) {
      checkin.claimedCount++;
      checkin.earnedCredits += 100;
      // The server counts the day it just recorded, so the fixture does too:
      // the streak is what decides whether the reward gets a screen or a line.
      data.checkinStreak++;
    }
    checkin.canEarnMore = false;
    data.claimedToday = true;
    return respond(200, {
      id: "22222222-2222-4222-a222-222222222222",
      questKey: "checkin",
      status: "granted",
      rewardAmount: 100,
      rewardTarget: "user",
      reason: null,
      submittedAt: data.serverNow,
      grantedAt: data.serverNow,
      expiresAt: new Date(
        Date.parse(data.serverNow) + 168 * 60 * 60 * 1000,
      ).toISOString(),
    });
  });
  return data;
}

function questChatPath(): string {
  return `/agents/${QUEST_AGENT_ID}/chat`;
}

async function openQuestPanel(): Promise<HTMLElement> {
  const entry = await waitFor(() => {
    return screen.getByTestId("get-started-entry");
  });
  click(entry);
  return await screen.findByRole("menu");
}

test("An admin sees every step and what each one pays", async () => {
  configureQuestPage(context, "admin");
  await setupPage({
    context,
    path: questChatPath(),
  });

  const entry = await waitFor(() => {
    return screen.getByTestId("get-started-entry");
  });
  expect(normalizedText(entry)).toBe("Get more credits3/5");

  const panel = await openQuestPanel();
  expect(within(panel).getByText("How rewards work")).toBeInTheDocument();
  const workflowRow = screen.getByTestId("get-started-quest-workflow");
  const workflow = within(workflowRow);
  expect(workflow.getByText("Build a workflow")).toBeInTheDocument();
  // The reward leads the description line, so the two read as one sentence.
  expect(normalizedText(workflowRow)).toContain("Build a workflow+1,000Build");
  expect(workflow.getByText("+1,000")).toBeInTheDocument();
  // An unfinished quest names what pressing the row does.

  // A reward that keeps paying names its unit next to the amount.
  const invite = within(screen.getByTestId("get-started-quest-invite"));
  expect(invite.getByText("Invite your team")).toBeInTheDocument();

  // A finished quest keeps the completion check and offers nothing to press.
  const slackRow = screen.getByTestId("get-started-quest-slack");
  expect(within(slackRow).queryByText("Add")).not.toBeInTheDocument();

  // Done but still earning: the connector keeps both its reward and its
  // affordance instead of collapsing to the completion check.
  const connectorRow = screen.getByTestId("get-started-quest-connector");
  expect(normalizedText(connectorRow)).toContain("100");
});

test("A member is only offered the steps they can finish themselves", async () => {
  configureQuestPage(context, "member");
  await setupPage({
    context,
    path: questChatPath(),
  });

  const entry = await waitFor(() => {
    return screen.getByTestId("get-started-entry");
  });
  expect(normalizedText(entry)).toBe("Get more credits2/3");

  const panel = await openQuestPanel();
  expect(screen.getByTestId("get-started-quest-workflow")).toBeInTheDocument();
  expect(within(panel).queryByText("Invite your team")).not.toBeInTheDocument();
  expect(within(panel).queryByText("Add to Slack")).not.toBeInTheDocument();
});

test("A workflow reward still with the reviewer stops offering the step again", async () => {
  const data = configureQuestPage(context, "admin");
  const workflow = data.quests.find((quest) => {
    return quest.key === "workflow";
  });
  if (!workflow) {
    throw new Error("Missing workflow fixture");
  }
  // The claim the review worker creates when a workflow is built. It is granted
  // by an hourly job, so the row has to say so for as long as that takes.
  workflow.pendingCount = 1;
  await setupPage({
    context,
    path: questChatPath(),
  });

  await openQuestPanel();
  const row = screen.getByTestId("get-started-quest-workflow");
  expect(normalizedText(row)).toContain("In review");
  // The action label alone, not the title that also starts with the verb.
  expect(within(row).queryByText("Build")).toBeNull();
  // Nothing left to press, so the row is a status line rather than an option.
  expect(row.getAttribute("role")).not.toBe("menuitem");
});

test("A review notification brings a granted workflow reward into the open panel", async () => {
  const data = configureQuestPage(context, "admin");
  const workflow = data.quests.find((quest) => {
    return quest.key === "workflow";
  });
  if (!workflow) {
    throw new Error("Missing workflow fixture");
  }
  workflow.pendingCount = 1;
  await setupPage({
    context,
    path: questChatPath(),
  });

  await openQuestPanel();
  const entry = screen.getByTestId("get-started-entry");
  expect(normalizedText(entry)).toBe("Get more credits3/5");
  Object.assign(workflow, {
    claimedCount: 1,
    earnedCredits: 1000,
    pendingCount: 0,
    canEarnMore: false,
  });
  context.mocks.ably.trigger(GET_STARTED_REWARDS_CHANGED_EVENT);
  await waitFor(() => {
    expect(normalizedText(entry)).toBe("Get more credits4/5");
  });
  expect(
    within(screen.getByRole("menu")).getByTestId("get-started-quest-workflow"),
  ).toBeInTheDocument();
});

function mockPhoneLinkCode(code: string): void {
  context.mocks.api(
    integrationsAgentPhoneContract.createLinkCode,
    ({ respond }) => {
      return respond(200, {
        code,
        expiresAt: "2026-09-15T12:10:00.000Z",
      });
    },
  );
}

async function openImessageQuestDialog(): Promise<HTMLElement> {
  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-imessage"));
  return await screen.findByRole("dialog", {
    name: "Text Okou from your iPhone",
  });
}

test("Adding iMessage opens the phone connect dialog with its reward", async () => {
  configureQuestPage(context, "member", { imessage: true });
  const code = "31415926";
  mockPhoneLinkCode(code);
  await setupPage({
    context,
    path: questChatPath(),
  });

  const entry = await waitFor(() => {
    return screen.getByTestId("get-started-entry");
  });
  expect(normalizedText(entry)).toBe("Get more credits2/4");
  await openQuestPanel();
  const row = screen.getByTestId("get-started-quest-imessage");
  expect(normalizedText(row)).toBe("Add to iMessage+1,000Add");
  click(row);

  const dialog = await screen.findByRole("dialog", {
    name: "Text Okou from your iPhone",
  });
  expect(dialog).toHaveAccessibleDescription(
    "Scan with your camera, then send the prefilled code.",
  );
  await expect(within(dialog).findByText("+1,000")).resolves.toBeVisible();
  await expect(
    within(dialog).findByTestId("agentphone-link-qr"),
  ).resolves.toHaveAttribute("data-sms-href", `sms:+19039853128?body=${code}`);
  expect(
    queryAllByRoleFast("button", dialog).map((button) => {
      return button.getAttribute("aria-label") ?? normalizedText(button);
    }),
  ).toStrictEqual([
    `Copy connection code ${code}`,
    "Copy +1 (903) 985-3128",
    "Close",
  ]);
});

test("Linking the phone closes the Get started dialog and completes the quest", async () => {
  const data = configureQuestPage(context, "member", { imessage: true });
  mockPhoneLinkCode("27182818");
  await setupPage({
    context,
    path: questChatPath(),
  });

  const dialog = await openImessageQuestDialog();
  await expect(
    within(dialog).findByTestId("agentphone-link-qr"),
  ).resolves.toBeInTheDocument();

  // The code arrives from the phone: the API links it, grants the quest, and
  // announces both.
  const imessage = data.quests.find((quest) => {
    return quest.key === "imessage";
  });
  if (!imessage) {
    throw new Error("Missing iMessage fixture");
  }
  Object.assign(imessage, {
    claimedCount: 1,
    earnedCredits: 1000,
    canEarnMore: false,
  });
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle: "+15555550123",
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  context.mocks.ably.trigger("agentphone:changed");
  context.mocks.ably.trigger(GET_STARTED_REWARDS_CHANGED_EVENT);

  await expect(
    screen.findByText("Phone number connected"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Text Okou from your iPhone" }),
    ).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(normalizedText(screen.getByTestId("get-started-entry"))).toBe(
      "Get more credits3/4",
    );
  });
});

test("A phone linked before the quest existed reads as done, without credits", async () => {
  configureQuestPage(context, "member", { imessage: true });
  context.mocks.data.agentPhoneIntegration({
    linked: true,
    phoneHandle: "+15555550123",
    agentPhoneNumber: "+19039853128",
    configured: true,
  });
  await setupPage({
    context,
    path: questChatPath(),
  });

  const entry = await waitFor(() => {
    return screen.getByTestId("get-started-entry");
  });
  expect(normalizedText(entry)).toBe("Get more credits3/4");
  await openQuestPanel();
  const row = screen.getByTestId("get-started-quest-imessage");
  // Finished: a status line with the completion check, nothing to press.
  expect(row.getAttribute("role")).not.toBe("menuitem");
  expect(within(row).queryByText("Add")).not.toBeInTheDocument();
});

test("Slack installed before the quest existed reads as done, without credits", async () => {
  configureQuestPage(context, "admin", { slackClaimed: false });
  await setupPage({
    context,
    path: questChatPath(),
  });

  const entry = await waitFor(() => {
    return screen.getByTestId("get-started-entry");
  });
  // The installed Slack counts toward the finished steps.
  expect(normalizedText(entry)).toBe("Get more credits3/5");
  const panel = await openQuestPanel();
  // The Slack reward is not among what is still claimable.
  expect(within(panel).getByText("1,200 to go")).toBeInTheDocument();
  const row = screen.getByTestId("get-started-quest-slack");
  expect(row.getAttribute("role")).not.toBe("menuitem");
  expect(within(row).queryByText("Add")).not.toBeInTheDocument();
});

test("Slack not yet installed keeps the step and its reward on offer", async () => {
  configureQuestPage(context, "admin", { slackClaimed: false });
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      ...slackInstalled(),
      isConnected: false,
      isInstalled: false,
      workspaceName: null,
      installUrl: "https://slack.com/oauth/v2/authorize?client_id=quest",
    });
  });
  await setupPage({
    context,
    path: questChatPath(),
  });

  const entry = await waitFor(() => {
    return screen.getByTestId("get-started-entry");
  });
  expect(normalizedText(entry)).toBe("Get more credits2/5");
  const panel = await openQuestPanel();
  expect(within(panel).getByText("3,200 to go")).toBeInTheDocument();
  const row = screen.getByTestId("get-started-quest-slack");
  expect(row.getAttribute("role")).toBe("menuitem");
  expect(within(row).getByText("+2,000")).toBeInTheDocument();
});

test("A failed Slack status read leaves the Slack step actionable on canonical settings", async () => {
  configureQuestPage(context, "admin", { slackClaimed: false });
  const opened = context.mocks.browser.open();
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Slack status is temporarily unavailable.",
      },
    });
  });
  await setupPage({
    context,
    path: questChatPath(),
  });

  const entry = await waitFor(() => {
    return screen.getByTestId("get-started-entry");
  });
  expect(normalizedText(entry)).toBe("Get more credits2/5");
  const panel = await openQuestPanel();
  expect(within(panel).getByText("3,200 to go")).toBeInTheDocument();
  expect(
    within(screen.getByTestId("get-started-quest-slack")).getByText("+2,000"),
  ).toBeInTheDocument();
  click(screen.getByTestId("get-started-quest-slack"));
  const dialog = await screen.findByRole("dialog", {
    name: "Work with Okou where your team already talks",
  });
  click(buttonNamed("Add to Slack", dialog));
  expect(new URL(opened.calls[0]?.url ?? "").pathname).toBe("/settings/slack");
  expect(opened.calls[0]?.target).toBe("_blank");
  expect(pathname()).toBe(questChatPath());
});

test("Invitation progress separates successful rewards from pending members and remains actionable below 15", async () => {
  const data = configureQuestPage(context, "admin");
  const invite = data.quests.find((q) => {
    return q.key === "invite";
  });
  if (!invite) {
    throw new Error("Missing invite fixture");
  }
  Object.assign(invite, {
    claimedCount: 8,
    earnedCredits: 800,
    pendingCount: 3,
  });
  await setupPage({
    context,
    path: questChatPath(),
  });
  const panel = await openQuestPanel();
  expect(within(panel).getByText("8/15", { exact: false })).toBeInTheDocument();
  expect(
    within(panel).getByText("3 pending", { exact: false }),
  ).toBeInTheDocument();
  expect(screen.getByTestId("get-started-quest-invite")).toBeInTheDocument();
});

test("Daily rewards are claimed by selecting check in", async () => {
  configureQuestPage(context, "member", { claimedToday: false });
  await setupPage({
    context,
    path: questChatPath(),
  });
  await openQuestPanel();
  const checkinRow = screen.getByTestId("get-started-quest-checkin");
  expect(within(checkinRow).getByText("Check in")).toBeInTheDocument();
  expect(normalizedText(checkinRow)).toContain("Check in daily+100Check in");

  click(checkinRow);
  const dialog = await screen.findByRole("dialog", {
    name: "Checked in for today",
  });
  expect(within(dialog).getByText("1-day streak")).toBeInTheDocument();
  expect(within(dialog).getByText("+100 credits")).toBeInTheDocument();
  click(buttonNamed("Back to work", dialog));

  const updatedPanel = await openQuestPanel();
  await waitFor(() => {
    expect(screen.getByTestId("get-started-quest-checkin")).not.toHaveAttribute(
      "role",
      "menuitem",
    );
  });
  expect(within(updatedPanel).queryByText("Check in")).not.toBeInTheDocument();
});

test("The connector step says what it costs the user before it hands them off", async () => {
  configureQuestPage(context, "admin");
  context.mocks.browser.open();
  mockQuestCatalog();
  await setupPage({
    context,
    path: questChatPath(),
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-connector"));
  const dialog = await screen.findByRole("dialog", {
    name: "Okou works inside the tools you already use",
  });
  // The dialog says what the step is, and the list does the rest.
  expect(
    within(dialog).getByText("Pick one and Okou starts working in it."),
  ).toBeInTheDocument();
  // Explaining is all it does: the destination is still the connector list.
  expect(pathname()).toBe(questChatPath());

  const picker = await within(dialog).findByTestId("quest-connector-picker");
  expect(within(picker).getByText("Gmail")).toBeInTheDocument();

  // The whole catalog is still one press away for anyone who wants it.
  const browse = linkNamed("Browse all connectors", dialog);
  expect(browse).toHaveAttribute("href", "/connectors");
  await expectBrowserActivationsKeepIntro(browse, dialog);
  click(browse);
  await waitFor(() => {
    expect(pathname()).toBe("/connectors");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

test("The connector picker puts an existing healthy default in its connected group", async () => {
  configureQuestPage(context, "admin");
  const gmail = catalogItem("gmail", "Gmail", "auth-code", true);
  context.mocks.data.connectors([
    { ...requireConnectorFixtureAccount(gmail), slug: gmail.slug },
  ]);
  mockOneClickCatalog([gmail, catalogItem("notion", "Notion", "auth-code")]);
  await setupPage({ context, path: questChatPath() });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-connector"));
  const picker = await screen.findByTestId("quest-connector-picker");
  const connected = within(picker).getByRole("region", {
    name: "Connected",
  });
  expect(within(connected).getByText("Gmail")).toBeInTheDocument();
  const disconnected = within(picker).getByRole("region", {
    name: "Not connected",
  });
  expect(within(disconnected).getByText("Notion")).toBeInTheDocument();
});

test("The open connector picker reflects an account connected in another tab", async () => {
  configureQuestPage(context, "admin");
  const gmail = catalogItem("gmail", "Gmail", "auth-code", true);
  mockOneClickCatalog([gmail]);
  await setupPage({ context, path: questChatPath() });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-connector"));
  const picker = await screen.findByTestId("quest-connector-picker");
  const disconnected = within(picker).getByRole("region", {
    name: "Not connected",
  });
  expect(within(disconnected).getByText("Gmail")).toBeInTheDocument();

  context.mocks.data.connectors([
    { ...requireConnectorFixtureAccount(gmail), slug: gmail.slug },
  ]);
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "gmail" });

  const connected = await within(picker).findByRole("region", {
    name: "Connected",
  });
  expect(within(connected).getByText("Gmail")).toBeInTheDocument();
});

test("The connector picker keeps valid tools when a saved target becomes unavailable", async () => {
  configureQuestPage(context, "admin");
  const gmail = catalogItem("gmail", "Gmail", "auth-code", true);
  context.mocks.data.connectors([
    { ...requireConnectorFixtureAccount(gmail), slug: gmail.slug },
  ]);
  mockOneClickCatalog([gmail, catalogItem("notion", "Notion", "auth-code")]);
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Connector unavailable" },
    });
  });
  await setupPage({ context, path: questChatPath() });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-connector"));
  const picker = await screen.findByTestId("quest-connector-picker");
  expect(within(picker).getByText("Notion")).toBeInTheDocument();
  expect(within(picker).queryByText("Gmail")).not.toBeInTheDocument();
});

test("Picking a connector in the dialog starts its authorization", async () => {
  configureQuestPage(context, "admin");
  mockQuestCatalog();
  const opened: string[] = [];
  vi.stubGlobal("open", (url: string) => {
    opened.push(url);
    return null;
  });
  await setupPage({
    context,
    path: questChatPath(),
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-connector"));
  await screen.findByTestId("quest-connector-picker");

  click(await screen.findByTestId("quest-connector-gmail"));

  // Authorization begins in place: no second dialog repeating the connector's
  // name, and no page the reader would have to find the same connector on.
  await waitFor(() => {
    expect(opened.join(" ")).toContain("gmail");
  });
  expect(pathname()).toBe(questChatPath());
});

function slackNotInstalled(): SlackOrgStatus {
  return {
    ...slackInstalled(),
    isInstalled: false,
    isConnected: false,
    workspaceName: null,
    installUrl: null,
  };
}

async function openSlackIntro(): Promise<HTMLElement> {
  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-slack"));
  return await screen.findByRole("dialog", {
    name: "Work with Okou where your team already talks",
  });
}

test.each([
  {
    label: "starts OAuth directly",
    installUrl: "https://slack.com/oauth/v2/authorize?state=quest",
    destination: "https://slack.com/oauth/v2/authorize?state=quest&",
  },
  {
    label: "opens settings when the install URL is unavailable",
    installUrl: null,
    destination: "http://localhost/settings/slack?",
  },
])(
  "The Slack step $label at click time and retains the chat draft",
  async ({ installUrl, destination }) => {
    configureQuestPage(context, "admin", { slackClaimed: false });
    context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
      return respond(200, { ...slackNotInstalled(), installUrl });
    });
    const opened = context.mocks.browser.open();
    const timestamp = new Date("2026-10-15T13:00:00Z");
    mockNow(timestamp, context.signal);
    await setupPage({ context, path: questChatPath() });
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await fill(composer, "Keep my unsent Slack setup notes");

    const dialog = await openSlackIntro();
    const confirm = buttonNamed("Add to Slack", dialog);
    expect(confirm).toBeEnabled();
    click(confirm);
    // No await: window creation must happen inside the user gesture.
    expect(opened.calls).toStrictEqual([
      {
        url: `${destination}_t=${timestamp.getTime()}`,
        target: "_blank",
        features: null,
      },
    ]);
    expect(pathname()).toBe(questChatPath());
    expect(composer).toHaveTextContent("Keep my unsent Slack setup notes");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  },
);

test("The Slack entry forwards an existing prompt and retains same-origin preview access", async () => {
  configureQuestPage(context, "admin", { slackClaimed: false });
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, slackNotInstalled());
  });
  const opened = context.mocks.browser.open();
  // Same-origin App tabs share the captured cookie; the helper only puts the
  // bypass query on the corresponding API origin, never arbitrary links.
  context.mocks.browser.cookie("x-vercel-protection-bypass=preview-secret");
  const releaseAgents = context.mocks.deferred<void>();
  context.mocks.api(agentsMainContract.list, async ({ respond }) => {
    await releaseAgents.promise;
    return respond(200, [
      {
        agentId: QUEST_AGENT_ID,
        isDefaultAgent: false,
        ownerId: "test-user-123",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        visibility: "private",
      },
    ]);
  });
  // The page is interactive before its pending agent read consumes the prompt.
  const page = await startPage({
    context,
    host: "pr-431-app-okou-app-preview.vm0.workers.dev",
    path: `${questChatPath()}?prompt=Retain+my+work`,
  });
  await page.content;
  const dialog = await openSlackIntro();
  click(buttonNamed("Add to Slack", dialog));
  const url = new URL(opened.calls[0]?.url ?? "");
  expect(url.origin).toBe(window.location.origin);
  expect(url.pathname).toBe("/settings/slack");
  expect(url.searchParams.get("prompt")).toBe("Retain my work");
  expect(url.searchParams.get("_t")).toMatch(/^\d+$/u);
  expect(url.searchParams.has("x-vercel-protection-bypass")).toBeFalsy();
  expect(document.cookie).toContain(
    "x-vercel-protection-bypass=preview-secret",
  );
  expect(pathname()).toBe(questChatPath());
  releaseAgents.resolve();
  await page.ready;
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toHaveTextContent("Retain my work");
});

test("The Slack action retains its OAuth URL while a status refresh is pending", async () => {
  configureQuestPage(context, "admin", { slackClaimed: false });
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let pending = false;
  context.mocks.api(
    integrationsSlackContract.getStatus,
    async ({ respond }) => {
      if (pending) {
        requested.resolve();
        await release.promise;
      }
      return respond(200, {
        ...slackNotInstalled(),
        installUrl: "https://slack.com/oauth/v2/authorize?state=quest",
      });
    },
  );
  const opened = context.mocks.browser.open();
  await setupPage({ context, path: questChatPath() });
  const dialog = await openSlackIntro();
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("slack:changed")).toBeTruthy();
  });
  pending = true;
  context.mocks.ably.trigger("slack:changed");
  await requested.promise;
  click(buttonNamed("Add to Slack", dialog));
  const url = new URL(opened.calls[0]?.url ?? "");
  expect(url.origin).toBe("https://slack.com");
  expect(url.pathname).toBe("/oauth/v2/authorize");
  expect(url.searchParams.get("state")).toBe("quest");
  expect(opened.calls[0]?.target).toBe("_blank");
  expect(pathname()).toBe(questChatPath());
  release.resolve();
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

test.each(["blocked", "closed", "open"] as const)(
  "A %s Slack tab without completion leaves the quest retryable",
  async (outcome) => {
    configureQuestPage(context, "admin", { slackClaimed: false });
    context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
      return respond(200, slackNotInstalled());
    });
    const popup = context.mocks.browser.authWindow();
    const opened = context.mocks.browser.open(
      outcome === "blocked" ? null : popup,
    );
    let timestamp = 1_792_065_600_000;
    mockNow(() => {
      return timestamp;
    }, context.signal);
    await setupPage({ context, path: `${questChatPath()}?status=connected` });
    const dialog = await openSlackIntro();
    click(buttonNamed("Add to Slack", dialog));
    expect(opened.calls[0]?.target).toBe("_blank");
    if (outcome === "closed") {
      popup.close();
    }
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    const retry = await openSlackIntro();
    expect(normalizedText(screen.getByTestId("get-started-entry"))).toBe(
      "Get more credits2/5",
    );
    expect(buttonNamed("Add to Slack", retry)).toBeEnabled();
    timestamp += 1;
    click(buttonNamed("Add to Slack", retry));
    expect(opened.calls).toHaveLength(2);
    expect(new URL(opened.calls[1]?.url ?? "").searchParams.get("_t")).toBe(
      String(timestamp),
    );
    expect(pathname()).toBe(questChatPath());
    expect(popup.closed).toBe(outcome === "closed");
  },
);

test.each([
  { outcome: "unchanged", installed: false, rewarded: false, credits: 38 },
  {
    outcome: "installed without reward",
    installed: true,
    rewarded: false,
    credits: 37,
  },
  {
    outcome: "server-reported reward",
    installed: false,
    rewarded: true,
    credits: 2037,
  },
])(
  "The real Slack event reconciles $outcome from the API without inventing credit",
  async ({ installed, rewarded, credits }) => {
    const data = configureQuestPage(context, "admin", { slackClaimed: false });
    let org = slackNotInstalled();
    let balance = 37;
    context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
      return respond(200, org);
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, { ...defaultBillingStatus(), credits: balance });
    });
    await setupPage({
      context,
      path: questChatPath(),
      auth: { user: { id: "test-user-123", fullName: "Slack Quest Admin" } },
    });
    await waitFor(() => {
      expect(normalizedText(screen.getByTestId("get-started-entry"))).toBe(
        "Get more credits2/5",
      );
      expect(context.mocks.ably.hasSubscription("slack:changed")).toBeTruthy();
    });
    click(buttonNamed("Slack Quest Admin", document.body));
    const menu = await screen.findByRole("menu");
    const creditBalance = await within(menu).findByTestId(
      "account-menu-credit-balance",
    );
    await expect(
      within(creditBalance).findByText("37 credits"),
    ).resolves.toBeInTheDocument();

    // The event is only a hint. These are the independent API responses.
    org = installed ? { ...slackInstalled(), isConnected: false } : org;
    balance = credits;
    if (rewarded) {
      const slack = data.quests.find((quest) => {
        return quest.key === "slack";
      });
      if (!slack) {
        throw new Error("Missing Slack quest fixture");
      }
      Object.assign(slack, {
        claimedCount: 1,
        earnedCredits: 2000,
        canEarnMore: false,
      });
    }
    context.mocks.ably.trigger("slack:changed", { status: "connected" });
    await waitFor(() => {
      expect(
        within(creditBalance).getByText(
          `${credits.toLocaleString("en-US")} credits`,
        ),
      ).toBeInTheDocument();
      expect(normalizedText(screen.getByTestId("get-started-entry"))).toBe(
        installed || rewarded ? "Get more credits3/5" : "Get more credits2/5",
      );
    });
    expect(pathname()).toBe(questChatPath());
  },
);

test("Reopening Get Started recovers a Slack installation missed by realtime", async () => {
  configureQuestPage(context, "admin", { slackClaimed: false });
  let org = slackNotInstalled();
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, org);
  });
  await setupPage({ context, path: questChatPath() });
  const panel = await openQuestPanel();
  expect(within(panel).getByText("3,200 to go")).toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  org = { ...slackInstalled(), isConnected: false };
  const reopened = await openQuestPanel();
  await expect(
    within(reopened).findByText("1,200 to go"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByTestId("get-started-quest-slack")).not.toHaveAttribute(
    "role",
    "menuitem",
  );
  expect(normalizedText(screen.getByTestId("get-started-entry"))).toBe(
    "Get more credits3/5",
  );
});

test("The workflow step offers the recommendations rather than one sentence", async () => {
  configureQuestPage(context, "admin");
  context.mocks.browser.open();
  await setupPage({
    context,
    path: questChatPath(),
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-workflow"));

  const dialog = await screen.findByRole("dialog", {
    name: "One good run becomes something the team keeps",
  });
  // The composer's own shelf, so the step introduces the product's
  // recommendations instead of a second list kept in step with them by hand.
  expect(
    within(dialog).getByText("Start your day with a clear plan"),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText("Walk into meetings prepared"),
  ).toBeInTheDocument();

  // The way out is still the workflows page, and it is a link rather than the
  // screen's only filled control.
  const browse = linkNamed("Browse workflows", dialog);
  expect(browse).toHaveAttribute("href", "/workflows");
  await expectBrowserActivationsKeepIntro(browse, dialog);
  browse.focus();
  await userEvent.setup({ delay: null }).keyboard("{Enter}");
  await waitFor(() => {
    expect(pathname()).toBe("/workflows");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

test("Picking a workflow hands its sentence to the composer", async () => {
  configureQuestPage(context, "member");
  await setupPage({
    context,
    path: questChatPath(),
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-workflow"));
  const dialog = await screen.findByRole("dialog", {
    name: "One good run becomes something the team keeps",
  });
  click(within(dialog).getByTestId("quest-workflow-inbox"));

  // The URL param is not the assertion, because the composer consumes and
  // clears it on arrival; what matters is the sentence the reader lands in
  // front of, which they can still read and edit before sending.
  await waitFor(() => {
    expect(pathname()).toBe("/");
  });
  await waitFor(() => {
    const composer = document.querySelector(
      '[data-slot="chat-composer-card"] [contenteditable="true"]',
    );
    expect(composer).toHaveTextContent(
      "Help me organize incoming Gmail by urgency",
    );
  });
});

test("An ordinary day's check-in confirms the reward and streak in a dialog", async () => {
  const data = configureQuestPage(context, "member", { claimedToday: false });
  // Day nine is neither the first nor a weekly milestone.
  data.checkinStreak = 8;
  await setupPage({
    context,
    path: questChatPath(),
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-checkin"));

  const dialog = await screen.findByRole("dialog", {
    name: "Checked in for today",
  });
  expect(within(dialog).getByText("9-day streak")).toBeInTheDocument();
  expect(within(dialog).getByText("+100 credits")).toBeInTheDocument();
});

test("Check-in waits for refreshed rewards before showing the success dialog", async () => {
  const data = configureQuestPage(context, "member", { claimedToday: false });
  data.checkinStreak = 8;
  const refreshStarted = context.mocks.deferred<void>();
  const refreshReady = context.mocks.deferred<void>();
  context.mocks.api(getStartedContract.status, async ({ respond }) => {
    if (data.claimedToday) {
      if (!refreshStarted.settled()) {
        refreshStarted.resolve();
      }
      await refreshReady.promise;
    }
    return respond(200, data);
  });
  await setupPage({ context, path: questChatPath() });
  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-checkin"));
  await refreshStarted.promise;
  expect(
    screen.queryByRole("dialog", { name: "Checked in for today" }),
  ).not.toBeInTheDocument();
  const reopenedPanel = await openQuestPanel();
  expect(
    within(reopenedPanel).getByTestId("get-started-quest-checkin"),
  ).toHaveAttribute("aria-busy", "true");
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  refreshReady.resolve();
  const dialog = await screen.findByRole("dialog", {
    name: "Checked in for today",
  });
  expect(within(dialog).getByText("9-day streak")).toBeInTheDocument();
  expect(within(dialog).getByText("+100 credits")).toBeInTheDocument();
});

test("A failed check-in does not show a success dialog", async () => {
  configureQuestPage(context, "member", { claimedToday: false });
  context.mocks.api(getStartedContract.checkin, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Check-in unavailable" },
    });
  });
  await setupPage({
    context,
    path: questChatPath(),
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-checkin"));
  await expect(
    screen.findByText("Check-in unavailable"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: "Checked in for today" }),
  ).toBeNull();

  const panel = await openQuestPanel();
  expect(within(panel).getByText("Check in")).toBeInTheDocument();
});

test("Checking in confirms the reward instead of closing silently", async () => {
  configureQuestPage(context, "admin", { claimedToday: false });
  await setupPage({
    context,
    path: questChatPath(),
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-checkin"));

  const dialog = await screen.findByRole("dialog", {
    name: "Checked in for today",
  });
  // The reward, what it buys, and where the checklist now stands.
  expect(within(dialog).getByText("+100 credits")).toBeInTheDocument();
  expect(
    within(dialog).getByText(
      "Credits pay for the work itself: every run, every artifact, every workflow that runs on a schedule.",
    ),
  ).toBeInTheDocument();
});

test("The quest entry leaves the connector catalog unread until the connector step opens", async () => {
  configureQuestPage(context, "admin");
  let statusReads = 0;
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    statusReads += 1;
    return respond(200, {
      connectors: [catalogItem("gmail", "Gmail", "auth-code")],
    });
  });
  let oneClickReads = 0;
  mockOneClickCatalog([catalogItem("gmail", "Gmail", "auth-code")], () => {
    oneClickReads += 1;
  });
  await setupPage({
    context,
    path: questChatPath(),
  });

  // The intro dialog and its connect flow are mounted beside the entry, but
  // nothing is picked yet, so nothing asks for the catalog.
  await openQuestPanel();
  expect(oneClickReads).toBe(0);

  click(screen.getByTestId("get-started-quest-connector"));
  const picker = await screen.findByTestId("quest-connector-picker");
  expect(within(picker).getByText("Gmail")).toBeInTheDocument();
  // Subscribing also checks changes that happened before the dialog opened.
  expect(oneClickReads).toBeGreaterThan(0);
  // The picker lists what the one-click catalog returns; the full catalog
  // status is never read for it.
  expect(statusReads).toBe(0);
});

test("A connector that needs a choice opens its connect dialog from its own catalog entry", async () => {
  configureQuestPage(context, "admin");
  // The landing page can independently read a random workflow card's
  // connectors. Use a fixture slug no other surface reads, so this count
  // belongs only to the quest's choice flow.
  const oauth = catalogItem("quest-choice", "Choice connector", "auth-code");
  const firstMethod = oauth.authMethods[0];
  if (!firstMethod) {
    throw new Error("Missing auth method");
  }
  // Two browser methods leave nothing to start in one press.
  const choice: PublicConnectorCatalogStatusItem = {
    ...oauth,
    authMethods: [
      firstMethod,
      { ...firstMethod, id: "workspace-oauth", label: "Workspace OAuth" },
    ],
    singleAuthCodeAuthMethodId: null,
  };
  // The slug route would also match the catalog's static paths, so it is
  // installed before the one-click mock, which then takes precedence there.
  let choiceReads = 0;
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    if (params.connectorSlug !== choice.slug) {
      return respond(404, {
        error: { message: "Connector not found", code: "NOT_FOUND" },
      });
    }
    choiceReads += 1;
    return respond(200, { connector: choice });
  });
  mockOneClickCatalog([choice]);
  await setupPage({
    context,
    path: questChatPath(),
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-connector"));
  const tile = await screen.findByTestId("quest-connector-quest-choice");
  expect(choiceReads).toBe(0);
  click(tile);

  // The dialog offers both methods, which only the connector's own full entry
  // carries.
  const dialog = await screen.findByRole("dialog", {
    name: "Choice connector",
  });
  expect(within(dialog).getByText("Workspace OAuth")).toBeInTheDocument();
  expect(choiceReads).toBe(1);
});
