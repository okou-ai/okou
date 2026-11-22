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
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
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
        sharedWorkerTestTransport: "message-port",
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
