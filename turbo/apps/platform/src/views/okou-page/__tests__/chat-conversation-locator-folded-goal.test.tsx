import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import {
  conversationEvents,
  messageAnchor,
  messageOffset,
  mockChatGeometry,
  requiredElement,
  VIEWPORT_HEIGHT,
} from "./chat-conversation-locator-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  chatScrollContainer,
  context,
  mockChatLifecycleWithoutBrowserSession,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000828";

function foldedRunWorkConversation(): MockChatEventInput[] {
  const triggerRunId = "locator-run-work-trigger";
  const goalRunId = "locator-run-work-goal";
  const goalGroupId = "locator-run-work-goal-group";
  return [
    ...conversationEvents(7),
    {
      id: "locator-work-question",
      role: "user",
      content: "Review the deployment",
      runId: triggerRunId,
      createdAt: "2026-08-01T12:00:00.000Z",
    },
    {
      id: "locator-work-early",
      role: "assistant",
      content: "Checked the first deployment region",
      runId: triggerRunId,
      createdAt: "2026-08-01T12:00:20.000Z",
    },
    {
      id: "locator-work-middle",
      role: "assistant",
      content: "Checked the second deployment region",
      runId: triggerRunId,
      createdAt: "2026-08-01T12:00:40.000Z",
    },
    {
      id: "locator-work-trigger-complete",
      role: "assistant",
      content: null,
      runId: triggerRunId,
      runLifecycleEvent: "completed",
      createdAt: "2026-08-01T12:00:41.000Z",
    },
    {
      id: "locator-work-goal-continuation",
      role: "user",
      eventType: "input.prompt",
      content: null,
      runId: goalRunId,
      runGroupId: goalGroupId,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "goal",
            goalBrief: "Keep checking the deployment regions",
          },
        ],
      },
      createdAt: "2026-08-01T12:00:50.000Z",
    },
    {
      id: "locator-work-final",
      role: "assistant",
      content: "All deployment regions are healthy",
      runId: goalRunId,
      runGroupId: goalGroupId,
      createdAt: "2026-08-01T12:01:00.000Z",
    },
    {
      id: "locator-work-complete",
      role: "assistant",
      content: null,
      runId: goalRunId,
      runGroupId: goalGroupId,
      runLifecycleEvent: "completed",
      createdAt: "2026-08-01T12:01:01.000Z",
    },
  ];
}

test("folded goal continuations do not create locator markers", async () => {
  const user = userEvent.setup();
  mockChatGeometry();
  mockChatLifecycleWithoutBrowserSession({
    threadId: THREAD_ID,
    threadTitle: "Run work locator",
    chatEvents: foldedRunWorkConversation(),
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await screen.findByText("All deployment regions are healthy");
  const container = chatScrollContainer();
  expect(
    within(container).queryByText("Checked the first deployment region"),
  ).not.toBeInTheDocument();
  expect(
    within(container).queryByText("Keep checking the deployment regions"),
  ).not.toBeInTheDocument();

  fireEvent.scroll(container);
  const rail = requiredElement("[data-conversation-locator]");
  await waitFor(() => {
    // Seven earlier requests and the real trigger remain visible user turns.
    expect(rail.querySelectorAll("[data-locator-tick]")).toHaveLength(8);
  });

  await user.pointer({
    target: rail,
    coords: { clientX: 12, clientY: VIEWPORT_HEIGHT / 2 + 35 },
  });
  const preview = requiredElement("[data-conversation-locator-preview]");
  await waitFor(() => {
    expect(preview).toHaveTextContent("Review the deployment");
    expect(preview).not.toHaveTextContent(
      "Keep checking the deployment regions",
    );
  });
  click(rail);

  await waitFor(() => {
    expect(messageOffset("Review the deployment", container)).toBeCloseTo(168);
    expect(
      messageAnchor("Review the deployment", container).querySelector(
        "[data-locator-landed]",
      ),
    ).toBeInTheDocument();
  });
});
