import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  userNotificationsContract,
  type UserNotification,
} from "@okouai/api-contracts/contracts/user-notifications";
import {
  workflowAutomationsContract,
  workflowsDetailContract,
  type WorkflowAutomationSummary,
  type WorkflowDetailResponse,
} from "@okouai/api-contracts/contracts/workflows";
import {
  click,
  queryAllByRoleFast,
  setupPage,
  type SetupPageAuth,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";

const context = testContext();
const WORKSPACE_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const OTHER_WORKSPACE_ID = "org_other_notification_workspace";
const WORKFLOW_ID = "d0000000-0000-4000-a000-000000000201";
const AUTOMATION_ID = "e0000000-0000-4000-a000-000000000201";
const OTHER_AUTOMATION_ID = "e0000000-0000-4000-a000-000000000202";
const HOME = "/agents/c0000000-0000-4000-a000-000000000001/chat";
const DISABLED_AT = "2026-11-05T03:00:00.000Z";
const CREATED_AT = "2026-11-06T03:00:00.000Z";
const READ_AT = "2026-11-06T04:00:00.000Z";
const TITLE = "Scheduled automation automatically disabled";

function auth(workspaceId = WORKSPACE_ID): SetupPageAuth {
  return {
    user: { id: "test-user-123", fullName: "Notification tester" },
    organization: {
      activeOrg: { id: workspaceId, name: "Research workspace" },
      memberships: [
        {
          id: "membership_research",
          organization: { id: WORKSPACE_ID, name: "Research workspace" },
        },
        {
          id: "membership_design",
          organization: { id: OTHER_WORKSPACE_ID, name: "Design workspace" },
        },
      ],
    },
  };
}

function notification({
  recoveryScheduled = false,
  workspaceId = WORKSPACE_ID,
}: {
  readonly recoveryScheduled?: boolean;
  readonly workspaceId?: string;
} = {}): UserNotification {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: TITLE,
    summary: "Daily work summary stopped after consecutive execution failures.",
    createdAt: CREATED_AT,
    readAt: null,
    payload: {
      type: "rich_text",
      markdown: "Daily work summary was automatically disabled.",
      automationDisabled: {
        automationId: AUTOMATION_ID,
        workflowId: WORKFLOW_ID,
        workspaceId,
        automationName: "Daily work summary",
        disabledAt: DISABLED_AT,
        consecutiveFailures: 3,
        recoveryScheduled,
      },
    },
  };
}

function automation(
  id = AUTOMATION_ID,
  enabled = false,
): WorkflowAutomationSummary {
  return {
    id,
    kind: "schedule",
    schedule: {
      type: "loop",
      intervalSeconds: id === AUTOMATION_ID ? 3600 : 7200,
    },
    scheduleSummary: "Hourly summary",
    ownerUserId: "test-user-123",
    enabled,
    chatThreadId: null,
    nextRunAt: enabled ? "2026-11-10T06:00:00.000Z" : null,
    lastRunAt: DISABLED_AT,
    official: null,
  };
}

function workflow(): WorkflowDetailResponse {
  return {
    id: WORKFLOW_ID,
    agentId: "c0000000-0000-4000-a000-000000000001",
    agentName: "research-bot",
    agentDisplayName: "Research Bot",
    name: "daily-summary",
    displayName: "Daily summary workflow",
    description: "Prepare a summary",
    visibility: "private",
    ownerUserId: "test-user-123",
    canManage: true,
    canPublish: false,
    official: null,
    importSource: null,
    createdByUserId: "test-user-123",
    updatedByUserId: "test-user-123",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    instruction: "Prepare the summary.",
    files: [],
    fileContents: [],
    automations: [automation(), automation(OTHER_AUTOMATION_ID, true)],
  };
}

function summary(item: UserNotification) {
  const { payload, ...entry } = item;
  return { ...entry, type: payload.type };
}

function mockInbox(item = notification(), detailUnavailable?: () => boolean) {
  let readAt: string | null = null;
  context.mocks.api(userNotificationsContract.list, ({ respond }) => {
    return respond(200, {
      items: [{ ...summary(item), readAt }],
      nextCursor: null,
    });
  });
  context.mocks.api(userNotificationsContract.get, ({ respond }) => {
    if (detailUnavailable?.()) {
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "Unavailable" },
      });
    }
    return respond(200, { ...item, readAt });
  });
  context.mocks.api(userNotificationsContract.summary, ({ respond }) => {
    return respond(200, { unreadCount: readAt ? 0 : 1 });
  });
  context.mocks.api(userNotificationsContract.markRead, ({ respond }) => {
    readAt = READ_AT;
    return respond(200, { readAt });
  });
}

function mockAutomationDestination(detail = workflow()) {
  context.mocks.api(workflowAutomationsContract.get, ({ respond }) => {
    return respond(200, detail.automations[0]!);
  });
  context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
    return respond(200, detail);
  });
  context.mocks.api(workflowsDetailContract.ownerProfile, ({ respond }) => {
    return respond(200, { displayName: "Notification tester", imageUrl: null });
  });
}

function control(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const result = queryAllByRoleFast(role, container).find((item) => {
    return (
      item.getAttribute("aria-label") === name ||
      item.textContent?.trim() === name
    );
  });
  if (!result) {
    throw new Error(`Missing ${role}: ${name}`);
  }
  return result;
}

async function openDetails(item = notification()) {
  mockInbox(item);
  context.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });
  await setupPage({
    context,
    path: HOME,
    auth: auth(),
    featureSwitches: {
      [FeatureSwitchKey.UserNotifications]: true,
      // Disabling new writes must not hide a persisted historical message.
      [FeatureSwitchKey.AutomationDisableNotifications]: false,
    },
  });
  await waitFor(() => {
    expect(control("button", "Notifications")).toBeInTheDocument();
  });
  click(control("button", "Notifications"));
  const title = await screen.findByText(TITLE);
  const row = title.closest("button");
  if (!row) {
    throw new Error("Notification row was not rendered");
  }
  expect(within(row).getByText("Unread")).toBeInTheDocument();
  click(row);
  const dialog = await screen.findByRole("dialog", { name: TITLE });
  await within(dialog).findByText("System notification");
  return dialog;
}

function destination(workspaceId = WORKSPACE_ID) {
  return `/workflows/${WORKFLOW_ID}/automations?automationId=${AUTOMATION_ID}&workspaceId=${workspaceId}`;
}

test("A visible home bell discovers a later personal notification while the new writer switch is off", async () => {
  let delivered = false;
  const item = notification({ workspaceId: OTHER_WORKSPACE_ID });
  context.mocks.browser.visibilityState("visible");
  context.mocks.api(userNotificationsContract.summary, ({ respond }) => {
    return respond(200, { unreadCount: delivered ? 1 : 0 });
  });
  context.mocks.api(userNotificationsContract.list, ({ respond }) => {
    return respond(200, {
      items: delivered ? [summary(item)] : [],
      nextCursor: null,
    });
  });
  await setupPage({
    context,
    path: HOME,
    auth: auth(),
    featureSwitches: {
      [FeatureSwitchKey.UserNotifications]: true,
      [FeatureSwitchKey.AutomationDisableNotifications]: false,
    },
  });
  await screen.findByText("0 unread notifications");
  delivered = true;
  // No focus/visibility event or inbox action: the owned foreground loop
  // discovers this new personal inbox message in another workspace.
  await screen.findByText("1 unread notification");
  click(control("button", "Notifications"));
  const title = await screen.findByText(TITLE);
  expect(
    within(title.closest("button")!).getByText("Unread"),
  ).toBeInTheDocument();
});

test("A failed detail load leaves its notification unread until content is successfully mounted", async () => {
  let fail = true;
  mockInbox(notification(), () => {
    return fail;
  });
  await setupPage({
    context,
    path: HOME,
    auth: auth(),
    featureSwitches: { [FeatureSwitchKey.UserNotifications]: true },
  });
  await screen.findByText("1 unread notification");
  click(control("button", "Notifications"));
  const title = await screen.findByText(TITLE);
  click(title.closest("button")!);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Couldn’t load this notification");
  expect(screen.getByText("1 unread notification")).toBeInTheDocument();
  fail = false;
  click(control("button", "Try again", dialog));
  await within(dialog).findByText("System notification");
  await screen.findByText("0 unread notifications");
});

test("A historical disablement uses system attribution, membership name, actual event time and a mounted read receipt", async () => {
  const dialog = await openDetails();
  expect(within(dialog).getByText("Daily work summary")).toBeInTheDocument();
  expect(within(dialog).getByText("Research workspace")).toBeInTheDocument();
  expect(
    within(dialog).getByText(
      "Automatically disabled after 3 consecutive execution failures.",
    ),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByText(
      "It stopped running on its previous schedule. Review the failure information before explicitly re-enabling it.",
    ),
  ).toBeInTheDocument();
  const timestamp = dialog.querySelector("time");
  expect(timestamp).toHaveAttribute("datetime", DISABLED_AT);
  expect(timestamp).toHaveTextContent("2026");
  expect(timestamp).toHaveTextContent("11:00 AM");
  expect(control("link", "View automation", dialog)).toHaveAttribute(
    "href",
    destination(),
  );
  await screen.findByText("0 unread notifications");
});

test("A recovery pause stays readable without a workspace name and never displays a structural workspace ID", async () => {
  const dialog = await openDetails(
    notification({
      recoveryScheduled: true,
      workspaceId: "org_no_longer_accessible",
    }),
  );
  expect(within(dialog).getByText("Original workspace")).toBeInTheDocument();
  expect(
    within(dialog).getByText(
      "It was paused and the system scheduled a recovery attempt. Check its current status before making changes.",
    ),
  ).toBeInTheDocument();
  expect(dialog).not.toHaveTextContent("org_no_longer_accessible");
  await screen.findByText("0 unread notifications");
});

test("View automation rechecks access and focuses the exact current automation without enabling it or its sibling", async () => {
  mockAutomationDestination();
  const dialog = await openDetails();
  click(control("link", "View automation", dialog));
  const selected = await screen.findByRole("group", { name: "Every 1 hour" });
  await waitFor(() => {
    expect(selected).toHaveFocus();
  });
  expect(selected).toHaveAttribute("aria-current", "true");
  expect(within(selected).getByRole("switch")).not.toBeChecked();
  const other = screen.getByRole("group", { name: "Every 2 hours" });
  expect(within(other).getByRole("switch")).toBeChecked();
  expect(pathname()).toBe(`/workflows/${WORKFLOW_ID}/automations`);
  expect(search()).toBe(
    `?automationId=${AUTOMATION_ID}&workspaceId=${WORKSPACE_ID}`,
  );
});

for (const status of [403, 404] as const) {
  test(`An automation API ${status} produces safe no-access feedback rather than a recovery action`, async () => {
    context.mocks.api(workflowAutomationsContract.get, ({ respond }) => {
      return respond(status, {
        error: {
          code: status === 403 ? "FORBIDDEN" : "NOT_FOUND",
          message: "Unavailable",
        },
      });
    });
    await setupPage({ context, path: destination(), auth: auth() });
    await expect(
      screen.findByText("Automation not found or you do not have access"),
    ).resolves.toBeInTheDocument();
    expect(control("link", "Back to workflows")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(WORKFLOW_ID);
    expect(document.body).not.toHaveTextContent(AUTOMATION_ID);
  });
}

test("A cross-workspace notification uses the normal explicit workspace switch and preserves the exact destination", async () => {
  mockAutomationDestination();
  const clerk = context.mocks.clerk();
  mockedClerk.setActive.mockImplementation(() => {
    clerk.organization({
      activeOrg: { id: OTHER_WORKSPACE_ID, name: "Design workspace" },
    });
    clerk.stateChanged();
    return Promise.resolve();
  });
  await setupPage({
    context,
    path: destination(OTHER_WORKSPACE_ID),
    auth: auth(),
  });
  await screen.findByText(
    "This automation is in Design workspace. Switch workspace to view it.",
  );
  click(control("button", "Switch workspace", screen.getByRole("main")));
  const selected = await screen.findByRole("group", { name: "Every 1 hour" });
  expect(within(selected).getByRole("switch")).not.toBeChecked();
  expect(location.pathname + location.search).toBe(
    destination(OTHER_WORKSPACE_ID),
  );
  await waitFor(() => {
    expect(selected).toHaveFocus();
  });
});

test("A removed workspace membership does not grant access from a notification's structural IDs", async () => {
  await setupPage({
    context,
    path: destination("org_removed_membership"),
    auth: auth(),
  });
  await expect(
    screen.findByText("Automation not found or you do not have access"),
  ).resolves.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("org_removed_membership");
});

test("A recovered Official Workflow automation opens read-only with its current enabled state", async () => {
  const detail = workflow();
  const recovered: WorkflowDetailResponse = {
    ...detail,
    canManage: false,
    official: {
      definitionName: "daily-summary",
      installationState: "installed",
      definitionLifecycle: "active",
      readOnly: true,
    },
    automations: [{ ...automation(), enabled: true }],
  };
  mockAutomationDestination(recovered);
  await setupPage({ context, path: destination(), auth: auth() });
  await screen.findByText(
    "This automation is managed by the system. Its current status is shown below.",
  );
  const selected = screen.getByRole("group", { name: "Every 1 hour" });
  expect(within(selected).getByRole("switch")).toBeChecked();
  expect(within(selected).getByRole("switch")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(pathname()).toBe(`/workflows/${WORKFLOW_ID}/automations`);
});
