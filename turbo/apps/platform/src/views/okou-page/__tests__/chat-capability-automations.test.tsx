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
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
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
      agentId: AGENT_ID,
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
