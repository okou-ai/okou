import { selectDesktopHeaderAction } from "./chat-header-test-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
  type ChatThreadWorkflowAutomation,
} from "@okouai/api-contracts/contracts/workflows";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  CAPABILITY_AGENT_ID,
  findButton,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
  createChatCapabilityHelpers,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

const ACTIVE_SCHEDULE_ID = "a0000000-0000-4000-a000-000000000861";
const WEBHOOK_ID = "a0000000-0000-4000-a000-000000000862";
const DISABLED_SCHEDULE_ID = "a0000000-0000-4000-a000-000000000863";
const OFFICIAL_SCHEDULE_ID = "a0000000-0000-4000-a000-000000000864";

function workflow(
  id: string,
  name: string,
  displayName: string,
): ChatThreadWorkflowAutomation["workflow"] {
  return {
    id,
    agentId: CAPABILITY_AGENT_ID,
    name,
    displayName,
    description: null,
  };
}

function automationPanel(title: string): HTMLElement {
  const titleElement = screen.getByText(title);
  const panel = titleElement.parentElement?.parentElement;
  if (!(panel instanceof HTMLElement)) {
    throw new Error(`Automation panel ${title} was not available`);
  }
  return panel;
}

function automationControl(
  panel: HTMLElement,
  role: "button" | "link",
  name: string,
): HTMLElement {
  const control = queryAllByRoleFast(role, panel).find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === name;
  });
  if (!control) {
    throw new Error(`${name} ${role} was not available`);
  }
  return control;
}

async function openAutomationBrowser(
  serverRecency = false,
): Promise<readonly ChatThreadWorkflowAutomation[]> {
  const automations = [
    {
      id: ACTIVE_SCHEDULE_ID,
      ownerUserId: "test-user-123",
      enabled: true,
      chatThreadId: RUN_THREAD_ID,
      nextRunAt: "2026-08-02T10:00:00.000Z",
      lastRunAt: "2026-08-01T08:00:00.000Z",
      official: null,
      kind: "schedule",
      schedule: { type: "loop", intervalSeconds: 7200 },
      scheduleSummary: "Every two hours",
      workflow: workflow(
        "a0000000-0000-4000-a000-000000000871",
        "active-release-schedule",
        "Active release schedule",
      ),
    },
    {
      id: WEBHOOK_ID,
      ownerUserId: "test-user-123",
      enabled: true,
      chatThreadId: RUN_THREAD_ID,
      nextRunAt: null,
      lastRunAt: "2026-08-01T09:00:00.000Z",
      official: null,
      kind: "event",
      eventType: "webhook-received",
      eventConfig: {
        provider: "webhook",
        event: "received",
        auth: { mode: "hmac-sha256" },
      },
      schedule: null,
      scheduleSummary: null,
      secretLastFour: "2468",
      lastReceivedAt: "2026-08-01T09:00:00.000Z",
      workflow: workflow(
        "a0000000-0000-4000-a000-000000000872",
        "release-webhook",
        "Release webhook",
      ),
    },
    {
      id: DISABLED_SCHEDULE_ID,
      ownerUserId: "test-user-123",
      enabled: false,
      chatThreadId: RUN_THREAD_ID,
      nextRunAt: null,
      lastRunAt: null,
      official: null,
      kind: "schedule",
      schedule: { type: "loop", intervalSeconds: 86_400 },
      scheduleSummary: "Every day",
      workflow: workflow(
        "a0000000-0000-4000-a000-000000000873",
        "paused-digest-schedule",
        "Paused digest schedule",
      ),
    },
    {
      id: OFFICIAL_SCHEDULE_ID,
      ownerUserId: "test-user-123",
      enabled: true,
      chatThreadId: RUN_THREAD_ID,
      nextRunAt: "2026-08-02T10:00:00.000Z",
      lastRunAt: null,
      official: {
        blueprintKey: "daily",
        appliedFingerprint: "a".repeat(64),
        reconciliationStatus: "current",
        intendedEnabled: true,
        parameterBindings: [],
      },
      kind: "schedule",
      schedule: { type: "loop", intervalSeconds: 86_400 },
      scheduleSummary: "Every day",
      workflow: workflow(
        "a0000000-0000-4000-a000-000000000874",
        "morning-brief",
        "Official Morning Brief",
      ),
    },
  ] satisfies readonly ChatThreadWorkflowAutomation[];
  installCapabilityChat({
    events: [
      {
        id: "automation-browser-prompt",
        role: "user",
        content: "Review the workspace automations",
        runId: "d0000000-0000-4000-a000-000000000861",
        seqId: 1,
        createdAt: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "automation-browser-response",
        role: "assistant",
        content: "The automation workspace is ready.",
        runId: "d0000000-0000-4000-a000-000000000861",
        seqId: 2,
        createdAt: "2026-08-01T10:00:01.000Z",
      },
    ],
  });
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ params, respond }) => {
      return respond(
        200,
        params.threadId === RUN_THREAD_ID ? [...automations] : [],
      );
    },
  );

  await setupPage({
    context,
    path: RUN_PATH,
    ...(serverRecency
      ? {
          auth: {
            user: {
              id: "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
              fullName: "Bingjie Zang",
              email: "bingjie@okou.ai",
            },
          },
        }
      : {}),
    featureSwitches: { [FeatureSwitchKey.WorkflowRecency]: serverRecency },
  });

  await readyChat();
  await selectDesktopHeaderAction("Automations");
  const automationSidebar = await screen.findByRole("complementary", {
    name: "Automations",
  });
  expect(automationSidebar).toBeVisible();
  return automations;
}

test("Chat-header Run now completes while a slash query's legacy import is pending", async () => {
  const legacyId = "a0000000-0000-4000-a000-000000000872";
  const runWorkflowId = "a0000000-0000-4000-a000-000000000871";
  const legacy = JSON.stringify([legacyId]);
  const values = new Map([["okou_recent-workflows", legacy]]);
  vi.spyOn(localStorage, "getItem").mockImplementation((key) => {
    return values.get(key) ?? null;
  });
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    values.set(key, value);
  });
  vi.spyOn(localStorage, "removeItem").mockImplementation((key) => {
    values.delete(key);
  });
  const importRequested = context.mocks.deferred<void>();
  const imported = context.mocks.deferred<void>();
  const runRequested = context.mocks.deferred<void>();
  const runResponse = context.mocks.deferred<void>();
  let importFinished = false;
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [
      {
        id: legacyId,
        name: "zulu",
        displayName: null,
        description: null,
        lastUsedAt: importFinished ? "1970-01-01T00:00:00.000010Z" : null,
      },
      {
        id: runWorkflowId,
        name: "active-release-schedule",
        displayName: null,
        description: null,
        lastUsedAt: null,
      },
      {
        id: "a0000000-0000-4000-a000-000000000875",
        name: "alpha",
        displayName: null,
        description: null,
        lastUsedAt: null,
      },
    ]);
  });
  context.mocks.api(
    workflowsCollectionContract.migrateRecency,
    async ({ body, respond }) => {
      expect(body).toStrictEqual({ workflowIds: [legacyId] });
      importRequested.resolve();
      await imported.promise;
      importFinished = true;
      return respond(200, { migrated: true });
    },
  );
  context.mocks.api(
    workflowAutomationsContract.run,
    async ({ params, respond }) => {
      expect(params.id).toBe(ACTIVE_SCHEDULE_ID);
      runRequested.resolve();
      await runResponse.promise;
      return respond(201, {
        chatThreadId: RUN_THREAD_ID,
        runId: "accepted-automation-run",
      });
    },
  );
  await openAutomationBrowser(true);
  const editor = await findComposerEditor();
  await fill(editor, "Draft /");
  await importRequested.promise;
  await screen.findByRole("status", { name: "Loading workflows..." });
  const run = automationControl(
    automationPanel("Active release schedule"),
    "button",
    "Run now",
  );
  click(run);
  await runRequested.promise;
  await waitFor(() => {
    expect(run).toBeDisabled();
  });
  runResponse.resolve();
  await waitFor(() => {
    expect(
      automationControl(
        automationPanel("Active release schedule"),
        "button",
        "Run now",
      ),
    ).toBeEnabled();
  });
  expect(importFinished).toBeFalsy();
  expect(values.get("okou_recent-workflows")).toBe(legacy);
  // Run now blurs the composer; reopen its still-pending slash query.
  await fill(editor, "Draft");
  await fill(editor, "Draft /");
  await screen.findByRole("status", { name: "Loading workflows..." });
  imported.resolve();
  await waitFor(() => {
    const menu = screen.getByTestId("slash-workflow-menu");
    const names = queryAllByRoleFast("button", menu)
      .map((button) => {
        return button.querySelector('[data-slot="slash-workflow-name"]')
          ?.textContent;
      })
      .filter(Boolean);
    expect(names).toStrictEqual([
      "/zulu",
      "/active-release-schedule",
      "/alpha",
    ]);
  });
  expect(values.get("okou_recent-workflows")).toBe(legacy);
});

test("Browse an active scheduled workflow and its available controls", async () => {
  await openAutomationBrowser();
  const activeSchedule = automationPanel("Active release schedule");
  expect(within(activeSchedule).getByText("Active")).toBeVisible();
  expect(within(activeSchedule).getByText("Every 2 hours")).toBeVisible();
  expect(within(activeSchedule).getByText("Last run")).toBeVisible();
  expect(within(activeSchedule).getByText("Next run")).toBeVisible();
  expect(automationControl(activeSchedule, "link", "View")).toBeVisible();
  expect(automationControl(activeSchedule, "button", "Run now")).toBeVisible();
  expect(automationControl(activeSchedule, "button", "Edit")).toBeVisible();
});

test("Browse a webhook workflow without offering schedule editing", async () => {
  await openAutomationBrowser();
  const webhook = automationPanel("Release webhook");
  expect(automationControl(webhook, "link", "View")).toBeVisible();
  expect(automationControl(webhook, "button", "Run now")).toBeVisible();
  expect(
    queryAllByRoleFast("button", webhook).some((button) => {
      return button.textContent?.trim() === "Edit";
    }),
  ).toBeFalsy();
});

test("Keep official automation management without offering Run now", async () => {
  await openAutomationBrowser();
  const official = automationPanel("Official Morning Brief");
  expect(automationControl(official, "link", "View")).toBeVisible();
  expect(automationControl(official, "link", "View")).toHaveAttribute(
    "href",
    "/workflows/a0000000-0000-4000-a000-000000000874/automations",
  );
  expect(
    queryAllByRoleFast("button", official).find((button) => {
      return ["Run now", "Edit"].includes(button.textContent?.trim() ?? "");
    }),
  ).toBeUndefined();
});

test("Refresh the automation list when the thread's automations change", async () => {
  const automations: ChatThreadWorkflowAutomation[] = [
    {
      id: ACTIVE_SCHEDULE_ID,
      ownerUserId: "test-user-123",
      enabled: true,
      chatThreadId: RUN_THREAD_ID,
      nextRunAt: "2026-08-01T12:00:00.000Z",
      lastRunAt: "2026-08-01T10:00:00.000Z",
      official: null,
      kind: "schedule",
      schedule: { type: "loop", intervalSeconds: 7200 },
      scheduleSummary: "Every 2 hours",
      workflow: workflow(
        "a0000000-0000-4000-a000-000000000871",
        "active-release-schedule",
        "Active release schedule",
      ),
    },
  ];
  installCapabilityChat({
    events: [
      {
        id: "automation-refresh-prompt",
        role: "user",
        content: "Watch the workspace automations",
        runId: "d0000000-0000-4000-a000-000000000862",
        seqId: 1,
        createdAt: "2026-08-01T10:00:00.000Z",
      },
      {
        id: "automation-refresh-response",
        role: "assistant",
        content: "The automation watch is ready.",
        runId: "d0000000-0000-4000-a000-000000000862",
        seqId: 2,
        createdAt: "2026-08-01T10:00:01.000Z",
      },
    ],
  });
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ params, respond }) => {
      return respond(
        200,
        params.threadId === RUN_THREAD_ID ? [...automations] : [],
      );
    },
  );

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await selectDesktopHeaderAction("Automations");
  const automationSidebar = await screen.findByRole("complementary", {
    name: "Automations",
  });
  expect(
    within(automationSidebar).getByText("Active release schedule"),
  ).toBeVisible();
  const topic = `chatThreadAutomationsChanged:${RUN_THREAD_ID}`;
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });

  automations.push({
    id: WEBHOOK_ID,
    ownerUserId: "test-user-123",
    enabled: true,
    chatThreadId: RUN_THREAD_ID,
    nextRunAt: null,
    lastRunAt: null,
    official: null,
    kind: "event",
    eventType: "webhook-received",
    eventConfig: {
      provider: "webhook",
      event: "received",
      auth: { mode: "hmac-sha256" },
    },
    schedule: null,
    scheduleSummary: null,
    secretLastFour: "2468",
    lastReceivedAt: "2026-08-01T09:00:00.000Z",
    workflow: workflow(
      "a0000000-0000-4000-a000-000000000872",
      "release-webhook",
      "Release webhook",
    ),
  });
  context.mocks.ably.trigger(topic);

  await expect(
    within(automationSidebar).findByText("Release webhook"),
  ).resolves.toBeVisible();
  expect(
    within(automationSidebar).getByText("Active release schedule"),
  ).toBeVisible();
});

test.each(["Active release schedule", "Paused digest schedule"])(
  "An earlier chat automation save preserves a newer editor for %s",
  async (title) => {
    const automations = await openAutomationBrowser();
    const active = automations.find((automation) => {
      return automation.id === ACTIVE_SCHEDULE_ID;
    });
    if (!active || active.kind !== "schedule") {
      throw new Error("Expected the active schedule");
    }
    let current: readonly ChatThreadWorkflowAutomation[] = automations;
    context.mocks.api(
      workflowAutomationsContract.listForChatThread,
      ({ respond }) => {
        return respond(200, [...current]);
      },
    );
    const started = context.mocks.deferred<void>();
    const response = context.mocks.deferred<void>();
    context.mocks.api(
      workflowAutomationsContract.update,
      async ({ respond }) => {
        started.resolve();
        await response.promise;
        const saved = {
          ...active,
          schedule: { type: "loop" as const, intervalSeconds: 18_000 },
          scheduleSummary: "Every 5 hours",
        };
        current = automations.map((item) => {
          return item.id === active.id ? saved : item;
        });
        return respond(200, saved);
      },
    );
    click(
      automationControl(
        automationPanel("Active release schedule"),
        "button",
        "Edit",
      ),
    );
    const first = await screen.findByRole("dialog");
    click(automationControl(first, "button", "Save automation"));
    await started.promise;
    click(await findButton("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    click(automationControl(automationPanel(title), "button", "Edit"));
    const newer = await screen.findByRole("dialog");
    const value = within(newer).getByRole("combobox");
    click(value);
    click(await screen.findByRole("option", { name: "30 minutes" }));
    response.resolve();
    await screen.findByText("Every 5 hours");
    await expect(screen.findByRole("dialog")).resolves.toBeInTheDocument();
    expect(value).toHaveTextContent("30 minutes");
  },
);
