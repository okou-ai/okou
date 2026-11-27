import {
  mockChatEventRows,
  normalizeMockChatEvents,
} from "./chat-event-test-helpers.ts";
import {
  chatThreadsContract,
  chatThreadEventsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow, mockMonotonicNow } from "../../../lib/time.ts";
import {
  testContext,
  chatEventRowsResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import { chatListThread } from "./chat-list-test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { threadLinkByTitle } from "./sidebar-test-helpers.tsx";
const context = testContext();
function feeds() {
  const thread = chatListThread(17, "Release review");
  const witness = chatListThread(18, "Build in progress");
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 917,
    threads: [thread, witness],
  });
  return {
    thread,
    witness,
    start: () => {
      return setupPage({
        context,
        ...pageOptions,
        path: "/",
      });
    },
  };
}
const notify = () => {
  return context.mocks.ably.trigger("chatIndicatorsChanged", {});
};
test("sidebar-controls-010 A pair of server changes updates Unread to Running and back on the home list without loading the conversation", async () => {
  const { thread, start } = feeds();
  let utc = Date.UTC(2026, 7, 20);
  mockNow(() => {
    return utc;
  }, context.signal);
  let monotonic = 8000;
  mockMonotonicNow(() => {
    return monotonic;
  }, context.signal);
  let status: "unread" | "active" = "unread";
  const warmed = context.mocks.deferred<string>();
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      warmed.resolve(params.threadId);
      return respond(200, chatEventRowsResponse([], query));
    },
  );
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      threads: { [thread.id]: status },
      unreadAt: status === "unread" ? { [thread.id]: thread.updatedAt } : {},
    });
  });
  await start();
  await screen.findByText(thread.title!);
  const link = threadLinkByTitle(thread.title!);
  await waitFor(() => {
    return expect(link).toHaveAccessibleName("Release review Unread");
  });
  status = "active";
  notify();
  await waitFor(() => {
    return expect(link).toHaveAccessibleName("Release review Running");
  });
  utc += 60_000;
  monotonic += 60_000;
  status = "unread";
  notify();
  await waitFor(() => {
    return expect(link).toHaveAccessibleName("Release review Unread");
  });
  expect(warmed.settled()).toBeFalsy();
});
test("sidebar-controls-012 A burst received during an unsuccessful leading refresh still exposes the latest unread chat", async () => {
  const { thread, witness, start } = feeds();
  const begun = context.mocks.deferred<void>(),
    held = context.mocks.deferred<void>();
  const latest = context.mocks.deferred<void>();
  let mode: "quiet" | "leading" | "latest" = "quiet";
  context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
    if (mode === "leading") {
      begun.resolve();
      await held.promise;
      return respond(503, {
        error: { code: "UNAVAILABLE", message: "Leading response unavailable" },
      });
    }
    if (mode === "latest" && !latest.settled()) {
      latest.resolve();
    }
    return respond(
      200,
      mode === "latest"
        ? {
            threads: { [thread.id]: "unread" },
            unreadAt: { [thread.id]: thread.updatedAt },
          }
        : { threads: { [witness.id]: "active" }, unreadAt: {} },
    );
  });
  try {
    await start();
    await screen.findByText(thread.title!);
    const link = threadLinkByTitle(thread.title!);
    expect(link).toHaveAccessibleName("Release review");
    await waitFor(() => {
      return expect(
        threadLinkByTitle("Build in progress"),
      ).toHaveAccessibleName("Build in progress Running");
    });
    mode = "leading";
    notify();
    await begun.promise;
    mode = "latest";
    for (let i = 0; i < 20; i++) {
      notify();
    }
    expect(link).toHaveAccessibleName("Release review");
    held.resolve();
    await latest.promise;
    await waitFor(() => {
      return expect(link).toHaveAccessibleName("Release review Unread");
    });
  } finally {
    if (!held.settled()) {
      held.resolve();
    }
  }
});

test("message-port-033 Unread and read-cursor updates leave the transcript alone until its next message arrives", async () => {
  const notes = continuityThread(922, 1, "Transit log");
  const flagged = continuityThread(922, 2, "Permit review");
  const labels = ["Train arrived", "Inspector signed"];
  const rows = mockChatEventRows(
    normalizeMockChatEvents(
      labels.map((content, index) => {
        return {
          role: "user" as const,
          content,
          seqId: index + 1,
          runId: crypto.randomUUID(),
          id: crypto.randomUUID(),
          createdAt: "2026-09-16T10:12:00Z",
        };
      }),
      notes.id,
    ),
  );
  const ws = installContinuityWorkspace(context, {
    caseId: 922,
    threads: [notes, flagged],
    chatEventRows: rows.slice(0, 1),
  });
  let unread = false;
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      threads: unread ? { [flagged.id]: "unread" } : {},
      unreadAt: unread ? { [flagged.id]: flagged.updatedAt } : {},
    });
  });
  let secondAvailable = false;
  const firstCatchUp = context.mocks.deferred<void>();
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    const events = Object.fromEntries(
      body.map(([id, after]) => {
        if (id === notes.id && !firstCatchUp.settled()) {
          firstCatchUp.resolve();
        }
        return [
          id,
          secondAvailable && id === notes.id
            ? rows.filter((row) => {
                return row.seqId > after;
              })
            : [],
        ];
      }),
    );
    return respond(200, { events, notFoundThreads: [] });
  });
  let elapsed = 5000;
  mockMonotonicNow(() => {
    return elapsed;
  }, context.signal);
  await setupPage({
    ...ws.pageOptions,
    context,
    path: "/chats/" + notes.id,
  });
  await screen.findByText("Train arrived");
  const permit = threadLinkByTitle("Permit review");
  unread = true;
  notify();
  await waitFor(() => {
    return expect(permit).toHaveAccessibleName("Permit review Unread");
  });
  unread = false;
  context.mocks.ably.trigger("chatThreadReadCursorUpdated", {
    threadId: flagged.id,
    readThroughSeqId: 1,
  });
  await waitFor(() => {
    return expect(permit).toHaveAccessibleName("Permit review");
  });
  expect(firstCatchUp.settled()).toBeFalsy();
  const topic = "chatThreadMessageCreated:" + notes.id;
  context.mocks.ably.trigger(topic, { threadId: notes.id });
  await firstCatchUp.promise;
  expect(screen.queryByText("Inspector signed")).toBeNull();
  elapsed += 2000;
  secondAvailable = true;
  ws.setChatEventRows(rows);
  context.mocks.ably.trigger(topic, { threadId: notes.id });
  await expect(
    screen.findByText("Inspector signed"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Train arrived")).toBeInTheDocument();
});
