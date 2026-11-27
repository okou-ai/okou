import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import {
  normalizeMockChatEvents,
  mockChatEventRows,
} from "./chat-event-test-helpers.ts";
import { promptEvent } from "./chat-run-test-fixtures.ts";
const context = testContext();
test("message-port-019 Split conversations receive the right rows when the second response finishes first", async () => {
  const chapters = ["Electrical upgrades", "Roof repair"].map(
    (title, index) => {
      const thread = continuityThread(804, index + 1, title);
      const text = "Instructions for " + title;
      const [row] = mockChatEventRows(
        normalizeMockChatEvents(
          [
            promptEvent({
              id: crypto.randomUUID(),
              runId: crypto.randomUUID(),
              seqId: 1,
              text,
            }),
          ],
          thread.id,
        ),
      );
      if (!row) {
        throw new Error("Missing transcript fixture");
      }
      return {
        thread,
        text,
        row,
        requested: context.mocks.deferred<void>(),
        released: context.mocks.deferred<void>(),
      };
    },
  );
  const [primary, side] = chapters;
  if (!primary || !side) {
    throw new Error("Two transcripts are required");
  }
  const workspace = installContinuityWorkspace(context, {
    caseId: 804,
    threads: [primary.thread, side.thread],
    chatEventRows: [],
  });
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ params, query, respond }) => {
      const match = chapters.find((c) => {
        return c.thread.id === params.threadId;
      });
      if (!match) {
        throw new Error("Unexpected thread");
      }
      if (query.sinceEventId) {
        return respond(200, {
          rows: [],
          cursor: {
            lastEventId: query.sinceEventId,
            lastSeqId: query.sinceSeqId,
          },
          hasMore: false,
        });
      }
      match.requested.resolve();
      await match.released.promise;
      return respond(200, {
        rows: [match.row],
        cursor: { lastEventId: match.row.id, lastSeqId: 1 },
        hasMore: false,
      });
    },
  );
  const page = await startPage({
    context,
    ...workspace.pageOptions,
    path: "/chats/" + primary.thread.id + "?sidebar=" + side.thread.id,
  });
  await Promise.all(
    chapters.map((c) => {
      return c.requested.promise;
    }),
  );
  side.released.resolve();
  await expect(screen.findByText(side.text)).resolves.toBeVisible();
  expect(screen.queryByText(primary.text)).toBeNull();
  primary.released.resolve();
  await page.ready;
  for (const chat of chapters) {
    const transcript = await screen.findByText(chat.text);
    expect(
      transcript.closest("[data-chat-thread-container-id]"),
    ).toHaveAttribute("data-chat-thread-container-id", chat.thread.id);
  }
});
