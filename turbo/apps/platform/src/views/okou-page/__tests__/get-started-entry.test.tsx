import {
  GET_STARTED_REWARDS,
  GET_STARTED_REWARDS_CHANGED_EVENT,
  getStartedContract,
  type GetStartedStatus,
} from "@okouai/api-contracts/contracts/get-started";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  integrationsSlackContract,
  type SlackOrgStatus,
} from "@okouai/api-contracts/contracts/integrations-slack";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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

function configureQuestPage(
  context: TestContext,
  role: "admin" | "member",
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
    claimedToday: true,
    quests: keys.map((key) => {
      const reward = GET_STARTED_REWARDS[key];
      const claimedCount =
        key === "connector" ? 3 : key === "slack" || key === "checkin" ? 1 : 0;
      return {
        key,
        claimedCount,
        rewardAmount: reward.amount,
        rewardTarget: reward.target,
        limit: reward.limit,
        earnedCredits: claimedCount * reward.amount,
        pendingCount: 0,
        canEarnMore: key !== "slack" && key !== "checkin",
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
      submittedAt: data.serverNow,
      grantedAt: null,
      expiresAt: null,
    };
    data.shareClaim = claim;
    return respond(202, claim);
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
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });

  const entry = await waitFor(() => {
    return screen.getByTestId("get-started-entry");
  });
  expect(normalizedText(entry)).toBe("Get started3/6");

  const panel = await openQuestPanel();
  expect(
    within(panel).getByText(
      "Rewards expire 7 days after they are granted. Slack rewards go to the organization; other rewards go to your personal balance.",
    ),
  ).toBeInTheDocument();
  const workflowRow = screen.getByTestId("get-started-quest-workflow");
  const workflow = within(workflowRow);
  expect(workflow.getByText("Build a workflow")).toBeInTheDocument();
  // The reward leads the description line, so the two read as one sentence.
  expect(normalizedText(workflowRow)).toContain(
    "+1,000 · Successfully run a workflow you created.",
  );
  expect(workflow.getByText("+1,000")).toBeInTheDocument();
  // An unfinished quest names what pressing the row does.
  expect(workflow.getByText("Build")).toBeInTheDocument();

  // A reward that keeps paying names its unit next to the amount.
  const invite = within(screen.getByTestId("get-started-quest-invite"));
  expect(invite.getByText("Invite your team")).toBeInTheDocument();
  expect(invite.getByText("per member")).toBeInTheDocument();

  // Personal earnings exclude Slack; another OAuth connector can still earn a reward.
  expect(within(panel).getByText("400")).toBeInTheDocument();
  expect(screen.getByTestId("get-started-quest-connector")).toBeInTheDocument();
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
  expect(normalizedText(entry)).toBe("Get started2/4");

  const panel = await openQuestPanel();
  expect(screen.getByTestId("get-started-quest-workflow")).toBeInTheDocument();
  expect(screen.getByTestId("get-started-quest-share")).toBeInTheDocument();
  expect(within(panel).queryByText("Invite your team")).not.toBeInTheDocument();
  expect(
    within(panel).queryByText("Add Okou to Slack"),
  ).not.toBeInTheDocument();
  // The earned total counts only the quests this role was offered.
  expect(within(panel).getByText("400")).toBeInTheDocument();
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
  expect(within(panel).queryByText("Share Okou on X")).toBeInTheDocument();
  // The row no longer offers the reward, and it is no longer a menu item.
  expect(
    queryAllByRoleFast("menuitem", panel).find((candidate) => {
      return normalizedText(candidate).includes("Share Okou on X");
    }),
  ).toBeUndefined();

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
  Object.assign(share, {
    claimedCount: 1,
    earnedCredits: 2000,
    canEarnMore: false,
  });
  context.mocks.ably.trigger(GET_STARTED_REWARDS_CHANGED_EVENT);
  await expect(within(panel).findByText("2,400")).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("In review")).not.toBeInTheDocument();
});

test("Reward notifications refresh quests without disconnecting shared chat history", async () => {
  const data = configureQuestPage(context, "member");
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
  await expect(
    within(panel).findByText(
      "This post is not eligible. Submit another public post mentioning Okou.",
    ),
  ).resolves.toBeInTheDocument();
  expect(screen.getByTestId("get-started-quest-share")).toBeInTheDocument();
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
  click(buttonNamed("Cancel", dialog));
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
    within(panel).getByText("Pending invitations: 3", { exact: false }),
  ).toBeInTheDocument();
  expect(screen.getByTestId("get-started-quest-invite")).toBeInTheDocument();
  expect(within(panel).getByText("1,200")).toBeInTheDocument();
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
    submittedAt: data.serverNow,
    grantedAt: null,
    expiresAt: null,
  };
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });
  const panel = await openQuestPanel();
  expect(
    within(panel).getByText(
      "This post is not eligible. Submit another public post mentioning Okou.",
    ),
  ).toBeInTheDocument();
  click(screen.getByTestId("get-started-quest-share"));
  await expect(
    screen.findByRole("dialog", { name: "Share Okou on X" }),
  ).resolves.toBeInTheDocument();
});

test("Opening the app checks in and focus refresh uses the server UTC day", async () => {
  const data = configureQuestPage(context, "member");
  data.claimedToday = false;
  const checkin = data.quests.find((q) => {
    return q.key === "checkin";
  });
  if (!checkin) {
    throw new Error("Missing checkin fixture");
  }
  Object.assign(checkin, {
    claimedCount: 0,
    earnedCredits: 0,
    canEarnMore: true,
  });
  await setupPage({
    context,
    path: questChatPath(),
    featureSwitches: { [FeatureSwitchKey.GetStartedQuests]: true },
  });
  const panel = await openQuestPanel();
  await expect(within(panel).findByText("400")).resolves.toBeInTheDocument();
  const checkinRow = screen.getByTestId("get-started-quest-checkin");
  expect(normalizedText(checkinRow)).toContain(
    "Open the app daily. Resets at 00:00 UTC.",
  );
  // Opening the app is the check-in, so this row offers nothing to press.
  expect(within(checkinRow).queryByText("Check in")).not.toBeInTheDocument();
  data.serverNow = "2026-09-16T00:00:00.000Z";
  data.nextResetAt = "2026-09-17T00:00:00.000Z";
  data.claimedToday = false;
  fireEvent.focus(window);
  await expect(within(panel).findByText("500")).resolves.toBeInTheDocument();
});
