import { screen, waitFor } from "@testing-library/react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import {
  buttonByText,
  context,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";
import {
  findWorkHistoryToggle,
  getWorkHistoryToggle,
} from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

type Capture = (
  eventName: string,
  properties?: Record<string, unknown>,
) => void;
type Identify = (
  distinctId: string,
  properties?: Record<string, unknown>,
) => void;
type Init = (key: string, config?: unknown) => void;
type Register = (properties: Record<string, unknown>) => void;
type Reset = () => void;
type Unregister = (property: string) => void;

const { posthog } = vi.hoisted(() => {
  vi.stubEnv("VITE_POSTHOG_KEY", "phc_chat_engagement_telemetry_test");
  window.location.href = "https://app.okou.ai/";
  return {
    posthog: {
      capture: vi.fn<Capture>(),
      identify: vi.fn<Identify>(),
      init: vi.fn<Init>(),
      register: vi.fn<Register>(),
      reset: vi.fn<Reset>(),
      unregister: vi.fn<Unregister>(),
    },
  };
});

vi.mock("posthog-js/dist/module.slim", () => {
  return { posthog };
});

beforeEach(() => {
  posthog.capture.mockClear();
});

afterAll(() => {});

function capturedEvents(eventName: string): unknown[][] {
  return posthog.capture.mock.calls.filter(([capturedEventName]) => {
    return capturedEventName === eventName;
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

  it("reports the selected recommended follow-up", async () => {
    const threadId = "e7000000-0000-4000-a000-000000000103";
    const followupPrompt = "Create a presentation outline";
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
              prompt: "Draft launch copy",
              kind: "talk",
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

    expect(capturedEvents("chat_recommended_followup_selected")).toStrictEqual([
      [
        "chat_recommended_followup_selected",
        {
          assistant_message_id: "msg-recommend-completed:followups",
          followup_index: 0,
          followup_count: 2,
          followup_kind: "generate",
          generation_type: "presentation",
        },
      ],
    ]);
  });
});
