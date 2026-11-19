import {
  workflowAutomationsContract,
  type ChatThreadWorkflowAutomation,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import {
  createChatRunFixtures,
  findButton,
  queryButton,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

async function chooseMenuItem(name: string): Promise<void> {
  const item = await waitFor(() => {
    const match = queryAllByRoleFast("menuitem").find((candidate) => {
      return candidate.textContent?.trim() === name;
    });
    if (!match) {
      throw new Error(`Menu item ${name} was not visible`);
    }
    return match;
  });
  click(item);
}

const LAST_RUN_AT = "2026-08-01T08:00:00.000Z";
const NEXT_RUN_AT = "2026-08-01T10:00:00.000Z";

type ScheduleAutomation = Extract<
  ChatThreadWorkflowAutomation,
  { kind: "schedule" }
>;

function scheduleAutomation(args: {
  readonly id: string;
  readonly workflowId: string;
  readonly displayName: string;
  readonly intervalSeconds: number;
  readonly enabled?: boolean;
}): ScheduleAutomation {
  return {
    id: args.id,
    ownerUserId: "test-user-123",
    enabled: args.enabled ?? true,
    chatThreadId: RUN_THREAD_ID,
    nextRunAt: NEXT_RUN_AT,
    lastRunAt: LAST_RUN_AT,
    official: null,
    workflow: {
      id: args.workflowId,
      agentId: AGENT_ID,
      name: args.displayName.toLowerCase().replaceAll(" ", "-"),
      displayName: args.displayName,
      description: null,
    },
    kind: "schedule",
    schedule: { type: "loop", intervalSeconds: args.intervalSeconds },
    scheduleSummary: `Every ${String(args.intervalSeconds)} seconds`,
  };
}

function webhookAutomation(): ChatThreadWorkflowAutomation {
  return {
    id: "e1000000-0000-4000-a000-000000000203",
    ownerUserId: "test-user-123",
    enabled: true,
    chatThreadId: RUN_THREAD_ID,
    nextRunAt: null,
    lastRunAt: null,
    official: null,
    workflow: {
      id: "e2000000-0000-4000-a000-000000000203",
      agentId: AGENT_ID,
      name: "release-webhook",
      displayName: "Release webhook",
      description: null,
    },
    kind: "event",
    eventType: "webhook-received",
    eventConfig: {
      provider: "webhook",
      event: "received",
      auth: { mode: "hmac-sha256" },
    },
    schedule: null,
    scheduleSummary: null,
    secretLastFour: "a1b2",
    lastReceivedAt: null,
  };
}

const ACTIVE_SCHEDULE_ID = "e1000000-0000-4000-a000-000000000201";
const PAUSED_SCHEDULE_ID = "e1000000-0000-4000-a000-000000000202";

function activeSchedule(intervalSeconds: number): ScheduleAutomation {
  return scheduleAutomation({
    id: ACTIVE_SCHEDULE_ID,
    workflowId: "e2000000-0000-4000-a000-000000000201",
    displayName: "Active release schedule",
    intervalSeconds,
  });
}

function pausedSchedule(): ScheduleAutomation {
  return scheduleAutomation({
    id: PAUSED_SCHEDULE_ID,
    workflowId: "e2000000-0000-4000-a000-000000000202",
    displayName: "Paused digest schedule",
    intervalSeconds: 3600,
    enabled: false,
  });
}

function mockThreadAutomations(
  read: () => readonly ChatThreadWorkflowAutomation[],
): void {
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ params, respond }) => {
      expect(params.threadId).toBe(RUN_THREAD_ID);
      return respond(200, [...read()]);
    },
  );
}

function automationCard(
  title: string,
  panel: HTMLElement = screen.getByRole("complementary", {
    name: "Automations",
  }),
): HTMLElement {
  const heading = within(panel)
    .getAllByText(title)
    .find((element) => {
      return element.tagName === "P";
    });
  const card = heading?.parentElement?.parentElement;
  if (!card) {
    throw new Error(`Automation ${title} is not in the panel`);
  }
  return card;
}

async function openAutomations(): Promise<HTMLElement> {
  await readyChat();
  click(await findButton("More actions"));
  await chooseMenuItem("Automations");
  return await screen.findByRole("complementary", { name: "Automations" });
}

function runTime(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

test("Browse an active scheduled workflow and its available controls", async () => {
  installRunChat();
  mockThreadAutomations(() => {
    return [activeSchedule(7200)];
  });
  await setupPage({ context, path: RUN_PATH });

  await openAutomations();

  const card = await waitFor(() => {
    return automationCard("Active release schedule");
  });
  expect(card).toHaveTextContent("Active");
  expect(card).toHaveTextContent("Every 2 hours");
  expect(card).toHaveTextContent(`Last run${runTime(LAST_RUN_AT)}`);
  expect(card).toHaveTextContent(`Next run${runTime(NEXT_RUN_AT)}`);
  const view = queryAllByRoleFast("link", card).find((link) => {
    return link.textContent?.trim() === "View";
  });
  expect(view).toHaveAttribute(
    "href",
    "/workflows/e2000000-0000-4000-a000-000000000201/automations",
  );
  expect(queryButton("Run now", card)).toBeEnabled();
  expect(queryButton("Edit", card)).toBeEnabled();
});

test("Refresh the automation list when the thread's automations change", async () => {
  installRunChat();
  let automations: ChatThreadWorkflowAutomation[] = [activeSchedule(7200)];
  mockThreadAutomations(() => {
    return automations;
  });
  await setupPage({ context, path: RUN_PATH });
  await openAutomations();
  await waitFor(() => {
    expect(automationCard("Active release schedule")).toHaveTextContent(
      "Every 2 hours",
    );
  });
  const topic = `chatThreadAutomationsChanged:${RUN_THREAD_ID}`;
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
  });

  automations = [...automations, webhookAutomation()];
  act(() => {
    context.mocks.ably.trigger(topic);
  });

  await waitFor(() => {
    expect(automationCard("Release webhook")).toHaveTextContent(
      "Webhook automation",
    );
  });
  expect(automationCard("Active release schedule")).toHaveTextContent(
    "Every 2 hours",
  );
});

test("An earlier chat automation save preserves a newer editor for Active release schedule", async () => {
  installRunChat();
  let automations: ChatThreadWorkflowAutomation[] = [
    activeSchedule(18_000),
    pausedSchedule(),
  ];
  let reads = 0;
  mockThreadAutomations(() => {
    reads += 1;
    return automations;
  });
  const saveStarted = context.mocks.deferred<number>();
  const releaseSave = context.mocks.deferred<void>();
  context.mocks.api(
    workflowAutomationsContract.update,
    async ({ params, body, respond }) => {
      expect(params.id).toBe(ACTIVE_SCHEDULE_ID);
      if (!("schedule" in body) || body.schedule.type !== "loop") {
        throw new Error("Expected a loop schedule update");
      }
      saveStarted.resolve(body.schedule.intervalSeconds);
      await releaseSave.promise;
      const saved = activeSchedule(body.schedule.intervalSeconds);
      automations = [saved, pausedSchedule()];
      const { workflow: _workflow, ...summary } = saved;
      return respond(200, summary satisfies WorkflowAutomationSummary);
    },
  );
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: RUN_PATH });
  // The edit dialog is modal, so the panel is captured before it opens.
  const panel = await openAutomations();
  await waitFor(() => {
    expect(automationCard("Paused digest schedule", panel)).toHaveTextContent(
      "Disabled",
    );
  });

  click(queryButton("Edit", automationCard("Active release schedule", panel))!);
  const firstEditor = await screen.findByRole("dialog", {
    name: "Edit automation",
  });
  click(queryButton("Save automation", firstEditor)!);
  await expect(saveStarted.promise).resolves.toBe(18_000);
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(firstEditor).not.toBeInTheDocument();
  });
  click(queryButton("Edit", automationCard("Active release schedule", panel))!);
  const newerEditor = await screen.findByRole("dialog", {
    name: "Edit automation",
  });
  click(within(newerEditor).getByRole("combobox", { name: "Every" }));
  click(await screen.findByRole("option", { name: "30 minutes" }));
  await waitFor(() => {
    expect(
      within(newerEditor).getByRole("combobox", { name: "Every" }),
    ).toHaveTextContent("30 minutes");
  });

  const readsBeforeSave = reads;
  releaseSave.resolve();

  await waitFor(() => {
    expect(reads).toBeGreaterThan(readsBeforeSave);
  });

  await waitFor(() => {
    expect(automationCard("Active release schedule", panel)).toHaveTextContent(
      "Every 5 hours",
    );
  });
  expect(newerEditor).toBeInTheDocument();
  expect(
    within(newerEditor).getByRole("combobox", { name: "Every" }),
  ).toHaveTextContent("30 minutes");
});
