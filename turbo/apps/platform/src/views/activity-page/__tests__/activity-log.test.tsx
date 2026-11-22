import { runTelemetryEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const RUN_ID = "d0000000-0000-4000-a000-000000000f41";
const PRIVATE_DIAGNOSTIC = "upstream 500 at 10.0.4.12 token=sk-private-4f1a";

interface AgentEventFixture {
  readonly eventType: string;
  readonly eventData: unknown;
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    sessionId: "session-f41",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    status: "failed",
    prompt: "Review the release",
    appendSystemPrompt: null,
    createdAt: "2026-11-20T07:00:00.000Z",
    startedAt: "2026-11-20T07:00:01.000Z",
    completedAt: "2026-11-20T07:01:00.000Z",
    ...overrides,
  };
}

function mockAgentEvents(events: readonly AgentEventFixture[]): void {
  context.mocks.api(
    runTelemetryEventsContract.getTelemetryEvents,
    ({ respond }) => {
      return respond(200, {
        events: events.map((event, index) => {
          return {
            sequenceNumber: index + 1,
            eventType: event.eventType,
            eventData: event.eventData,
            createdAt: "2026-11-20T07:00:02.000Z",
          };
        }),
        hasMore: false,
        status: "completed",
        lastEventSequence: events.length,
      });
    },
  );
}

async function openActivity(): Promise<void> {
  await setupPage({ context, path: `/activities/${RUN_ID}` });
  await expect(
    screen.findByRole("heading", { name: "Okou" }),
  ).resolves.toBeInTheDocument();
}

const USAGE_LIMIT =
  "Your model provider's usage allowance has been reached. Check your provider's usage limits or choose a different model or account.";

test.each([
  // An older API returned a raw diagnostic and no failure reason.
  {
    message: "Oops, something went wrong.",
    response: { error: PRIVATE_DIAGNOSTIC },
  },
  // The current API classifies the failure instead.
  { message: USAGE_LIMIT, response: { failureReason: "usage_limit" } },
] as const)(
  "Failed activities accept old and new responses without displaying diagnostics: $message",
  async ({ message, response }) => {
    context.mocks.http.get(`*/api/logs/${RUN_ID}`, () => {
      return HttpResponse.json(detail(response));
    });
    mockAgentEvents([]);

    await openActivity();

    await expect(screen.findByText(message)).resolves.toBeInTheDocument();
    expect(screen.queryByText(PRIVATE_DIAGNOSTIC)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("sk-private-4f1a");
  },
);

function completedActivity(): void {
  context.mocks.http.get(`*/api/logs/${RUN_ID}`, () => {
    return HttpResponse.json(detail({ status: "completed" }));
  });
}

test("Activity logs show useful reasoning without progress noise", async () => {
  completedActivity();
  mockAgentEvents([
    {
      eventType: "assistant",
      eventData: {
        type: "assistant",
        message: {
          content: [
            {
              type: "thinking",
              thinking: "Compare the two release branches first.",
            },
            { type: "text", text: "The release branch is ready." },
          ],
        },
      },
    },
    {
      eventType: "system",
      eventData: { type: "system", subtype: "thinking_tokens", tokens: 4096 },
    },
  ]);
  await openActivity();
  const thinking = await waitFor(() => {
    const summary = [...document.querySelectorAll("summary")].find((item) => {
      return item.textContent?.includes("Thinking");
    });
    if (!summary) {
      throw new Error("Expected the Thinking entry");
    }
    return summary;
  });

  click(thinking);

  await waitFor(() => {
    expect(thinking.closest("details")).toHaveAttribute("open");
  });
  expect(
    screen.getByText("Compare the two release branches first."),
  ).toBeInTheDocument();
  expect(screen.getByText("The release branch is ready.")).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("thinking_tokens");
  expect(document.body).not.toHaveTextContent("4096");
});

test("Large plans and file-change lists remain readable", async () => {
  context.mocks.http.get(`*/api/logs/${RUN_ID}`, () => {
    return HttpResponse.json(
      detail({ status: "completed", framework: "codex" }),
    );
  });
  const indexes = Array.from({ length: 25 }, (_, index) => {
    return index;
  });
  mockAgentEvents([
    {
      eventType: "turn.plan.updated",
      eventData: {
        type: "turn.plan.updated",
        plan: indexes.map((index) => {
          return { step: `Step ${index}`, status: "pending" };
        }),
      },
    },
    {
      eventType: "item.completed",
      eventData: {
        type: "item.completed",
        item: {
          id: "item-file-changes",
          type: "file_change",
          status: "completed",
          changes: indexes.map((index) => {
            return { path: `src/file-${index}.ts`, kind: "update" };
          }),
        },
      },
    },
  ]);

  await openActivity();

  await expect(screen.findByText(/Step 19$/mu)).resolves.toBeInTheDocument();
  const root = document.body;
  expect(root).toHaveTextContent("src/file-19.ts");
  expect(root).toHaveTextContent("+5 more steps");
  expect(root).toHaveTextContent("+5 more changes");
  expect(root).not.toHaveTextContent("Step 20");
  expect(root).not.toHaveTextContent("src/file-20.ts");
});

test("Activity search finds content inside nested work", async () => {
  completedActivity();
  const task = "toolu_task_audit";
  mockAgentEvents([
    {
      eventType: "system",
      eventData: {
        type: "system",
        subtype: "task_started",
        task_id: "task-audit",
        tool_use_id: task,
        description: "Audit the invoices",
      },
    },
    {
      eventType: "assistant",
      eventData: {
        type: "assistant",
        parent_tool_use_id: task,
        message: {
          content: [
            { type: "text", text: "Nested output: twelve invoices reviewed" },
          ],
        },
      },
    },
    {
      eventType: "assistant",
      eventData: {
        type: "assistant",
        parent_tool_use_id: task,
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_bash",
              name: "Bash",
              input: { command: "ls /secure" },
            },
          ],
        },
      },
    },
    {
      eventType: "user",
      eventData: {
        type: "user",
        parent_tool_use_id: task,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_bash",
              is_error: true,
              content: "Permission denied: /secure",
            },
          ],
        },
      },
    },
    {
      eventType: "system",
      eventData: {
        type: "system",
        subtype: "task_notification",
        task_id: "task-audit",
        status: "completed",
        summary: "Audit finished",
      },
    },
    {
      eventType: "assistant",
      eventData: {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_todo",
              name: "TodoWrite",
              input: {
                todos: [
                  {
                    content: "Email the finance team",
                    status: "pending",
                    activeForm: "Emailing the finance team",
                  },
                ],
              },
            },
          ],
        },
      },
    },
    {
      eventType: "assistant",
      eventData: {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Wrapping up the audit." }],
        },
      },
    },
  ]);
  await openActivity();
  await expect(
    screen.findByText("Wrapping up the audit."),
  ).resolves.toBeInTheDocument();
  const search = screen.getByPlaceholderText("Search steps");
  const root = document.body;

  // Each match keeps its step; nested matches keep their parent task.
  for (const [query, step] of [
    ["twelve invoices", "Audit the invoices"],
    ["Email the finance team", "Todo"],
    ["Permission denied", "Audit the invoices"],
  ] as const) {
    await fill(search, query);
    await waitFor(() => {
      expect(root).toHaveTextContent("(1/3 matched)");
    });
    expect(root).toHaveTextContent(query);
    expect(root).toHaveTextContent(step);
    expect(root).not.toHaveTextContent("Wrapping up the audit.");
  }

  await fill(search, "TodoWrite");

  await waitFor(() => {
    expect(root).toHaveTextContent("(0/3 matched)");
  });
  expect(root).not.toHaveTextContent("Email the finance team");
});
