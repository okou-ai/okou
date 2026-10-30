import {
  sharedThreadVisibilityContract,
  type SharedThreadAudience,
} from "@okouai/api-contracts/contracts/shared-thread-visibility";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
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
const FOLLOW_UP_PROMPT_EVENT_ID = "b0000000-0000-4000-a000-000000000806";
const PROMPT = "Summarize the launch plan";
const FOLLOW_UP_PROMPT = "Keep it short";
const ANSWER = "The launch plan has three phases.";

function mockConversation(
  chatEvents: MockChatEventInput[] = standardConversation(),
): void {
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

function requiredRadioNamed(name: string): HTMLElement {
  const group = screen.getByRole("radiogroup", { name: "Who can access" });
  const radio = queryAllByRoleFast("radio", group).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!radio) {
    throw new Error(`Radio not found: ${name}`);
  }
  return radio;
}

function selectionActionButtons(): HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    return ["c", "q", "f"].includes(
      button.getAttribute("aria-keyshortcuts") ?? "",
    );
  });
}

function selectAnswerText(): void {
  const answer = screen.getByText(ANSWER);
  const range = document.createRange();
  range.selectNodeContents(answer);
  const rect = new DOMRect(24, 24, 200, 24);
  Object.defineProperty(range, "getClientRects", {
    value: () => {
      return [rect];
    },
  });
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Text selection is unavailable");
  }
  fireEvent.pointerDown(answer, {
    button: 0,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  });
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  fireEvent.pointerUp(answer, {
    button: 0,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  });
  fireEvent.click(answer);
}

function clearAnswerSelection(): void {
  window.getSelection()?.removeAllRanges();
  fireEvent(document, new Event("selectionchange"));
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

// The row under a user bubble holds the space the next bubble in a burst is
// pulled into, so it is part of that message's frame rather than part of the
// copy button it usually carries. jsdom computes no layout, so the overlap this
// guards against has no page-observable form: the reserved row is the only
// evidence available for it, and the case is still worth covering because
// losing that row is exactly what put two bubbles on top of each other.
function nameLineSwitches(): Partial<Record<FeatureSwitchKey, boolean>> {
  return { [FeatureSwitchKey.ChatReplyNameLine]: true };
}

function userMessageFor(text: string): HTMLElement {
  const message = screen
    .getByText(text)
    .closest<HTMLElement>('[data-role="user"]');
  if (!message) {
    throw new Error(`User message not found: ${text}`);
  }
  return message;
}

function actionRowFor(text: string): HTMLElement | null {
  return userMessageFor(text).querySelector<HTMLElement>(
    "[data-chat-user-message-actions]",
  );
}

// Alongside the reserved row, the stacked marker is the only evidence of the
// pull itself, for the same reason: jsdom computes no layout.
function isStackedOnPrevious(text: string): boolean {
  return userMessageFor(text).dataset.chatUserMessageStacked !== undefined;
}

async function setupMessageSharing(
  chatEvents: MockChatEventInput[] = standardConversation(),
  featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>,
) {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const createRequests: string[][] = [];
  mockConversation(chatEvents);
  context.mocks.api(sharedThreadsContract.create, ({ body, respond }) => {
    createRequests.push([...body.eventIds]);
    return respond(201, { id: SHARED_THREAD_ID });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches,
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
        featureSwitches?.[FeatureSwitchKey.SharedThreadVisibility]
          ? "Choose who can view this conversation. Only you can change access."
          : "Selected messages and their attachments will be public.",
      ).length,
    ).toBeGreaterThan(0);
  });
  return {
    answerGroup: selectableGroupForText(ANSWER),
    clipboard,
    createRequests,
    promptGroup: selectableGroupForText(PROMPT),
  };
}

async function prepareGroupSelection(
  featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>,
) {
  const { promptGroup } = await setupMessageSharing(
    standardConversation(),
    featureSwitches,
  );
  const selection = within(promptGroup).getByRole("checkbox", {
    name: "Select message group",
  });
  return { promptGroup, selection };
}

async function expectOneSelectedGroup(selection: HTMLElement) {
  await waitFor(() => {
    expect(selection).toBeChecked();
    expect(selection).toHaveAccessibleName("Deselect message group");
    expect(requiredButtonNamed("Share").closest("footer")).toHaveTextContent(
      "1 selected",
    );
  });
}

async function expectNoSelectedGroups(selection: HTMLElement) {
  await waitFor(() => {
    expect(selection).not.toBeChecked();
    expect(selection).toHaveAccessibleName("Select message group");
    expect(requiredButtonNamed("Share")).toBeDisabled();
  });
}

test("The row label toggles a message group once", async () => {
  const { promptGroup, selection } = await prepareGroupSelection();
  expect(selection).not.toBeChecked();
  click(within(promptGroup).getByText("Select message group"));
  await expectOneSelectedGroup(selection);
  click(within(promptGroup).getByText("Deselect message group"));
  await expectNoSelectedGroups(selection);
});

test("With Agent name on replies, the selection column toggles a group and marks it as a whole", async () => {
  const { promptGroup, selection } =
    await prepareGroupSelection(nameLineSwitches());
  expect(promptGroup).not.toHaveAttribute("data-selected");
  click(within(promptGroup).getByText("Select message group"));
  await expectOneSelectedGroup(selection);
  expect(promptGroup).toHaveAttribute("data-selected");
  click(selection);
  await expectNoSelectedGroups(selection);
  expect(promptGroup).not.toHaveAttribute("data-selected");
});

test("The checkbox toggles a message group once", async () => {
  const user = userEvent.setup({ delay: null });
  const { selection } = await prepareGroupSelection();
  await user.click(selection);
  await expectOneSelectedGroup(selection);
  await user.click(selection);
  await expectNoSelectedGroups(selection);
  expect(selection).toHaveFocus();
});

test("Keyboard toggling preserves focus and the message group count", async () => {
  const user = userEvent.setup({ delay: null });
  const { selection } = await prepareGroupSelection();
  selection.focus();
  expect(selection).toHaveFocus();
  await user.keyboard(" ");
  await expectOneSelectedGroup(selection);
  expect(selection).toHaveFocus();
  await user.keyboard(" ");
  await expectNoSelectedGroups(selection);
  expect(selection).toHaveFocus();
});

test("Message text and code copying remain separate from group selection", async () => {
  const code = "const launch = true;";
  const conversation = standardConversation().map((event) => {
    return event.role === "assistant"
      ? {
          ...event,
          content: `${ANSWER}\n\n[Launch reference](https://example.com/launch)\n\n\`\`\`typescript\n${code}\n\`\`\``,
        }
      : event;
  });
  const { answerGroup, clipboard } = await setupMessageSharing(conversation);
  const selection = within(answerGroup).getByRole("checkbox");
  const link = queryAllByRoleFast("link", answerGroup).find((element) => {
    return element.textContent === "Launch reference";
  });
  if (!link) {
    throw new Error("Expected the launch reference link");
  }
  expect(link).toHaveAttribute("href", "https://example.com/launch");
  click(screen.getByText(ANSWER));
  click(requiredButtonNamed("Copy to clipboard"));
  await waitFor(() => {
    expect(requiredButtonNamed("Copied")).toBeInTheDocument();
  });
  expect(clipboard.writes).toStrictEqual([`${code}\n`]);
  expect(selection).not.toBeChecked();
  expect(requiredButtonNamed("Share")).toBeDisabled();

  click(within(answerGroup).getByText("Select message group"));
  await waitFor(() => {
    expect(selection).toBeChecked();
  });
  click(screen.getByText(ANSWER));
  expect(selection).toBeChecked();
  expect(requiredButtonNamed("Share").closest("footer")).toHaveTextContent(
    "1 selected",
  );
});

test("A growing selected message group becomes partial and can select its new messages", async () => {
  const user = userEvent.setup();
  const chatEvents: MockChatEventInput[] = standardConversation().slice(0, 1);
  const createRequests: string[][] = [];
  mockConversation(chatEvents);
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
  const group = selectableGroupForText(PROMPT);
  click(within(group).getByText("Select message group"));
  const selection = within(group).getByRole("checkbox");
  await waitFor(() => {
    expect(selection).toBeChecked();
  });

  act(() => {
    chatEvents.push({
      id: FOLLOW_UP_PROMPT_EVENT_ID,
      role: "user",
      content: FOLLOW_UP_PROMPT,
      runId: "launch-run",
      createdAt: "2026-08-01T10:00:01Z",
    });
    createChatEvent(THREAD_ID);
  });
  await screen.findByText(FOLLOW_UP_PROMPT);
  expect(selection).toBePartiallyChecked();
  click(within(group).getByText("Select message group"));
  await waitFor(() => {
    expect(selection).toBeChecked();
  });
  expect(selection).not.toBePartiallyChecked();
  expect(requiredButtonNamed("Share").closest("footer")).toHaveTextContent(
    "1 selected",
  );

  await user.click(selection);
  expect(selection).not.toBeChecked();
  expect(selection).not.toBePartiallyChecked();
  expect(requiredButtonNamed("Share")).toBeDisabled();

  await user.keyboard(" ");
  expect(selection).toBeChecked();
  expect(selection).not.toBePartiallyChecked();
  click(requiredButtonNamed("Share"));
  await screen.findByRole("textbox", { name: "Shared conversation link" });
  expect(createRequests).toStrictEqual([
    [PROMPT_EVENT_ID, FOLLOW_UP_PROMPT_EVENT_ID],
  ]);
});

test("Share selected message groups as a public conversation snapshot", async () => {
  const { answerGroup, promptGroup, clipboard, createRequests } =
    await setupMessageSharing();
  click(within(promptGroup).getByText("Select message group"));
  click(within(answerGroup).getByText("Select message group"));
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
  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([
    `https://app.okou.ai/share/threads/${SHARED_THREAD_ID}`,
  ]);
  expect(within(answerGroup).getByRole("checkbox")).toBeChecked();
  expect(within(answerGroup).getByRole("checkbox")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  click(within(answerGroup).getByText("Deselect message group"));
  expect(within(answerGroup).getByRole("checkbox")).toBeChecked();
  expect(screen.queryByTestId("chat-event-actions")).toBeNull();
});

test("Hide passage actions throughout sharing and restore them afterward", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockConversation();
  context.mocks.api(sharedThreadsContract.create, ({ respond }) => {
    return respond(201, { id: SHARED_THREAD_ID });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
  await screen.findByText(ANSWER);
  selectAnswerText();
  await waitFor(() => {
    expect(selectionActionButtons()).toHaveLength(3);
  });

  click(requiredButtonNamed("Share messages"));
  await screen.findAllByText("0 selected");
  expect(selectionActionButtons()).toHaveLength(0);

  clearAnswerSelection();
  selectAnswerText();
  expect(window.getSelection()?.toString()).toBe(ANSWER);
  expect(selectionActionButtons()).toHaveLength(0);
  const answerGroup = selectableGroupForText(ANSWER);
  expect(within(answerGroup).getByRole("checkbox")).not.toBeChecked();
  expect(requiredButtonNamed("Share")).toBeDisabled();

  click(within(answerGroup).getByText("Select message group"));
  await screen.findAllByText("1 selected");

  click(requiredButtonNamed("Share"));
  await screen.findByRole("textbox", { name: "Shared conversation link" });
  expect(clipboard.writes).toStrictEqual([
    `https://app.okou.ai/share/threads/${SHARED_THREAD_ID}`,
  ]);
  clearAnswerSelection();
  selectAnswerText();
  expect(selectionActionButtons()).toHaveLength(0);

  click(requiredButtonNamed("Close"));
  await waitFor(() => {
    expect(buttonsNamed("Share messages").length).toBeGreaterThan(0);
  });
  expect(selectionActionButtons()).toHaveLength(0);
  clearAnswerSelection();
  selectAnswerText();
  await waitFor(() => {
    expect(selectionActionButtons()).toHaveLength(3);
  });
});

async function startSharingBackToBackPrompts(
  featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  mockConversation([
    {
      id: PROMPT_EVENT_ID,
      role: "user",
      content: PROMPT,
      runId: "launch-run",
      createdAt: "2026-08-01T10:00:00Z",
    },
    {
      id: FOLLOW_UP_PROMPT_EVENT_ID,
      role: "user",
      content: FOLLOW_UP_PROMPT,
      runId: "launch-run",
      createdAt: "2026-08-01T10:00:01Z",
    },
    {
      id: ANSWER_EVENT_ID,
      role: "assistant",
      content: ANSWER,
      runId: "launch-run",
      createdAt: "2026-08-01T10:00:02Z",
    },
  ]);
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches,
  });

  await screen.findByText(FOLLOW_UP_PROMPT);
  expect(actionRowFor(PROMPT)).toBeInTheDocument();
  expect(actionRowFor(FOLLOW_UP_PROMPT)).toBeInTheDocument();
  expect(isStackedOnPrevious(FOLLOW_UP_PROMPT)).toBeTruthy();
  await waitFor(() => {
    expect(buttonsNamed("Share messages").length).toBeGreaterThan(0);
  });

  click(requiredButtonNamed("Share messages"));

  await waitFor(() => {
    expect(screen.getAllByText("0 selected").length).toBeGreaterThan(0);
  });
}

// Back-to-back user messages are pulled together by a negative margin sized
// against the row that sits under every bubble. Share selection hides the copy
// button in that row; when it took the row with it, the second bubble climbed
// into the first one and the two rendered on top of each other.
test("Back-to-back user messages keep their frame apart while sharing", async () => {
  await startSharingBackToBackPrompts();
  expect(actionRowFor(PROMPT)).toBeInTheDocument();
  expect(actionRowFor(FOLLOW_UP_PROMPT)).toBeInTheDocument();
  expect(isStackedOnPrevious(FOLLOW_UP_PROMPT)).toBeTruthy();
  expect(buttonsNamed("Copy message")).toHaveLength(0);
});

// With Agent name on replies, a selected group is tinted, so sharing drops the
// row and the pull measured against it together; a pull without its row would
// put the second bubble on top of the first.
test("With Agent name on replies, back-to-back user messages drop their pull with the copy row while sharing", async () => {
  await startSharingBackToBackPrompts(nameLineSwitches());
  expect(actionRowFor(PROMPT)).toBeNull();
  expect(actionRowFor(FOLLOW_UP_PROMPT)).toBeNull();
  expect(isStackedOnPrevious(FOLLOW_UP_PROMPT)).toBeFalsy();
  expect(buttonsNamed("Copy message")).toHaveLength(0);
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

test("A selected answer remains shareable after later turns move it outside the render window", async () => {
  const chatEvents: MockChatEventInput[] = [
    ...standardConversation(),
    {
      id: "launch-completed",
      role: "assistant",
      content: null,
      runId: "launch-run",
      runLifecycleEvent: "completed",
      createdAt: "2026-08-01T10:00:02Z",
    },
  ];
  const createRequests: string[][] = [];
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Growing launch conversation",
    chatEvents,
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
  const selection = within(selectableGroupForText(ANSWER)).getByRole(
    "checkbox",
  );
  click(selection);
  await waitFor(() => {
    expect(selection).toBeChecked();
    expect(requiredButtonNamed("Share").closest("footer")).toHaveTextContent(
      "1 selected",
    );
  });

  act(() => {
    for (let turn = 1; turn <= 12; turn++) {
      const minute = String(turn).padStart(2, "0");
      const runId = `later-run-${String(turn)}`;
      chatEvents.push(
        {
          id: `later-prompt-${String(turn)}`,
          role: "user",
          content: `Follow-up question ${String(turn)}`,
          runId,
          createdAt: `2026-08-01T10:${minute}:00Z`,
        },
        {
          id: `later-answer-${String(turn)}`,
          role: "assistant",
          content: `Follow-up answer ${String(turn)}`,
          runId,
          createdAt: `2026-08-01T10:${minute}:01Z`,
        },
        {
          id: `later-completed-${String(turn)}`,
          role: "assistant",
          content: null,
          runId,
          runLifecycleEvent: "completed",
          createdAt: `2026-08-01T10:${minute}:02Z`,
        },
      );
    }
    createChatEvent(THREAD_ID);
  });

  await screen.findByText("Follow-up answer 12");
  expect(screen.queryByText(ANSWER)).not.toBeInTheDocument();
  const shareButton = requiredButtonNamed("Share");
  expect(shareButton.closest("footer")).toHaveTextContent("1 selected");
  expect(shareButton).toBeEnabled();
  click(shareButton);

  await screen.findByRole("textbox", { name: "Shared conversation link" });
  expect(createRequests).toStrictEqual([[ANSWER_EVENT_ID]]);
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

  click(within(oversizedGroup).getByText("Select message group"));

  await screen.findByText("Select fewer messages to share");
  expect(oversizedSelection).not.toBeChecked();
  expect(screen.getByText("A normal message remains available")).toBeVisible();
});

async function setupSingleMessageShare(conflict = false) {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const response = context.mocks.deferred<void>();
  const createRequests: { eventIds: string[]; id: string | undefined }[] = [];
  mockConversation();
  context.mocks.api(sharedThreadsContract.create, async ({ body, respond }) => {
    createRequests.push({ eventIds: [...body.eventIds], id: body.id });
    await response.promise;
    if (conflict) {
      return respond(409, {
        error: {
          message: "A shared conversation with this ID already exists",
          code: "CONFLICT",
        },
      });
    }
    return respond(201, { id: body.id ?? SHARED_THREAD_ID });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
  await screen.findByText(ANSWER);
  await waitFor(() => {
    expect(buttonsNamed("Share message")).toHaveLength(1);
  });
  const share = requiredButtonNamed("Share message");
  return { clipboard, createRequests, response, share };
}

test("Share one answer with its prompt by copying the link before creating the share", async () => {
  const { clipboard, createRequests, response, share } =
    await setupSingleMessageShare();
  click(share);
  // The button confirms in the click; it waits for neither the share nor a toast.
  expect(clipboard.writes).toHaveLength(1);
  expect(buttonsNamed("Share link copied")).toHaveLength(1);
  await waitFor(() => {
    expect(createRequests).toHaveLength(1);
  });
  const [request] = createRequests;
  expect(request?.eventIds).toStrictEqual([PROMPT_EVENT_ID, ANSWER_EVENT_ID]);
  expect(clipboard.writes).toStrictEqual([
    `https://app.okou.ai/share/threads/${request?.id}`,
  ]);
  response.resolve();
});

test("Revert the button and report a dead copied link when creation fails", async () => {
  const { response, share } = await setupSingleMessageShare(true);
  click(share);
  expect(buttonsNamed("Share link copied")).toHaveLength(1);
  response.resolve();
  await expect(
    screen.findByText("The shared link could not be created."),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(buttonsNamed("Share message")).toHaveLength(1);
  });
});

test("Select an audience before creating a share and change it after creation", async () => {
  let audience: SharedThreadAudience = "organization";
  let revision = "b0000000-0000-4000-a000-000000000901";
  const created: (SharedThreadAudience | undefined)[] = [];
  const updates: SharedThreadAudience[] = [];
  context.mocks.api(sharedThreadVisibilityContract.get, ({ respond }) => {
    return respond(200, {
      id: SHARED_THREAD_ID,
      audience,
      revision,
      organization: { id: "org_mock", name: "Acme" },
    });
  });
  context.mocks.api(
    sharedThreadVisibilityContract.update,
    ({ body, respond }) => {
      expect(body.expectedRevision).toBe(revision);
      audience = body.audience;
      revision = "b0000000-0000-4000-a000-000000000902";
      updates.push(audience);
      return respond(200, {
        id: SHARED_THREAD_ID,
        audience,
        revision,
        organization: { id: "org_mock", name: "Acme" },
      });
    },
  );
  const { answerGroup } = await setupMessageSharing(standardConversation(), {
    [FeatureSwitchKey.SharedThreadVisibility]: true,
  });
  context.mocks.api(
    sharedThreadVisibilityContract.create,
    ({ body, respond }) => {
      created.push(body.audience);
      return respond(201, { id: SHARED_THREAD_ID });
    },
  );
  click(requiredButtonNamed("Who can access"));
  expect(requiredRadioNamed("Anyone with the link")).toBeChecked();
  click(requiredRadioNamed("Anyone at Default Org"));
  await userEvent.keyboard("{Escape}");
  click(within(answerGroup).getByText("Select message group"));
  click(requiredButtonNamed("Share"));
  await screen.findByRole("textbox", { name: "Shared conversation link" });
  expect(created).toStrictEqual(["organization"]);
  const footer = screen
    .getByRole("textbox", { name: "Shared conversation link" })
    .closest("footer")!;
  const manage = queryAllByRoleFast("button", footer).find((button) => {
    return button.getAttribute("aria-label") === "Share";
  });
  if (!manage) {
    throw new Error("Expected the conversation share menu");
  }
  click(manage);
  await waitFor(() => {
    expect(requiredRadioNamed("Anyone at Acme")).toBeChecked();
  });
  click(requiredRadioNamed("Anyone with the link"));
  await waitFor(() => {
    expect(requiredRadioNamed("Anyone with the link")).toBeChecked();
  });
  expect(updates).toStrictEqual(["public"]);
});

test("A message share starts public and exposes its access controls", async () => {
  mockConversation();
  const permissions = context.mocks.deferred<void>();
  const requests: (SharedThreadAudience | undefined)[] = [];
  context.mocks.browser.clipboardWriteText();
  context.mocks.api(
    sharedThreadVisibilityContract.create,
    ({ body, respond }) => {
      requests.push(body.audience);
      return respond(201, { id: body.id ?? SHARED_THREAD_ID });
    },
  );
  context.mocks.api(
    sharedThreadVisibilityContract.get,
    async ({ params, respond }) => {
      await permissions.promise;
      return respond(200, {
        id: params.id,
        audience: "public",
        revision: "b0000000-0000-4000-a000-000000000901",
        organization: { id: "org_mock", name: "Acme" },
      });
    },
  );
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.SharedThreadVisibility]: true },
  });
  await screen.findByText(ANSWER);
  await waitFor(() => {
    expect(buttonsNamed("Share message")).toHaveLength(1);
  });
  click(requiredButtonNamed("Share message"));
  await screen.findByRole("textbox", { name: "Shared conversation link" });
  expect(requests).toStrictEqual(["public"]);
  await screen.findByRole("status", { name: "Loading permissions" });
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  expect(buttonsNamed("Copy link")).toHaveLength(0);
  permissions.resolve();
  await waitFor(() => {
    expect(requiredRadioNamed("Anyone with the link")).toBeChecked();
  });
  expect(requiredButtonNamed("Copy link")).toBeEnabled();
  expect(screen.queryByText("0 selected")).not.toBeInTheDocument();
});

test("A visibility share fails without publishing when its API is unavailable", async () => {
  context.mocks.api(sharedThreadVisibilityContract.create, ({ respond }) => {
    return respond(404, { error: { code: "NOT_FOUND", message: "Not found" } });
  });
  const { answerGroup } = await setupMessageSharing(standardConversation(), {
    [FeatureSwitchKey.SharedThreadVisibility]: true,
  });
  click(within(answerGroup).getByText("Select message group"));
  click(requiredButtonNamed("Share"));
  await screen.findByText("Could not create the shared conversation.");
  expect(
    screen.queryByRole("textbox", { name: "Shared conversation link" }),
  ).not.toBeInTheDocument();
});
