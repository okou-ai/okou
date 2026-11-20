import { catalogFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import { friendReferralsContract } from "@okouai/api-contracts/contracts/friend-referrals";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
} from "../../../__tests__/page-helper.ts";
import { connectorCatalogConnectItem } from "../../../mocks/handlers/api-connectors.ts";

import { mockNow } from "../../../lib/time.ts";
import { pathname } from "../../../signals/location.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";

const QUEST_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const context = testContext();

test("The gift opens invitations independently of credit quests and copies the invitation link", async () => {
  const status = configureQuestPage(context, "admin");
  status.quests = [];
  const linkReady = context.mocks.deferred<void>();
  context.mocks.api(friendReferralsContract.link, async ({ respond }) => {
    await linkReady.promise;
    return respond(200, {
      code: "a7k2p9",
      registeredCount: 3,
      rewardedCount: 2,
      earnedCredits: 40_000,
    });
  });
  await setupInvitationPage();
  const user = userEvent.setup({ delay: null });
  const entry = await waitFor(() => {
    return buttonNamed("Invite your friends", document.body);
  });
  entry.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Invite friends, get $20 each",
  });
  expect(
    within(dialog).getByText(
      "You get $20 in credits once a friend completes all 3 steps",
    ),
  ).toBeInTheDocument();
  expect(within(dialog).getByText("Buys a usage pack")).toBeInTheDocument();
  expect(
    within(dialog).getByText(/expire 1 month after they’re granted/u),
  ).toBeInTheDocument();
  await expect(
    within(dialog).findByRole("status", {
      name: "Getting your invitation link…",
    }),
  ).resolves.toBeInTheDocument();
  linkReady.resolve();
  await waitFor(() => {
    return buttonNamed("Copy invite link", dialog);
  });
  expect(within(dialog).getByText("40,000")).toBeInTheDocument();
  click(buttonNamed("Copy invite link", dialog));
  await waitFor(() => {
    expect(buttonNamed("Copied", dialog)).toBeInTheDocument();
  });
  await expect(navigator.clipboard.readText()).resolves.toBe(
    `${location.origin}/sign-up?friend_referral=a7k2p9`,
  );
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(entry).toHaveFocus();
  });
});

test("History navigation closes a reopened invitation dialog without restoring stale open state", async () => {
  const status = configureQuestPage(context, "admin");
  status.quests = [];
  context.mocks.api(friendReferralsContract.link, ({ respond }) => {
    return respond(200, {
      code: "a7k2p9",
      registeredCount: 3,
      rewardedCount: 2,
      earnedCredits: 40_000,
    });
  });
  await setupInvitationPage();
  await waitFor(() => {
    return buttonNamed("Invite your friends", document.body);
  });
  expect(
    screen.queryByRole("dialog", { name: "Invite friends, get $20 each" }),
  ).not.toBeInTheDocument();
  click(linkNamed("Workflows", document.body));
  await screen.findByRole("heading", { name: "Workflows" });
  act(() => {
    window.history.back();
  });
  const reopenedEntry = await waitFor(() => {
    return buttonNamed("Invite your friends", document.body);
  });
  click(reopenedEntry);
  await screen.findByRole("dialog", {
    name: "Invite friends, get $20 each",
  });
  act(() => {
    window.history.forward();
  });
  await screen.findByRole("heading", { name: "Workflows" });
  act(() => {
    window.history.back();
  });
  await waitFor(() => {
    expect(pathname()).toBe(questChatPath());
    expect(
      screen.queryByRole("dialog", {
        name: "Invite friends, get $20 each",
      }),
    ).not.toBeInTheDocument();
  });
});

async function setupInvitationPage() {
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: {
      [FeatureSwitchKey.SingleAgent]: false,
    },
    auth: {
      user: { id: "test-user-123", fullName: "Referral User" },
      organization: {
        activeOrg: {
          id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
          name: "Referral Workspace",
        },
        memberships: [{ id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" }],
      },
    },
  });
}

test("Referral link failures can be retried in the same dialog", async () => {
  configureQuestPage(context, "admin");
  let failed = true;
  context.mocks.api(friendReferralsContract.link, ({ respond }) => {
    return failed
      ? respond(403, {
          error: {
            code: "FORBIDDEN",
            message: "Organization access denied",
          },
        })
      : respond(200, {
          code: "a7k2p9",
          registeredCount: 0,
          rewardedCount: 0,
          earnedCredits: 0,
        });
  });
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: {
      [FeatureSwitchKey.SingleAgent]: false,
    },
    auth: {
      user: { id: "test-user-123", fullName: "Referral User" },
      organization: {
        activeOrg: {
          id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
          name: "Referral Workspace",
        },
        memberships: [{ id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" }],
      },
    },
  });
  await screen.findByTestId("get-started-entry");
  click(buttonNamed("Invite your friends", document.body));
  const dialog = await screen.findByRole("dialog", {
    name: "Invite friends, get $20 each",
  });
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Your invitation link could not be loaded. Try again.",
  );
  failed = false;
  click(buttonNamed("Try again", dialog));
  await waitFor(() => {
    expect(buttonNamed("Copy invite link", dialog)).toBeInTheDocument();
  });
});

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
  expect(within(connectorRow).getByText("· 3/10")).toBeInTheDocument();
  expect(within(connectorRow).getByText("Connect")).toBeInTheDocument();
});

test("A connector reward at its limit shows completion and stops offering more credits", async () => {
  const data = configureQuestPage(context, "admin");
  const connector = data.quests.find((quest) => {
    return quest.key === "connector";
  });
  if (!connector) {
    throw new Error("Missing connector fixture");
  }
  connector.claimedCount = 10;
  connector.earnedCredits = 1000;
  connector.canEarnMore = false;
  await setupPage({ context, path: questChatPath() });

  await openQuestPanel();
  const row = screen.getByTestId("get-started-quest-connector");
  expect(within(row).getByText("· 10/10")).toBeInTheDocument();
  expect(within(row).getByText("Connect a connector")).toBeInTheDocument();
  expect(within(row).queryByText("Connect")).toBeNull();
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
  expect(
    screen.queryByRole("dialog", { name: /Gmail/u }),
  ).not.toBeInTheDocument();
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
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  release.resolve();
});

test.each<"blocked" | "closed" | "open">(["blocked"])(
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

test("A saved check-in waits for a financial confirmation before celebrating", async () => {
  const data = configureQuestPage(context, "member", { claimedToday: false });
  context.mocks.api(getStartedContract.checkin, ({ respond }) => {
    const checkin = data.quests.find((quest) => {
      return quest.key === "checkin";
    });
    if (!checkin) {
      throw new Error("Expected check-in quest");
    }
    checkin.pendingCount = 1;
    return respond(202, {
      status: "pending",
      requestId: "3b37c105-4676-4a59-9c33-705330fe8439",
    });
  });
  await setupPage({ context, path: questChatPath() });
  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-checkin"));
  await expect(
    screen.findByText(
      "Your check-in was saved. Credits will update after confirmation.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: "Checked in for today" }),
  ).not.toBeInTheDocument();
  const panel = await openQuestPanel();
  expect(
    within(screen.getByTestId("get-started-quest-checkin")).getByText(
      "In review",
    ),
  ).toBeInTheDocument();
  expect(within(panel).queryByText("Checked in")).not.toBeInTheDocument();
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
