import { act, screen, waitFor, within } from "@testing-library/react";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const PROMPT_EVENT_ID = "b0000000-0000-4000-a000-000000000802";
const ANSWER_EVENT_ID = "b0000000-0000-4000-a000-000000000803";
const SHARED_THREAD_ID = "b0000000-0000-4000-a000-000000000804";
const GROUPED_ANSWER_EVENT_IDS = [
  "b0000000-0000-4000-a000-000000000811",
  "b0000000-0000-4000-a000-000000000812",
  "b0000000-0000-4000-a000-000000000813",
] as const;
const GROUPED_RUN_ID = "grouped-launch-run";
const PROMPT = "Summarize the launch plan";
const ANSWER = "The launch plan has three phases.";

function mockConversation(chatEvents = standardConversation()): void {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Launch planning",
    chatEvents,
  });
}

function standardConversation() {
  return [
    {
      id: PROMPT_EVENT_ID,
      role: "user" as const,
      content: PROMPT,
      runId: "launch-run",
      createdAt: "2026-08-01T10:00:00Z",
    },
    {
      id: ANSWER_EVENT_ID,
      role: "assistant" as const,
      content: ANSWER,
      runId: "launch-run",
      createdAt: "2026-08-01T10:00:01Z",
    },
  ];
}

function buttonsNamed(name: string): HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    return (
      button.getAttribute("aria-label") === name ||
      button.textContent?.trim() === name
    );
  });
}

function requiredButtonNamed(name: string): HTMLElement {
  const button = buttonsNamed(name)[0];
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function selectableGroupForText(text: string): HTMLElement {
  const group = screen
    .getByText(text)
    .closest<HTMLElement>("[data-chat-share-selectable-group]");
  if (!group) {
    throw new Error(`Selectable message group not found: ${text}`);
  }
  return group;
}

test("Share selected message groups as a public conversation snapshot", async () => {
  const createRequests: string[][] = [];
  mockConversation();
  context.mocks.api(sharedThreadsContract.create, ({ body, respond }) => {
    createRequests.push([...body.eventIds]);
    return respond(201, { id: SHARED_THREAD_ID });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await screen.findByText(PROMPT);
  await waitFor(() => {
    expect(buttonsNamed("Share messages").length).toBeGreaterThan(0);
  });

  click(requiredButtonNamed("Share messages"));

  await waitFor(() => {
    expect(screen.getAllByText("0 selected").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "Selected messages and their attachments will be public.",
      ).length,
    ).toBeGreaterThan(0);
  });
  const promptGroup = selectableGroupForText(PROMPT);
  const answerGroup = selectableGroupForText(ANSWER);
  const promptSelection = within(promptGroup).getByRole("checkbox", {
    name: "Select message group",
  });

  click(screen.getByText(PROMPT));
  await waitFor(() => {
    expect(promptSelection).toBeChecked();
    expect(promptSelection).toHaveAccessibleName("Deselect message group");
  });

  click(screen.getByText(PROMPT));
  await waitFor(() => {
    expect(promptSelection).not.toBeChecked();
    expect(promptSelection).toHaveAccessibleName("Select message group");
  });

  click(screen.getByText(PROMPT));
  click(screen.getByText(ANSWER));
  await waitFor(() => {
    expect(screen.getAllByText("2 selected").length).toBeGreaterThan(0);
    expect(requiredButtonNamed("Share")).toBeEnabled();
  });

  click(requiredButtonNamed("Share"));

  await waitFor(() => {
    expect(createRequests).toStrictEqual([[PROMPT_EVENT_ID, ANSWER_EVENT_ID]]);
  });
  const shareLink = await screen.findByRole("textbox", {
    name: "Shared conversation link",
  });
  expect(shareLink).toHaveValue(
    `https://app.okou.ai/share/threads/${SHARED_THREAD_ID}`,
  );
  expect(within(answerGroup).getByRole("checkbox")).toBeChecked();
  expect(screen.queryByTestId("chat-event-actions")).toBeNull();
});

test("Replacing a selected live answer clears it before the next answer is shared", async () => {
  const nextAnswerId = "b0000000-0000-4000-a000-000000000805";
  const nextAnswer = "The revised launch plan has four phases.";
  const chatEvents = standardConversation();
  const createRequests: string[][] = [];
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Live launch planning",
    chatEvents,
    activeRunIds: ["launch-run"],
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  context.mocks.api(sharedThreadsContract.create, ({ body, respond }) => {
    createRequests.push([...body.eventIds]);
    return respond(201, { id: SHARED_THREAD_ID });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await screen.findByText(ANSWER);
  await waitFor(() => {
    expect(buttonsNamed("Share messages").length).toBeGreaterThan(0);
  });
  click(requiredButtonNamed("Share messages"));

  const firstSelection = within(selectableGroupForText(ANSWER)).getByRole(
    "checkbox",
  );
  click(firstSelection);
  await waitFor(() => {
    expect(firstSelection).toBeChecked();
    expect(screen.getAllByText("1 selected").length).toBeGreaterThan(0);
  });

  act(() => {
    chatEvents.push({
      id: nextAnswerId,
      role: "assistant",
      content: nextAnswer,
      runId: "launch-run",
      createdAt: "2026-08-01T10:00:02Z",
    });
    createChatEvent(THREAD_ID);
  });

  await screen.findByText(nextAnswer);
  expect(screen.queryByText(ANSWER)).not.toBeInTheDocument();
  const nextSelection = within(selectableGroupForText(nextAnswer)).getByRole(
    "checkbox",
  );
  expect(nextSelection).not.toBeChecked();
  const shareButton = requiredButtonNamed("Share");
  expect.soft(shareButton.closest("footer")).toHaveTextContent("0 selected");
  expect.soft(shareButton).toBeDisabled();

  click(nextSelection);
  await waitFor(() => {
    expect(nextSelection).toBeChecked();
  });
  expect.soft(shareButton.closest("footer")).toHaveTextContent("1 selected");
  click(requiredButtonNamed("Share"));

  await screen.findByRole("textbox", { name: "Shared conversation link" });
  expect(createRequests).toStrictEqual([[nextAnswerId]]);
});

test.each(["running", "failed"] as const)(
  "Sharing a %s answer shows only its latest message and restores the expanded history on close",
  async (runStatus) => {
    const createRequests: string[][] = [];
    const error = "The provider could not complete the request.";
    const statusSelector =
      runStatus === "failed"
        ? "[data-chat-run-status-tail]"
        : "[data-thinking-indicator]";
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      threadTitle: "Grouped launch answer",
      chatEvents: [
        {
          id: PROMPT_EVENT_ID,
          role: "user",
          content: PROMPT,
          runId: GROUPED_RUN_ID,
          createdAt: "2026-08-01T10:00:00Z",
        },
        ...GROUPED_ANSWER_EVENT_IDS.map((id, index) => {
          return {
            id,
            role: "assistant" as const,
            content: `Launch answer ${String(index + 1)}`,
            runId: GROUPED_RUN_ID,
            createdAt: `2026-08-01T10:00:0${String(index + 1)}Z`,
          };
        }),
        ...(runStatus === "failed"
          ? [
              {
                id: "b0000000-0000-4000-a000-000000000814",
                eventType: "run.failed" as const,
                content: null,
                error,
                runId: GROUPED_RUN_ID,
                createdAt: "2026-08-01T10:00:04Z",
              },
            ]
          : []),
      ],
      activeRunIds: runStatus === "running" ? [GROUPED_RUN_ID] : [],
    });
    context.mocks.api(sharedThreadsContract.create, ({ body, respond }) => {
      createRequests.push([...body.eventIds]);
      return respond(201, { id: SHARED_THREAD_ID });
    });

    await setupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      host: "app.okou.ai",
    });

    await screen.findByText("Launch answer 3");
    expect(screen.queryByText("Launch answer 1")).toBeNull();
    expect(screen.queryByText("Launch answer 2")).toBeNull();
    click(requiredButtonNamed("Expand work history"));

    await screen.findByText("Launch answer 1");
    expect(screen.getByText("Launch answer 2")).toBeInTheDocument();
    expect(screen.getByTestId("chat-event-actions")).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector(statusSelector)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(buttonsNamed("Share messages").length).toBeGreaterThan(0);
    });
    click(requiredButtonNamed("Share messages"));

    const answerGroup = selectableGroupForText("Launch answer 3");
    const answerSelection = within(answerGroup).getByRole("checkbox", {
      name: "Select message group",
    });
    expect(screen.queryByText("Launch answer 1")).toBeNull();
    expect(screen.queryByText("Launch answer 2")).toBeNull();
    expect(buttonsNamed("Collapse work history")).toHaveLength(0);
    expect(buttonsNamed("Expand work history")).toHaveLength(0);
    expect(screen.queryByTestId("chat-event-actions")).toBeNull();
    expect(document.querySelector("[data-chat-run-work-history]")).toBeNull();
    expect(document.querySelector("[data-chat-run-status-tail]")).toBeNull();
    expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    expect(screen.queryByText(error)).toBeNull();
    click(answerSelection);

    await waitFor(() => {
      expect(screen.getAllByText("1 selected").length).toBeGreaterThan(0);
      expect(answerSelection).toBeChecked();
    });
    expect(
      document.querySelectorAll('[role="checkbox"][aria-checked="true"]'),
    ).toHaveLength(1);

    click(requiredButtonNamed("Share"));
    await screen.findByRole("textbox", { name: "Shared conversation link" });
    expect(createRequests).toStrictEqual([[GROUPED_ANSWER_EVENT_IDS.at(-1)]]);
    expect(screen.queryByTestId("chat-event-actions")).toBeNull();
    expect(screen.queryByText("Launch answer 1")).toBeNull();
    expect(document.querySelector("[data-chat-run-status-tail]")).toBeNull();

    click(requiredButtonNamed("Close"));

    await screen.findByText("Launch answer 1");
    expect(screen.getByText("Launch answer 2")).toBeInTheDocument();
    expect(screen.getByText("Launch answer 3")).toBeInTheDocument();
    expect(requiredButtonNamed("Collapse work history")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("chat-event-actions")).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector(statusSelector)).toBeInTheDocument();
    });
  },
);

test("Sharing while awaiting the first answer hides the run indicator until cancelled", async () => {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: standardConversation().slice(0, 1),
    activeRunIds: ["launch-run"],
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await screen.findByText(PROMPT);
  await waitFor(() => {
    expect(
      document.querySelector("[data-thinking-indicator]"),
    ).toBeInTheDocument();
  });
  click(requiredButtonNamed("Share messages"));

  const promptGroup = selectableGroupForText(PROMPT);
  expect(within(promptGroup).getByRole("checkbox")).toBeInTheDocument();
  expect(document.querySelector("[data-thinking-indicator]")).toBeNull();

  click(requiredButtonNamed("Cancel"));

  await waitFor(() => {
    expect(
      document.querySelector("[data-thinking-indicator]"),
    ).toBeInTheDocument();
  });
});

test("An oversized message group cannot be added to a shared snapshot", async () => {
  const oversizedBody = `Oversized message\n\n<!--${"界".repeat(524_289)}-->`;
  mockConversation([
    {
      id: PROMPT_EVENT_ID,
      role: "user",
      content: "A normal message remains available",
      runId: "oversized-run",
      createdAt: "2026-08-01T10:00:00Z",
    },
    {
      id: ANSWER_EVENT_ID,
      role: "assistant",
      content: oversizedBody,
      runId: "oversized-run",
      createdAt: "2026-08-01T10:00:01Z",
    },
  ]);
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await screen.findByText("A normal message remains available");
  await waitFor(() => {
    expect(buttonsNamed("Share messages").length).toBeGreaterThan(0);
  });
  click(requiredButtonNamed("Share messages"));

  await screen.findByText("Oversized message");
  const oversizedGroup = selectableGroupForText("Oversized message");
  const oversizedSelection = within(oversizedGroup).getByRole("checkbox", {
    name: "Select message group",
  });

  click(screen.getByText("Oversized message"));

  await screen.findByText("Select fewer messages to share");
  expect(oversizedSelection).not.toBeChecked();
  expect(screen.getByText("A normal message remains available")).toBeVisible();
});
