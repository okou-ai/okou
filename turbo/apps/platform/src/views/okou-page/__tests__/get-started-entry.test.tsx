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
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
import { connectorCatalogConnectItem } from "../../../mocks/handlers/api-connectors.ts";
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
});

test("The entry stays hidden while the switch is off", async () => {
  configureQuestPage(context, "admin");
  await setupPage({ context, path: questChatPath() });

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByTestId("get-started-entry")).not.toBeInTheDocument();
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

test("Daily rewards are claimed by selecting check in", async () => {
  configureQuestPage(context, "member", { claimedToday: false });
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
  await expect(
    within(panel).findByText("400 earned"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByTestId("get-started-quest-checkin")).not.toHaveAttribute(
    "role",
    "menuitem",
  );
  expect(within(panel).queryByText("Check in")).not.toBeInTheDocument();
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

test("An ordinary day's check-in reports the streak without taking the screen", async () => {
  const data = configureQuestPage(context, "member", { claimedToday: false });
  // Mid-streak: the next check-in is day four, which is neither the first nor
  // a full week, so it is the case that should stay out of the way.
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

  // The streak is the part worth saying, and it is said without a modal.
  await expect(screen.findByText("4-day streak")).resolves.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
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
    featureSwitches: {
      [FeatureSwitchKey.GetStartedQuests]: true,
      [FeatureSwitchKey.GetStartedQuestIntro]: true,
    },
  });

  // The intro dialog and its connect flow are mounted beside the entry, but
  // nothing is picked yet, so nothing asks for the catalog.
  await openQuestPanel();
  expect(oneClickReads).toBe(0);

  click(screen.getByTestId("get-started-quest-connector"));
  const picker = await screen.findByTestId("quest-connector-picker");
  expect(within(picker).getByText("Gmail")).toBeInTheDocument();
  expect(oneClickReads).toBe(1);
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
    featureSwitches: {
      [FeatureSwitchKey.GetStartedQuests]: true,
      [FeatureSwitchKey.GetStartedQuestIntro]: true,
    },
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
