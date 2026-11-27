import {
  chatThreadByIdContract,
  chatThreadEventsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
} from "./chat-event-test-helpers.ts";

type Telemetry = {
  name: string;
  duration?: number;
  "attributes.custom"?: Record<string, unknown>;
};
const { records } = vi.hoisted(() => {
  return { records: [] as Telemetry[] };
});
vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      ingest(_dataset: string, batch: Telemetry[]) {
        records.push(...batch);
      }
      flush() {
        return Promise.resolve();
      }
    },
  };
});
const context = testContext();

async function readPrivateChat(host: string) {
  records.length = 0;
  const thread = continuityThread(981, 1, "Glacier survey");
  const ws = installContinuityWorkspace(context, {
    caseId: 981,
    threads: [thread],
    chatEventRows: [],
  });
  const arrival = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  const text = "The glacier crew checked in";
  const row = mockChatEventRows(
    normalizeMockChatEvents(
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          content: text,
          seqId: 1,
          runId: crypto.randomUUID(),
          createdAt: "2026-11-06T13:00:00Z",
        },
      ],
      thread.id,
    ),
  )[0]!;
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ params, query, respond }) => {
      expect(params.threadId).toBe(thread.id);
      if (!arrival.settled()) {
        arrival.resolve();
      }
      await release.promise;
      return respond(200, {
        rows: (query.sinceSeqId ?? 0) < 1 ? [row] : [],
        cursor: { lastSeqId: 1, lastEventId: row.id },
        hasMore: false,
      });
    },
  );
  let recovery = false;
  const initialDetail = context.mocks.deferred<void>();
  const refreshed = context.mocks.deferred<void>();
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    if (!recovery && !initialDetail.settled()) {
      initialDetail.resolve();
    }
    if (recovery && !refreshed.settled()) {
      refreshed.resolve();
    }
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: recovery,
    });
  });
  try {
    const opening = await startPage({
      ...ws.pageOptions,
      context,
      host,
      path: "/chats/" + thread.id,
      env: { VITE_AXIOM_CLIENT_TELEMETRY_TOKEN: "private-chat-test" },
    });

    const topic = "chatThreadDetailChanged:" + thread.id;
    await Promise.all([arrival.promise, initialDetail.promise]);
    recovery = true;
    context.mocks.ably.triggerOnChannel(
      "user:" + ws.pageOptions.auth.user.id,
      topic,
      {},
    );
    await refreshed.promise;
    const pane = await screen.findByRole("region", { name: "Chat thread" });
    expect(
      pane.querySelector("[data-role=user], [data-role=assistant]"),
    ).toBeNull();
    expect(screen.queryByText(text)).toBeNull();
    const query = records.find((record) => {
      return record.name === "chat-event.cache-only";
    });
    release.resolve();
    await opening.ready;
    await expect(screen.findByText(text)).resolves.toBeVisible();
    return { query, threadId: thread.id };
  } finally {
    if (!release.settled()) {
      release.resolve();
    }
  }
}

test("Production telemetry control reports the empty private conversation before its first remote message", async () => {
  const { query, threadId } = await readPrivateChat("app.okou.ai");
  expect(query).toMatchObject({
    duration: expect.any(Number),
    "attributes.custom": { "okou.client.outcome": "success" },
  });
  expect(query?.["attributes.custom"]).toStrictEqual({
    "okou.client.outcome": "success",
    "okou.client.runtime": "window",
  });
  expect(JSON.stringify(query)).not.toContain(threadId);
});
test("single-connection-client-002 a preview conversation finishes its empty local read without publishing query telemetry", async () => {
  const { query } = await readPrivateChat("pr-387-app.omby.ai");
  expect(query).toBeUndefined();
});
