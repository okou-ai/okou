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
  findEnabledButton,
  RUN_PATH,
  RUN_THREAD_ID,
  completedEvent,
} from "./chat-run-test-fixtures.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";

const context = testContext();
const workflowId = "a4c00000-0000-4000-8000-000000000018";
test("chat-capability-workflows-001 editing the audit schedule replaces the five-minute rule and closes its editor", async () => {
  createChatRunFixtures(context).installRunChat();
  let automation: Extract<ChatThreadWorkflowAutomation, { kind: "schedule" }> =
    {
      id: crypto.randomUUID(),
      ownerUserId: "test-user-123",
      enabled: true,
      chatThreadId: RUN_THREAD_ID,
      nextRunAt: null,
      lastRunAt: null,
      official: null,
      workflow: {
        id: workflowId,

        name: "audit-receipts",
        description: null,
        displayName: "Receipt audit",
      },
      kind: "schedule",
      schedule: { type: "loop", intervalSeconds: 300 },
      scheduleSummary: "Every 5 minutes",
    };
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ params, respond }) => {
      return respond(
        200,
        params.threadId === RUN_THREAD_ID ? [automation] : [],
      );
    },
  );
  context.mocks.api(
    workflowAutomationsContract.update,
    ({ body, params, respond }) => {
      if (
        params.id !== automation.id ||
        !("schedule" in body) ||
        body.schedule.type !== "loop"
      ) {
        throw new Error("Expected an interval change to the receipt audit");
      }
      automation = {
        ...automation,
        schedule: body.schedule,
        scheduleSummary:
          "Every " + body.schedule.intervalSeconds / 60 + " minutes",
      };
      return respond(200, automation);
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
  await panel.findByText("Every 5 minutes");
  click(await findEnabledButton("Edit", sidebar));
  const dialog = await screen.findByRole("dialog");
  const editor = within(dialog);
  click(editor.getByRole("combobox", { name: "Every" }));
  click(await screen.findByRole("option", { name: "15 minutes" }));
  click(await findEnabledButton("Save automation", dialog));
  await panel.findByText("Every 15 minutes");
  expect(panel.queryByText("Every 5 minutes")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("chat-capability-workflows-003 completed, legacy and pending triggers render their corresponding workflow content", async () => {
  const main = crypto.randomUUID(),
    legacy = crypto.randomUUID();
  const prompt = "Review the unposted September invoices";
  const ignored = "Summarize outstanding receipts";
  const old = "Gather the legacy receipt bundle";
  const waiting = "Collect pending hotel expenses";
  function trigger(
    seqId: number,
    runId: string | undefined,
    name: string,
    brief: string,
    withPrompt = false,
  ): MockChatEventInput {
    return {
      id: crypto.randomUUID(),
      seqId,
      runId,
      createdAt: "2026-08-01T10:00:0" + seqId + ".000Z",
      role: "user",
      content: null,
      eventType: "input.automation",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "automation",
            workflowName: name,
            automationBrief: brief,
            ...(withPrompt ? { workflowId } : {}),
          },
          ...(withPrompt ? [{ type: "text" as const, text: prompt }] : []),
        ],
      },
    };
  }
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      trigger(1, main, "receipt-audit", ignored, true),
      completedEvent({ id: "audit-done", runId: main, seqId: 2 }),
      trigger(3, legacy, "legacy-audit", old),
      completedEvent({ id: "legacy-done", runId: legacy, seqId: 4 }),
      trigger(5, undefined, "pending-audit", waiting),
    ],
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  const text = await screen.findByText(prompt);
  const message = text.closest<HTMLElement>('[data-role="user"]')!;
  const turn = within(message);
  expect(
    queryAllByRoleFast("link", message).find((link) => {
      return link.getAttribute("aria-label") === "Open workflow receipt-audit";
    }),
  ).toHaveAttribute("href", "/workflows/" + workflowId + "/automations");
  expect(turn.queryByText(ignored)).toBeNull();
  click(text);
  expect(window.location.pathname).toBe(RUN_PATH);
  await expect(screen.findByText(old)).resolves.toBeInTheDocument();
  const pending = await screen.findByRole("listitem", {
    name: "Pending automation event",
  });
  expect(within(pending).getByText(waiting)).toBeInTheDocument();
  expect(screen.queryByRole("listitem", { name: "Queued message" })).toBeNull();
});
