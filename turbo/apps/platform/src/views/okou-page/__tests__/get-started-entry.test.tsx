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
    connected: false,
    connectionStatus: "not-connected",
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
    "+1,000 · Turn a repeat task into a reusable skill",
  );
  expect(workflow.getByText("+1,000")).toBeInTheDocument();
  // An unfinished quest names what pressing the row does.
  expect(workflow.getByText("Build")).toBeInTheDocument();

  // A reward that keeps paying names its unit next to the amount.
  const invite = within(screen.getByTestId("get-started-quest-invite"));
  expect(invite.getByText("Invite your team")).toBeInTheDocument();
  expect(invite.getByText("per member")).toBeInTheDocument();

  // A finished quest keeps the completion check and offers nothing to press.
  const slackRow = screen.getByTestId("get-started-quest-slack");
  expect(within(slackRow).queryByText("Add")).not.toBeInTheDocument();

  // Done but still earning: the connector keeps both its reward and its
  // affordance instead of collapsing to the completion check.
  const connectorRow = screen.getByTestId("get-started-quest-connector");
  expect(normalizedText(connectorRow)).toContain("+100 per connector");
  expect(within(connectorRow).getByText("Connect")).toBeInTheDocument();

  // Personal earnings exclude Slack; another OAuth connector can still earn a reward.
  expect(within(panel).getByText("400")).toBeInTheDocument();
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
    ).toContain(
      "This post is not eligible. Submit another public post mentioning Okou.",
    );
  });
  expect(within(panel).getByText("300")).toBeInTheDocument();
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
  await openQuestPanel();
  expect(
    normalizedText(screen.getByTestId("get-started-quest-share")),
  ).toContain(
    "This post is not eligible. Submit another public post mentioning Okou.",
  );
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
  await expect(within(panel).findByText("300")).resolves.toBeInTheDocument();
  const checkinRow = screen.getByTestId("get-started-quest-checkin");
  expect(within(checkinRow).getByText("Check in")).toBeInTheDocument();
  expect(normalizedText(checkinRow)).toContain(
    "Check in once a day. Resets at 00:00 UTC.",
  );

  click(checkinRow);
  await expect(within(panel).findByText("400")).resolves.toBeInTheDocument();
  expect(screen.getByTestId("get-started-quest-checkin")).not.toHaveAttribute(
    "role",
    "menuitem",
  );
  expect(within(panel).queryByText("Check in")).not.toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  const sameDayPanel = await openQuestPanel();
  expect(within(sameDayPanel).getByText("400")).toBeInTheDocument();
  expect(within(sameDayPanel).queryByText("Check in")).not.toBeInTheDocument();
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
  expect(within(nextDayPanel).getByText("400")).toBeInTheDocument();

  const nextDayCheckin = screen.getByTestId("get-started-quest-checkin");
  nextDayCheckin.focus();
  await userEvent.keyboard("{Enter}");
  await expect(
    within(nextDayPanel).findByText("500"),
  ).resolves.toBeInTheDocument();
  expect(within(nextDayPanel).queryByText("Check in")).not.toBeInTheDocument();
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
  await expect(within(panel).findByText("300")).resolves.toBeInTheDocument();
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
  expect(within(panel).getByText("300")).toBeInTheDocument();
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
    within(dialog).getByText(
      "Connect one of your tools so Okou can work in it.",
    ),
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

test("The workflow step ends by handing over the prompt itself", async () => {
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

  const steps = await screen.findByRole("dialog", {
    name: "One good run becomes something the team keeps",
  });
  expect(within(steps).getByText("Start from a template")).toBeInTheDocument();
  expect(within(steps).getByText("Run it once")).toBeInTheDocument();
  expect(
    within(steps).getByText("Save it, then give it a schedule"),
  ).toBeInTheDocument();

  click(buttonNamed("Give me one to try", steps));

  const handover = await screen.findByRole("dialog", {
    name: "Ask the way you would ask a colleague",
  });
  // The prompt is readable before it is sent, not hidden behind the button.
  expect(
    within(handover).getByText(
      "Every Monday morning, check what my competitors published last week, group it by theme, and give me a comparison table.",
    ),
  ).toBeInTheDocument();

  // The way out of the handover is still the template list.
  click(buttonNamed("Browse templates", handover));
  await waitFor(() => {
    expect(pathname()).toBe("/workflows");
  });
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
    name: "That is today done",
  });
  // The reward, what it buys, and where the checklist now stands.
  expect(within(dialog).getByText("+100 credits")).toBeInTheDocument();
  expect(
    within(dialog).getByText(
      "Credits pay for the work itself: every run, every artifact, every workflow that runs on a schedule.",
    ),
  ).toBeInTheDocument();
});
