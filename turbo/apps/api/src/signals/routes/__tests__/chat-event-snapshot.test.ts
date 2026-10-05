import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  chatThreadEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  ageFakeChatEventObject,
  deleteFakeChatEventObject,
  FAKE_CHAT_EVENT_SNAPSHOT_URL,
  installFakeChatEventR2,
  readFakeChatEventObject,
  writeFakeChatEventObject,
} from "./helpers/fake-chat-event-r2";
import {
  readChatEventSnapshotHead,
  updateChatEventSnapshotHead,
} from "./helpers/runtime-state";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
// Manual objects share the fake R2 directory, so each test owns its teardown.
const trackFakeChatEventObject = createFixtureTracker(
  deleteFakeChatEventObject,
);

const R2_GC_SLOT_MS = 10 * 60 * 1000;
const R2_GC_SHARD_GROUP_COUNT = 16 ** 2;
function mockR2GcWindowForKey(key: string, after: Date): Date {
  const prefixStart = "chat-events/".length;
  const shardGroup = Number.parseInt(
    key.slice(prefixStart, prefixStart + 2),
    16,
  );
  const firstSlot = Math.ceil(after.getTime() / R2_GC_SLOT_MS);
  const slotOffset =
    (shardGroup -
      (firstSlot % R2_GC_SHARD_GROUP_COUNT) +
      R2_GC_SHARD_GROUP_COUNT) %
    R2_GC_SHARD_GROUP_COUNT;
  const aligned = new Date((firstSlot + slotOffset) * R2_GC_SLOT_MS);
  mockNow(aligned);
  return aligned;
}

function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return {
    authorization: "Bearer clerk-session",
  };
}

function eventsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadEventsContract,
  );
}

async function readPublishedSnapshotObjectKey(
  actor: ApiTestUser,
  threadId: string,
): Promise<string> {
  const signingCount = context.mocks.s3.getSignedUrl.mock.calls.length;
  await accept(
    eventsClient().snapshot({
      headers: authenticate(actor),
      params: { threadId },
    }),
    [200],
  );
  const [signing, ...otherSignings] =
    context.mocks.s3.getSignedUrl.mock.calls.slice(signingCount);
  const command = signing?.[1];
  if (
    otherSignings.length !== 0 ||
    !(command instanceof GetObjectCommand) ||
    !command.input.Key
  ) {
    throw new Error("Expected one public Snapshot download signing request");
  }
  return command.input.Key;
}

async function runSnapshotCron(
  chatThreadIds: readonly string[],
  r2ObjectKeys: readonly string[] = [],
) {
  const client = setupApp({
    context,
    routes: testChatEventSnapshotRoutes,
  })(testChatEventSnapshotContract);
  const response = await accept(
    client.snapshot({
      body: {
        chat_thread_ids: [...chatThreadIds],
        r2_object_keys: [...r2ObjectKeys],
      },
    }),
    [200],
  );
  return response.body;
}

async function projectChatEventSearch(
  ...chatThreadIds: readonly string[]
): Promise<void> {
  const client = setupApp({
    context,
    routes: testChatEventSearchProjectionRoutes,
  })(testChatEventSearchProjectionContract);
  await accept(
    client.project({ body: { chat_thread_ids: [...chatThreadIds] } }),
    [200],
  );
}

async function sendNoCreditMessage(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly threadId?: string;
    readonly prompt: string;
    readonly userMessage?: UserMessageDocument;
  },
): Promise<string> {
  await api.ensurePersonalSubscriptionModel(actor);
  const sent = await chat.requestSendEvent(actor, body, [201]);
  if (sent.status !== 201) {
    throw new Error("Expected the no-credit send to be accepted");
  }
  // The background pick rejects the input; let it settle before reading.
  await flushWaitUntilForTest();
  return sent.body.threadId;
}

describe("chat event snapshot read endpoints", () => {
  beforeEach(() => {
    installFakeChatEventR2(context);
  });

  it("serves the current Snapshot version and its terminal cursor", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot download agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `snapshot-download-${randomUUID()}`,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "feedback",
            quote: "Snapshot feedback quote",
            note: [{ type: "text", text: "Keep the canonical location." }],
            eventId: "snapshot-feedback-source-event",
            range: { start: 4, end: 13 },
          },
        ],
      },
    });

    const missing = await accept(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: {
        message: "Chat event snapshot not found",
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
      },
    });

    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);
    const head = await readChatEventSnapshotHead(context, threadId);

    const download = await accept(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
      [200],
    );
    expect(download.body).toStrictEqual({
      url: FAKE_CHAT_EVENT_SNAPSHOT_URL,
      expiresInSeconds: 172_800,
      lastEventId: head.last_event_id,
      lastSeqId: head.last_seq_id,
    });

    const snapshotObject = readFakeChatEventObject(head.object_key);
    if (snapshotObject === undefined) {
      throw new Error("Expected the feedback snapshot object");
    }
    const archivedEvents = gunzipSync(snapshotObject)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => {
        return chatEventFromRow(chatEventRowSchema.parse(JSON.parse(line)));
      });
    const archivedInput = archivedEvents.find((event) => {
      return event?.eventType === "input.prompt";
    });
    if (archivedInput?.eventType !== "input.prompt") {
      throw new Error("Expected the archived feedback input");
    }
    const archivedFeedback = archivedInput.userMessage.parts.find((part) => {
      return part.type === "feedback";
    });
    expect(archivedFeedback).toStrictEqual({
      type: "feedback",
      quote: "Snapshot feedback quote",
      note: [{ type: "text", text: "Keep the canonical location." }],
      eventId: "snapshot-feedback-source-event",
      range: { start: 4, end: 13 },
    });

    await expect(
      readChatEventSnapshotHead(context, threadId),
    ).resolves.toMatchObject({
      archive_schema_version: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
      last_event_id: head.last_event_id,
      last_seq_id: head.last_seq_id,
      object_key: head.object_key,
      snapshot_count: 1,
    });

    const stranger = bdd.user({ orgId: `org_${randomUUID()}` });
    const strangerResponse = await accept(
      eventsClient().snapshot({
        headers: authenticate(stranger),
        params: { threadId },
      }),
      [404],
    );
    expect(strangerResponse.body).toStrictEqual({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });
  }, 60_000);

  it("returns complete batch tails and partitions cursors that need a Snapshot", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Batch catch-up agent",
    });
    const firstThreadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `batch-catch-up-first-${randomUUID()}`,
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId: firstThreadId,
      prompt: `batch-catch-up-tail-${randomUUID()}`,
    });
    const secondThreadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `batch-catch-up-second-${randomUUID()}`,
    });

    const stranger = bdd.user({ orgId: `org_${randomUUID()}` });
    const strangerAgent = await bdd.createAgent(stranger, {
      displayName: "Batch catch-up stranger agent",
    });
    const strangerThreadId = await sendNoCreditMessage(stranger, {
      agentId: strangerAgent.agentId,
      prompt: `batch-catch-up-stranger-${randomUUID()}`,
    });
    const firstRows = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId: firstThreadId },
        query: { sinceSeqId: 0 },
      }),
      [200],
    );
    const secondRows = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId: secondThreadId },
        query: { sinceSeqId: 0 },
      }),
      [200],
    );
    const firstCursor = firstRows.body.rows[0];
    const secondCursor = secondRows.body.rows.at(-1);
    if (!firstCursor || !secondCursor) {
      throw new Error("Expected Chat Event batch cursor fixtures");
    }
    const missingThreadId = randomUUID();

    const response = await accept(
      eventsClient().catchUp({
        headers: authenticate(owner),
        body: [
          [firstThreadId, firstCursor.seqId],
          [secondThreadId, secondCursor.seqId],
          [strangerThreadId, 0],
          [missingThreadId, 0],
        ],
      }),
      [200],
    );
    expect(response.body).toStrictEqual({
      events: {
        [firstThreadId]: firstRows.body.rows.filter((row) => {
          return row.seqId > firstCursor.seqId;
        }),
        [secondThreadId]: [],
      },
      notFoundThreads: [strangerThreadId, missingThreadId],
    });

    const aheadCursor = await accept(
      eventsClient().catchUp({
        headers: authenticate(owner),
        body: [[secondThreadId, secondCursor.seqId + 1]],
      }),
      [200],
    );
    expect(aheadCursor.body).toStrictEqual({
      events: {},
      notFoundThreads: [secondThreadId],
    });

    await projectChatEventSearch(firstThreadId);
    await runSnapshotCron([firstThreadId]);
    const snapshot = await accept(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId: firstThreadId },
      }),
      [200],
    );
    const snapshotCursor = await accept(
      eventsClient().catchUp({
        headers: authenticate(owner),
        body: [[firstThreadId, snapshot.body.lastSeqId]],
      }),
      [200],
    );
    expect(snapshotCursor.body).toStrictEqual({
      events: { [firstThreadId]: [] },
      notFoundThreads: [],
    });
    expect(snapshot.body.lastSeqId).toBeGreaterThan(firstCursor.seqId);
    const snapshotCoveredCursor = await accept(
      eventsClient().catchUp({
        headers: authenticate(owner),
        body: [[firstThreadId, firstCursor.seqId]],
      }),
      [200],
    );
    expect(snapshotCoveredCursor.body).toStrictEqual({
      events: {},
      notFoundThreads: [firstThreadId],
    });
    const expiredCursor = await accept(
      eventsClient().catchUp({
        headers: authenticate(owner),
        body: [[firstThreadId, 0]],
      }),
      [200],
    );
    expect(expiredCursor.body).toStrictEqual({
      events: {},
      notFoundThreads: [firstThreadId],
    });
  }, 60_000);

  it("fails closed without moving the pointer for unsupported archive revisions", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Unsupported Snapshot revision agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `unsupported-snapshot-revision-${randomUUID()}`,
    });
    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);
    const originalHead = await readChatEventSnapshotHead(context, threadId);
    const originalObject = readFakeChatEventObject(originalHead.object_key);
    if (originalObject === undefined) {
      throw new Error("Expected a Snapshot object for the revision fixture");
    }

    const futureObjectKey = `chat-events/${threadId}/${originalHead.last_seq_id.toString()}-r2-${createHash("sha256").update(originalObject).digest("hex")}.ndjson.gz`;
    writeFakeChatEventObject(futureObjectKey, originalObject);
    await trackFakeChatEventObject(Promise.resolve(futureObjectKey));
    await updateChatEventSnapshotHead(context, threadId, futureObjectKey);
    const futureHead = await readChatEventSnapshotHead(context, threadId);

    await expect(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
    ).rejects.toThrow("Unknown response status 500");
    await expect(
      readChatEventSnapshotHead(context, threadId),
    ).resolves.toStrictEqual(futureHead);
    expect(readFakeChatEventObject(futureObjectKey)).toStrictEqual(
      originalObject,
    );
  }, 60_000);

  it("skips undecodable Snapshot heads and keeps the stored object", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot decode classification agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `snapshot-decode-classification-${randomUUID()}`,
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `snapshot-semantic-reorder-${randomUUID()}`,
    });
    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);
    const originalHead = await readChatEventSnapshotHead(context, threadId);
    const originalObject = readFakeChatEventObject(originalHead.object_key);
    if (originalObject === undefined) {
      throw new Error("Expected a Snapshot object for decode classification");
    }
    const originalRows = gunzipSync(originalObject)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        return chatEventRowSchema.parse(JSON.parse(line));
      });
    const firstRow = originalRows[0];
    const inputRow = originalRows.find((row) => {
      return row.eventType === "input.prompt";
    });
    if (firstRow === undefined || inputRow === undefined) {
      throw new Error("Expected complete Snapshot decode fixtures");
    }
    const encodeRows = (rows: readonly unknown[]): Buffer => {
      return Buffer.from(
        rows
          .map((row) => {
            return `${JSON.stringify(row)}\n`;
          })
          .join(""),
      );
    };
    const rawRowBody = Buffer.from(
      `${JSON.stringify({ ...firstRow, unexpected: true })}\n`,
    );
    const projectionBody = encodeRows(
      originalRows.map((row) => {
        return row.id === inputRow.id ? { ...row, payload: null } : row;
      }),
    );
    const prefixBody = encodeRows(
      originalRows.map((row) => {
        return row.id === firstRow.id
          ? { ...row, chatThreadId: randomUUID() }
          : row;
      }),
    );
    const terminalBody = encodeRows(originalRows.slice(0, -1));
    const invalidGzip = Buffer.from("sanitized invalid gzip fixture");
    const cases = [
      {
        failureClass: "checksum",
        object: originalObject,
        keyDigest: createHash("sha256")
          .update("different sanitized checksum fixture")
          .digest("hex"),
      },
      {
        failureClass: "gzip",
        object: invalidGzip,
        keyDigest: createHash("sha256").update(invalidGzip).digest("hex"),
      },
      {
        failureClass: "raw_row",
        object: gzipSync(rawRowBody),
      },
      {
        failureClass: "projection",
        object: gzipSync(projectionBody),
      },
      {
        failureClass: "prefix",
        object: gzipSync(prefixBody),
      },
      {
        failureClass: "terminal",
        object: gzipSync(terminalBody),
      },
    ] as const;

    for (const testCase of cases) {
      const digest =
        "keyDigest" in testCase
          ? testCase.keyDigest
          : createHash("sha256").update(testCase.object).digest("hex");
      const objectKey = `chat-events/${threadId}/${originalHead.last_seq_id.toString()}-${digest}.ndjson.gz`;
      writeFakeChatEventObject(objectKey, testCase.object);
      await trackFakeChatEventObject(Promise.resolve(objectKey));
      await updateChatEventSnapshotHead(context, threadId, objectKey);
      const staleHead = await readChatEventSnapshotHead(context, threadId);

      const result = await runSnapshotCron([threadId], [objectKey]);

      expect(result).toMatchObject({
        snapshots: 0,
        skippedUndecodableHeads: 1,
      });
      await expect(
        readChatEventSnapshotHead(context, threadId),
      ).resolves.toStrictEqual(staleHead);
      expect(readFakeChatEventObject(objectKey)).toStrictEqual(testCase.object);
    }
  }, 90_000);

  it("serves current Raw Event rows from cold-start and paired cursors", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Row parity agent",
    });
    const marker = `row-parity-${randomUUID()}`;
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `${marker} first`,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: `${marker} first` },
          {
            type: "feedback",
            quote: "Raw feedback quote",
            note: [{ type: "text", text: "Keep the Raw Event location." }],
            eventId: "raw-feedback-source-event",
            range: { start: 2, end: 8 },
          },
        ],
      },
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `${marker} second`,
    });

    const fromStart = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: { sinceSeqId: 0 },
      }),
      [200],
    );
    const firstRow = fromStart.body.rows[0];
    if (firstRow === undefined) {
      throw new Error("Expected seeded chat events");
    }
    const firstSeqId = firstRow.seqId;

    const canonicalInput = fromStart.body.rows
      .map((row) => {
        return chatEventFromRow(row);
      })
      .find((event) => {
        return event?.eventType === "input.prompt";
      });
    if (canonicalInput?.eventType !== "input.prompt") {
      throw new Error("Expected the canonical feedback input");
    }
    expect(
      canonicalInput.userMessage.parts.find((part) => {
        return part.type === "feedback";
      }),
    ).toMatchObject({
      type: "feedback",
      eventId: "raw-feedback-source-event",
      range: { start: 2, end: 8 },
    });

    const rows = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceSeqId: firstSeqId,
          sinceEventId: firstRow.id,
        },
      }),
      [200],
    );
    expect(rows.body.cursor).toStrictEqual({
      lastEventId: rows.body.rows.at(-1)?.id,
      lastSeqId: rows.body.rows.at(-1)?.seqId,
    });
    for (const row of rows.body.rows) {
      chatEventRowSchema.parse(row);
      expect(row.chatThreadId).toBe(threadId);
    }

    const projected = rows.body.rows.map((row) => {
      return chatEventFromRow(row);
    });
    expect(projected).toHaveLength(rows.body.rows.length);
    expect(rows.body.rows).toStrictEqual(
      fromStart.body.rows.filter((row) => {
        return row.seqId > firstSeqId;
      }),
    );
    expect(projected).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "input.prompt",
          userMessage: expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: `${marker} second`,
              }),
            ]),
          }),
        }),
      ]),
    );

    expect(fromStart.body.rows[0]?.seqId).toBe(firstSeqId);
    expect(fromStart.body.rows).toHaveLength(rows.body.rows.length + 1);

    const mismatchedPair = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceSeqId: firstSeqId,
          sinceEventId: randomUUID(),
        },
      }),
      [410],
    );
    expect(mismatchedPair.body).toStrictEqual({
      error: {
        message: "Chat events cursor has expired",
        code: "CHAT_EVENTS_EXPIRED",
      },
    });

    const expired = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceSeqId: 999_999,
          sinceEventId: randomUUID(),
        },
      }),
      [410],
    );
    expect(expired.body).toStrictEqual({
      error: {
        message: "Chat events cursor has expired",
        code: "CHAT_EVENTS_EXPIRED",
      },
    });
  }, 60_000);

  it("garbage-collects unreferenced snapshot objects", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot maintenance agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `snapshot-maintenance-${randomUUID()}`,
    });

    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);

    const objectKey = await readPublishedSnapshotObjectKey(owner, threadId);
    expect(readFakeChatEventObject(objectKey)).toBeDefined();

    const future = mockR2GcWindowForKey(
      objectKey,
      new Date(now() + 8 * 24 * 60 * 60 * 1000),
    );
    ageFakeChatEventObject(
      objectKey,
      new Date(future.getTime() - 8 * 24 * 60 * 60 * 1000),
    );
    const protectedHead = await runSnapshotCron([threadId], [objectKey]);
    expect(protectedHead.r2ObjectsDeleted).toBe(0);
    expect(readFakeChatEventObject(objectKey)).toBeDefined();

    const orphanKey = `chat-events/${threadId.slice(0, 3)}-orphan.ndjson.gz`;
    writeFakeChatEventObject(orphanKey, Buffer.from("orphan"));
    await trackFakeChatEventObject(Promise.resolve(orphanKey));
    ageFakeChatEventObject(
      orphanKey,
      new Date(future.getTime() - 8 * 24 * 60 * 60 * 1000),
    );
    const orphanGc = await runSnapshotCron([threadId], [orphanKey]);
    expect(orphanGc).toMatchObject({
      r2ObjectsMeasured: 1,
      r2ObjectsDeleted: 1,
    });
    expect(readFakeChatEventObject(orphanKey)).toBeUndefined();

    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `snapshot-replacement-${randomUUID()}`,
    });
    await projectChatEventSearch(threadId);
    const replacement = await runSnapshotCron([threadId], [objectKey]);
    expect(replacement.r2ObjectsDeleted).toBe(1);
    expect(readFakeChatEventObject(objectKey)).toBeUndefined();
    const newObjectKey = await readPublishedSnapshotObjectKey(owner, threadId);
    expect(newObjectKey).not.toBe(objectKey);
    expect(readFakeChatEventObject(newObjectKey)).toBeDefined();
  }, 120_000);

  it("limits object cleanup to the fixed per-pass quota", async () => {
    const shard = "ffe";
    const marker = randomUUID();
    const keys = Array.from({ length: 1001 }, (_, index) => {
      const subpartition = (index % 16).toString(16);
      return `chat-events/${shard}${subpartition}-quota-${marker}-${index.toString().padStart(4, "0")}.ndjson.gz`;
    });
    for (const key of keys) {
      writeFakeChatEventObject(key, Buffer.from("orphan"));
      await trackFakeChatEventObject(Promise.resolve(key));
    }
    mockR2GcWindowForKey(
      `chat-events/${shard}`,
      new Date(now() + 8 * 24 * 60 * 60 * 1000),
    );

    const result = await runSnapshotCron([], keys);

    expect(result.r2ObjectsDeleted).toBe(1000);
    const remaining = keys.filter((key) => {
      return readFakeChatEventObject(key) !== undefined;
    });
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
