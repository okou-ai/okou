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
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const NOW = "2026-11-05T04:00:00.000Z";
const WORKSPACE_ID = "org_default";
const HOURLY = "Every 1 hour";

function hourlyAutomation(
  overrides: Partial<WorkflowAutomationSummary> = {},
): WorkflowAutomationSummary {
  return {
    id: crypto.randomUUID(),
    ownerUserId: "test-user-123",
    enabled: false,
    chatThreadId: null,
    nextRunAt: null,
    lastRunAt: null,
    official: null,
    kind: "schedule",
    schedule: { type: "loop", intervalSeconds: 3600 },
    scheduleSummary: "Every 1 hour",
    ...overrides,
  } as WorkflowAutomationSummary;
}

function workflowDetail(
  automations: readonly WorkflowAutomationSummary[],
  overrides: Partial<WorkflowDetailResponse> = {},
): WorkflowDetailResponse {
  return {
    id: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    agentName: "default",
    agentDisplayName: "Default",
    name: "daily-work-summary",
    displayName: "Daily work summary",
    description: null,
    visibility: "private",
    ownerUserId: "test-user-123",
    createdAt: "2026-11-01T00:00:00.000Z",
    canManage: true,
    canPublish: false,
    official: null,
    importSource: null,
    createdByUserId: "test-user-123",
    updatedByUserId: "test-user-123",
    updatedAt: "2026-11-01T00:00:00.000Z",
    instruction: "Summarize the work completed today.",
    files: null,
    fileContents: null,
    automations: [...automations],
    ...overrides,
  };
}

/** The workflow API as seen by the event destination and the For you card. */
function mockWorkflow(detail: WorkflowDetailResponse) {
  const api = {
    automationReads: 0,
    enabled: [] as string[],
    disabled: [] as string[],
  };
  context.mocks.api(workflowsDetailContract.get, ({ params, respond }) => {
    return params.workflowId === detail.id
      ? respond(200, detail)
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Workflow not found" },
        });
  });
  context.mocks.api(workflowAutomationsContract.get, ({ params, respond }) => {
    api.automationReads += 1;
    const automation = detail.automations.find((candidate) => {
      return candidate.id === params.id;
    });
    return automation
      ? respond(200, automation)
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Automation not found" },
        });
  });
  context.mocks.api(
    workflowAutomationsContract.enable,
    ({ params, respond }) => {
      api.enabled.push(params.id);
      const automation = detail.automations.find((candidate) => {
        return candidate.id === params.id;
      });
      return automation
        ? respond(200, { ...automation, enabled: true })
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Automation not found" },
          });
    },
  );
  context.mocks.api(
    workflowAutomationsContract.disable,
    ({ params, respond }) => {
      api.disabled.push(params.id);
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Automation not found" },
      });
    },
  );
  return api;
}

function destination(
  workflowId: string,
  automationId: string,
  workspaceId = WORKSPACE_ID,
): string {
  const search = new URLSearchParams({ automationId, workspaceId });
  return `/workflows/${workflowId}/automations?${search}`;
}

function automationRow(title: string): HTMLElement {
  return screen.getByRole("group", { name: title });
}

function automationSwitch(title: string): HTMLElement {
  return within(automationRow(title)).getByRole("switch");
}

function getAction(
  role: "button" | "link" | "tab",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const action = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!action) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return action;
}

function pauseEvent(
  workflowId: string,
  automationId: string,
  overrides: Partial<PlatformEvent["content"]> = {},
): PlatformEvent {
  return {
    id: crypto.randomUUID(),
    type: "event",
    sourceType: "platform-event",
    priority: 0,
    createdAt: "2026-11-05T03:00:00.000Z",
    updatedAt: "2026-11-05T03:00:00.000Z",
    expiresAt: null,
    content: {
      eventType: "automation-disabled",
      automationId,
      workflowId,
      workspaceId: WORKSPACE_ID,
      automationName: "Daily work summary",
      disabledAt: "2026-11-05T03:00:00.000Z",
      consecutiveFailures: 3,
      recoveryScheduled: false,
      ...overrides,
    },
    state: { status: "active" },
  };
}

async function openForYou(): Promise<void> {
  await setupPage({
    context,
    path: "/for-you",
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
  });
}

test("A failed destination can retry through the loading status and reach the same automation", async () => {
  const hourly = hourlyAutomation();
  const detail = workflowDetail([hourly]);
  const api = mockWorkflow(detail);
  const retry = context.mocks.deferred<void>();
  let recovered = false;
  context.mocks.api(
    workflowAutomationsContract.get,
    async ({ params, respond }) => {
      if (!recovered) {
        return respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Unavailable" },
        });
      }
      await retry.promise;
      return params.id === hourly.id
        ? respond(200, hourly)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Automation not found" },
          });
    },
  );

  await setupPage({ context, path: destination(detail.id, hourly.id) });

  await expect(
    screen.findByText("Couldn’t load this automation"),
  ).resolves.toBeInTheDocument();
  expect(getAction("link", "Back to workflows")).toHaveAttribute(
    "href",
    "/workflows",
  );
  recovered = true;
  click(getAction("button", "Try again"));

  await expect(
    screen.findByRole("status", { name: "Loading automation" }),
  ).resolves.toBeInTheDocument();
  retry.resolve();

  await waitFor(() => {
    expect(automationRow(HOURLY)).toHaveAttribute("aria-current", "true");
  });
  expect(automationSwitch(HOURLY)).not.toBeChecked();
  expect(window.location.pathname).toBe(`/workflows/${detail.id}/automations`);
  expect(new URLSearchParams(window.location.search).get("automationId")).toBe(
    hourly.id,
  );
  expect(api.enabled).toStrictEqual([]);
});

test("A valid event destination hands Settings over to the normal workflow page", async () => {
  const hourly = hourlyAutomation();
  const detail = workflowDetail([hourly]);
  mockWorkflow(detail);
  await setupPage({ context, path: destination(detail.id, hourly.id) });
  await waitFor(() => {
    expect(automationRow(HOURLY)).toHaveAttribute("aria-current", "true");
  });

  click(getAction("tab", "Settings"));

  await waitFor(() => {
    expect(window.location.pathname).toBe(`/workflows/${detail.id}/info`);
  });
  expect(window.location.search).toBe("");
  expect(getAction("tab", "Settings")).toHaveAttribute("aria-selected", "true");
  await expect(
    screen.findByDisplayValue("daily-work-summary"),
  ).resolves.toBeInTheDocument();

  click(getAction("tab", "Automations"));

  await waitFor(() => {
    expect(window.location.pathname).toBe(
      `/workflows/${detail.id}/automations`,
    );
  });
  expect(window.location.search).toBe("");
  await expect(
    screen.findByRole("group", { name: HOURLY }),
  ).resolves.toBeInTheDocument();
  expect(automationSwitch(HOURLY)).not.toBeChecked();
});

test("An automation API 404 produces safe no-access feedback rather than a recovery action", async () => {
  const hourly = hourlyAutomation();
  const detail = workflowDetail([hourly]);
  mockWorkflow(detail);
  context.mocks.api(workflowAutomationsContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Automation not found" },
    });
  });

  await setupPage({ context, path: destination(detail.id, hourly.id) });

  await expect(
    screen.findByText("Automation not found or you do not have access"),
  ).resolves.toBeInTheDocument();
  expect(getAction("link", "Back to workflows")).toHaveAttribute(
    "href",
    "/workflows",
  );
  expect(queryAllByRoleFast("tab")).toStrictEqual([]);
  expect(document.body).not.toHaveTextContent(detail.id);
  expect(document.body).not.toHaveTextContent(hourly.id);
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.textContent?.trim() === "Try again";
    }),
  ).toBeFalsy();
});

test("A removed workspace membership does not grant access from a event's structural IDs", async () => {
  const hourly = hourlyAutomation();
  const detail = workflowDetail([hourly]);
  const api = mockWorkflow(detail);

  await setupPage({
    context,
    path: destination(detail.id, hourly.id, "org_removed"),
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: { id: WORKSPACE_ID, name: "Default Org" },
        memberships: [
          {
            id: WORKSPACE_ID,
            organization: { id: WORKSPACE_ID, name: "Default Org" },
          },
        ],
      },
    },
  });

  await expect(
    screen.findByText("Automation not found or you do not have access"),
  ).resolves.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("org_removed");
  expect(api.automationReads).toBe(0);
});

test("A recovered Official Workflow automation opens read-only with its current enabled state", async () => {
  const hourly = hourlyAutomation({ enabled: true });
  const detail = workflowDetail([hourly], {
    canManage: false,
    official: {
      definitionName: "daily-work-summary",
      installationState: "installed",
      definitionLifecycle: "active",
      readOnly: true,
    },
  });
  mockWorkflow(detail);

  await setupPage({ context, path: destination(detail.id, hourly.id) });

  await expect(
    screen.findByText(
      "This automation is managed by the system. Its current status is shown below.",
    ),
  ).resolves.toBeInTheDocument();
  const enabled = automationSwitch(HOURLY);
  expect(enabled).toBeChecked();
  expect(enabled).toHaveAttribute("aria-disabled", "true");
  expect(window.location.pathname).toBe(`/workflows/${detail.id}/automations`);
});

test("A failed dismissal stays visible and can be retried without changing its automation", async () => {
  mockNow(new Date(NOW), context.signal);
  const hourly = hourlyAutomation();
  const detail = workflowDetail([hourly]);
  const api = mockWorkflow(detail);
  const event = pauseEvent(detail.id, hourly.id);
  let items: PlatformEvent[] = [event];
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: [...items] });
  });
  let dismissals = 0;
  context.mocks.api(feedContract.dismiss, ({ params, respond }) => {
    dismissals += 1;
    if (dismissals === 1) {
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Unavailable" },
      });
    }
    items = items.filter((item) => {
      return item.id !== params.id;
    });
    return respond(204);
  });
  await openForYou();
  const card = await screen.findByRole("article", {
    name: "Automation paused",
  });

  click(getAction("button", "Dismiss", card));

  await expect(within(card).findByRole("alert")).resolves.toHaveTextContent(
    "We couldn’t complete that action. Try again.",
  );
  expect(
    within(card).getByRole("heading", { name: "Automation paused" }),
  ).toBeVisible();

  click(getAction("button", "Dismiss", card));

  await expect(screen.findByText("All caught up")).resolves.toBeInTheDocument();
  expect(dismissals).toBe(2);
  expect(api.enabled).toStrictEqual([]);
  expect(api.disabled).toStrictEqual([]);
});

test("A pause update explains the failure, shows the description, and links to the exact automation in a new tab", async () => {
  mockNow(new Date(NOW), context.signal);
  context.mocks.data.userPreferences({
    timezone: "Asia/Shanghai",
    locale: "en-US",
  });
  const hourly = hourlyAutomation();
  const detail = workflowDetail([hourly]);
  mockWorkflow(detail);
  const event = pauseEvent(detail.id, hourly.id, {
    automationDescription: "Summarizes yesterday's merged pull requests.",
  });
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: [event] });
  });

  await openForYou();

  const card = await screen.findByRole("article", {
    name: "Automation paused",
  });
  expect(within(card).getByText("System update")).toBeInTheDocument();
  expect(
    within(card).getByText(
      "We paused this automation after 3 consecutive run attempts didn’t complete successfully. This gives you time to review what happened before it runs again.",
    ),
  ).toBeInTheDocument();
  expect(
    within(card).getByText("Summarizes yesterday's merged pull requests."),
  ).toBeInTheDocument();
  const pausedAt = within(card).getByText(/^Paused on /u);
  expect(pausedAt).toHaveTextContent("11:00 AM");
  expect(pausedAt).toHaveAttribute("datetime", "2026-11-05T03:00:00.000Z");
  const link = getAction("link", "View automation", card);
  expect(link).toHaveTextContent("Daily work summary");
  expect(link).toHaveAttribute("href", destination(detail.id, hourly.id));
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(card).not.toHaveTextContent(WORKSPACE_ID);
});

test("Enable keeps the update available after rejection and clears it after enabling the linked automation", async () => {
  mockNow(new Date(NOW), context.signal);
  const hourly = hourlyAutomation();
  const sibling = hourlyAutomation({
    enabled: true,
    schedule: { type: "loop", intervalSeconds: 7200 },
    scheduleSummary: "Every 2 hours",
  });
  const detail = workflowDetail([hourly, sibling]);
  const api = mockWorkflow(detail);
  const event = pauseEvent(detail.id, hourly.id);
  let items: PlatformEvent[] = [event];
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: [...items] });
  });
  const dismissed: string[] = [];
  context.mocks.api(feedContract.dismiss, ({ params, respond }) => {
    dismissed.push(params.id);
    items = items.filter((item) => {
      return item.id !== params.id;
    });
    return respond(204);
  });
  const retry = context.mocks.deferred<void>();
  context.mocks.api(
    workflowAutomationsContract.enable,
    async ({ params, respond }) => {
      api.enabled.push(params.id);
      if (api.enabled.length === 1) {
        return respond(409, {
          error: { code: "CONFLICT", message: "Automation is busy" },
        });
      }
      await retry.promise;
      return respond(200, { ...hourly, enabled: true });
    },
  );
  await openForYou();
  const card = await screen.findByRole("article", {
    name: "Automation paused",
  });

  click(getAction("button", "Enable", card));

  await expect(within(card).findByRole("alert")).resolves.toHaveTextContent(
    "We couldn’t complete that action. Try again.",
  );
  expect(getAction("button", "Enable", card)).toBeEnabled();
  expect(dismissed).toStrictEqual([]);

  click(getAction("button", "Enable", card));

  await waitFor(() => {
    expect(getAction("button", "Dismiss", card)).toBeDisabled();
  });
  expect(getAction("button", "Enable", card)).toHaveAttribute(
    "aria-busy",
    "true",
  );
  retry.resolve();

  await expect(screen.findByText("All caught up")).resolves.toBeInTheDocument();
  expect(api.enabled).toStrictEqual([hourly.id, hourly.id]);
  expect(api.disabled).toStrictEqual([]);
  expect(dismissed).toStrictEqual([event.id]);
});
