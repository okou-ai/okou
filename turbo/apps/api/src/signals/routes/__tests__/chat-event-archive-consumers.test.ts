import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import AdmZip from "adm-zip";
import { HttpResponse } from "msw";
import {
  PI_MEMORY_CITATION_OPEN,
  PI_MEMORY_CITATION_CLOSE,
} from "@okouai/api-contracts/contracts/pi-memory-citations";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { testChatEventRetentionContract } from "@okouai/api-contracts/contracts/test-chat-event-retention";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { createStore } from "ccstate";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  readRetentionEvents$,
  revokeRetentionEvent$,
  seedRetentionInvisibleReplacement$,
  seedRetentionOutputEvent$,
  seedRetentionRun$,
} from "../../../test-fixtures/chat-event-retention";
import {
  holdChatEventReadsFixture,
  queueChatEventPhysicalDeletionFixture,
  queueOtherWorkerChatEventReadFixture,
} from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { sharedThreadRoutes } from "../shared-threads";
import { testChatEventRetentionRoutes } from "../test-chat-event-retention";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  installFakeChatEventR2,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const routeMocks = createRouteMocks(context);

interface ArchiveFixture {
  readonly actor: ApiTestUser;
  readonly threadId: string;
}

const escapedOpen = `&lt;${PI_MEMORY_CITATION_OPEN.slice(1, -1)}&gt;`;

function withHiddenCitation(visible: string): string {
  // Retained raw-backed rows contain both an isolated example and real private provenance.
  return `${visible.replace(escapedOpen, PI_MEMORY_CITATION_OPEN)}${PI_MEMORY_CITATION_OPEN}<citation_entries>memory.md:1-1|note=[private]</citation_entries>${PI_MEMORY_CITATION_CLOSE}`;
}

function searchClient() {
  return setupApp({ context, routes: testChatEventSearchProjectionRoutes })(
    testChatEventSearchProjectionContract,
  );
}

function snapshotClient() {
  return setupApp({ context, routes: testChatEventSnapshotRoutes })(
    testChatEventSnapshotContract,
  );
}

function retentionClient() {
  return setupApp({ context, routes: testChatEventRetentionRoutes })(
    testChatEventRetentionContract,
  );
}

function sharedThreadClient() {
  return setupApp({ context, routes: sharedThreadRoutes })(
    sharedThreadsContract,
  );
}

function authenticate(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

async function createArchiveFixture(label: string): Promise<ArchiveFixture> {
  const actor = bdd.user({ orgId: `org_${randomUUID()}` });
  const agent = await bdd.createAgent(actor, {
    displayName: `${label} archive agent`,
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: `${label} archive thread`,
  });
  return { actor, threadId: thread.id };
}

async function archiveAndRetain(
  threadId: string,
  eventIds: readonly string[],
): Promise<void> {
  await accept(
    searchClient().project({ body: { chat_thread_ids: [threadId] } }),
    [200],
  );
  await accept(
    snapshotClient().snapshot({
      body: { chat_thread_ids: [threadId], r2_object_keys: [] },
    }),
    [200],
  );
  const retained = await accept(
    retentionClient().retain({ body: { chat_thread_ids: [threadId] } }),
    [200],
  );
  expect(retained.body.deleted).toBe(eventIds.length);
  await expect(
    store.set(readRetentionEvents$, eventIds, context.signal),
  ).resolves.toHaveLength(0);
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function byteStream(bytes: Buffer): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

function installEmptyStorageArchives(): void {
  const manifest = Buffer.from(
    JSON.stringify({
      version: "archive-consumer-fixture",
      createdAt: new Date(0).toISOString(),
      files: [],
      totalSize: 0,
      fileCount: 0,
    }),
  );
  const archive = gzipSync(Buffer.alloc(1024));
  const fallback = context.mocks.s3.send.getMockImplementation();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (typeof command !== "object" || command === null) {
      return fallback?.(command) ?? Promise.resolve({});
    }
    const key = commandInput(command).Key;
    if (
      command.constructor.name !== "GetObjectCommand" ||
      (typeof key === "string" && key.startsWith("chat-events/"))
    ) {
      return fallback?.(command) ?? Promise.resolve({});
    }
    const bytes =
      typeof key === "string" && key.endsWith("/manifest.json")
        ? manifest
        : archive;
    return Promise.resolve({
      Body: byteStream(bytes),
      ContentLength: bytes.length,
    });
  });
}

function exportZip(exportKey: string): AdmZip {
  const putInput = context.mocks.s3.send.mock.calls
    .map(([command]) => {
      return commandInput(command);
    })
    .find((input) => {
      return input.Key === exportKey;
    });
  if (!Buffer.isBuffer(putInput?.Body)) {
    throw new Error("Expected archived user export ZIP upload");
  }
  return new AdmZip(putInput.Body);
}

function zipText(zip: AdmZip, name: string): string {
  const entry = zip.getEntry(name);
  if (entry === null) {
    throw new Error(`Expected ZIP entry ${name}`);
  }
  return entry.getData().toString("utf8");
}

describe("archived chat event consumers", () => {
  const recordedPuts: RecordedChatEventPut[] = [];

  beforeEach(() => {
    recordedPuts.length = 0;
    mockEnv("GIT_COMMIT_SHA", "b".repeat(40));
    installFakeChatEventR2(context, recordedPuts);
    installEmptyStorageArchives();
  });

  it("exports snapshot history plus the PostgreSQL tail after archived source rows are gone", async () => {
    const fixture = await createArchiveFixture("export");
    const archivedVisible = `archived-export-${randomUUID()} \`${escapedOpen}\` suffix`;
    const archivedText = withHiddenCitation(archivedVisible);
    const archivedEventId = await store.set(
      seedRetentionOutputEvent$,
      {
        chatThreadId: fixture.threadId,
        content: archivedText,
        offsetMs: -60_000,
      },
      context.signal,
    );
    await archiveAndRetain(fixture.threadId, [archivedEventId]);
    const tailVisible = `hot-tail-${randomUUID()} \`${escapedOpen}\` suffix`;
    const tailText = withHiddenCitation(tailVisible);
    await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: fixture.threadId, content: tailText },
      context.signal,
    );

    const exportApi = createOpsLogsApi(context);
    const started = await exportApi.requestPostUserExport(fixture.actor, [202]);
    await flushWaitUntilForTest();
    const status = await exportApi.requestGetUserExport(fixture.actor, [200]);
    expect(status.body.job).toMatchObject({
      id: started.body.jobId,
      status: "completed",
    });
    const zip = exportZip(
      `exports/${fixture.actor.userId}/${started.body.jobId}.zip`,
    );
    const messages = JSON.parse(
      zipText(zip, `conversations/chat-thread-${fixture.threadId}.json`),
    ) as readonly { readonly role: string; readonly content: string }[];
    expect(messages).toMatchObject([
      { role: "assistant", content: archivedVisible },
      { role: "assistant", content: tailVisible },
    ]);
  }, 60_000);

  it("shares archived selections with a fixed title when the title provider is unavailable", async () => {
    const fixture = await createArchiveFixture("sharing-provider-failure");
    // Expired, physically removed events are historical state with no public
    // write API. Reuse this archive harness, then observe the public share API.
    const eventId = await store.set(
      seedRetentionOutputEvent$,
      {
        chatThreadId: fixture.threadId,
        content: "A completed answer to share",
        offsetMs: -180_000,
      },
      context.signal,
    );
    await archiveAndRetain(fixture.threadId, [eventId]);
    mockOptionalEnv("OPENROUTER_API_KEY", "test-sharing-key");
    chatCallbacks.mockOpenRouterCompletions(() => {
      return new HttpResponse(null, { status: 503 });
    });
    const created = await accept(
      sharedThreadClient().create({
        params: { threadId: fixture.threadId },
        headers: authenticate(fixture.actor),
        body: { eventIds: [eventId] },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    const shared = await accept(
      sharedThreadClient().get({ params: { id: created.body.id } }),
      [200],
    );
    expect(shared.body).toStrictEqual({
      id: created.body.id,
      publicBrand: "okou",
      title: "Shared conversation",
      messages: [
        {
          messageIndex: 0,
          role: "assistant",
          content: "A completed answer to share",
        },
      ],
    });
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("shares an archived selection while excluding archived revoked and invisible messages", async () => {
    const fixture = await createArchiveFixture("sharing");
    const archivedVisible = `share-archived-${randomUUID()} \`${escapedOpen}\` suffix`;
    const archivedText = withHiddenCitation(archivedVisible);
    const archivedEventId = await store.set(
      seedRetentionOutputEvent$,
      {
        chatThreadId: fixture.threadId,
        content: archivedText,
        offsetMs: -180_000,
      },
      context.signal,
    );
    const hidden = await store.set(
      seedRetentionInvisibleReplacement$,
      {
        chatThreadId: fixture.threadId,
        targetOffsetMs: -270_000,
        replacementOffsetMs: -240_000,
      },
      context.signal,
    );
    const hiddenRevokerId = await store.set(
      revokeRetentionEvent$,
      {
        chatThreadId: fixture.threadId,
        eventId: hidden.replacementId,
        offsetMs: -210_000,
      },
      context.signal,
    );
    const invisible = await store.set(
      seedRetentionInvisibleReplacement$,
      {
        chatThreadId: fixture.threadId,
        targetOffsetMs: -180_000,
        replacementOffsetMs: -150_000,
      },
      context.signal,
    );
    const allEventIds = [
      archivedEventId,
      hidden.targetId,
      hidden.replacementId,
      hiddenRevokerId,
      invisible.targetId,
    ];
    await archiveAndRetain(fixture.threadId, allEventIds);
    const hotEvents = await store.set(
      readRetentionEvents$,
      [invisible.targetId, invisible.replacementId],
      context.signal,
    );
    expect(
      hotEvents.map(({ id }) => {
        return id;
      }),
    ).toStrictEqual([invisible.replacementId]);

    mockOptionalEnv("OPENROUTER_API_KEY", "archive-sharing-key");
    chatCallbacks.mockOpenRouterCompletions(() => {
      return "Archived selection";
    });
    const created = await accept(
      sharedThreadClient().create({
        params: { threadId: fixture.threadId },
        headers: authenticate(fixture.actor),
        body: {
          eventIds: [
            hidden.targetId,
            archivedEventId,
            hidden.replacementId,
            invisible.targetId,
            invisible.replacementId,
            archivedEventId,
          ],
        },
      }),
      [201],
    );
    const shared = await accept(
      sharedThreadClient().get({ params: { id: created.body.id } }),
      [200],
    );
    expect(shared.body).toStrictEqual({
      id: created.body.id,
      publicBrand: "okou",
      title: "Archived selection",
      messages: [
        {
          messageIndex: 0,
          role: "assistant",
          content: archivedVisible,
        },
      ],
    });

    const excluded = await accept(
      sharedThreadClient().create({
        params: { threadId: fixture.threadId },
        headers: authenticate(fixture.actor),
        body: {
          eventIds: [
            hidden.targetId,
            hidden.replacementId,
            invisible.targetId,
            invisible.replacementId,
          ],
        },
      }),
      [400],
    );
    expect(excluded.body.error.code).toBe("NO_SHAREABLE_MESSAGES");
  }, 60_000);

  it("shares one hot-table snapshot when physical deletion queues behind its read", async () => {
    const fixture = await createArchiveFixture("sharing-race");
    const hotVisible = `share-hot-race-${randomUUID()} \`${escapedOpen}\` suffix`;
    const hotText = withHiddenCitation(hotVisible);
    const hotEventId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: fixture.threadId, content: hotText },
      context.signal,
    );

    mockOptionalEnv("OPENROUTER_API_KEY", "hot-sharing-race-key");
    chatCallbacks.mockOpenRouterCompletions(() => {
      return "Hot selection";
    });
    const heldReads = await holdChatEventReadsFixture({
      signal: context.signal,
    });
    const otherWorkerRead = await queueOtherWorkerChatEventReadFixture({
      signal: context.signal,
    });
    let createRequestDone: Promise<unknown> = Promise.resolve();
    let deletionDone: Promise<void> = Promise.resolve();
    onTestFinished(async () => {
      heldReads.release();
      await Promise.allSettled([
        heldReads.done,
        otherWorkerRead.done,
        deletionDone,
        createRequestDone,
      ]);
    });
    await expect.poll(otherWorkerRead.blocked).toBe(true);
    await expect.poll(heldReads.blockedStatementCounts).toStrictEqual({
      hotSnapshotReads: 0,
      physicalDeletions: 0,
    });
    const createRequest = sharedThreadClient().create({
      params: { threadId: fixture.threadId },
      headers: authenticate(fixture.actor),
      body: { eventIds: [hotEventId] },
    });
    createRequestDone = createRequest;

    await expect.poll(heldReads.blockedStatementCounts).toStrictEqual({
      hotSnapshotReads: 1,
      physicalDeletions: 0,
    });
    const deletion = await queueChatEventPhysicalDeletionFixture({
      eventId: hotEventId,
      signal: context.signal,
    });
    deletionDone = deletion.done;
    await expect.poll(heldReads.blockedStatementCounts).toStrictEqual({
      hotSnapshotReads: 1,
      physicalDeletions: 1,
    });

    heldReads.release();
    const [created] = await Promise.all([
      accept(createRequest, [201]),
      heldReads.done,
      otherWorkerRead.done,
      deletionDone,
    ]);
    await expect(
      store.set(readRetentionEvents$, [hotEventId], context.signal),
    ).resolves.toHaveLength(0);
    const shared = await accept(
      sharedThreadClient().get({ params: { id: created.body.id } }),
      [200],
    );
    expect(shared.body).toStrictEqual({
      id: created.body.id,
      publicBrand: "okou",
      title: "Hot selection",
      messages: [
        {
          messageIndex: 0,
          role: "assistant",
          content: hotVisible,
        },
      ],
    });
  }, 60_000);

  it("keeps automatic session rotation best effort when old hot events are missing", async () => {
    const fixture = await createArchiveFixture("session-context");
    const runId = await store.set(
      seedRetentionRun$,
      {
        chatThreadId: fixture.threadId,
        status: "completed",
        threadBound: true,
      },
      context.signal,
    );
    const archivedEventId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: fixture.threadId, runId, offsetMs: -60_000 },
      context.signal,
    );
    await archiveAndRetain(fixture.threadId, [archivedEventId]);

    const resolved = await accept(
      retentionClient().sessionPrompt({
        body: { chat_thread_id: fixture.threadId },
      }),
      [200],
    );
    const { prompt } = resolved.body;

    expect(prompt).toContain(`CHAT_THREAD_ID: ${fixture.threadId}`);
    expect(prompt).toContain(`RUN_ID: ${runId}`);
    expect(prompt).toContain("User: Retention fixture run");
    expect(prompt).toContain("Assistant: [no stored assistant message]");
  }, 60_000);
});
