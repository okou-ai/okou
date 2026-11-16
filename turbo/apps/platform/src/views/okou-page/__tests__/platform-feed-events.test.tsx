import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  feedContract,
  type PlatformEvent,
} from "@okouai/api-contracts/contracts/feed";
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
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();
const WORKSPACE_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const OTHER_WORKSPACE_ID = "org_other_event_workspace";
const WORKFLOW_ID = "d0000000-0000-4000-a000-000000000201";
const AUTOMATION_ID = "e0000000-0000-4000-a000-000000000201";
const OTHER_AUTOMATION_ID = "e0000000-0000-4000-a000-000000000202";
const DISABLED_AT = "2026-11-05T03:00:00.000Z";
const CREATED_AT = "2026-11-06T03:00:00.000Z";

function auth(workspaceId = WORKSPACE_ID): SetupPageAuth {
  return {
    user: { id: "test-user-123", fullName: "Feed tester" },
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

function platformEvent(): PlatformEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "event",
    sourceType: "platform-event",
    priority: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    expiresAt: null,
    state: { status: "active" },
    content: {
      eventType: "automation-disabled",
      automationId: AUTOMATION_ID,
      workflowId: WORKFLOW_ID,
      workspaceId: WORKSPACE_ID,
      automationName: "Daily work summary",
      disabledAt: DISABLED_AT,
      consecutiveFailures: 3,
      recoveryScheduled: false,
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

function mockAutomationDestination(detail = workflow()) {
  context.mocks.api(workflowAutomationsContract.get, ({ respond }) => {
    return respond(200, detail.automations[0]!);
  });
  context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
    return respond(200, detail);
  });
  context.mocks.api(workflowsDetailContract.ownerProfile, ({ respond }) => {
    return respond(200, { displayName: "Feed tester", imageUrl: null });
  });
}

function control(
  role: "button" | "link" | "tab",
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

async function openDetails(item = platformEvent()) {
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: [item] });
  });
  context.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });
  await setupPage({
    context,
    path: "/for-you",
    auth: auth(),
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
  });
  await screen.findByRole("heading", { name: "Automation disabled" });
  return screen.getByRole("main");
}

function destination(workspaceId = WORKSPACE_ID) {
  return `/workflows/${WORKFLOW_ID}/automations?automationId=${AUTOMATION_ID}&workspaceId=${workspaceId}`;
}

test("A fast event destination replaces its initially hidden loading status", async () => {
  mockAutomationDestination();
  const response = createDeferredPromise<void>(context.signal);
  context.mocks.api(workflowAutomationsContract.get, async ({ respond }) => {
    await response.promise;
    return respond(200, automation());
  });
  const dialog = await openDetails();
  click(control("link", "View automation", dialog));
  const loading = await screen.findByLabelText("Loading automation");
  expect(loading).not.toBeVisible();
  response.resolve();
  const selected = await screen.findByRole("group", { name: "Every 1 hour" });
  expect(selected).toHaveAttribute("aria-current", "true");
  expect(within(selected).getByRole("switch")).not.toBeChecked();
  expect(loading).not.toBeInTheDocument();
});

test("A pending event destination shows a lightweight status until access resolves", async () => {
  mockAutomationDestination();
  const response = createDeferredPromise<void>(context.signal);
  context.mocks.api(workflowAutomationsContract.get, async ({ respond }) => {
    await response.promise;
    return respond(200, automation());
  });
  const dialog = await openDetails();
  click(control("link", "View automation", dialog));
  const loading = await screen.findByLabelText("Loading automation");
  await waitFor(() => {
    expect(loading).toBeVisible();
  });
  expect(loading).toHaveAttribute("aria-busy", "true");
  response.resolve();
  const selected = await screen.findByRole("group", { name: "Every 1 hour" });
  expect(selected).toHaveAttribute("aria-current", "true");
  expect(within(selected).getByRole("switch")).not.toBeChecked();
});

test("A failed destination can retry through the loading status and reach the same automation", async () => {
  mockAutomationDestination();
  let failed = true;
  const response = createDeferredPromise<void>(context.signal);
  context.mocks.api(workflowAutomationsContract.get, async ({ respond }) => {
    if (failed) {
      return respond(500, {
        error: { code: "INTERNAL_ERROR", message: "Unavailable" },
      });
    }
    await response.promise;
    return respond(200, automation());
  });
  await setupPage({ context, path: destination(), auth: auth() });
  await screen.findByText("Couldn’t load this automation");
  expect(control("link", "Back to workflows")).toBeInTheDocument();
  failed = false;
  click(control("button", "Try again"));
  const loading = await screen.findByLabelText("Loading automation");
  await waitFor(() => {
    expect(loading).toBeVisible();
  });
  response.resolve();
  const selected = await screen.findByRole("group", { name: "Every 1 hour" });
  expect(within(selected).getByRole("switch")).not.toBeChecked();
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

test.each([
  { tab: "Instructions", route: "instructions" },
  { tab: "Settings", route: "info" },
])(
  "A valid event destination hands $tab over to the normal workflow page",
  async ({ tab, route }) => {
    mockAutomationDestination();
    await setupPage({ context, path: destination(), auth: auth() });
    const selected = await screen.findByRole("group", { name: "Every 1 hour" });
    expect(selected).toHaveAttribute("aria-current", "true");

    await userEvent.click(control("tab", tab));

    await expect(
      tab === "Instructions"
        ? screen.findByText("Prepare the summary.")
        : screen.findByDisplayValue("Daily summary workflow"),
    ).resolves.toBeInTheDocument();
    expect(pathname()).toBe(`/workflows/${WORKFLOW_ID}/${route}`);
    expect(search()).toBe("");
    expect(control("tab", tab)).toHaveAttribute("aria-selected", "true");
    expect(control("tab", tab)).toHaveFocus();

    click(control("tab", "Automations"));

    const automationRow = await screen.findByRole("group", {
      name: "Every 1 hour",
    });
    expect(within(automationRow).getByRole("switch")).not.toBeChecked();
    expect(pathname()).toBe(`/workflows/${WORKFLOW_ID}/automations`);
    expect(search()).toBe("");
  },
);

test.each([403, 404] as const)(
  "An automation API %i produces safe no-access feedback rather than a recovery action",
  async (status) => {
    mockAutomationDestination();
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
    expect(queryAllByRoleFast("tab")).toHaveLength(0);
    expect(document.body).not.toHaveTextContent(WORKFLOW_ID);
    expect(document.body).not.toHaveTextContent(AUTOMATION_ID);
  },
);

test("A cross-workspace event uses the normal explicit workspace switch and preserves the exact destination", async () => {
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

test("A removed workspace membership does not grant access from a event's structural IDs", async () => {
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

test("A failed dismissal stays visible and can be retried without changing its automation", async () => {
  let fail = true;
  context.mocks.api(feedContract.dismiss, ({ respond }) => {
    return fail
      ? respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Unable to dismiss" },
        })
      : respond(204);
  });
  await openDetails();
  expect(screen.getByText("Platform event")).toBeInTheDocument();
  click(control("button", "Dismiss"));
  await screen.findByRole("alert");
  expect(
    screen.getByRole("heading", { name: "Automation disabled" }),
  ).toBeInTheDocument();
  fail = false;
  click(control("button", "Dismiss"));
  await screen.findByText("All caught up");
});

test("An event preserves its actual disable time in the member's timezone and exact automation link", async () => {
  const card = await openDetails();
  expect(within(card).getByText("Daily work summary")).toBeInTheDocument();
  expect(within(card).getByText("Platform event")).toBeInTheDocument();
  const timestamp = within(card).getByText(/^Disabled at /u);
  expect(timestamp).toHaveAttribute("datetime", DISABLED_AT);
  expect(timestamp).toHaveTextContent("2026");
  expect(timestamp).toHaveTextContent("11:00 AM");
  expect(control("link", "View automation", card)).toHaveAttribute(
    "href",
    destination(),
  );
  expect(card).not.toHaveTextContent(WORKSPACE_ID);
});
