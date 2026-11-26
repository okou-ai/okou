import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SECOND_ATTACHMENT_THREAD_ID } from "./chat-attachment-test-helpers.ts";
import {
  continuityAttachment,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import {
  conversationEvents,
  mockChatGeometry,
  requiredElement,
} from "./chat-conversation-locator-test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
} from "./chat-event-test-helpers.ts";
import {
  findComposer,
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

test("chat-continuity-history-003 scrolling to the end then using Control Up restores the top of six turns", async () => {
  mockChatGeometry();
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: conversationEvents(6),
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Locator answer 6");
  const viewport = requiredElement(
    "[data-scroll-container]",
    requiredElement("[data-chat-thread-container-id]"),
  );
  await waitFor(() => {
    return expect(
      viewport.scrollTop + viewport.clientHeight,
    ).toBeGreaterThanOrEqual(viewport.scrollHeight);
  });
  fireEvent.wheel(viewport, { deltaY: -300 });
  viewport.scrollTop = 35;
  fireEvent.scroll(viewport);
  fireEvent.wheel(viewport, { deltaY: -34 });
  viewport.scrollTop = 1;
  fireEvent.scroll(viewport);
  click(await findFastControl("button", "Scroll to bottom"));
  await waitFor(() => {
    expect(viewport.scrollTop + viewport.clientHeight).toBeGreaterThanOrEqual(
      viewport.scrollHeight,
    );
    expect(queryFastControl("button", "Scroll to bottom")).toBeNull();
  });
  expect(screen.getByText("Locator answer 6")).toBeInTheDocument();
  viewport.focus();
  await userEvent.keyboard("{Control>}{ArrowUp}{/Control}");
  await waitFor(() => {
    return expect(viewport.scrollTop).toBe(0);
  });
  await expect(
    findFastControl("button", "Scroll to bottom"),
  ).resolves.toBeInTheDocument();
});
test("chat-continuity-history-001 opening a long history keeps its final repeated request anchored once", async () => {
  mockChatGeometry();
  const file = continuityAttachment(769, 1, "request.pdf", "application/pdf");
  const rows = conversationEvents(24);
  const events = rows.map((e, i) => {
    return e.role === "user" && i >= 22 && i < 44
      ? {
          ...e,
          content: "Prepare the same report",
          ...(i === 26
            ? {
                fileParts: [
                  {
                    type: "file" as const,
                    fileId: file.id,
                    filenameSnapshot: file.filename,
                    contentType: file.contentType,
                  },
                ],
              }
            : {}),
        }
      : e;
  });
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID, chatEvents: events });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Locator answer 24");
  const final = await screen.findByText("Locator answer 22");
  expect(screen.queryByText("Locator answer 11")).toBeNull();
  await expect(findComposer()).resolves.toBeEnabled();
  const anchor = final.closest<HTMLElement>(
    "[data-chat-scroll-anchor-event-id]",
  );
  expect(anchor).toBeInTheDocument();
  expect(
    document.querySelectorAll(
      '[data-chat-scroll-anchor-event-id="' +
        anchor!.dataset.chatScrollAnchorEventId +
        '"]',
    ),
  ).toHaveLength(1);
});

test("chat-continuity-history-006 acknowledging a steer replaces the main pending turn without writing the side pane", async () => {
  const side = SECOND_ATTACHMENT_THREAD_ID,
    gate = context.mocks.deferred<void>(),
    queued = context.mocks.deferred<string>();
  const text = "Steer this active run once";
  const runId = "a9000000-0000-4000-a000-000000000761";
  const lifecycle = mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    threadTitle: "Main plan",
    activeRunIds: [runId],
    chatEvents: [
      {
        id: "1ed06126-f705-43b6-8347-2807ee800101",
        role: "user",
        content: "Previous task",
        runId,
        createdAt: "2026-08-01T10:00:00Z",
      },
    ],
    appendGate: gate.promise,
    onQueuedEventAppend: (body) => {
      return queued.resolve(body.clientEventId);
    },
  });
  const mainRows = mockChatEventRows(
    normalizeMockChatEvents(
      [
        {
          id: "1ed06126-f705-43b6-8347-2807ee800101",
          role: "user",
          content: "Previous task",
          runId,
          createdAt: "2026-08-01T10:00:00Z",
        },
      ],
      RUN_THREAD_ID,
    ),
  );
  const sideRows = mockChatEventRows(
    normalizeMockChatEvents(
      [
        {
          id: "1ed06126-f705-43b6-8347-2807ee800102",
          role: "assistant",
          content: "Side answer",
          createdAt: "2026-08-01T10:01:00Z",
        },
      ],
      side,
    ),
  );
  const mainThread = {
    ...continuityThread(788, 1, "Main plan"),
    id: RUN_THREAD_ID,
  };
  const sideThread = { ...continuityThread(788, 2, "Side plan"), id: side };
  const view = installContinuityWorkspace(context, {
    caseId: 788,
    threads: [mainThread, sideThread],
    chatEventRows: [...mainRows, ...sideRows],
  });
  await setupPage({
    context,
    path: RUN_PATH + "?sidebar=" + side,
    ...view.pageOptions,
  });
  const other = (await screen.findByText("Side answer")).closest<HTMLElement>(
    "[data-chat-thread-container-id]",
  )!;
  const main = (await screen.findByText("Previous task")).closest<HTMLElement>(
    "[data-chat-thread-container-id]",
  )!;
  expect(main).toHaveAttribute("data-chat-thread-container-id", RUN_THREAD_ID);
  expect(other).toHaveAttribute("data-chat-thread-container-id", side);
  await findFastControl("button", /stop|interrupt/i, main);
  await fill(within(main).getByRole("textbox", { name: "Message" }), text);
  click(await findFastControl("button", "Send", main));
  const turn = await queued.promise;
  const pending = main.querySelectorAll("[data-role=user]");
  expect(
    Array.from(pending).filter((row) => {
      return row.textContent?.includes(text);
    }),
  ).toHaveLength(1);
  expect(within(other).queryByText(text)).toBeNull();
  gate.resolve();
  mainRows.push(
    ...mockChatEventRows(
      normalizeMockChatEvents(
        [
          {
            id: turn,
            seqId: 2,
            role: "user",
            content: text,
            runId,
            createdAt: "2026-08-01T10:02:00Z",
          },
          {
            id: "1ed06126-f705-43b6-8347-2807ee800104",
            seqId: 3,
            role: "assistant",
            content: "Acknowledged main steer",
            runId,
            createdAt: "2026-08-01T10:03:00Z",
          },
        ],
        RUN_THREAD_ID,
      ),
    ),
  );
  view.setChatEventRows([...mainRows, ...sideRows]);
  lifecycle.completeRun("Acknowledged main steer");
  await within(main).findByText("Acknowledged main steer");
  await waitFor(() => {
    expect(within(main).getAllByText(text)).toHaveLength(1);
    const match = main.querySelectorAll(
      '[data-chat-scroll-anchor-event-id="' + turn + '"]',
    );
    expect(match).toHaveLength(1);
    expect(match[0]).toHaveTextContent(text);
  });
  expect(within(other).queryByText(text)).toBeNull();
  expect(within(other).getByText("Side answer")).toBeInTheDocument();
});
