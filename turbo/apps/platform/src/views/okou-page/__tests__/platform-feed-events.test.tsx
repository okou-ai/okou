import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  feedContract,
  type PlatformEvent,
} from "@okouai/api-contracts/contracts/feed";
import {
  workflowAutomationsContract,
  workflowsDetailContract,
  type WorkflowDetailResponse,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { screen, within, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
function pausedEvent(): PlatformEvent {
  const time = "2026-11-05T03:00:00Z";
  return {
    id: crypto.randomUUID(),
    type: "event",
    sourceType: "platform-event",
    createdAt: time,
    updatedAt: time,
    expiresAt: null,
    priority: 10,
    state: { status: "active" },
    content: {
      eventType: "automation-disabled",
      automationId: crypto.randomUUID(),
      workflowId: crypto.randomUUID(),
      workspaceId: "org_default",
      automationName: "Daily work summary",
      disabledAt: time,
      consecutiveFailures: 3,
      recoveryScheduled: true,
    },
  };
}

function pathTo({ content }: PlatformEvent) {
  return (
    "/workflows/" +
    content.workflowId +
    "/automations?automationId=" +
    content.automationId +
    "&workspaceId=" +
    content.workspaceId
  );
}

function showEvent(item: PlatformEvent) {
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: [item] });
  });
  return setupPage({
    context,
    path: "/for-you",
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
  });
}

function workflow(item: PlatformEvent, official = false) {
  const automation: WorkflowAutomationSummary = {
    id: item.content.automationId,
    ownerUserId: "user_default",
    chatThreadId: null,
    kind: "schedule",
    enabled: official,
    official: null,
    nextRunAt: null,
    lastRunAt: null,
    schedule: { type: "loop", intervalSeconds: 3600 },
    scheduleSummary: "Every hour",
  };
  const detail: WorkflowDetailResponse = {
    id: item.content.workflowId,
    name: "warehouse-report",
    displayName: "Warehouse report",

    description: "Review shipments",
    visibility: "private",
    ownerUserId: "user_default",
    createdAt: item.createdAt,
    createdByUserId: "user_default",
    updatedByUserId: "user_default",
    updatedAt: item.updatedAt,
    instruction: "Review shipments every hour",
    files: null,
    fileContents: null,
    automations: [automation],
    canManage: !official,
    canPublish: false,
    importSource: null,
    official: official
      ? {
          definitionName: "warehouse-report",
          definitionLifecycle: "active",
          installationState: "installed",
          readOnly: true,
        }
      : null,
  };
  context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
    return respond(200, detail);
  });
  return automation;
}

test("platform-feed-events-008 an inaccessible automation offers the workflows return link", async () => {
  const item = pausedEvent();
  context.mocks.api(workflowAutomationsContract.get, ({ respond }) => {
    return respond(404, { error: { code: "NOT_FOUND", message: "Missing" } });
  });
  await setupPage({ context, path: pathTo(item) });
  await screen.findByText("Automation not found or you do not have access");
  await expect(
    findFastControl("link", "Back to workflows"),
  ).resolves.toHaveAttribute("href", "/workflows");
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect(queryAllByRoleFast("tab")).toHaveLength(0);
  expect(document.body).not.toHaveTextContent(item.content.workflowId);
  expect(document.body).not.toHaveTextContent(item.content.automationId);
  expect(queryFastControl("button", "Try again")).toBeNull();
  expect(queryFastControl("button", "Enable")).toBeNull();
});

test("platform-feed-events-010 an unrecognized workspace is redacted in the destination", async () => {
  const item = pausedEvent();
  item.content.workspaceId = "org_removed_warehouse";
  await setupPage({
    context,
    path: pathTo(item),
    auth: {
      user: { id: "user_default", fullName: "Warehouse member" },
      organization: {
        activeOrg: { id: "org_default", name: "Warehouse" },
        memberships: [
          {
            id: "present-membership",
            organization: { id: "org_default", name: "Warehouse" },
          },
        ],
      },
    },
  });
  await screen.findByText("Automation not found or you do not have access");
  expect(document.body).not.toHaveTextContent(item.content.workspaceId);
});

test("platform-feed-events-012 retrying a failed event dismissal clears the card", async () => {
  const item = pausedEvent();
  let available = false;
  context.mocks.api(feedContract.dismiss, ({ params, respond }) => {
    return available && params.id === item.id
      ? respond(204)
      : respond(503, { error: { code: "UNAVAILABLE", message: "Try later" } });
  });
  await showEvent(item);
  const card = await screen.findByRole("article", {
    name: "Automation paused",
  });
  click(await findFastControl("button", "Dismiss", card));
  await within(card).findByRole("alert");
  expect(
    within(card).getByRole("heading", { name: "Automation paused" }),
  ).toBeVisible();
  expect(card).toHaveTextContent(item.content.automationName);
  available = true;
  click(await findFastControl("button", "Dismiss", card));
  await screen.findByText("All caught up");
  expect(
    screen.queryByRole("article", { name: "Automation paused" }),
  ).toBeNull();
});

test("platform-feed-events-013 the localized pause timestamp and destination describe the same automation", async () => {
  const item = pausedEvent();
  context.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });
  await showEvent(item);
  const card = await screen.findByRole("article", {
    name: "Automation paused",
  });
  const time = await within(card).findByText(/Nov 5, 2026.*11:00 AM/);
  expect(time).toHaveAttribute("datetime", item.content.disabledAt);
  const link = await findFastControl("link", "View automation", card);
  expect(link).toHaveTextContent("Daily work summary");
  expect(link).toHaveAttribute("href", pathTo(item));
  expect(card).not.toHaveTextContent(item.content.workspaceId);
});

test("platform-feed-events-011 the system-managed automation is enabled and read-only", async () => {
  const item = pausedEvent(),
    schedule = workflow(item, true);
  context.mocks.api(workflowAutomationsContract.get, ({ respond }) => {
    return respond(200, schedule);
  });
  await setupPage({ context, path: pathTo(item) });
  await screen.findByText(/This automation is managed by the system/);
  const toggle = await screen.findByRole("switch");
  expect(toggle).toBeChecked();
  expect(toggle).toHaveAttribute("aria-disabled", "true");
  click(toggle);
  expect(toggle).toBeChecked();
  expect(location.pathname).toBe(
    "/workflows/" + item.content.workflowId + "/automations",
  );
});

test("platform-feed-events-006 ordinary workflow tabs preserve the hourly automation after recovery", async () => {
  const item = pausedEvent(),
    schedule = workflow(item);
  context.mocks.api(workflowAutomationsContract.get, ({ respond }) => {
    return respond(200, schedule);
  });
  await setupPage({ context, path: pathTo(item) });
  const settings = await findFastControl("tab", "Settings");
  click(settings);
  await waitFor(() => {
    return expect(location.pathname).toBe(
      "/workflows/" + item.content.workflowId + "/info",
    );
  });
  expect(location.search).toBe("");
  expect(settings).toHaveAttribute("aria-selected", "true");
  const name = await screen.findByDisplayValue("Warehouse report");
  expect(name).toHaveAttribute("name", "displayName");
  click(await findFastControl("tab", "Automations"));
  const toggle = await screen.findByRole("switch");
  expect(toggle).not.toBeChecked();
  await screen.findByText(/Every (1 )?hour/i);
  expect(location.pathname).toBe(
    "/workflows/" + item.content.workflowId + "/automations",
  );
  expect(location.search).toBe("");
});

test("platform-feed-events-003 a pending retry resolves to the original disabled hourly automation", async () => {
  const item = pausedEvent(),
    schedule = workflow(item);
  let recovering = false;
  const resume = context.mocks.deferred<void>();
  context.mocks.api(
    workflowAutomationsContract.get,
    async ({ params, respond }) => {
      if (params.id !== schedule.id) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Missing" },
        });
      }
      if (!recovering) {
        return respond(503, {
          error: { code: "UNAVAILABLE", message: "Unavailable" },
        });
      }
      await resume.promise;
      return respond(200, schedule);
    },
  );
  await setupPage({ context, path: pathTo(item) });
  await screen.findByText("Couldn’t load this automation");
  await expect(
    findFastControl("link", "Back to workflows"),
  ).resolves.toHaveAttribute("href", "/workflows");
  recovering = true;
  click(await findFastControl("button", "Try again"));
  try {
    await screen.findByRole("status", { name: "Loading automation" });
  } finally {
    resume.resolve();
  }
  await screen.findByText(/Every (1 )?hour/i);
  await expect(screen.findByRole("switch")).resolves.not.toBeChecked();
  expect(location.pathname).toBe(
    "/workflows/" + item.content.workflowId + "/automations",
  );
});
