import {
  GET_STARTED_REWARDS,
  GET_STARTED_REWARDS_CHANGED_EVENT,
  getStartedContract,
  type GetStartedStatus,
} from "@okouai/api-contracts/contracts/get-started";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  integrationsSlackContract,
  type SlackOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-slack";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
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

function slackInstalled(): SlackOrgStatus {
  return {
    isConnected: true,
    isInstalled: true,
    isAdmin: true,
    workspaceName: "Quest Workspace",
    installUrl: null,
    connectUrl: null,
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
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
  return {
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
    connection: null,
    connected,
    connectionStatus: connected ? "connected" : "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: true,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: grantKind === "auth-code" ? "oauth" : null,
    connectNotice: null,
  };
}

function mockQuestCatalog(): void {
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, {
      connectors: [
        catalogItem("gmail", "Gmail", "auth-code"),
        catalogItem("notion", "Notion", "auth-code"),
        catalogItem("openai", "OpenAI", "manual"),
      ],
    });
  });
}

function configureQuestPage(
  context: TestContext,
  role: "admin" | "member",
  { claimedToday = true }: { claimedToday?: boolean } = {},
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
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "private",
    },
  ]);
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, slackInstalled());
  });
  const keys =
    role === "admin"
      ? ([
          "connector",
          "slack",
          "workflow",
          "invite",
          "share",
          "checkin",
        ] as const)
      : (["connector", "workflow", "share", "checkin"] as const);
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
          : key === "slack" || (key === "checkin" && claimedToday)
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
        canEarnMore: key !== "slack" && (key !== "checkin" || !claimedToday),
      };
    }),
    shareClaim: null,
    recentGrants: [],
  };
  context.mocks.api(getStartedContract.status, ({ respond }) => {
    return respond(200, data);
  });
  context.mocks.api(getStartedContract.submitShare, ({ body, respond }) => {
    expect(body.url).toBe("https://x.com/molly/status/1873");
    const claim = {
      id: "11111111-1111-4111-a111-111111111111",
      questKey: "share" as const,
      status: "pending" as const,
      rewardAmount: 2000,
      rewardTarget: "user" as const,
      reason: null,
      postUrl: "https://x.com/molly/status/1873",
      submittedAt: data.serverNow,
      grantedAt: null,
      expiresAt: null,
    };
    data.shareClaim = claim;
    return respond(202, claim);
  });
  let checkinGrantCount = 0;
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
      // The server counts the day it just recorded, so the fixture does too;
      // the popup reports the resulting streak.
      data.checkinStreak++;
    }
    checkin.canEarnMore = false;
    data.claimedToday = true;
    const claimId = `22222222-2222-4222-a222-${checkinGrantCount.toString().padStart(12, "0")}`;
    checkinGrantCount++;
    return respond(200, {
      id: claimId,
      questKey: "checkin",
      status: "granted",
      rewardAmount: 100,
      rewardTarget: "user",
      reason: null,
      postUrl: "https://x.com/molly/status/1873",
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

test("Get more credits is the only control in the corner", async () => {
  configureQuestPage(context, "admin");
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });

  await expect(
    screen.findByTestId("get-started-entry"),
  ).resolves.toBeInTheDocument();

  // Get more credits already carries inviting and Slack as its own rows, so the
  // split control that used to sit beside it is gone.
  expect(screen.queryByTestId("growth-entry")).toBeNull();
  expect(screen.queryByTestId("growth-entry-menu")).toBeNull();
  expect(
    queryAllByRoleFast("button").find((candidate) => {
      return normalizedText(candidate) === "Invite humans 🤝";
    }),
  ).toBeUndefined();
});

test("An admin sees every step and what each one pays", async () => {
  configureQuestPage(context, "admin");
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });

  const entry = await waitFor(() => {
    return screen.getByTestId("get-started-entry");
  });
  expect(normalizedText(entry)).toBe("Get more credits3/6");

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

  // Personal earnings exclude Slack; another OAuth connector can still earn a reward.
  expect(within(panel).getByText("400 earned")).toBeInTheDocument();
});

test("A member is only offered the steps they can finish themselves", async () => {
  configureQuestPage(context, "member");
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });

  const entry = await waitFor(() => {
    return screen.getByTestId("get-started-entry");
  });
  expect(normalizedText(entry)).toBe("Get more credits2/4");

  const panel = await openQuestPanel();
  expect(screen.getByTestId("get-started-quest-workflow")).toBeInTheDocument();
  expect(screen.getByTestId("get-started-quest-share")).toBeInTheDocument();
  expect(within(panel).queryByText("Invite your team")).not.toBeInTheDocument();
  expect(within(panel).queryByText("Add to Slack")).not.toBeInTheDocument();
  // The earned total counts only the quests this role was offered.
  expect(within(panel).getByText("400 earned")).toBeInTheDocument();
});

test("Building a workflow opens the workflows page", async () => {
  configureQuestPage(context, "admin");
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-workflow"));

  await waitFor(() => {
    expect(pathname()).toBe("/workflows");
  });
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
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });

  await openQuestPanel();
  const row = screen.getByTestId("get-started-quest-workflow");
  expect(normalizedText(row)).toContain("In review");
  // The action label alone, not the title that also starts with the verb.
  expect(within(row).queryByText("Build")).toBeNull();
  // Nothing left to press, so the row is a status line rather than an option.
  expect(row.getAttribute("role")).not.toBe("menuitem");
});

test("Sharing on X restores pending state and an Ably review notification updates the open panel", async () => {
  const data = configureQuestPage(context, "admin");
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-share"));

  const dialog = await screen.findByRole("dialog", {
    name: "Share Okou on X",
  });
  const submit = buttonNamed("Submit", dialog);
  // Nothing can be claimed without a link.
  expect(submit).toBeDisabled();

  fireEvent.change(within(dialog).getByRole("textbox", { name: "Post link" }), {
    target: { value: "https://x.com/molly/status/1873" },
  });
  expect(submit).toBeEnabled();
  click(submit);

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  const panel = await openQuestPanel();
  expect(within(panel).getByText("In review")).toBeInTheDocument();
  expect(within(panel).queryByText("Share on X")).toBeInTheDocument();
  // The row no longer offers the reward, but it stays pressable: the step is
  // the one waiting quest that still has something to show.
  const waitingRow = queryAllByRoleFast("menuitem", panel).find((candidate) => {
    return normalizedText(candidate).includes("Share on X");
  });
  if (!waitingRow) {
    throw new Error("Missing waiting X row");
  }
  expect(normalizedText(waitingRow)).not.toContain("Share on XShare");
  click(waitingRow);
  const waitingDialog = await screen.findByRole("dialog", {
    name: "Your post is with the reviewer",
  });
  // The post itself is the thing the reader cannot reconstruct from the row.
  expect(
    within(waitingDialog).getByText("https://x.com/molly/status/1873"),
  ).toBeInTheDocument();
  // Nothing to submit, because there is nothing left to submit.
  expect(
    queryAllByRoleFast("button", waitingDialog).find((candidate) => {
      return normalizedText(candidate) === "Submit";
    }),
  ).toBeUndefined();
  click(buttonNamed("Done", waitingDialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  // Pressing the row closed the panel, as every quest row does.
  const afterReview = await openQuestPanel();

  if (!data.shareClaim) {
    throw new Error("Missing submitted X claim");
  }
  const share = data.quests.find((quest) => {
    return quest.key === "share";
  });
  if (!share) {
    throw new Error("Missing X quest");
  }
  data.shareClaim.status = "granted";
  data.shareClaim.grantedAt = data.serverNow;
  data.shareClaim.expiresAt = "2026-09-22T12:00:00.000Z";
  data.recentGrants = [data.shareClaim];
  Object.assign(share, {
    claimedCount: 1,
    earnedCredits: 2000,
    canEarnMore: false,
  });
  context.mocks.ably.trigger(GET_STARTED_REWARDS_CHANGED_EVENT);
  await expect(
    within(afterReview).findByText("2,400 earned"),
  ).resolves.toBeInTheDocument();
  expect(within(afterReview).queryByText("In review")).not.toBeInTheDocument();
  const rewardDialog = await screen.findByRole("dialog", {
    name: "Nice work!",
  });
  expect(within(rewardDialog).getByText("Share on X")).toBeInTheDocument();
  expect(within(rewardDialog).getByText("+2,000 credits")).toBeInTheDocument();
});

test("Reward notifications refresh quests without disconnecting shared chat history", async () => {
  const data = configureQuestPage(context, "member", { claimedToday: false });
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 640px)";
  });
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [
        {
          id: "b0000000-0000-4000-a000-000000000001",
          agentId: QUEST_AGENT_ID,
          title: "Existing reward conversation",
          sortAt: data.serverNow,
          createdAt: data.serverNow,
          updatedAt: data.serverNow,
          pinnedAt: null,
          renamedAt: null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
          selectedVideoModel: null,
        },
      ],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  data.shareClaim = {
    id: "33333333-3333-4333-a333-333333333333",
    questKey: "share",
    status: "pending",
    rewardAmount: 2000,
    rewardTarget: "user",
    reason: null,
    postUrl: "https://x.com/molly/status/1873",
    submittedAt: data.serverNow,
    grantedAt: null,
    expiresAt: null,
  };
  await setupPage({
    context,
    path: questChatPath(),
    sharedWorkerTestTransport: "message-port",
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });
  await expect(
    screen.findByText("Existing reward conversation"),
  ).resolves.toBeInTheDocument();
  const panel = await openQuestPanel();
  expect(within(panel).getByText("In review")).toBeInTheDocument();
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "user:test-user-123",
        GET_STARTED_REWARDS_CHANGED_EVENT,
      ),
    ).toBeTruthy();
  });
  data.shareClaim.status = "rejected";
  data.shareClaim.reason = "post_must_mention_okou";
  context.mocks.ably.triggerOnChannel(
    "user:test-user-123",
    GET_STARTED_REWARDS_CHANGED_EVENT,
    null,
  );
  // The reward shares the description line, so the rejection reason is read
  // off the row rather than as a standalone text node.
  await waitFor(() => {
    expect(
      normalizedText(screen.getByTestId("get-started-quest-share")),
    ).toContain("Must mention Okou");
  });
  expect(within(panel).getByText("300 earned")).toBeInTheDocument();
  expect(
    within(screen.getByTestId("get-started-quest-checkin")).getByText(
      "Check in",
    ),
  ).toBeInTheDocument();
});

test("The entry stays hidden while the switch is off", async () => {
  configureQuestPage(context, "admin");
  await setupPage({ context, path: questChatPath() });

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByTestId("get-started-entry")).not.toBeInTheDocument();
});

test("The invite quest opens usable People settings from the keyboard", async () => {
  const user = userEvent.setup();
  configureQuestPage(context, "admin");
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });

  await openQuestPanel();
  await user.keyboard("{Home}{ArrowDown}{ArrowDown}");
  expect(screen.getByTestId("get-started-quest-invite")).toHaveFocus();
  await user.keyboard("{Enter}");

  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await expect(
    within(settings).findByRole("heading", { name: "People" }),
  ).resolves.toBeInTheDocument();
  expect(buttonNamed("Add member", settings)).toBeEnabled();
  await waitFor(() => {
    expect(settings).toContainElement(document.activeElement as HTMLElement);
  });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("Cancelling a share draft clears the link without consuming a reward", async () => {
  configureQuestPage(context, "admin");
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-share"));
  const dialog = await screen.findByRole("dialog", { name: "Share Okou on X" });
  const input = within(dialog).getByRole("textbox", { name: "Post link" });
  fireEvent.change(input, {
    target: { value: "https://x.com/molly/status/1873" },
  });
  expect(buttonNamed("Submit", dialog)).toBeEnabled();
  click(buttonNamed("Later", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-share"));
  const reopened = await screen.findByRole("dialog", {
    name: "Share Okou on X",
  });
  expect(
    within(reopened).getByRole("textbox", { name: "Post link" }),
  ).toHaveValue("");
  expect(buttonNamed("Submit", reopened)).toBeDisabled();
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
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });
  const panel = await openQuestPanel();
  expect(within(panel).getByText("8/15", { exact: false })).toBeInTheDocument();
  expect(
    within(panel).getByText("3 pending", { exact: false }),
  ).toBeInTheDocument();
  expect(screen.getByTestId("get-started-quest-invite")).toBeInTheDocument();
  expect(within(panel).getByText("1,200 earned")).toBeInTheDocument();
});

test("A rejected X claim can be replaced and survives opening the task panel", async () => {
  const data = configureQuestPage(context, "member");
  data.shareClaim = {
    id: "33333333-3333-4333-a333-333333333333",
    questKey: "share",
    status: "rejected",
    rewardAmount: 2000,
    rewardTarget: "user",
    reason: "post_must_mention_okou",
    postUrl: "https://x.com/molly/status/1873",
    submittedAt: data.serverNow,
    grantedAt: null,
    expiresAt: null,
  };
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });
  await openQuestPanel();
  // The reviewer's own reason, not a bare refusal: a reader told only that the
  // claim failed submits the same link again.
  expect(
    normalizedText(screen.getByTestId("get-started-quest-share")),
  ).toContain("Must mention Okou");
  click(screen.getByTestId("get-started-quest-share"));
  await expect(
    screen.findByRole("dialog", { name: "Share Okou on X" }),
  ).resolves.toBeInTheDocument();
});

test("Daily rewards are claimed by selecting check in and menu reopening refreshes the UTC day", async () => {
  const data = configureQuestPage(context, "member", { claimedToday: false });
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });
  const panel = await openQuestPanel();
  await expect(
    within(panel).findByText("300 earned"),
  ).resolves.toBeInTheDocument();
  const checkinRow = screen.getByTestId("get-started-quest-checkin");
  expect(within(checkinRow).getByText("Check in")).toBeInTheDocument();
  expect(normalizedText(checkinRow)).toContain("Check in daily+100Check in");

  click(checkinRow);
  const firstDayReward = await screen.findByRole("dialog", {
    name: "Checked in for today",
  });
  expect(within(firstDayReward).getByText("+100 credits")).toBeInTheDocument();
  click(buttonNamed("Back to work", firstDayReward));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  const sameDayPanel = await openQuestPanel();
  await expect(
    within(sameDayPanel).findByText("400 earned"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByTestId("get-started-quest-checkin")).not.toHaveAttribute(
    "role",
    "menuitem",
  );
  expect(within(sameDayPanel).queryByText("Check in")).not.toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  const reopenedSameDayPanel = await openQuestPanel();
  expect(
    within(reopenedSameDayPanel).getByText("400 earned"),
  ).toBeInTheDocument();
  expect(
    within(reopenedSameDayPanel).queryByText("Check in"),
  ).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  data.serverNow = "2026-09-16T00:00:00.000Z";
  data.nextResetAt = "2026-09-17T00:00:00.000Z";
  data.claimedToday = false;
  const checkin = data.quests.find((quest) => {
    return quest.key === "checkin";
  });
  if (!checkin) {
    throw new Error("Missing check-in fixture");
  }
  checkin.canEarnMore = true;
  const nextDayPanel = await openQuestPanel();
  await expect(
    within(nextDayPanel).findByText("Check in"),
  ).resolves.toBeInTheDocument();
  expect(within(nextDayPanel).getByText("400 earned")).toBeInTheDocument();

  const nextDayCheckin = screen.getByTestId("get-started-quest-checkin");
  nextDayCheckin.focus();
  await userEvent.keyboard("{Enter}");
  const nextDayReward = await screen.findByRole("dialog", {
    name: "Checked in for today",
  });
  expect(within(nextDayReward).getByText("+100 credits")).toBeInTheDocument();
  click(buttonNamed("Back to work", nextDayReward));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  const afterNextDay = await openQuestPanel();
  await expect(
    within(afterNextDay).findByText("500 earned"),
  ).resolves.toBeInTheDocument();
  expect(within(afterNextDay).queryByText("Check in")).not.toBeInTheDocument();
});

test("The daily step leads the list on the same grammar as every other step", async () => {
  const data = configureQuestPage(context, "member", { claimedToday: false });
  data.checkinStreak = 6;
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });
  const panel = await openQuestPanel();

  // The totals describe the whole list, so they are stated once above it
  // rather than inside the first step.
  await expect(
    within(panel).findByText("300 earned"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).getByText("3,200 to go")).toBeInTheDocument();

  // The daily step leads, and what is finished sinks below what still pays.
  const rows = within(panel).getAllByTestId(/^get-started-quest-/u);
  expect(
    rows.map((row) => {
      return row.dataset.testid;
    }),
  ).toStrictEqual([
    "get-started-quest-checkin",
    "get-started-quest-connector",
    "get-started-quest-workflow",
    "get-started-quest-share",
  ]);

  // It says what it is, what it pays, how far the streak has run and what
  // pressing it does -- the four parts every other row carries.
  const checkin = within(screen.getByTestId("get-started-quest-checkin"));
  expect(checkin.getByText("Check in daily")).toBeInTheDocument();
  expect(checkin.getByText("+100")).toBeInTheDocument();
  expect(
    checkin.getByText("6-day streak", { exact: false }),
  ).toBeInTheDocument();
  expect(checkin.getByText("Check in")).toBeInTheDocument();
});

test("A pending check-in disables the action and a failed request leaves it available", async () => {
  configureQuestPage(context, "member", { claimedToday: false });
  const responseReady = createDeferredPromise<void>(context.signal);
  context.mocks.api(getStartedContract.checkin, async ({ respond }) => {
    await responseReady.promise;
    return respond(403, {
      error: {
        code: "FORBIDDEN",
        message: "Check-in is temporarily unavailable",
      },
    });
  });
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });
  const panel = await openQuestPanel();
  await expect(
    within(panel).findByText("300 earned"),
  ).resolves.toBeInTheDocument();
  const checkinRow = screen.getByTestId("get-started-quest-checkin");

  click(checkinRow);
  await waitFor(() => {
    expect(checkinRow).toHaveAttribute("aria-disabled", "true");
    expect(checkinRow).toHaveAttribute("aria-busy", "true");
  });
  responseReady.resolve();
  await expect(
    screen.findByText("Check-in is temporarily unavailable"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(checkinRow).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(within(checkinRow).getByText("Check in")).toBeInTheDocument();
  expect(within(panel).getByText("300 earned")).toBeInTheDocument();
});

test("The connector step says what it costs the user before it hands them off", async () => {
  configureQuestPage(context, "admin");
  mockQuestCatalog();
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: {
      [FeatureSwitchKey.GetStartedQuests]: true,
      [FeatureSwitchKey.GetStartedQuestIntro]: true,
    },
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

  // The reward only pays on connectors that finish in the browser, so those
  // are the ones the dialog offers; the key-pasting half of the catalog would
  // earn nothing and is not shown here.
  const picker = await within(dialog).findByTestId("quest-connector-picker");
  expect(within(picker).getByText("Gmail")).toBeInTheDocument();
  expect(within(picker).queryByText("OpenAI")).not.toBeInTheDocument();

  // The whole catalog is still one press away for anyone who wants it.
  click(buttonNamed("Browse all connectors", dialog));
  await waitFor(() => {
    expect(pathname()).toBe("/connectors");
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
    featureSwitches: {
      [FeatureSwitchKey.GetStartedQuests]: true,
      [FeatureSwitchKey.GetStartedQuestIntro]: true,
    },
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

test("The dialog leads with the connectors the step can still be completed with", async () => {
  configureQuestPage(context, "admin");
  // Slack is the better-ranked connector and is already connected, so the
  // catalog order alone would put it first. The step can only be finished on
  // Notion, so Notion is what the reader meets first in spite of that rank.
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, {
      connectors: [
        catalogItem("slack", "Slack", "auth-code", true, 1),
        catalogItem("notion", "Notion", "auth-code", false, 2),
      ],
    });
  });
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: {
      [FeatureSwitchKey.GetStartedQuests]: true,
      [FeatureSwitchKey.GetStartedQuestIntro]: true,
    },
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-connector"));
  const picker = await screen.findByTestId("quest-connector-picker");

  const notConnected = within(picker).getByRole("region", {
    name: "Not connected",
  });
  const connected = within(picker).getByRole("region", { name: "Connected" });
  expect(within(notConnected).getByText("Notion")).toBeInTheDocument();
  expect(within(connected).getByText("Slack")).toBeInTheDocument();

  // Reading order, not just membership: the unfinished half comes first.
  expect(
    notConnected.compareDocumentPosition(connected) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test("The Slack step starts the install instead of handing over a list", async () => {
  const data = configureQuestPage(context, "admin");
  // The workspace this step exists for: an admin who has not installed yet, so
  // the quest is still claimable and the status carries the URL that does the
  // work. The shared fixture ships Slack already installed.
  const slack = data.quests.find((quest) => {
    return quest.key === "slack";
  });
  if (!slack) {
    throw new Error("Missing slack fixture");
  }
  slack.claimedCount = 0;
  slack.earnedCredits = 0;
  slack.canEarnMore = true;
  context.mocks.api(integrationsSlackContract.getStatus, ({ respond }) => {
    return respond(200, {
      ...slackInstalled(),
      isConnected: false,
      isInstalled: false,
      installUrl: "https://slack.com/oauth/v2/authorize?state=quest",
    });
  });
  const opened: string[] = [];
  vi.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return null;
  });
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: {
      [FeatureSwitchKey.GetStartedQuests]: true,
      [FeatureSwitchKey.GetStartedQuestIntro]: true,
    },
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-slack"));
  const dialog = await screen.findByRole("dialog", {
    name: "Work with Okou where your team already talks",
  });

  click(buttonNamed("Add to Slack", dialog));
  await waitFor(() => {
    expect(opened).toHaveLength(1);
  });
  expect(opened[0]).toContain("https://slack.com/oauth/v2/authorize");
  // The authorization owns the next step, so the reader is not also dropped on
  // the integrations page behind it.
  expect(pathname()).toBe(questChatPath());
});

test("Declining an introduced step costs the user nothing", async () => {
  configureQuestPage(context, "admin");
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: {
      [FeatureSwitchKey.GetStartedQuests]: true,
      [FeatureSwitchKey.GetStartedQuestIntro]: true,
    },
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-invite"));
  const dialog = await screen.findByRole("dialog", {
    name: "What one person knows, everyone can run",
  });
  expect(
    within(dialog).getByText("Invite your teammates to this workspace."),
  ).toBeInTheDocument();

  click(buttonNamed("Later", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(pathname()).toBe(questChatPath());
});

test("The workflow step offers the recommendations rather than one sentence", async () => {
  configureQuestPage(context, "admin");
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: {
      [FeatureSwitchKey.GetStartedQuests]: true,
      [FeatureSwitchKey.GetStartedQuestIntro]: true,
    },
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
  click(buttonNamed("Browse workflows", dialog));
  await waitFor(() => {
    expect(pathname()).toBe("/workflows");
  });
});

test("Picking a workflow hands its sentence to the composer", async () => {
  configureQuestPage(context, "member");
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: {
      [FeatureSwitchKey.GetStartedQuests]: true,
      [FeatureSwitchKey.GetStartedQuestIntro]: true,
    },
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

test("Every daily check-in confirms its reward, including ordinary streak days", async () => {
  const data = configureQuestPage(context, "member", { claimedToday: false });
  // Mid-streak: the next check-in is day four, between the first day and a
  // full week.
  data.checkinStreak = 3;
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: {
      [FeatureSwitchKey.GetStartedQuests]: true,
      [FeatureSwitchKey.GetStartedQuestIntro]: true,
    },
  });

  await openQuestPanel();
  click(screen.getByTestId("get-started-quest-checkin"));

  const rewardDialog = await screen.findByRole("dialog", {
    name: "Checked in for today",
  });
  expect(within(rewardDialog).getByText("4-day streak")).toBeInTheDocument();
  expect(within(rewardDialog).getByText("+100 credits")).toBeInTheDocument();
});

test("Checking in confirms the reward instead of closing silently", async () => {
  configureQuestPage(context, "admin", { claimedToday: false });
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: {
      [FeatureSwitchKey.GetStartedQuests]: true,
      [FeatureSwitchKey.GetStartedQuestIntro]: true,
    },
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
