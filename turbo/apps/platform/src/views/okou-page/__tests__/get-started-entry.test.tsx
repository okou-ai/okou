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
): void {
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
  expect(normalizedText(entry)).toBe("Get started2/6");

  const panel = await openQuestPanel();
  expect(
    within(panel).getByText("Credits go to your personal balance."),
  ).toBeInTheDocument();
  const workflow = within(screen.getByTestId("get-started-quest-workflow"));
  expect(workflow.getByText("Build a workflow")).toBeInTheDocument();
  expect(
    workflow.getByText("Turn a repeat task into an automation"),
  ).toBeInTheDocument();
  expect(workflow.getByText("+1,000")).toBeInTheDocument();

  // A reward that keeps paying names its unit next to the amount.
  const invite = within(screen.getByTestId("get-started-quest-invite"));
  expect(invite.getByText("Invite your team")).toBeInTheDocument();
  expect(invite.getByText("per member")).toBeInTheDocument();

  // Connecting and installing Slack are already done, so they carry no reward.
  expect(within(panel).getByText("2,300")).toBeInTheDocument();
  expect(
    screen.queryByTestId("get-started-quest-connector"),
  ).not.toBeInTheDocument();
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
  expect(normalizedText(entry)).toBe("Get started1/4");

  const panel = await openQuestPanel();
  expect(screen.getByTestId("get-started-quest-workflow")).toBeInTheDocument();
  expect(screen.getByTestId("get-started-quest-share")).toBeInTheDocument();
  expect(within(panel).queryByText("Invite your team")).not.toBeInTheDocument();
  expect(
    within(panel).queryByText("Add Okou to Slack"),
  ).not.toBeInTheDocument();
  // The earned total counts only the quests this role was offered.
  expect(within(panel).getByText("300")).toBeInTheDocument();
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

test("Sharing on X spends the one submission", async () => {
  configureQuestPage(context, "admin");
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
  await user.keyboard("{Home}{ArrowDown}");
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

test("Cancelling a share draft clears the link without consuming the submission", async () => {
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
