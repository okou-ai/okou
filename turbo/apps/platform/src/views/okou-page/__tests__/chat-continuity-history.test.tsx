import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  chatEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";
import {
  continuityEventRow,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();

interface CapturedSend {
  readonly clientEventId: string;
  readonly threadId: string;
  readonly userMessage: UserMessageDocument;
}

function textDocument(text: string): UserMessageDocument {
  return { version: 1, parts: [{ type: "text", text }] };
}

function promptRow(
  caseId: number,
  sequence: number,
  threadId: string,
  text: string,
  options: {
    readonly id?: string;
    readonly runId?: string;
    readonly runGroupId?: string;
    readonly revokesEventId?: string;
    readonly userMessage?: UserMessageDocument;
  } = {},
): ChatEventRow {
  const row = continuityEventRow(caseId, sequence, threadId, "input.prompt", {
    payload: { userMessage: options.userMessage ?? textDocument(text) },
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.runGroupId === undefined
      ? {}
      : { runGroupId: options.runGroupId }),
    ...(options.revokesEventId === undefined
      ? {}
      : { revokesEventId: options.revokesEventId }),
  });
  return options.id === undefined ? row : { ...row, id: options.id };
}

function outputRow(
  caseId: number,
  sequence: number,
  threadId: string,
  text: string,
  run: { readonly id: string; readonly groupId?: string },
): ChatEventRow {
  return continuityEventRow(caseId, sequence, threadId, "output.message", {
    payload: { content: text },
    runId: run.id,
    ...(run.groupId === undefined ? {} : { runGroupId: run.groupId }),
  });
}

function completedRow(
  caseId: number,
  sequence: number,
  threadId: string,
  runId: string,
): ChatEventRow {
  return continuityEventRow(caseId, sequence, threadId, "run.completed", {
    runId,
  });
}

function threadContainer(threadId: string): HTMLElement {
  const container = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  if (!container) {
    throw new Error(`Expected chat pane ${threadId}`);
  }
  return container;
}

function scrollContainer(threadId: string): HTMLElement {
  const scroller = threadContainer(threadId).querySelector<HTMLElement>(
    "[data-scroll-container]",
  );
  if (!scroller) {
    throw new Error(`Expected scroll container for ${threadId}`);
  }
  return scroller;
}

function setScrollableGeometry(
  scroller: HTMLElement,
  scrollHeight: number,
  clientHeight: number,
): void {
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: scrollHeight },
    clientHeight: { configurable: true, value: clientHeight },
  });
}

function eventAnchorCount(container: ParentNode, eventId: string): number {
  return container.querySelectorAll(
    `[data-chat-scroll-anchor-event-id="${eventId}"]`,
  ).length;
}

function userTurnCount(container: ParentNode, text: string): number {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-role="user"]'),
  ).filter((turn) => {
    return turn.textContent?.includes(text) === true;
  }).length;
}

function queuedMessage(container: ParentNode): HTMLElement | undefined {
  return (
    container.querySelector<HTMLElement>(
      '[role="listitem"][aria-label="Queued message"]',
    ) ?? undefined
  );
}

async function prepareLongGroupedConversation() {
  const thread = continuityThread(20, 1, "Long grouped history");
  const rows: ChatEventRow[] = [];
  let sequence = 1;
  const addPair = (
    prompt: string,
    response: string,
    runId: string,
    runGroupId?: string,
    userMessage?: UserMessageDocument,
  ): { readonly prompt: ChatEventRow; readonly response: ChatEventRow } => {
    const promptEvent = promptRow(20, sequence++, thread.id, prompt, {
      runId,
      ...(runGroupId === undefined ? {} : { runGroupId }),
      ...(userMessage === undefined ? {} : { userMessage }),
    });
    const responseEvent = outputRow(20, sequence++, thread.id, response, {
      id: runId,
      ...(runGroupId === undefined ? {} : { groupId: runGroupId }),
    });
    rows.push(promptEvent, responseEvent);
    return { prompt: promptEvent, response: responseEvent };
  };
  const earliest = addPair(
    "Earliest retained request",
    "Earliest retained answer",
    "history-run-earliest",
  );
  addPair("Older planning request", "Older planning answer", "history-run-2");
  addPair("Earlier review request", "Earlier review answer", "history-run-3");
  const beforeGroup = addPair(
    "Context before repeated work",
    "Neighboring answer before repeated work",
    "history-run-before-group",
  );
  const runGroupId = "launch-brief-group";
  addPair(
    "Build the launch brief from these references",
    "First launch brief result",
    "history-group-run-1",
    runGroupId,
  );
  addPair(
    "Build the launch brief from these references",
    "Second launch brief result",
    "history-group-run-2",
    runGroupId,
  );
  const latestGrouped = addPair(
    "Build the launch brief from these references",
    "Final launch brief is ready",
    "history-group-run-3",
    runGroupId,
    {
      version: 1,
      parts: [
        {
          type: "text",
          text: "Build the launch brief from these references",
        },
        {
          type: "file",
          fileId: "f8000000-0000-4000-a000-000000020001",
          filenameSnapshot: "launch-evidence.pdf",
          contentType: "application/pdf",
        },
      ],
    },
  );
  const afterGroup = addPair(
    "Review the final launch brief",
    "Neighboring answer after repeated work",
    "history-run-after-group",
  );
  addPair("Most recent follow-up", "Most recent answer", "history-run-recent");
  const workspace = installContinuityWorkspace(context, {
    caseId: 20,
    threads: [thread],
    chatEventRows: rows,
  });
  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  const container = threadContainer(thread.id);
  return {
    thread,
    composer,
    container,
    latestGrouped,
    earliest,
    beforeGroup,
    afterGroup,
  };
}

test("Render a long conversation with intact grouped messages", async () => {
  const { composer, container, latestGrouped } =
    await prepareLongGroupedConversation();
  await waitFor(() => {
    expect(container).toHaveTextContent("Final launch brief is ready");
    expect(container).toHaveTextContent(
      "Neighboring answer before repeated work",
    );
    expect(container).toHaveTextContent(
      "Neighboring answer after repeated work",
    );
    expect(container).toHaveTextContent("launch-evidence.pdf");
  });
  expect(composer).toBeVisible();
  expect(container).toHaveTextContent("First launch brief result");
  expect(container).toHaveTextContent("Second launch brief result");
  expect(container).not.toHaveTextContent("Earliest retained request");
  expect(eventAnchorCount(container, latestGrouped.response.id)).toBe(1);
});

test("Page older conversation history without losing grouped-run anchors", async () => {
  const { thread, container, earliest, beforeGroup, afterGroup } =
    await prepareLongGroupedConversation();
  await waitFor(() => {
    expect(container).toHaveTextContent("Final launch brief is ready");
  });
  expect(container).not.toHaveTextContent("Earliest retained request");
  const scroller = scrollContainer(thread.id);
  setScrollableGeometry(scroller, 2400, 600);
  scroller.scrollTop = 50;
  fireEvent.scroll(scroller);
  await waitFor(() => {
    expect(container).toHaveTextContent("Earliest retained request");
    expect(container).toHaveTextContent("Earliest retained answer");
  });
  expect(eventAnchorCount(container, earliest.prompt.id)).toBe(1);
  expect(eventAnchorCount(container, beforeGroup.prompt.id)).toBe(1);
  expect(eventAnchorCount(container, afterGroup.response.id)).toBe(1);
});

test("Navigate chat history with scroll controls and keyboard commands", async () => {
  const thread = continuityThread(21, 1, "Scrollable conversation");
  const rows: ChatEventRow[] = [];
  for (let index = 1; index <= 6; index++) {
    const runId = `scroll-run-${index.toString()}`;
    rows.push(
      promptRow(21, index * 2 - 1, thread.id, `History request ${index}`, {
        runId,
      }),
      outputRow(21, index * 2, thread.id, `History answer ${index}`, {
        id: runId,
      }),
    );
  }
  const workspace = installContinuityWorkspace(context, {
    caseId: 21,
    threads: [thread],
    chatEventRows: rows,
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  const container = threadContainer(thread.id);
  await waitFor(() => {
    expect(container).toHaveTextContent("History answer 6");
  });
  const scroller = scrollContainer(thread.id);
  setScrollableGeometry(scroller, 2400, 600);
  scroller.scrollTop = 2400;

  scroller.scrollTop = 800;
  fireEvent.scroll(scroller);
  await waitFor(() => {
    expect(container.querySelector("[data-scroll-to-bottom]")).toBeVisible();
  });

  click(fastButton("Scroll to bottom", container));
  await waitFor(() => {
    expect(scroller.scrollTop).toBe(2400);
    expect(container.querySelector("[data-scroll-to-bottom]")).toBeNull();
  });
  expect(container).toHaveTextContent("History answer 6");

  container.focus();
  await userEvent.keyboard("{Control>}{ArrowUp}{/Control}");
  await waitFor(() => {
    expect(scroller.scrollTop).toBe(0);
    expect(container.querySelector("[data-scroll-to-bottom]")).toBeVisible();
  });

  composer.focus();
  await userEvent.keyboard("{Control>}{ArrowDown}{/Control}");
  await waitFor(() => {
    expect(scroller.scrollTop).toBe(2400);
    expect(container.querySelector("[data-scroll-to-bottom]")).toBeNull();
  });

  await fill(composer, "Arrow remains available while editing");
  const bottomOffset = scroller.scrollTop;
  await userEvent.keyboard("{ArrowUp}");
  expect(composer).toHaveTextContent("Arrow remains available while editing");
  expect(scroller.scrollTop).toBe(bottomOffset);
});

test("Keep both open chats live without mixing their messages", async () => {
  const main = continuityThread(22, 1, "Live main conversation");
  const side = continuityThread(22, 2, "Live side conversation");
  const mainRunId = "b9000000-0000-4000-a000-000000000001";
  const sideRunId = "b9000000-0000-4000-a000-000000000002";
  const initialRows = [
    promptRow(22, 1, main.id, "Existing main request", { runId: mainRunId }),
    outputRow(22, 2, main.id, "Existing main answer", { id: mainRunId }),
    promptRow(22, 1, side.id, "Existing side request", { runId: sideRunId }),
    outputRow(22, 2, side.id, "Existing side answer", { id: sideRunId }),
  ];
  const workspace = installContinuityWorkspace(context, {
    caseId: 22,
    threads: [main, side],
    chatEventRows: initialRows,
  });

  await setupPage({
    context,
    path: `/chats/${main.id}?sidebar=${side.id}`,
    ...workspace.pageOptions,
  });

  await waitFor(() => {
    expect(threadContainer(main.id)).toHaveTextContent("Existing main answer");
    expect(threadContainer(side.id)).toHaveTextContent("Existing side answer");
  });
  const mainContainer = threadContainer(main.id);
  const sideContainer = threadContainer(side.id);

  const mainReply = outputRow(
    22,
    3,
    main.id,
    "A live reply for the main conversation",
    { id: mainRunId },
  );
  const sideReply = outputRow(
    22,
    3,
    side.id,
    "A live reply for the side conversation",
    { id: sideRunId },
  );
  workspace.setChatEventRows([...initialRows, mainReply, sideReply]);
  createChatEvent(main.id);
  createChatEvent(side.id);

  await waitFor(() => {
    expect(mainContainer).toHaveTextContent(
      "A live reply for the main conversation",
    );
    expect(sideContainer).toHaveTextContent(
      "A live reply for the side conversation",
    );
  });
  expect(mainContainer).not.toHaveTextContent(
    "A live reply for the side conversation",
  );
  expect(sideContainer).not.toHaveTextContent(
    "A live reply for the main conversation",
  );
  expect(mainContainer).toBeVisible();
  expect(sideContainer).toBeVisible();
});

test.each([
  {
    caseId: 220,
    scenario: "a new run",
    activeRun: false,
    message: "Send this exactly once",
  },
  {
    caseId: 221,
    scenario: "an active run",
    activeRun: true,
    message: "Steer this active run once",
  },
])(
  "Confirm a message for $scenario in split chats without duplicating it",
  async ({ caseId, activeRun, message }) => {
    const thread = continuityThread(caseId, 1, "Message confirmation");
    const side = continuityThread(caseId, 2, "Independent side conversation");
    const initialRunId = "b9000000-0000-4000-a000-000000000001";
    const sideRunId = "b9000000-0000-4000-a000-000000000003";
    const confirmedRunId = activeRun
      ? initialRunId
      : "b9000000-0000-4000-a000-000000000002";
    const mainRows = [
      promptRow(caseId, 1, thread.id, "Existing request", {
        runId: initialRunId,
      }),
      outputRow(caseId, 2, thread.id, "Existing answer", { id: initialRunId }),
      ...(activeRun ? [] : [completedRow(caseId, 3, thread.id, initialRunId)]),
    ];
    const initialRows = [
      ...mainRows,
      promptRow(caseId, 1, side.id, "Existing side request", {
        runId: sideRunId,
      }),
      outputRow(caseId, 2, side.id, "Existing side answer", { id: sideRunId }),
    ];
    const workspace = installContinuityWorkspace(context, {
      caseId,
      threads: [thread, side],
      chatEventRows: initialRows,
    });
    const send = context.mocks.deferred<CapturedSend>();
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      if (
        !("userMessage" in body) ||
        body.userMessage === undefined ||
        body.clientEventId === undefined ||
        body.threadId === undefined
      ) {
        throw new Error("Expected a normal chat message send");
      }
      send.resolve({
        clientEventId: body.clientEventId,
        threadId: body.threadId,
        userMessage: body.userMessage,
      });
      return respond(201, {
        runId: activeRun ? null : confirmedRunId,
        threadId: body.threadId,
      });
    });

    await setupPage({
      context,
      path: `/chats/${thread.id}?sidebar=${side.id}`,
      ...workspace.pageOptions,
    });

    await waitFor(() => {
      expect(threadContainer(thread.id)).toHaveTextContent("Existing answer");
      expect(threadContainer(side.id)).toHaveTextContent(
        "Existing side answer",
      );
    });
    const container = threadContainer(thread.id);
    const sideContainer = threadContainer(side.id);
    const composer = await within(container).findByLabelText("Message");
    const sideComposer = await within(sideContainer).findByLabelText("Message");
    expect(sideComposer).toBeVisible();

    expect(
      container.querySelectorAll('button[aria-label="Stop"]'),
    ).toHaveLength(activeRun ? 1 : 0);

    await fill(composer, message);
    await waitFor(() => {
      expect(fastButton("Send", container)).toBeEnabled();
    });
    click(fastButton("Send", container));
    const sent = await send.promise;
    await waitFor(() => {
      expect(userTurnCount(container, message)).toBe(1);
    });
    expect(sent.threadId).toBe(thread.id);
    expect(sideContainer).not.toHaveTextContent(message);

    const confirmedPrompt = promptRow(
      caseId,
      mainRows.length + 2,
      thread.id,
      message,
      {
        runId: confirmedRunId,
        revokesEventId: sent.clientEventId,
        userMessage: sent.userMessage,
      },
    );
    workspace.setChatEventRows([
      ...initialRows,
      promptRow(caseId, mainRows.length + 1, thread.id, message, {
        id: sent.clientEventId,
        userMessage: sent.userMessage,
      }),
      confirmedPrompt,
      outputRow(
        caseId,
        mainRows.length + 3,
        thread.id,
        "Assistant acknowledged the message",
        { id: confirmedRunId },
      ),
    ]);
    createChatEvent(thread.id);

    await waitFor(() => {
      expect(container).toHaveTextContent("Assistant acknowledged the message");
    });
    expect(userTurnCount(container, message)).toBe(1);
    expect(eventAnchorCount(container, confirmedPrompt.id)).toBe(1);
    expect(eventAnchorCount(container, sent.clientEventId)).toBe(0);
    expect(queuedMessage(container)).toBeUndefined();
    expect(container).toBeVisible();
    expect(sideContainer).toBeVisible();
    expect(sideContainer).toHaveTextContent("Existing side answer");
    expect(sideContainer).not.toHaveTextContent(message);
    expect(sideContainer).not.toHaveTextContent(
      "Assistant acknowledged the message",
    );
  },
);
