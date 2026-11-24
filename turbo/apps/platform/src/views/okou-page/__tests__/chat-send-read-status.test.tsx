import { chatListThread } from "./chat-list-test-helpers.ts";
import { threadLinkByTitle } from "./sidebar-test-helpers.tsx";
import { mockNow } from "../../../lib/time.ts";
import { changeChatIndicators } from "../../../mocks/mock-helpers.ts";
import {
  chatThreadMarkReadContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import {
  startPage,
  setupPage,
  click,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  findEnabledButton,
  RUN_THREAD_ID,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
function timeline() {
  const delivered: string[] = [];
  const lifecycle = mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    threadTitle: "Release room",
    chatEvents: [
      {
        role: "assistant",
        content: "The last review ended",
        runId: "99100000-0000-4000-a000-000000000001",
        createdAt: "2026-08-11T18:00:00Z",
      },
    ],
    onRunCreate(body) {
      if (body.prompt) {
        delivered.push(body.prompt);
      }
    },
  });
  return { lifecycle, delivered };
}
async function send(text: string) {
  const editor = await findComposerEditor();
  await fill(editor, text);
  click(await findEnabledButton("Send"));
  return editor;
}
test("chat-send-read-status-005 an unauthorized mark on a completed review leaves its composer available for the next request", async () => {
  const { delivered } = timeline(),
    answered = context.mocks.deferred<string>();
  context.mocks.api(
    chatThreadMarkReadContract.markRead,
    ({ params, respond }) => {
      if (!answered.settled()) {
        answered.resolve(params.id);
      }
      return respond(401, {
        error: { code: "UNAUTHORIZED", message: "Read status denied" },
      });
    },
  );
  const page = await startPage({ context, path: RUN_PATH });
  await expect(page.ready).rejects.toMatchObject({ status: 401 });
  await screen.findByText("The last review ended");
  await expect(answered.promise).resolves.toBe(RUN_THREAD_ID);
  const text = "Review the deployment risks",
    editor = await send(text);
  await waitFor(() => {
    expect(delivered).toContain(text);
    expect(editor.textContent).toBe("");
  });
});

test.each([
  ["chat-send-read-status-002", "delivered"],
  ["Withheld control", "withheld"],
] as const)(
  "%s A conversation accepts both messages while an unauthorized indicator response is %s",
  async (_case, schedule) => {
    const { lifecycle, delivered } = timeline();
    const requested = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const received = context.mocks.deferred<void>();
    let monitor = false;
    const parse = Response.prototype.json;
    vi.spyOn(Response.prototype, "json").mockImplementation(async function (
      this: Response,
    ) {
      const body: unknown = await parse.call(this);
      if (
        this.status === 401 &&
        new URL(this.url).pathname === chatThreadsContract.indicators.path &&
        !received.settled()
      ) {
        received.resolve();
      }
      return body;
    });
    context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
      if (!monitor) {
        return respond(200, { threads: {}, unreadAt: {} });
      }
      if (!requested.settled()) {
        requested.resolve();
      }
      await release.promise;
      return respond(401, {
        error: { code: "UNAUTHORIZED", message: "Indicator refresh denied" },
      });
    });
    await setupPage({ context, path: RUN_PATH });
    await screen.findByText("The last review ended");
    monitor = true;
    changeChatIndicators();
    await requested.promise;
    const first = "Continue the release review";
    const editor = await send(first);
    await screen.findByText(first, { selector: "[data-role=user] *" });
    await waitFor(() => {
      return expect(delivered).toContain(first);
    });
    if (schedule === "delivered") {
      release.resolve();
      await received.promise;
    }
    lifecycle.completeRun("The release window is clear.");
    await screen.findByText("The release window is clear.");
    expect(editor.textContent).toBe("");
    const follow = "Record the remaining checks";
    await fill(editor, follow);
    await waitFor(() => {
      return expect(editor.textContent).toBe(follow);
    });
    expect(received.settled()).toBe(schedule === "delivered");
    expect(delivered).toStrictEqual([first]);
    if (!release.settled()) {
      release.resolve();
    }
    await received.promise;
    click(await findEnabledButton("Send"));
    await waitFor(() => {
      return expect(delivered).toStrictEqual([first, follow]);
    });
    await screen.findByText(follow, { selector: "[data-role=user] *" });
  },
);

test("Reading a newer completed run clears its unread state even while the sidebar has an older update", async () => {
  const thread = "Harbor review";
  const follow = crypto.randomUUID();
  const listStamp = "2026-03-10T00:06:00.000Z";
  const initialRead = "2026-03-10T00:06:30.000Z";
  const finished = "2026-03-10T00:07:00.000Z";
  let terminal = initialRead;
  let read: string | null = null;
  let published = listStamp;
  mockNow(new Date(finished), context.signal);
  const service = mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    threadTitle: thread,
    activeRunIds: [follow],
    chatEvents: [
      {
        role: "user",
        content: "Review the harbor",
        runId: follow,
        createdAt: listStamp,
      },
    ],
  });
  const witness = chatListThread(19, "Pilot dispatch");
  service.setThreadList([
    { ...chatListThread(18, thread), id: RUN_THREAD_ID },
    witness,
  ]);
  const first = context.mocks.deferred<void>();
  const caughtUp = context.mocks.deferred<void>();
  const received = context.mocks.deferred<void>();
  const parse = Response.prototype.json;
  vi.spyOn(Response.prototype, "json").mockImplementation(async function (
    this: Response,
  ) {
    const body: unknown = await parse.call(this);
    if (
      this.status === 200 &&
      this.url &&
      new URL(this.url).pathname === chatThreadsContract.indicators.path &&
      !received.settled()
    ) {
      const result =
        chatThreadsContract.indicators.responses[200].safeParse(body);
      if (result.success && result.data.threads[witness.id] === "unread") {
        received.resolve();
      }
    }
    return body;
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    const unread = read === null || read < published;
    return respond(200, {
      threads: {
        ...(unread ? { [RUN_THREAD_ID]: "unread" as const } : {}),
        ...(published === finished ? { [witness.id]: "unread" as const } : {}),
      },
      unreadAt: {
        [RUN_THREAD_ID]: published,
        ...(published === finished ? { [witness.id]: finished } : {}),
      },
    });
  });
  context.mocks.api(
    chatThreadMarkReadContract.markRead,
    ({ params, respond }) => {
      expect(params.id).toBe(RUN_THREAD_ID);
      read = terminal;
      if (!first.settled()) {
        first.resolve();
      }
      if (read === finished && !caughtUp.settled()) {
        caughtUp.resolve();
      }
      return respond(200, { lastReadAt: read });
    },
  );
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Review the harbor", {
    selector: "[data-role=user] *",
  });
  await first.promise;
  terminal = finished;
  service.completeRun("Harbor inspection complete");
  await screen.findByText("Harbor inspection complete");
  await caughtUp.promise;
  published = finished;
  changeChatIndicators();
  await received.promise;
  await waitFor(() => {
    expect(threadLinkByTitle("Pilot dispatch")).toHaveAccessibleName(
      "Pilot dispatch Unread",
    );
    expect(threadLinkByTitle(thread)).toHaveAccessibleName(thread);
  });
});
