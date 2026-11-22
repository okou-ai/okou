import {
  workflowAutomationsContract,
  type ChatThreadWorkflowAutomation,
} from "@okouai/api-contracts/contracts/workflows";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import {
  createChatRunFixtures,
  findButton,
  queryButton,
  RUN_THREAD_ID,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
const context = testContext();
const last = "2026-09-12T13:05:00Z",
  next = "2026-09-12T15:05:00Z";
function releaseSchedule(): Extract<
  ChatThreadWorkflowAutomation,
  { kind: "schedule" }
> {
  return {
    id: crypto.randomUUID(),
    ownerUserId: "test-user-123",
    enabled: true,
    chatThreadId: RUN_THREAD_ID,
    lastRunAt: last,
    nextRunAt: next,
    official: null,
    workflow: {
      id: crypto.randomUUID(),

      name: "release-schedule",
      displayName: "Active release schedule",
      description: null,
    },
    kind: "schedule",
    schedule: { type: "loop", intervalSeconds: 7200 },
    scheduleSummary: "Every 2 hours",
  };
}
test("chat-capability-automations-001 the active release schedule identifies both run times and its available actions", async () => {
  const record = releaseSchedule();
  createChatRunFixtures(context).installRunChat();
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ params, respond }) => {
      return respond(200, params.threadId === RUN_THREAD_ID ? [record] : []);
    },
  );
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  click(await findButton("More actions"));
  click(
    await waitFor(() => {
      const item = queryAllByRoleFast("menuitem").find((el) => {
        return el.textContent?.trim() === "Automations";
      });
      expect(item).toBeDefined();
      return item!;
    }),
  );
  const sidebar = await screen.findByTestId("automation-sidebar");
  const panel = within(sidebar);
  await panel.findByText("Active release schedule");
  const schedule = panel.getByRole("article");
  const card = within(schedule);
  function value(label: string) {
    return card.getByText(label, { selector: "dt" }).nextElementSibling;
  }
  expect(value("Status")).toHaveTextContent("Active");
  expect(value("Schedule")).toHaveTextContent("Every 2 hours");
  const format = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  expect(value("Last run")).toHaveTextContent(format.format(new Date(last)));
  expect(value("Next run")).toHaveTextContent(format.format(new Date(next)));
  expect(queryButton("Edit", schedule)).toBeEnabled();
  expect(queryButton("Run now", schedule)).toBeEnabled();
  expect(
    queryAllByRoleFast("link", sidebar).find((link) => {
      return link.textContent?.trim() === "View";
    }),
  ).toHaveAttribute(
    "href",
    "/workflows/" + record.workflow.id + "/automations",
  );
});
async function openAutomations() {
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  click(await findButton("More actions"));
  const menu = await screen.findByRole("menu");
  click(
    queryAllByRoleFast("menuitem", menu).find((el) => {
      return el.textContent?.trim() === "Automations";
    })!,
  );
  return screen.findByTestId("automation-sidebar");
}
test("chat-capability-automations-004 a thread change brings its release webhook into the open panel", async () => {
  const schedule = releaseSchedule(),
    records: ChatThreadWorkflowAutomation[] = [schedule];
  createChatRunFixtures(context).installRunChat();
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ params, respond }) => {
      return respond(200, params.threadId === RUN_THREAD_ID ? records : []);
    },
  );
  const panel = await openAutomations();
  const cards = within(panel);
  await cards.findByText("Active release schedule");
  expect(cards.queryByText("Release webhook")).toBeNull();
  records.push({
    ...schedule,
    id: crypto.randomUUID(),
    workflow: {
      ...schedule.workflow,
      id: crypto.randomUUID(),
      name: "release-hook",
      displayName: "Release webhook",
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
    lastReceivedAt: null,
    secretLastFour: "1234",
  });
  context.mocks.ably.trigger("chatThreadAutomationsChanged:" + RUN_THREAD_ID, {
    threadId: RUN_THREAD_ID,
  });
  await expect(cards.findByText("Release webhook")).resolves.toBeVisible();
  expect(cards.getByText("Active release schedule")).toBeVisible();
});
test("chat-capability-automations-005 finishing the five-hour save preserves a newer thirty-minute edit", async () => {
  const initial = releaseSchedule(),
    paused = {
      ...releaseSchedule(),
      enabled: false,
      workflow: {
        ...initial.workflow,
        id: crypto.randomUUID(),
        name: "paused-digest",
        displayName: "Paused digest schedule",
      },
    };
  initial.schedule = { type: "loop", intervalSeconds: 18_000 };
  initial.scheduleSummary = "Every 5 hours";
  const rescheduled = "2026-09-13T02:00:00Z";
  let saved = initial;
  const gate = context.mocks.deferred<void>();
  createChatRunFixtures(context).installRunChat();
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ params, respond }) => {
      return respond(
        200,
        params.threadId === RUN_THREAD_ID ? [saved, paused] : [],
      );
    },
  );
  context.mocks.api(
    workflowAutomationsContract.update,
    async ({ params, body, respond }) => {
      await gate.promise;
      if (
        params.id !== initial.id ||
        !("schedule" in body) ||
        body.schedule?.type !== "loop" ||
        body.schedule.intervalSeconds !== 18_000
      ) {
        return respond(400, {
          error: {
            code: "BAD_REQUEST",
            message: "Expected the edited release schedule",
          },
        });
      }
      saved = { ...initial, schedule: body.schedule, nextRunAt: rescheduled };
      return respond(200, saved);
    },
  );
  const panel = await openAutomations();
  const cards = within(panel);
  await cards.findByText("Paused digest schedule");
  const active = cards.getByText("Active release schedule").parentElement!
    .nextElementSibling as HTMLElement;
  async function edit(interval: string) {
    click(queryButton("Edit", active)!);
    const editor = await screen.findByRole("dialog", {
      name: "Edit automation",
    });
    const field = within(editor).getByRole("combobox", { name: "Every" });
    click(field);
    click(await screen.findByRole("option", { name: interval }));
    expect(field).toHaveTextContent(interval);
    return editor;
  }
  const first = await edit("5 hours");
  const save = queryButton("Save automation", first)!;
  click(save);
  await waitFor(() => {
    return expect(save).toBeDisabled();
  });
  click(queryButton("Close", first)!);
  await waitFor(() => {
    return expect(first).not.toBeInTheDocument();
  });
  const second = await edit("30 minutes");
  const updatedTime = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(rescheduled));
  expect(within(active).queryByText(updatedTime)).toBeNull();
  gate.resolve();
  await within(active).findByText(updatedTime);
  expect(within(active).getByText("Every 5 hours")).toBeVisible();
  expect(second).toBeVisible();
  expect(
    within(second).getByRole("combobox", { name: "Every" }),
  ).toHaveTextContent("30 minutes");
});
