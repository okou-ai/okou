import {
  workflowAutomationsContract,
  type ChatThreadWorkflowAutomation,
} from "@okouai/api-contracts/contracts/workflows";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  CAPABILITY_AGENT_ID,
  context,
  findButton,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-capability-test-helpers.ts";

const ACTIVE_SCHEDULE_ID = "a0000000-0000-4000-a000-000000000861";
const WEBHOOK_ID = "a0000000-0000-4000-a000-000000000862";
const DISABLED_SCHEDULE_ID = "a0000000-0000-4000-a000-000000000863";

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

async function openAutomationBrowser(): Promise<void> {
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

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  click(await findButton("Automations"));
  const automationSidebar = await screen.findByRole("complementary", {
    name: "Automations",
  });
  expect(automationSidebar).toBeVisible();
}

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

test("Browse a paused scheduled workflow without an inline switch", async () => {
  await openAutomationBrowser();
  const disabledSchedule = automationPanel("Paused digest schedule");
  expect(within(disabledSchedule).getByText("Disabled")).toBeVisible();
  expect(
    within(disabledSchedule).queryByRole("switch"),
  ).not.toBeInTheDocument();
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
  click(await findButton("Automations"));
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
