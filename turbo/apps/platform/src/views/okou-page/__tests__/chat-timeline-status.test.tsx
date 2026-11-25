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
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  promptEvent,
} from "./chat-run-test-fixtures.ts";
import { type MockChatEventInput } from "./chat-event-test-helpers.ts";

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

function stamp(day: number, hour: number, minute: number) {
  return new Date(2026, 9, day, hour, minute).toISOString();
}
async function open(events: MockChatEventInput[]) {
  mockNow(new Date(2026, 9, 28, 12), context.signal);
  createChatRunFixtures(context).installRunChat({ chatEvents: events });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
}
function appearsBefore(first: Element, second: Element) {
  return Boolean(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}
test("chat-thread-timeline-002 a thread containing only this morning's message needs no Today divider", async () => {
  const runId = crypto.randomUUID(),
    createdAt = stamp(28, 8, 12);
  await open([
    promptEvent({
      id: "today-note",
      runId,
      seqId: 1,
      text: "Morning reconciliation",
      createdAt,
    }),
    completedEvent({ id: "today-finished", runId, seqId: 2, createdAt }),
  ]);
  await screen.findByText("Morning reconciliation");
  expect(screen.queryByRole("separator", { name: "Today" })).toBeNull();
});
test("chat-thread-timeline-004 a turn crossing midnight places today's divider before the early user message", async () => {
  const runId = crypto.randomUUID(),
    late = stamp(27, 23, 59),
    early = stamp(28, 0, 1);
  await open([
    promptEvent({
      id: "late-request",
      runId,
      seqId: 1,
      text: "Record the evening count",
      createdAt: late,
    }),
    promptEvent({
      id: "early-note",
      runId,
      seqId: 2,
      text: "Record the opening inventory",
      createdAt: early,
    }),
    completedEvent({ id: "counted", runId, seqId: 3, createdAt: early }),
  ]);
  const morningNote = await screen.findByText("Record the opening inventory");
  const request = screen.getByText("Record the evening count");
  expect(
    appearsBefore(
      screen.getByRole("separator", { name: "Yesterday" }),
      request,
    ),
  ).toBeTruthy();
  expect(
    appearsBefore(request, screen.getByRole("separator", { name: "Today" })),
  ).toBeTruthy();
  expect(
    appearsBefore(
      screen.getByRole("separator", { name: "Today" }),
      morningNote,
    ),
  ).toBeTruthy();
});
test("chat-thread-timeline-006 an assistant reply opens yesterday's section before today's next user turn", async () => {
  const first = crypto.randomUUID(),
    next = crypto.randomUUID();
  await open([
    promptEvent({
      id: "oct26",
      runId: first,
      seqId: 1,
      text: "Send the quarterly totals",
      createdAt: stamp(26, 23, 50),
    }),
    assistantEvent({
      id: "oct27",
      runId: first,
      seqId: 2,
      text: "The quarterly totals are available",
      createdAt: stamp(27, 8, 0),
    }),
    completedEvent({
      id: "totals-done",
      runId: first,
      seqId: 3,
      createdAt: stamp(27, 8, 2),
    }),
    promptEvent({
      id: "oct28",
      runId: next,
      seqId: 4,
      text: "Archive the result",
      createdAt: stamp(28, 8, 25),
    }),
    completedEvent({
      id: "archived",
      runId: next,
      seqId: 5,
      createdAt: stamp(28, 8, 26),
    }),
  ]);
  const archive = await screen.findByText("Archive the result");
  const reply = screen.getByText("The quarterly totals are available");
  expect(
    appearsBefore(
      screen.getByText("Send the quarterly totals"),
      screen.getByRole("separator", { name: "Yesterday" }),
    ),
  ).toBeTruthy();
  expect(
    appearsBefore(screen.getByRole("separator", { name: "Yesterday" }), reply),
  ).toBeTruthy();
  expect(
    appearsBefore(reply, screen.getByRole("separator", { name: "Today" })),
  ).toBeTruthy();
  expect(
    appearsBefore(screen.getByRole("separator", { name: "Today" }), archive),
  ).toBeTruthy();
});
