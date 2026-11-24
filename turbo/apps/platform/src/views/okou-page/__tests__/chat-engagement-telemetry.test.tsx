import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { buttonByText, setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  findWorkHistoryToggle,
  getWorkHistoryToggle,
} from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

vi.hoisted(() => {
  window.location.href = "https://app.okou.ai/";
});

beforeEach(() => {
  context.mocks.posthog();
});

function capturedEvents(eventName: string): unknown[][] {
  return context.mocks
    .posthog()
    .events.filter(({ name }) => {
      return name === eventName;
    })
    .map(({ name, properties }) => {
      return [name, properties];
    });
}

describe("chat engagement telemetry", () => {
  it("reports expanding active work history without reporting collapse", async () => {
    const threadId = "e7000000-0000-4000-a000-000000000101";
    mockChatLifecycle(context, {
      threadId,
      activeRunIds: ["run-active-work-telemetry"],
      chatEvents: [
        {
          id: "msg-active-work-user",
          role: "user",
          content: "Review the launch",
          runId: "run-active-work-telemetry",
          createdAt: "2026-09-04T10:00:00Z",
        },
        {
          id: "msg-active-work-hidden",
          role: "assistant",
          content: "Checking the launch brief.",
          runId: "run-active-work-telemetry",
          createdAt: "2026-09-04T10:00:10Z",
        },
        {
          id: "msg-active-work-details",
          role: "assistant",
          content: "Checking the launch details.",
          runId: "run-active-work-telemetry",
          createdAt: "2026-09-04T10:00:12Z",
        },
        {
          id: "msg-active-work-audience",
          role: "assistant",
          content: "Checking the launch audience.",
          runId: "run-active-work-telemetry",
          createdAt: "2026-09-04T10:00:14Z",
        },
        {
          id: "msg-active-work-schedule",
          role: "assistant",
          content: "Checking the launch schedule.",
          runId: "run-active-work-telemetry",
          createdAt: "2026-09-04T10:00:16Z",
        },
        {
          id: "msg-active-work-visible",
          role: "assistant",
          content: "Checking the launch metrics.",
          runId: "run-active-work-telemetry",
          createdAt: "2026-09-04T10:00:20Z",
        },
      ],
    });

    await setupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const expandWork = await findWorkHistoryToggle("collapsed");
    expect(screen.getByText(/^Working for /)).toBeVisible();
    expect(screen.queryByText("Checking the launch brief.")).toBeNull();

    click(expandWork);

    await waitFor(() => {
      expect(screen.getByText("Checking the launch brief.")).toBeVisible();
    });
    expect(capturedEvents("chat_work_history_expanded")).toStrictEqual([
      ["chat_work_history_expanded", { work_status: "active" }],
    ]);

    click(getWorkHistoryToggle("expanded"));

    await waitFor(() => {
      expect(screen.queryByText("Checking the launch brief.")).toBeNull();
    });
    expect(capturedEvents("chat_work_history_expanded")).toHaveLength(1);
  });

  it("reports expanding completed work history through the range control", async () => {
    const threadId = "e7000000-0000-4000-a000-000000000102";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-completed-work-user",
          role: "user",
          content: "Summarize the launch",
          runId: "run-completed-work-telemetry",
          createdAt: "2026-09-04T10:00:00Z",
        },
        {
          id: "msg-completed-work-hidden",
          role: "assistant",
          content: "Checking the launch notes.",
          runId: "run-completed-work-telemetry",
          createdAt: "2026-09-04T10:00:10Z",
        },
        {
          id: "msg-completed-work-details",
          role: "assistant",
          content: "Checking the launch details.",
          runId: "run-completed-work-telemetry",
          createdAt: "2026-09-04T10:00:12Z",
        },
        {
          id: "msg-completed-work-audience",
          role: "assistant",
          content: "Checking the launch audience.",
          runId: "run-completed-work-telemetry",
          createdAt: "2026-09-04T10:00:14Z",
        },
        {
          id: "msg-completed-work-schedule",
          role: "assistant",
          content: "Checking the launch schedule.",
          runId: "run-completed-work-telemetry",
          createdAt: "2026-09-04T10:00:16Z",
        },
        {
          id: "msg-completed-work-result",
          role: "assistant",
          content: "The launch summary is ready.",
          runId: "run-completed-work-telemetry",
          runLifecycleEvent: "completed",
          createdAt: "2026-09-04T10:00:20Z",
        },
      ],
    });

    await setupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const expandWork = await findWorkHistoryToggle("collapsed");
    expect(screen.getByText("Worked for 20 sec")).toBeVisible();

    click(expandWork);

    await expect(
      screen.findByText("Checking the launch notes."),
    ).resolves.toBeInTheDocument();
    expect(capturedEvents("chat_work_history_expanded")).toStrictEqual([
      ["chat_work_history_expanded", { work_status: "completed" }],
    ]);
  });

  it.each([
    { touch: false, layout: "rows" },
    { touch: true, layout: "quick-reply-rail" },
  ])(
    "reports recommendation frequency by kind in $layout",
    async ({ touch, layout }) => {
      context.mocks.browser.matchMedia((query) => {
        return touch && query === "(pointer: coarse)";
      });
      const threadId = "e7000000-0000-4000-a000-000000000103";
      const followupPrompt = "Create a presentation outline";
      const workflowPrompt = "Save this process as a workflow";
      const emailPrompt = "After I send it, notify me when they reply";
      mockChatLifecycle(context, {
        threadId,
        chatEvents: [
          {
            id: "msg-recommend-user",
            role: "user",
            content: "Package the launch plan",
            runId: "run-recommend-telemetry",
            createdAt: "2026-09-04T10:00:00Z",
          },
          {
            id: "msg-recommend-assistant",
            role: "assistant",
            content: "The launch plan is ready.",
            runId: "run-recommend-telemetry",
            createdAt: "2026-09-04T10:00:10Z",
          },
          {
            id: "msg-recommend-completed",
            role: "assistant",
            content: null,
            runId: "run-recommend-telemetry",
            runLifecycleEvent: "completed",
            followups: [
              {
                prompt: followupPrompt,
                kind: "generate",
                generationType: "presentation",
              },
              {
                prompt: workflowPrompt,
                kind: "workflow",
              },
              {
                prompt: emailPrompt,
                kind: "email",
              },
            ],
            createdAt: "2026-09-04T10:00:20Z",
          },
        ],
      });

      await setupPage({ context, path: `/chats/${threadId}` });

      click(
        await waitFor(() => {
          return buttonByText(followupPrompt);
        }),
      );

      click(buttonByText(workflowPrompt));
      click(buttonByText(emailPrompt));
      // Re-selecting existing draft text is another click, not another impression.
      click(buttonByText(workflowPrompt));

      expect(capturedEvents("chat_recommended_followups_shown")).toStrictEqual([
        [
          "chat_recommended_followups_shown",
          {
            chat_thread_id: threadId,
            assistant_message_id: "msg-recommend-completed:followups",
            followup_layout: layout,
            followup_count: 3,
            workflow_followup_count: 1,
            email_followup_count: 1,
            followup_kinds: ["generate", "workflow", "email"],
            generation_types: ["presentation"],
          },
        ],
      ]);
      expect(
        capturedEvents("chat_recommended_followup_selected"),
      ).toStrictEqual(
        [
          { index: 0, kind: "generate", generationType: "presentation" },
          { index: 1, kind: "workflow", generationType: undefined },
          { index: 2, kind: "email", generationType: undefined },
          { index: 1, kind: "workflow", generationType: undefined },
        ].map(({ index, kind, generationType }) => {
          return [
            "chat_recommended_followup_selected",
            {
              chat_thread_id: threadId,
              assistant_message_id: "msg-recommend-completed:followups",
              followup_layout: layout,
              followup_index: index,
              followup_count: 3,
              followup_kind: kind,
              generation_type: generationType,
            },
          ];
        }),
      );
    },
  );
});
