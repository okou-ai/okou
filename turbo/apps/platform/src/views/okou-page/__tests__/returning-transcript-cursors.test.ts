import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import {
  normalizeMockChatEvents,
  mockChatEventRows,
} from "./chat-event-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
test("A returning reader sees cached expenses before two later messages arrive and can start another conversation", async () => {
  const thread = continuityThread(942, 1, "Expenses"),
    other = continuityThread(942, 2, "Travel review");
  const stages = [
    "Approve train ticket",
    "Book the return seat",
    "Print the departure pass",
  ];
  const rows = mockChatEventRows(
    normalizeMockChatEvents(
      stages.map((content, i) => {
        return {
          id: crypto.randomUUID(),
          role: "user",
          content,
          runId: crypto.randomUUID(),
          seqId: i + 1,
          createdAt: new Date(Date.UTC(2026, 10, 1, 10, 0, i)).toISOString(),
        };
      }),
      thread.id,
    ),
  );
  const ws = installContinuityWorkspace(context, {
    caseId: 942,
    threads: [thread, other],
    chatEventRows: rows.slice(0, 1),
  });
  const pageOptions = {
    ...ws.pageOptions,
    path: "/chats/" + thread.id,
    sharedWorkerTestTransport: "message-port" as const,
  };
  const original = createTestRuntime(context);
  await setupPage({ ...pageOptions, context: original });
  await screen.findByText(stages[0]!);
  cleanup();
  original.dispose();
  const arrived = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  let length = 2;
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ params, query, respond }) => {
      const matching = params.threadId === thread.id;
      const cursor = query.sinceSeqId ?? 0;
      if (matching) {
        if (!arrived.settled()) {
          arrived.resolve();
        }
        await release.promise;
      }
      const body = matching ? rows.slice(cursor, length) : [];
      const tail = body.at(-1);
      const lastEventId = tail?.id ?? query.sinceEventId;
      return respond(200, {
        rows: body,
        hasMore: false,
        cursor: lastEventId
          ? { lastSeqId: tail?.seqId ?? cursor, lastEventId }
          : { lastSeqId: 0, lastEventId: null },
      });
    },
  );
  const active = createTestRuntime(context);
  const session = await startPage({ ...pageOptions, context: active });
  try {
    await arrived.promise;
    await expect(screen.findByText(stages[0]!)).resolves.toBeVisible();
    expect(screen.queryByText(stages[1]!)).toBeNull();
    release.resolve();
    await session.ready;
    await screen.findByText(stages[1]!);
    const member = ws.pageOptions.auth;
    const wire =
      "user-org:" + member.user.id + ":" + member.organization?.activeOrg?.id;
    const emit = () => {
      return context.mocks.ably.triggerOnChannel(
        wire,
        "chatThreadMessageCreated:" + thread.id,
        { threadId: thread.id },
      );
    };
    length = 3;
    emit();
    await screen.findByText(stages[2]!);
    const messages = screen.getAllByText(
      /^(Approve train ticket|Book the return seat|Print the departure pass)$/,
    );
    expect(
      messages.map((message) => {
        return message.textContent;
      }),
    ).toStrictEqual(stages);
    click(await findFastControl("link", /^New chat/));
    await waitFor(() => {
      return expect(location.pathname).toBe("/");
    });
    await screen.findByRole("textbox", { name: "Message" });
    cleanup();
    active.dispose();
    await waitFor(() => {
      return expect(
        context.mocks.ably.hasChannelSubscriptionOnChannel(wire),
      ).toBeFalsy();
    });
    emit();
    await setupPage({
      ...pageOptions,
      context: createTestRuntime(context),
      path: "/chats/" + other.id,
    });
    await screen.findByText("Travel review", {
      selector: '[data-testid="chat-thread-header-title"]',
    });
  } finally {
    if (!release.settled()) {
      release.resolve();
    }
  }
});

test("Only the updated conversation gains a message when the worker warms two open threads", async () => {
  const stable = continuityThread(886, 1, "Mooring notes");
  const changed = continuityThread(886, 2, "Harbor survey");
  const ws = installContinuityWorkspace(context, {
    caseId: 886,
    threads: [stable, changed],
    chatEventRows: [],
  });
  const row = mockChatEventRows(
    normalizeMockChatEvents(
      [
        {
          role: "user",
          id: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          seqId: 1,
          createdAt: "2026-10-18T12:00:00Z",
          content: "Survey marker installed",
        },
      ],
      changed.id,
    ),
  )[0]!;
  const batch = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let supply = false;
  context.mocks.api(
    chatThreadEventsContract.catchUp,
    async ({ body, respond }) => {
      const targets = body.map(([id]) => {
        return id;
      });
      const matching =
        supply && targets.includes(stable.id) && targets.includes(changed.id);
      if (matching) {
        if (!batch.settled()) {
          batch.resolve();
        }
        await release.promise;
      }
      return respond(200, {
        notFoundThreads: [],
        events: Object.fromEntries(
          body.map(([id, seq]) => {
            return [id, matching && id === changed.id && seq < 1 ? [row] : []];
          }),
        ),
      });
    },
  );
  await setupPage({
    ...ws.pageOptions,
    context,
    path: "/chats/" + stable.id + "?sidebar=" + changed.id,
    sharedWorkerTestTransport: "message-port",
  });
  const pane = (id: string) => {
    return document.querySelector<HTMLElement>(
      '[data-chat-thread-container-id="' + id + '"]',
    )!;
  };
  await waitFor(() => {
    expect(pane(stable.id)).toBeVisible();
    expect(pane(changed.id)).toBeVisible();
  });
  supply = true;
  const auth = ws.pageOptions.auth;
  context.mocks.ably.triggerOnChannel(
    "user-org:" + auth.user.id + ":" + auth.organization?.activeOrg?.id,
    "chatThreadMessageCreated:" + stable.id,
    { threadId: stable.id },
  );
  await batch.promise;
  expect(screen.queryByText("Survey marker installed")).toBeNull();
  release.resolve();
  await screen.findByText("Survey marker installed");
  expect(pane(changed.id)).toHaveTextContent("Survey marker installed");
  expect(pane(stable.id)).not.toHaveTextContent("Survey marker installed");
});
