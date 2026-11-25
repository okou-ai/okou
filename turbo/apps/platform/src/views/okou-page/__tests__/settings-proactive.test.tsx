import {
  workflowAutomationsContract,
  type WorkflowAutomationsListEntry,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { debugMorningBriefContract } from "@okouai/api-contracts/contracts/debug-morning-brief";
import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";

const context = testContext();

function entry(official: boolean): WorkflowAutomationsListEntry {
  const ownerUserId = "harbor-reader";
  const id = crypto.randomUUID();
  return {
    workflow: {
      id: crypto.randomUUID(),
      name: "proactive-learning",
      displayName: "Learning",
      description: "Learning schedule",
      ownerUserId,
      canManage: true,
      canPublish: false,
      visibility: "private",
      createdAt: "2026-09-10T12:00:00.000Z",
      official: official
        ? {
            definitionName: "proactive-learning",
            installationState: "installed",
            definitionLifecycle: "active",
            readOnly: true,
          }
        : null,
      importSource: null,
    },
    automation: {
      id,
      ownerUserId,
      enabled: false,
      kind: "schedule",
      schedule: { type: "cron", cronExpression: "0 2 * * *", timezone: "UTC" },
      scheduleSummary: "Nightly",
      chatThreadId: crypto.randomUUID(),
      nextRunAt: null,
      lastRunAt: null,
      official: official
        ? {
            blueprintKey: "nightly-learning",
            appliedFingerprint: "e".repeat(64),
            reconciliationStatus: "current",
            intendedEnabled: false,
            parameterBindings: [],
          }
        : null,
    },
  };
}
async function visit(entries: WorkflowAutomationsListEntry[]) {
  context.mocks.api(
    workflowAutomationsContract.listWorkspace,
    ({ respond }) => {
      return respond(200, entries);
    },
  );
  await setupPage({
    context,
    path: "/?settings=debug",
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.AgentSuggestion]: true,
      [FeatureSwitchKey.OkouDebug]: true,
    },
  });
  return await findFastControl("button", "Run learning");
}
test("debug-learning-002 a custom workflow named Learning cannot start the official learning job", async () => {
  const run = await visit([entry(false)]);
  await screen.findByText(
    "Enable Learning in Preferences before running it here.",
  );
  expect(run).toBeDisabled();
});
test("debug-learning-004 closing Debug aborts the pending Learning run", async () => {
  const official = entry(true),
    started = context.mocks.deferred<void>(),
    aborted = context.mocks.deferred<void>();
  context.mocks.api(
    workflowAutomationsContract.run,
    async ({ request, params, respond }) => {
      expect(params.id).toBe(official.automation.id);
      request.signal.addEventListener(
        "abort",
        () => {
          aborted.resolve();
        },
        { once: true },
      );
      started.resolve();
      await aborted.promise;
      return respond(409, {
        error: { code: "CONFLICT", message: "Request closed" },
      });
    },
  );
  const run = await visit([official]);
  await waitFor(() => {
    expect(run).toBeEnabled();
  });
  click(run);
  await started.promise;
  await waitFor(() => {
    expect(run).toBeDisabled();
  });
  const dialog = await screen.findByRole("dialog");
  await userEvent.keyboard("{Escape}");
  await aborted.promise;
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
});

test("Debug queues the member's installed Learning schedule and opens its returned conversation", async () => {
  const installed = entry(true);
  const threadId = crypto.randomUUID();
  context.mocks.api(workflowAutomationsContract.run, ({ params, respond }) => {
    if (params.id !== installed.automation.id) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Unknown schedule" },
      });
    }
    return respond(201, { runId: null, chatThreadId: threadId });
  });
  const run = await visit([entry(false), installed]);
  await userEvent.click(run);
  await screen.findByText("Learning queued.");
  expect(run).toBeDisabled();
  const chat = await findFastControl("link", "Open chat");
  expect(chat).toHaveAttribute("href", "/chats/" + threadId);
  await userEvent.click(chat);
  await waitFor(() => {
    return expect(window.location.pathname).toBe("/chats/" + threadId);
  });
});

async function openDebug(role: "member" | "admin") {
  const org = { id: "org_test", name: "Debug workshop" };
  context.mocks.api(orgContract.get, ({ respond }) => {
    return respond(200, { ...org, role });
  });
  await setupPage({
    context,
    path: "/?settings=debug",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    auth: {
      user: { id: "user_harbor", fullName: "Harbor reader" },
      organization: {
        activeOrg: org,
        memberships: [{ id: org.id, role: "org:" + role }],
      },
    },
  });
}

function briefs(status: "failed" | "completed") {
  const ids = new Map<string, string>();
  context.mocks.api(debugMorningBriefContract.run, ({ body, respond }) => {
    const thread = crypto.randomUUID();
    ids.set(thread, body.requestId);
    return respond(200, {
      requestId: body.requestId,
      chatThreadId: thread,
      runId: null,
      status,
    });
  });
  return ids;
}
async function displayedRequest(ids: Map<string, string>) {
  const chat = await findFastControl("link", "Open chat");
  const thread = chat.getAttribute("href")?.split("/").at(-1);
  const request = ids.get(thread ?? "");
  expect(request).toBeDefined();
  return request;
}
test("debug-morning-brief-001 a member can run separate briefs without changing the daily schedule", async () => {
  const ids = briefs("completed");
  await openDebug("member");
  click(await findFastControl("button", "Run Morning Brief"));
  await screen.findByText("Morning Brief completed.");
  expect(
    screen.getByText(/Your daily schedule stays unchanged/),
  ).toBeInTheDocument();
  const first = await displayedRequest(ids);
  click(await findFastControl("button", "Run another Morning Brief"));
  await waitFor(async () => {
    await expect(displayedRequest(ids)).resolves.not.toBe(first);
  });
});
test("debug-morning-brief-003 a failed brief links its conversation and allows a new attempt", async () => {
  const ids = briefs("failed");
  await openDebug("member");
  click(await findFastControl("button", "Run Morning Brief"));
  await screen.findByText("Morning Brief failed. Open the chat for details.");
  await displayedRequest(ids);
  await expect(
    findFastControl("button", "Run another Morning Brief"),
  ).resolves.toBeEnabled();
});

test("Enter runs the focused Morning Brief action and exposes its completed chat", async () => {
  const issued = briefs("completed");
  await openDebug("admin");
  const run = await findFastControl("button", "Run Morning Brief");
  run.focus();
  expect(run).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await screen.findByText("Morning Brief completed.");
  await expect(displayedRequest(issued)).resolves.toBeTruthy();
});

test("debug-morning-brief-005 The keyboard-triggered brief stays busy until the requested conversation is ready", async () => {
  const issued = context.mocks.deferred<void>(),
    finished = context.mocks.deferred<void>();
  const id = crypto.randomUUID();
  context.mocks.api(
    debugMorningBriefContract.run,
    async ({ body, respond }) => {
      issued.resolve();
      await finished.promise;
      return respond(200, {
        requestId: body.requestId,
        chatThreadId: id,
        runId: null,
        status: "completed",
      });
    },
  );
  await openDebug("admin");
  const run = await findFastControl("button", "Run Morning Brief");
  run.focus();
  await userEvent.keyboard("{Enter}");
  await issued.promise;
  expect(
    screen.queryByText("Morning Brief completed."),
  ).not.toBeInTheDocument();
  finished.resolve();
  await screen.findByText("Morning Brief completed.");
  await expect(findFastControl("link", "Open chat")).resolves.toHaveAttribute(
    "href",
    "/chats/" + id,
  );
});

async function settings(rollout: boolean, enabled = false) {
  let active = enabled;
  context.mocks.api(feedContract.sources, ({ respond }) => {
    return respond(200, {
      suggestions: active,
      whatsNew: true,
      offers: true,
      systemUpdates: true,
    });
  });
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, {
      enabled: active,
      status: active ? "preparing" : "paused",
      unavailableReason: null,
    });
  });
  context.mocks.api(
    proactiveSuggestionsContract.updateWithFeed,
    ({ body, respond }) => {
      active = body.enabled;
      return respond(200, {
        enabled: active,
        status: active ? "enabled" : "paused",
        unavailableReason: null,
      });
    },
  );
  await setupPage({
    context,
    host: "app.okou.ai",
    path: rollout ? "/?settings=my-okou" : "/?settings=preference",
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: rollout },
  });
  return await screen.findByRole("region", { name: "Proactive" });
}

test("proactive-learning-settings-001 My Okou offers Morning brief before Suggestions and keeps them independent", async () => {
  const region = await settings(true);
  expect(screen.getByRole("heading", { name: "My Okou" })).toBeInTheDocument();
  const morning = await within(region).findByRole("switch", {
    name: "Morning brief",
  });
  const suggestions = await within(region).findByRole("switch", {
    name: "Suggestions",
  });
  expect(
    morning.compareDocumentPosition(suggestions) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(morning).not.toBeChecked();
  expect(suggestions).not.toBeChecked();
  click(suggestions);
  await waitFor(() => {
    expect(suggestions).toBeChecked();
    expect(suggestions).toBeEnabled();
  });
  expect(morning).not.toBeChecked();
});

test("proactive-learning-settings-002 Morning brief stays available outside the Suggestions rollout", async () => {
  const region = await settings(false);
  const morning = await within(region).findByRole("switch", {
    name: "Morning brief",
  });
  await waitFor(() => {
    expect(morning).toBeEnabled();
  });
  expect(within(region).getAllByRole("switch")).toStrictEqual([morning]);
});

test("proactive-suggestions-settings-001 the member can opt in and save an explicit opt-out independently", async () => {
  const region = await settings(true);
  const toggle = await within(region).findByRole("switch", {
    name: "Suggestions",
  });
  const brief = await within(region).findByRole("switch", {
    name: "Morning brief",
  });
  await waitFor(() => {
    expect(toggle).toBeEnabled();
  });
  expect(toggle).not.toBeChecked();
  click(toggle);
  await waitFor(() => {
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
  });
  expect(brief).not.toBeChecked();
  click(toggle);
  await waitFor(() => {
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
  });
  expect(brief).not.toBeChecked();
});
