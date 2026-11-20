import { screen, waitFor, within } from "@testing-library/react";
import {
  logsByIdContract,
  type LogDetail,
} from "@okouai/api-contracts/contracts/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import { expect, test } from "vitest";
import { CHAT_RUN_USAGE_LIMIT_MESSAGE } from "@okouai/api-contracts/contracts/errors";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEvent,
  AgentEventsResponse,
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
    failureReason: status === "failed" ? "unknown" : undefined,
    createdAt: CREATED_AT,
    startedAt: CREATED_AT,
    completedAt: status === "running" ? null : "2026-06-26T02:31:30Z",
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

function lastSequence(events: readonly AgentEvent[]): number | null {
  if (events.length === 0) {
    return null;
  }
  return events.reduce((maximum, item) => {
    return Math.max(maximum, Math.floor(item.sequenceNumber));
  }, 0);
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

test.each([
  {
    error: "retained private diagnostic",
    failureReason: undefined,
    expected: "Oops, something went wrong.",
  },
  {
    failureReason: "usage_limit" as const,
    expected: CHAT_RUN_USAGE_LIMIT_MESSAGE,
  },
])(
  "Failed activities accept old and new responses without displaying diagnostics: $expected",
  async ({ expected, ...fields }) => {
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, { ...makeLogDetail("failed"), ...fields });
    });
    context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
      return respond(200, {
        events: [],
        hasMore: false,
        status: "failed",
        lastEventSequence: null,
      });
    });
    await openActivity();
    await expect(screen.findByText(expected)).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("retained private diagnostic"),
    ).not.toBeInTheDocument();
  },
);

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
  expect(screen.getByText("Parent task")).toBeVisible();

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
  expect(document.body).not.toHaveTextContent("thinking_tokens");
  expect(document.body).not.toHaveTextContent(/777[,.\s]?777/u);
});
