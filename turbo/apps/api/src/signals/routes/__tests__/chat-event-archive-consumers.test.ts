import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";

import { HttpResponse } from "msw";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  PI_MEMORY_CITATION_OPEN,
  PI_MEMORY_CITATION_CLOSE,
} from "@okouai/api-contracts/contracts/pi-memory-citations";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { testChatEventRetentionContract } from "@okouai/api-contracts/contracts/test-chat-event-retention";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { testUserExportWorkContract } from "@okouai/api-contracts/contracts/test-user-export-work";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { semanticChatEventsFromChatEvents } from "@okouai/api-contracts/contracts/chat-event-semantics";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
  seedRetentionOutputEvents$,
  seedRetentionPendingEvent$,
  seedRetentionRun$,
} from "../../../test-fixtures/chat-event-retention";
import { withChatEventDeletedAfterReadFixture } from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { sharedThreadRoutes } from "../shared-threads";
import { testChatEventRetentionRoutes } from "../test-chat-event-retention";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { testUserExportWorkRoutes } from "../test-user-export-work";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  installFakeChatEventR2,
  readFakeChatEventObject,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import {
  installUserExportStorage,
  readExportChatRows,
  readExportJsonLines,
  readExportText,
  readUserExportZip,
} from "./helpers/user-export-storage";
import { createRouteMocks } from "./helpers/route-test";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { createEmailOutboxStateApi } from "./helpers/email-outbox-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import AdmZip from "adm-zip";

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

function installAgentStorage(): void {
  const snapshots = context.mocks.s3.send.getMockImplementation();
  createMiscRoutesApi(context);
  const objects = context.mocks.s3.send.getMockImplementation();
  if (!snapshots || !objects) {
    throw new Error("Expected snapshot and instruction storage mocks");
  }
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      (command instanceof HeadObjectCommand ||
        (command instanceof GetObjectCommand && command.input.Range)) &&
      command.input.Key?.startsWith("chat-events/")
    ) {
      const bytes = readFakeChatEventObject(command.input.Key);
      if (!bytes) {
        throw new Error("Expected an immutable snapshot object");
      }
      const range = command.input.Range
        ? /^bytes=(\d+)-(\d+)$/.exec(command.input.Range)
        : null;
      const start = range ? Number(range[1]) : 0;
      const end = range ? Number(range[2]) + 1 : bytes.length;
      const body = bytes.subarray(start, end);
      return Promise.resolve({
        Body: Readable.from([body]),
        ContentLength: body.length,
        ContentRange: range
          ? `bytes ${start}-${end - 1}/${bytes.length}`
          : undefined,
        ETag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
      });
    }
    if (
      (command instanceof GetObjectCommand ||
        command instanceof HeadObjectCommand ||
        command instanceof PutObjectCommand) &&
      !command.input.Key?.startsWith("chat-events/")
    ) {
      return objects(command);
    }
    return snapshots(command);
  });
}

function readDurableChatRows(zip: AdmZip, threadId: string) {
  const index = JSON.parse(
    readExportText(zip, `chat-messages/${threadId}/index.json`),
  ) as {
    snapshotPath: string;
    snapshotPhysicalCoverage: number;
    upperSeqId: number;
  };
  const snapshot = zip.getEntry(index.snapshotPath);
  if (!snapshot) {
    throw new Error("Expected the authoritative exported chat snapshot");
  }
  const archived = gunzipSync(snapshot.getData())
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => {
      return chatEventRowSchema.parse(JSON.parse(line));
    });
  const tail = zip
    .getEntries()
    .filter((entry) => {
      return entry.entryName.startsWith(`chat-messages/${threadId}/tail/`);
    })
    .flatMap((entry) => {
      return readExportJsonLines(zip, entry.entryName).map((row) => {
        return chatEventRowSchema.parse(row);
      });
    })
    .filter((row) => {
      return (
        row.seqId > index.snapshotPhysicalCoverage &&
        row.seqId <= index.upperSeqId
      );
    });
  return [...archived, ...tail].sort((left, right) => {
    return left.seqId - right.seqId;
  });
}

async function readChatTailRows(
  fixture: ArchiveFixture,
  after: ChatEventRow,
): Promise<readonly ChatEventRow[]> {
  const rows: ChatEventRow[] = [];
  let cursor = { lastEventId: after.id, lastSeqId: after.seqId };
  for (;;) {
    const page = await chat.listThreadEventRows(
      fixture.actor,
      fixture.threadId,
      cursor,
    );
    rows.push(...page);
    const last = page.at(-1);
    if (!last) {
      return rows;
    }
    cursor = { lastEventId: last.id, lastSeqId: last.seqId };
  }
}

async function createAdvancingExportFixture(
  advancement: "within-bound" | "overtake-with-revocation",
) {
  const fixture = await createArchiveFixture("export-advancement");
  if (!fixture.actor.orgId) {
    throw new Error("Expected an organization for the export fixture");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...fixture.actor, orgId: fixture.actor.orgId },
    { [FeatureSwitchKey.DurableUserExport]: true },
  );
  // Historical timestamps and retention are infrastructure states that
  // cannot be constructed through the ordinary message-send API. The
  // existing native archive fixture owns those rows; expected payloads are
  // read through the real Chat API and recovery is verified from the ZIP.
  const prefixId = await store.set(
    seedRetentionOutputEvent$,
    {
      chatThreadId: fixture.threadId,
      content: `Archived prefix ${randomUUID()}`,
      offsetMs: -180_000,
    },
    context.signal,
  );
  const [prefix] = await chat.listThreadEventRows(
    fixture.actor,
    fixture.threadId,
  );
  if (!prefix) {
    throw new Error("Expected the initial canonical chat row");
  }
  await archiveAndRetain(fixture.threadId, [prefixId]);
  const pendingId =
    advancement === "overtake-with-revocation"
      ? await store.set(
          seedRetentionPendingEvent$,
          { chatThreadId: fixture.threadId, offsetMs: -120_000 },
          context.signal,
        )
      : undefined;
  const outputIds = await store.set(
    seedRetentionOutputEvents$,
    {
      chatThreadId: fixture.threadId,
      count: pendingId === undefined ? 120 : 119,
      offsetMs: -90_000,
    },
    context.signal,
  );
  const archivedTailIds =
    pendingId === undefined ? outputIds : [pendingId, ...outputIds];
  const projectedTail = await readChatTailRows(fixture, prefix);
  const projectedLast = projectedTail.at(-1);
  const revokeTargetId = archivedTailIds[0];
  if (!projectedLast || !revokeTargetId) {
    throw new Error("Expected a tail longer than one export page");
  }
  await accept(
    searchClient().project({
      body: { chat_thread_ids: [fixture.threadId] },
    }),
    [200],
  );
  if (advancement === "within-bound") {
    // The snapshotter follows the committed search watermark. These rows
    // extend the export bound while remaining outside the next snapshot.
    await store.set(
      seedRetentionOutputEvents$,
      { chatThreadId: fixture.threadId, count: 5, offsetMs: -60_000 },
      context.signal,
    );
  }
  const originalTail = await readChatTailRows(fixture, prefix);
  const originalUpper = originalTail.at(-1)?.seqId;
  if (originalUpper === undefined) {
    throw new Error("Expected a nonempty initial export tail");
  }
  return {
    fixture,
    prefix,
    projectedTail,
    projectedLast,
    revokeTargetId,
    archivedTailIds,
    originalTail,
    originalUpper,
  };
}

async function restoreDownloadedChatRows(
  archiveBytes: Buffer,
  threadId: string,
): Promise<readonly ChatEventRow[]> {
  const directory = await mkdtemp(join(tmpdir(), "okou-chat-export-restore-"));
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const archive = join(directory, "export.zip");
  const script = join(directory, "restore.py");
  const output = join(directory, "restored");
  await writeFile(archive, archiveBytes);
  await writeFile(
    script,
    readExportText(new AdmZip(archiveBytes), "restore.py"),
  );
  const result = spawnSync("python3", [script, archive, output], {
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const contents = await readFile(
    join(output, "chat-messages", `${threadId}.jsonl`),
    "utf8",
  );
  return contents
    .trimEnd()
    .split("\n")
    .map((line) => {
      return chatEventRowSchema.parse(JSON.parse(line));
    });
}

function expectExportMessageBytes(
  rows: readonly ChatEventRow[],
  expected: {
    readonly ids: readonly string[];
    readonly texts: readonly string[];
    readonly threadId: string;
    readonly offset: number;
  },
): void {
  for (const [index, content] of expected.texts.entries()) {
    const row = rows[index + expected.offset];
    expect(row).toMatchObject({
      id: expected.ids[index],
      chatThreadId: expected.threadId,
      eventType: "output.message",
    });
    if (!row) {
      throw new Error("Expected every exported message");
    }
    expect(
      createHash("sha256").update(JSON.stringify(row.payload)).digest("hex"),
    ).toBe(
      createHash("sha256").update(JSON.stringify({ content })).digest("hex"),
    );
  }
}

describe("archived chat event consumers", () => {
  const recordedPuts: RecordedChatEventPut[] = [];

  beforeEach(() => {
    recordedPuts.length = 0;
    mockEnv("GIT_COMMIT_SHA", "b".repeat(40));
    installFakeChatEventR2(context, recordedPuts);
    installAgentStorage();
  });

  it.each([false, true])(
    "exports snapshot history plus the PostgreSQL tail after archived source rows are gone (durable=%s)",
    async (durable) => {
      const fixture = await createArchiveFixture("export");
      if (!fixture.actor.orgId) {
        throw new Error("Expected an organization for the export fixture");
      }
      // Durable admission is the registry default, so the legacy arm states
      // the owner opt-out that keeps its export on the streaming exporter.
      await updateFeatureSwitchesForUser(
        context,
        { ...fixture.actor, orgId: fixture.actor.orgId },
        {
          [FeatureSwitchKey.DurableUserExport]: durable,
        },
      );
      const archivedVisible = `archived-export-${randomUUID()} \`${escapedOpen}\` suffix`;
      // Each message stays within PostgreSQL's indexed document limit while
      // their combined compressed snapshot crosses the export range boundary.
      const archivedTexts = durable
        ? Array.from({ length: 24 }, () => {
            return (
              withHiddenCitation(archivedVisible) +
              randomBytes(256 * 1024).toString("base64")
            );
          })
        : [withHiddenCitation(archivedVisible)];
      const archivedEventIds: string[] = [];
      for (const content of archivedTexts) {
        archivedEventIds.push(
          await store.set(
            seedRetentionOutputEvent$,
            { chatThreadId: fixture.threadId, content, offsetMs: -60_000 },
            context.signal,
          ),
        );
      }
      await archiveAndRetain(fixture.threadId, archivedEventIds);
      const tailVisible = `hot-tail-${randomUUID()} \`${escapedOpen}\` suffix`;
      const tailTexts = durable
        ? Array.from({ length: 100 }, (_, index) => {
            return `${withHiddenCitation(tailVisible)} ${index} ${"x".repeat(64 * 1024)}`;
          })
        : [withHiddenCitation(tailVisible)];
      const tailEventIds: string[] = [];
      for (const content of tailTexts) {
        tailEventIds.push(
          await store.set(
            seedRetentionOutputEvent$,
            { chatThreadId: fixture.threadId, content },
            context.signal,
          ),
        );
      }

      const exportApi = createOpsLogsApi(context);
      const storage = durable
        ? installDurableUserExportStorage(context)
        : undefined;
      if (!durable) {
        installUserExportStorage(context);
      }
      const started = await exportApi.requestPostUserExport(
        fixture.actor,
        [202],
      );
      await flushWaitUntilForTest();
      if (durable) {
        await accept(
          setupApp({ context, routes: testUserExportWorkRoutes })(
            testUserExportWorkContract,
          ).action({
            body: {
              action: "run",
              userId: fixture.actor.userId,
              jobId: started.body.jobId,
              maxSteps: 200,
            },
          }),
          [200],
        );
      }
      const status = await exportApi.requestGetUserExport(fixture.actor, [200]);
      expect(status.body.job).toMatchObject({
        id: started.body.jobId,
        status: "completed",
      });
      const zip =
        storage && status.body.job?.downloadUrl
          ? new AdmZip(storage.download(status.body.job.downloadUrl))
          : readUserExportZip(
              context,
              `exports/${fixture.actor.userId}/${started.body.jobId}.zip`,
            );
      const messages = durable
        ? readDurableChatRows(zip, fixture.threadId)
        : readExportChatRows(zip, fixture.threadId);
      expectExportMessageBytes(messages, {
        ids: archivedEventIds,
        texts: archivedTexts,
        threadId: fixture.threadId,
        offset: 0,
      });
      expectExportMessageBytes(messages, {
        ids: tailEventIds,
        texts: tailTexts,
        threadId: fixture.threadId,
        offset: archivedTexts.length,
      });
      if (durable) {
        expect(
          zip.getEntries().filter((entry) => {
            return entry.entryName.startsWith(
              `chat-messages/${fixture.threadId}/tail/`,
            );
          }).length,
        ).toBeGreaterThan(1);
      }
      expect(messages).toHaveLength(archivedTexts.length + tailTexts.length);
      expect(messages[0]?.seqId).toBeLessThan(messages.at(-1)?.seqId ?? 0);
    },
    60_000,
  );

  it.each(["within-bound", "overtake-with-revocation"] as const)(
    "restores a durable export when archival advances between source pages (%s)",
    async (advancement) => {
      const {
        fixture,
        prefix,
        projectedTail,
        projectedLast,
        revokeTargetId,
        archivedTailIds,
        originalTail,
        originalUpper,
      } = await createAdvancingExportFixture(advancement);
      let interruptInitialBatch = true;
      let stagedTail: readonly ChatEventRow[] | undefined;
      const storage = installDurableUserExportStorage(context, {
        afterWrite: (command) => {
          if (!(command instanceof PutObjectCommand)) {
            return Promise.resolve();
          }
          if (interruptInitialBatch) {
            interruptInitialBatch = false;
            return Promise.reject(
              new Error("Staged object persisted before request worker exited"),
            );
          }
          const body = command.input.Body;
          if (
            stagedTail === undefined &&
            body instanceof Uint8Array &&
            Buffer.from(body).includes(revokeTargetId)
          ) {
            stagedTail = Buffer.from(body)
              .toString("utf8")
              .trimEnd()
              .split("\n")
              .map((line) => {
                return chatEventRowSchema.parse(JSON.parse(line));
              });
          }
          return Promise.resolve();
        },
      });
      const worker = () => {
        return setupApp({ context, routes: testUserExportWorkRoutes })(
          testUserExportWorkContract,
        );
      };
      const api = createOpsLogsApi(context);
      const started = await api.requestPostUserExport(fixture.actor, [202]);
      const workerRequest = {
        userId: fixture.actor.userId,
        jobId: started.body.jobId,
      };
      onTestFinished(async () => {
        await accept(
          worker().action({ body: { ...workerRequest, action: "delete" } }),
          [200],
        );
        const outbox = createEmailOutboxStateApi(context);
        const emails = await outbox.findItems({
          toAddress: fixture.actor.email,
          subject: "Your data export is ready",
        });
        if (emails.length > 0) {
          await outbox.deleteItems(
            emails.map((email) => {
              return email.id;
            }),
          );
        }
      });
      await flushWaitUntilForTest();
      await accept(
        worker().action({ body: { ...workerRequest, action: "make-due" } }),
        [200],
      );
      // Each response commits its checkpoint. Observe the external staged
      // write only to stop at the first tail page, without relying on sleeps
      // or a fixed number of preceding implementation steps.
      for (let step = 0; step < 10 && stagedTail === undefined; step += 1) {
        await accept(
          worker().action({
            body: { ...workerRequest, action: "run", maxSteps: 1 },
          }),
          [200],
        );
      }
      if (stagedTail === undefined) {
        throw new Error("Export did not commit its first chat tail page");
      }
      expect(stagedTail).toHaveLength(100);
      expect(stagedTail.at(-1)?.seqId).toBeLessThan(originalUpper);
      expect(
        (await api.requestGetUserExport(fixture.actor, [200])).body.job
          ?.downloadUrl,
      ).toBeNull();

      let revokerId: string | undefined;
      let expectedTail = originalTail;
      if (advancement === "overtake-with-revocation") {
        revokerId = await store.set(
          revokeRetentionEvent$,
          {
            chatThreadId: fixture.threadId,
            eventId: revokeTargetId,
            offsetMs: -30_000,
          },
          context.signal,
        );
        expectedTail = await readChatTailRows(fixture, prefix);
        await accept(
          searchClient().project({
            body: { chat_thread_ids: [fixture.threadId] },
          }),
          [200],
        );
      }
      const advanced = await accept(
        snapshotClient().snapshot({
          body: { chat_thread_ids: [fixture.threadId], r2_object_keys: [] },
        }),
        [200],
      );
      expect(advanced.body.snapshots).toBe(1);
      const retained = await accept(
        retentionClient().retain({
          body: { chat_thread_ids: [fixture.threadId] },
        }),
        [200],
      );
      expect(retained.body.deleted).toBe(
        archivedTailIds.length + (revokerId === undefined ? 0 : 1),
      );
      const expectedLast = expectedTail.at(-1);
      if (!expectedLast) {
        throw new Error(
          "Expected the complete canonical tail before retention",
        );
      }
      const afterRetention = await readChatTailRows(
        fixture,
        revokerId === undefined ? projectedLast : expectedLast,
      );
      expect(afterRetention).toStrictEqual(
        advancement === "within-bound"
          ? originalTail.slice(projectedTail.length)
          : [],
      );

      await accept(
        worker().action({
          body: { ...workerRequest, action: "run", maxSteps: 200 },
        }),
        [200],
      );
      const completed = await api.requestGetUserExport(fixture.actor, [200]);
      expect(completed.body.job).toMatchObject({
        id: started.body.jobId,
        status: "completed",
        error: null,
      });
      const downloadUrl = completed.body.job?.downloadUrl;
      if (!downloadUrl) {
        throw new Error("Expected the resumed export download");
      }
      const archiveBytes = storage.download(downloadUrl);
      const zip = new AdmZip(archiveBytes);
      const index = JSON.parse(
        readExportText(zip, `chat-messages/${fixture.threadId}/index.json`),
      ) as { snapshotPhysicalCoverage: number; upperSeqId: number };
      const expectedUpper = expectedLast.seqId;
      expect(index.upperSeqId).toBe(expectedUpper);
      expect(index.snapshotPhysicalCoverage).toBe(
        advancement === "within-bound" ? projectedLast.seqId : expectedUpper,
      );
      if (advancement === "overtake-with-revocation") {
        expect(index.upperSeqId).toBeGreaterThan(originalUpper);
      }
      expect(
        zip.getEntries().filter((entry) => {
          return (
            entry.entryName.startsWith(
              `chat-messages/${fixture.threadId}/snapshots/`,
            ) && entry.entryName.endsWith(".ndjson.gz")
          );
        }),
      ).toHaveLength(2);
      const restored = await restoreDownloadedChatRows(
        archiveBytes,
        fixture.threadId,
      );
      expect(restored).toStrictEqual([prefix, ...expectedTail]);
      expect(
        new Set(
          restored.map((row) => {
            return row.id;
          }),
        ).size,
      ).toBe(restored.length);
      if (revokerId !== undefined) {
        expect(restored).toContainEqual(
          expect.objectContaining({
            id: revokerId,
            eventType: "control.revoke",
            revokesEventId: revokeTargetId,
          }),
        );
        const visible = semanticChatEventsFromChatEvents(
          restored.map(chatEventFromRow),
        );
        expect(
          visible.map(({ event }) => {
            return event.id;
          }),
        ).not.toContain(revokeTargetId);
      }
    },
    60_000,
  );

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

  it("shares one hot-table snapshot when its event is deleted after the read without blocking other threads", async () => {
    const fixture = await createArchiveFixture("sharing-race");
    const hotVisible = `share-hot-race-${randomUUID()} \`${escapedOpen}\` suffix`;
    const hotText = withHiddenCitation(hotVisible);
    const hotEventId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: fixture.threadId, content: hotText },
      context.signal,
    );
    const unrelated = await createArchiveFixture("unrelated-sharing");
    const unrelatedText = `unrelated-hot-${randomUUID()}`;
    const unrelatedEventId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: unrelated.threadId, content: unrelatedText },
      context.signal,
    );

    mockOptionalEnv("OPENROUTER_API_KEY", "hot-sharing-race-key");
    chatCallbacks.mockOpenRouterCompletions(() => {
      return "Hot selection";
    });
    const created = await withChatEventDeletedAfterReadFixture({
      threadId: fixture.threadId,
      eventId: hotEventId,
      whileResponseHeld: async () => {
        // Another thread can finish real reads and writes while this response
        // is paused. The fixture then deletes only the selected original event.
        const otherCreated = await accept(
          sharedThreadClient().create({
            params: { threadId: unrelated.threadId },
            headers: authenticate(unrelated.actor),
            body: { eventIds: [unrelatedEventId] },
          }),
          [201],
        );
        const otherShared = await accept(
          sharedThreadClient().get({ params: { id: otherCreated.body.id } }),
          [200],
        );
        expect(otherShared.body.messages).toStrictEqual([
          { messageIndex: 0, role: "assistant", content: unrelatedText },
        ]);
      },
      work: async () => {
        return await accept(
          sharedThreadClient().create({
            params: { threadId: fixture.threadId },
            headers: authenticate(fixture.actor),
            body: { eventIds: [hotEventId] },
          }),
          [201],
        );
      },
    });
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

  it("restores sharing after the held hot-read response fails", async () => {
    const fixture = await createArchiveFixture("failed-sharing-race");
    const content = `retained-after-failed-read-${randomUUID()}`;
    const eventId = await store.set(
      seedRetentionOutputEvent$,
      { chatThreadId: fixture.threadId, content },
      context.signal,
    );
    mockOptionalEnv("OPENROUTER_API_KEY", "failed-sharing-race-key");
    chatCallbacks.mockOpenRouterCompletions(() => {
      return "Recovered selection";
    });
    const create = () => {
      return sharedThreadClient().create({
        params: { threadId: fixture.threadId },
        headers: authenticate(fixture.actor),
        body: { eventIds: [eventId] },
      });
    };

    await expect(
      withChatEventDeletedAfterReadFixture({
        threadId: fixture.threadId,
        eventId,
        whileResponseHeld: () => {
          // Fail after the real read but before physical deletion. A later
          // request must still share the retained event through a fresh pool.
          return Promise.reject(new Error("Held chat-event response failed"));
        },
        work: async () => {
          return await accept(create(), [201]);
        },
      }),
    ).rejects.toThrow("Unknown response status 500");

    const created = await accept(create(), [201]);
    const shared = await accept(
      sharedThreadClient().get({ params: { id: created.body.id } }),
      [200],
    );
    expect(shared.body).toStrictEqual({
      id: created.body.id,
      publicBrand: "okou",
      title: "Recovered selection",
      messages: [{ messageIndex: 0, role: "assistant", content }],
    });
  });

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
