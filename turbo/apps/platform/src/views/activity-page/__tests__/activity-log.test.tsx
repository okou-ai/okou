import { screen, waitFor, within } from "@testing-library/react";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEvent,
  AgentEventsResponse,
  LogDetail,
  LogStatus,
} from "../../../signals/okou-page/log-types.ts";

const context = testContext();

const RUN_ID = "a0000000-0000-4000-a000-000000000401";
const CREATED_AT = "2026-06-26T02:31:20Z";

function makeLogDetail(
  status: LogStatus = "completed",
  framework = "claude-code",
): LogDetail {
  return {
    id: RUN_ID,
    sessionId: "session-activity-log",
    agentId: "e0000000-0000-4000-a000-000000000010",
    displayName: "Activity Log Test",
    framework,
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    status,
    prompt: "",
    appendSystemPrompt: null,
    error: status === "failed" ? "Run failed" : null,
    createdAt: CREATED_AT,
    startedAt: CREATED_AT,
    completedAt: status === "running" ? null : "2026-06-26T02:31:30Z",
    artifact: { name: null, version: null },
  };
}

function event(
  sequenceNumber: number,
  eventType: string,
  eventData: AgentEvent["eventData"],
): AgentEvent {
  return {
    sequenceNumber,
    eventType,
    eventData,
    createdAt: CREATED_AT,
  };
}

function assistantText(sequenceNumber: number, text: string): AgentEvent {
  return event(sequenceNumber, "assistant", {
    message: {
      content: [{ type: "text", text }],
    },
  });
}

function lastSequence(events: readonly AgentEvent[]): number {
  return events.reduce((maximum, item) => {
    return Math.max(maximum, Math.floor(item.sequenceNumber));
  }, -1);
}

function mockActivity(
  events: readonly AgentEvent[],
  options: {
    readonly framework?: string;
    readonly status?: LogStatus;
  } = {},
): void {
  const status = options.status ?? "completed";
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, makeLogDetail(status, options.framework));
  });
  context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
    return respond(200, {
      events: [...events],
      hasMore: false,
      status,
      lastEventSequence: lastSequence(events),
    } satisfies AgentEventsResponse);
  });
}

function openActivity(): Promise<void> {
  return setupPage({ context, path: "/activities/" + RUN_ID });
}

function summaryForText(
  text: string,
  container: HTMLElement = document.body,
  occurrence = 0,
): HTMLElement {
  const element = within(container).getAllByText(text)[occurrence];
  const summary = element?.closest("summary");
  if (!summary) {
    throw new Error("Could not find summary for " + text);
  }
  return summary;
}

function detailsForText(
  text: string,
  container: HTMLElement = document.body,
  occurrence = 0,
): HTMLDetailsElement {
  const details = summaryForText(text, container, occurrence).closest(
    "details",
  );
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Could not find details for " + text);
  }
  return details;
}

function expandedTextElements(
  details: HTMLDetailsElement,
  text: string,
): HTMLElement[] {
  return within(details)
    .getAllByText(text)
    .filter((element) => {
      return element.closest("summary") === null;
    });
}

function expectBefore(first: Element, second: Element): void {
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
}

test("Large plans and file-change lists remain readable", async () => {
  mockActivity(
    [
      event(0, "turn.plan.updated", {
        type: "turn.plan.updated",
        plan: Array.from({ length: 25 }, (_, index) => {
          return {
            status: "pending",
            step: "Step " + index,
          };
        }),
      }),
      event(1, "item.completed", {
        type: "item.completed",
        item: {
          id: "files-many",
          type: "file_change",
          changes: Array.from({ length: 25 }, (_, index) => {
            return {
              kind: "modify",
              path: "src/file-" + index + ".ts",
            };
          }),
        },
      }),
    ],
    { framework: "codex" },
  );

  await openActivity();

  await expect(screen.findByText(/Step 19/u)).resolves.toBeInTheDocument();
  expect(screen.getByText(/src\/file-19\.ts/u)).toBeInTheDocument();
  expect(screen.getByText(/5 more steps/u)).toBeInTheDocument();
  expect(screen.getByText(/5 more changes/u)).toBeInTheDocument();
  expect(screen.queryByText(/Step 20/u)).not.toBeInTheDocument();
  expect(screen.queryByText(/src\/file-20\.ts/u)).not.toBeInTheDocument();
});

test("Activity logs do not hide a failed run behind completed child work", async () => {
  mockActivity(
    [
      event(0, "item.completed", {
        type: "item.completed",
        item: {
          id: "completed-child",
          type: "sub_agent_activity",
          kind: "completed",
          agent_thread_id: "child-thread",
          agent_path: "/root/completed-child",
        },
      }),
      event(1, "turn.completed", {
        type: "turn.completed",
        status: "failed",
        turn: {
          id: "failed-turn",
          status: "completed",
        },
      }),
    ],
    { framework: "codex", status: "failed" },
  );

  await openActivity();

  await expect(
    screen.findByRole("heading", { name: "Activity Log Test" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
  await expect(
    screen.findByText("Completed subagent"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Turn failed")).toBeInTheDocument();
  expect(screen.queryByText("Done")).not.toBeInTheDocument();
});

test("Invalid tool-result metadata does not corrupt the activity log", async () => {
  mockActivity([
    event(0, "assistant", {
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-negative-meta",
            name: "Bash",
            input: { command: "echo meta" },
          },
        ],
      },
    }),
    event(1, "user", {
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-negative-meta",
            content: "valid result content",
          },
        ],
      },
      tool_use_result: { durationMs: -5, bytes: -10 },
    }),
  ]);

  await openActivity();

  const toolHeading = await screen.findByText("Bash");
  click(summaryForText("Bash"));

  await expect(
    screen.findByText("valid result content"),
  ).resolves.toBeVisible();
  const toolDetails = toolHeading.closest("details");
  if (!toolDetails) {
    throw new Error("Tool details not found");
  }
  expect(toolDetails).not.toHaveTextContent("-5");
  expect(toolDetails).not.toHaveTextContent("-10");
});

test("Activity logs keep unmatched tool results visible", async () => {
  mockActivity([
    event(0, "user", {
      message: {
        content: [
          { type: "tool_result", content: "first unmatched result" },
          { type: "tool_result", content: "second unmatched result" },
        ],
      },
    }),
  ]);

  await openActivity();

  const unmatchedTools = await screen.findAllByText("Unknown");
  expect(unmatchedTools).toHaveLength(2);
  for (const tool of unmatchedTools) {
    const summary = tool.closest("summary");
    if (!summary) {
      throw new Error("Unmatched result summary not found");
    }
    click(summary);
  }

  expect(screen.getByText("first unmatched result")).toBeVisible();
  expect(screen.getByText("second unmatched result")).toBeVisible();
});

test("Activity logs attach results to the correct subtask", async () => {
  mockActivity([
    event(0, "system", {
      subtype: "task_started",
      task_id: "task-a",
      tool_use_id: "task-tool-a",
      description: "Task A",
    }),
    event(1, "system", {
      subtype: "task_started",
      task_id: "task-b",
      tool_use_id: "task-tool-b",
      description: "Task B",
    }),
    event(2, "assistant", {
      parent_tool_use_id: "task-tool-a",
      message: {
        content: [
          {
            type: "tool_use",
            id: "shared-tool-id",
            name: "Bash",
            input: { command: "echo task-a" },
          },
        ],
      },
    }),
    event(3, "assistant", {
      parent_tool_use_id: "task-tool-b",
      message: {
        content: [
          {
            type: "tool_use",
            id: "shared-tool-id",
            name: "Bash",
            input: { command: "echo task-b" },
          },
        ],
      },
    }),
    event(4, "user", {
      parent_tool_use_id: "task-tool-a",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "shared-tool-id",
            content: "result task-a",
          },
        ],
      },
    }),
    event(5, "user", {
      parent_tool_use_id: "task-tool-b",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "shared-tool-id",
            content: "result task-b",
          },
        ],
      },
    }),
    event(6, "user", {
      parent_tool_use_id: "missing-task",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "shared-tool-id",
            content: "unmatched parent result",
          },
        ],
      },
    }),
  ]);

  await openActivity();

  await expect(screen.findByText("Task A")).resolves.toBeInTheDocument();
  const taskA = detailsForText("Task A");
  const taskB = detailsForText("Task B");
  click(summaryForText("Task A"));
  click(summaryForText("Task B"));
  click(summaryForText("Bash", taskA));
  click(summaryForText("Bash", taskB));

  expect(within(taskA).getByText("result task-a")).toBeVisible();
  expect(within(taskA).queryByText("result task-b")).not.toBeInTheDocument();
  expect(within(taskB).getByText("result task-b")).toBeVisible();
  expect(within(taskB).queryByText("result task-a")).not.toBeInTheDocument();

  click(summaryForText("Unknown"));
  expect(screen.getByText("unmatched parent result")).toBeVisible();
});

test("Activity logs preserve distinct events recorded at the same position", async () => {
  const repeated = assistantText(0, "Repeated boundary event.");
  mockActivity([
    repeated,
    { ...repeated },
    assistantText(0, "Distinct same-position event."),
  ]);

  await openActivity();

  await expect(
    screen.findByText("Distinct same-position event."),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByText("Repeated boundary event.")).toHaveLength(1);
});

test("Activity logs preserve the order of closely related events", async () => {
  mockActivity([
    event(0, "user", {
      message: {
        content: [
          { type: "tool_result", content: "first ordered result" },
          { type: "tool_result", content: "second ordered result" },
        ],
      },
    }),
    event(1, "assistant", {
      message: {
        content: [
          {
            type: "tool_use",
            id: "todo-before-next-1",
            name: "TodoWrite",
            input: {
              todos: [{ content: "First ordered task", status: "in_progress" }],
            },
          },
          {
            type: "tool_use",
            id: "todo-before-next-2",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "First ordered task", status: "completed" },
                {
                  content: "Second ordered task",
                  status: "in_progress",
                },
              ],
            },
          },
        ],
      },
    }),
    assistantText(2, "Next normal event."),
  ]);

  await openActivity();

  await expect(
    screen.findByText("Next normal event."),
  ).resolves.toBeInTheDocument();
  for (const tool of screen.getAllByText("Unknown")) {
    const summary = tool.closest("summary");
    if (!summary) {
      throw new Error("Ordered tool summary not found");
    }
    click(summary);
  }
  for (const todo of screen.getAllByText("Todo")) {
    const summary = todo.closest("summary");
    if (!summary) {
      throw new Error("Ordered todo summary not found");
    }
    click(summary);
  }

  const firstResult = screen.getByText("first ordered result");
  const secondResult = screen.getByText("second ordered result");
  const todoCards = screen.getAllByText("Todo");
  const firstTodo = todoCards[0];
  const secondTodo = todoCards[1];
  if (!firstTodo || !secondTodo) {
    throw new Error("Ordered todo entries not found");
  }
  const nextEvent = screen.getByText("Next normal event.");
  expectBefore(firstResult, secondResult);
  expectBefore(secondResult, firstTodo);
  expectBefore(firstTodo, secondTodo);
  expectBefore(secondTodo, nextEvent);
  const firstTodoDetails = detailsForText("Todo", document.body, 0);
  const secondTodoDetails = detailsForText("Todo", document.body, 1);
  expect(
    expandedTextElements(firstTodoDetails, "First ordered task"),
  ).toHaveLength(1);
  expect(
    within(firstTodoDetails).queryByText("Second ordered task"),
  ).not.toBeInTheDocument();
  expect(
    expandedTextElements(secondTodoDetails, "First ordered task"),
  ).toHaveLength(1);
  expect(
    expandedTextElements(secondTodoDetails, "Second ordered task"),
  ).toHaveLength(1);
});

test("Activity search finds content inside nested work", async () => {
  mockActivity([
    event(0, "system", {
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "task-tool-1",
      description: "Parent task",
    }),
    event(1, "assistant", {
      parent_tool_use_id: "task-tool-1",
      message: {
        content: [{ type: "text", text: "Nested child output." }],
      },
    }),
    event(2, "assistant", {
      message: {
        content: [
          {
            type: "tool_use",
            id: "todo-search",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "Investigate sandbox retry",
                  status: "in_progress",
                },
              ],
            },
          },
        ],
      },
    }),
    event(3, "assistant", {
      message: {
        content: [
          {
            type: "tool_use",
            id: "todo-failure-search",
            name: "TodoWrite",
            input: {
              todos: [{ content: "Keep intended task", status: "pending" }],
            },
          },
        ],
      },
    }),
    event(4, "user", {
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "todo-failure-search",
            content: "Nested task-list failure",
            is_error: true,
          },
        ],
      },
    }),
  ]);

  await openActivity();

  await expect(screen.findByText("Parent task")).resolves.toBeInTheDocument();
  const search = await screen.findByPlaceholderText("Search steps");
  await fill(search, "Nested child output");
  await expect(screen.findByText("(1/3 matched)")).resolves.toBeInTheDocument();
  expect(screen.getByText("Parent task")).toBeInTheDocument();

  await fill(search, "Investigate sandbox retry");
  await waitFor(() => {
    expect(screen.getByText("(1/3 matched)")).toBeInTheDocument();
    const matchingTasks = screen.getAllByText("Investigate sandbox retry");
    expect(matchingTasks.length).toBeGreaterThan(0);
    expect(matchingTasks[0]).toBeVisible();
  });

  await fill(search, "Nested task-list failure");
  await waitFor(() => {
    expect(screen.getByText("(1/3 matched)")).toBeInTheDocument();
    expect(screen.getByText("Nested task-list failure")).toBeVisible();
  });

  await fill(search, "TodoWrite");
  await expect(screen.findByText("(0/3 matched)")).resolves.toBeInTheDocument();
  expect(screen.queryByText("Todo")).not.toBeInTheDocument();
});

test("Activity logs show plans only when they contain useful work", async () => {
  mockActivity(
    [
      event(0, "turn.plan.updated", {
        type: "turn.plan.updated",
        plan: [{ status: "empty-plan-marker" }, null],
      }),
      event(1, "turn.plan.updated", {
        type: "turn.plan.updated",
        explanation: "Review edge cases",
        plan: [{ status: "in_progress", step: "Check empty plans" }],
      }),
    ],
    { framework: "codex" },
  );

  await openActivity();

  await expect(
    screen.findByText(/Check empty plans/u),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText(/Review edge cases/u)).toBeInTheDocument();
  expect(screen.queryByText(/empty-plan-marker/u)).not.toBeInTheDocument();
});

test("Activity logs keep a task-list failure with its task card", async () => {
  mockActivity([
    event(0, "assistant", {
      message: {
        content: [
          {
            type: "tool_use",
            id: "todo-error",
            name: "TodoWrite",
            input: {
              todos: [{ content: "Check failure", status: "pending" }],
            },
          },
        ],
      },
    }),
    event(1, "user", {
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "todo-error",
            content: "todo write failed",
            is_error: true,
          },
        ],
      },
    }),
  ]);

  await openActivity();

  await expect(screen.findByText("Todo")).resolves.toBeInTheDocument();
  const search = await screen.findByPlaceholderText("Search steps");
  await fill(search, "todo write failed");

  await expect(screen.findByText("(1/1 matched)")).resolves.toBeInTheDocument();
  expect(screen.getByText("Check failure")).toBeVisible();
  expect(screen.getByText("todo write failed")).toBeVisible();
  expect(screen.getByText("Todo")).toBeInTheDocument();
});

test("Activity logs retain a reasoning-only event", async () => {
  mockActivity([
    event(0, "assistant", {
      message: {
        content: [
          {
            type: "thinking",
            thinking: "Inspect the previous run output.",
          },
        ],
      },
    }),
  ]);

  await openActivity();

  await expect(screen.findByText("Thinking")).resolves.toBeInTheDocument();
  click(summaryForText("Thinking"));

  expect(screen.getByText("Inspect the previous run output.")).toBeVisible();
});

test("Activity logs show useful reasoning without progress noise", async () => {
  mockActivity([
    event(0, "system", {
      type: "system",
      subtype: "thinking_tokens",
      thinking_token_count: 777_777,
    }),
    event(1, "assistant", {
      message: {
        content: [
          {
            type: "thinking",
            thinking: "Review the failing logs before responding.",
          },
          {
            type: "text",
            text: "The failure is in the log renderer.",
          },
        ],
      },
    }),
  ]);

  await openActivity();

  await expect(
    screen.findByText("The failure is in the log renderer."),
  ).resolves.toBeInTheDocument();
  click(summaryForText("Thinking"));

  expect(
    screen.getByText("Review the failing logs before responding."),
  ).toBeVisible();
  expect(screen.queryByText("thinking_tokens")).not.toBeInTheDocument();
  expect(screen.queryByText("777777")).not.toBeInTheDocument();
});

test("Pi bounded tool content stays associated with a failed tool and run", async () => {
  const notice = "[event content truncated for delivery]";
  const imageNotice = "[image omitted for delivery]";
  mockActivity(
    [
      event(1, "assistant", {
        message: {
          content: [
            {
              type: "tool_use",
              id: "bounded-pi-call",
              name: "read",
              input: { _delivery_notice: notice },
            },
          ],
        },
      }),
      event(2, "user", {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "bounded-pi-call",
              is_error: true,
              content: [
                { type: "text", text: notice },
                { type: "text", text: imageNotice },
              ],
            },
          ],
        },
      }),
    ],
    { framework: "pi", status: "failed" },
  );
  await openActivity();
  const search = await screen.findByPlaceholderText("Search steps");
  await fill(search, imageNotice);
  await expect(screen.findByText("(1/1 matched)")).resolves.toBeInTheDocument();
  expect(screen.getByText(imageNotice)).toBeVisible();
  expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
});

test("Codex bounded structured output remains a readable completed item", async () => {
  mockActivity(
    [
      event(1, "item.completed", {
        type: "item.completed",
        thread_id: "thread",
        turn_id: "turn",
        item: {
          type: "function_call_output",
          id: "bounded-codex-call",
          name: "read",
          namespace: "tools",
          output: [
            {
              type: "input_text",
              text: "[event content truncated for delivery]",
            },
            { type: "input_text", text: "[image omitted for delivery]" },
          ],
        },
      }),
    ],
    { framework: "codex" },
  );
  await openActivity();
  await expect(
    screen.findByText(/bounded-codex-call/u),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText(/function_call_output/u)).toBeVisible();
});
