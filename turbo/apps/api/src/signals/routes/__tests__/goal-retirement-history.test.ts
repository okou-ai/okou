import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it } from "vitest";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { testUserExportWorkContract } from "@okouai/api-contracts/contracts/test-user-export-work";
import AdmZip from "adm-zip";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  seedLiteralGoalArchive,
  removeSnapshottedGoalFixtureEvents,
  seedFilteredGoalArchiveProjections,
  seedMalformedGoalArchiveFixture,
} from "../../../test-fixtures/goal-retirement";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { sharedThreadRoutes } from "../shared-threads";
import { chatThreadRoutes } from "../chat-threads";
import { testUserExportWorkRoutes } from "../test-user-export-work";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { readDurableExportChatRows } from "./helpers/user-export-storage";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import { createRouteMocks } from "./helpers/route-test";
import {
  installFakeChatEventR2,
  readFakeChatEventObject,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const routeMocks = createRouteMocks(context);

describe("retired Goal logical history", () => {
  const puts: RecordedChatEventPut[] = [];
  beforeEach(() => {
    puts.length = 0;
    mockEnv("GIT_COMMIT_SHA", "b".repeat(40));
    installFakeChatEventR2(context, puts);
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
          ? /^bytes=(\d+)-(\d+)$/u.exec(command.input.Range)
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
  });

  it("filters a copied notice whose historical payload has an extra prototype key", async () => {
    const actor = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(actor, {
      displayName: "Historical payload",
    });
    const thread = await chat.createThread(actor, { agentId: agent.agentId });
    const prefix =
      "Okou Goal retired.\nGoal ID: 00000000-0000-4000-8000-000000000001\nOriginal recorded status: complete\nThe recorded status is preserved; retirement does not mark the objective complete.\n\nFull original objective:\n";
    // Only historical infrastructure can construct a payload rejected by current writers.
    const eventId = await seedMalformedGoalArchiveFixture(
      thread.id,
      `${prefix}Before <oai-mem-citation>hiddenneedle</oai-mem-citation> after`,
    );
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const shares = setupApp({ context, routes: sharedThreadRoutes })(
      sharedThreadsContract,
    );
    const created = await accept(
      shares.create({
        params: { threadId: thread.id },
        headers: { authorization: "Bearer clerk-session" },
        body: { eventIds: [eventId] },
      }),
      [201],
    );
    const shared = await accept(
      shares.get({ params: { id: created.body.id } }),
      [200],
    );
    expect(shared.body.messages[0]?.content).toBe(`${prefix}Before  after`);
    await accept(
      setupApp({ context, routes: testChatEventSearchProjectionRoutes })(
        testChatEventSearchProjectionContract,
      ).project({ body: { chat_thread_ids: [thread.id] } }),
      [200],
    );
    expect(
      (await chat.searchChat(actor, "hiddenneedle")).results,
    ).toStrictEqual([]);
    expect(
      (await chat.searchChat(actor, "Before")).results[0]?.matchedMessage
        .content,
    ).toBe(`${prefix}Before  after`);
  });

  it.each(["active", "paused", "blocked", "complete"] as const)(
    "preserves literal %s history",
    async (status) => {
      const actor = bdd.user({ orgId: `org_${randomUUID()}` });
      const agent = await bdd.createAgent(actor, {
        displayName: "Retirement history",
      });
      const thread = await chat.createThread(actor, {
        agentId: agent.agentId,
      });
      const objective =
        " \n完整目标 🧭 e\u0301\t\r\nBefore <oai-mem-citation>archiveneedle</oai-mem-citation> after\n" +
        "Inline `<oai-mem-citation>` and ```xml\n<oai-mem-citation>fenced literal</oai-mem-citation>\n```\n" +
        "'quoted'; $$ | </tag>\nExplain <oai-mem-citation>unmatchedneedle and keep all later original text\n\n";
      // Current APIs cannot create retired Goal history. Seed only retained
      // events; all observable assertions use production endpoints.
      await seedLiteralGoalArchive(thread.id, objective, status);
      const before = await chat.listThreadEvents(actor, thread.id);
      const archives = before.events.filter((event) => {
        return event.eventType === "output.message";
      });
      expect(archives).toHaveLength(1);
      expect(archives[0]?.content).toContain(
        `Original recorded status: ${status}`,
      );
      expect(archives[0]?.content?.endsWith(objective)).toBeTruthy();
      expect(
        before.events.filter((event) => {
          return event.eventType === "goal.close";
        }),
      ).toHaveLength(1);
      expect(archives[0]?.runId).toBeUndefined();
      const archive = archives[0];
      if (!archive?.content) {
        throw new Error("Expected archive");
      }
      const shares = setupApp({ context, routes: sharedThreadRoutes })(
        sharedThreadsContract,
      );
      const createShare = async () => {
        routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
        const created = await accept(
          shares.create({
            params: { threadId: thread.id },
            headers: { authorization: "Bearer clerk-session" },
            body: { eventIds: [archive.id] },
          }),
          [201],
        );
        const shared = await accept(
          shares.get({ params: { id: created.body.id } }),
          [200],
        );
        expect(shared.body.messages).toStrictEqual([
          { messageIndex: 0, role: "assistant", content: archive.content },
        ]);
        return created.body.id;
      };
      const hotShareId = await createShare();

      await accept(
        setupApp({ context, routes: testChatEventSearchProjectionRoutes })(
          testChatEventSearchProjectionContract,
        ).project({ body: { chat_thread_ids: [thread.id] } }),
        [200],
      );
      const searchable = await chat.searchChat(actor, "archiveneedle");
      expect(
        searchable.results.map((result) => {
          return result.matchedMessage.content;
        }),
      ).toStrictEqual([archive.content]);
      const oldShareId = await seedFilteredGoalArchiveProjections(thread.id);
      const oldShare = await accept(
        shares.get({ params: { id: oldShareId } }),
        [200],
      );
      expect(oldShare.body.messages[0]?.content).not.toContain("archiveneedle");

      await accept(
        setupApp({ context, routes: testChatEventSnapshotRoutes })(
          testChatEventSnapshotContract,
        ).snapshot({
          body: { chat_thread_ids: [thread.id], r2_object_keys: [] },
        }),
        [200],
      );
      expect(puts.length).toBeGreaterThan(0);
      await removeSnapshottedGoalFixtureEvents(thread.id);
      await chat.requestListThreadEvents(actor, thread.id, {}, [410]);
      routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      const download = await accept(
        setupApp({ context, routes: chatThreadRoutes })(
          chatThreadEventsContract,
        ).snapshot({
          headers: {
            authorization: "Bearer clerk-session",
            [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
              CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
          },
          params: { threadId: thread.id },
        }),
        [200],
      );
      const cursor = download.body;
      if (cursor.lastEventId === null) {
        throw new Error("Expected nonempty retirement snapshot");
      }
      const snapshotPut = puts.at(-1);
      if (snapshotPut === undefined) {
        throw new Error("Expected snapshot publication");
      }
      const snapshotRows = gunzipSync(snapshotPut.body)
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          return chatEventRowSchema.parse(JSON.parse(line));
        });
      expect(projectChatEventRows(snapshotRows)).toStrictEqual(before.events);
      await accept(
        setupApp({ context, routes: testChatEventSearchProjectionRoutes })(
          testChatEventSearchProjectionContract,
        ).project({ body: { chat_thread_ids: [thread.id] } }),
        [200],
      );
      const repaired = await chat.searchChat(actor, "unmatchedneedle");
      expect(
        repaired.results.map((result) => {
          return result.matchedMessage.content;
        }),
      ).toStrictEqual([archive.content]);
      await createShare();
      expect(
        (await accept(shares.get({ params: { id: hotShareId } }), [200])).body
          .messages[0]?.content,
      ).toBe(archive.content);
      expect(
        (await accept(shares.get({ params: { id: oldShareId } }), [200])).body,
      ).toStrictEqual(oldShare.body);

      const after = await chat.listThreadEvents(actor, thread.id, {
        sinceSeqId: cursor.lastSeqId,
        sinceEventId: cursor.lastEventId,
      });
      expect(after.events).toStrictEqual([]);

      const sent = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          threadId: thread.id,
          prompt: "Continue with a regular message",
        },
        [201],
      );
      expect(sent.status).toBe(201);
      const continued = await chat.listThreadEvents(actor, thread.id, {
        sinceSeqId: cursor.lastSeqId,
        sinceEventId: cursor.lastEventId,
      });
      expect(
        continued.events.filter((event) => {
          return event.eventType === "output.message";
        }),
      ).toStrictEqual([]);
      expect(
        continued.events.some((event) => {
          return event.eventType === "input.prompt";
        }),
      ).toBeTruthy();

      const continuedRows = await chat.listThreadEventRows(
        actor,
        thread.id,
        cursor,
      );
      const exports = createOpsLogsApi(context);
      const storage = installDurableUserExportStorage(context);
      const started = await exports.requestPostUserExport(actor, [202]);
      await flushWaitUntilForTest();
      await accept(
        setupApp({ context, routes: testUserExportWorkRoutes })(
          testUserExportWorkContract,
        ).action({
          body: {
            action: "run",
            userId: actor.userId,
            jobId: started.body.jobId,
            maxSteps: 200,
          },
        }),
        [200],
      );
      const exportStatus = await exports.requestGetUserExport(actor, [200]);
      expect(exportStatus.body.job).toMatchObject({
        id: started.body.jobId,
        status: "completed",
      });
      const downloadUrl = exportStatus.body.job?.downloadUrl;
      if (!downloadUrl) {
        throw new Error("Expected a downloadable goal-history export");
      }
      const zip = new AdmZip(storage.download(downloadUrl));
      const rows = readDurableExportChatRows(zip, thread.id);
      expect(rows).toStrictEqual([...snapshotRows, ...continuedRows]);
      expect(
        rows.filter((row) => {
          return row.id === archive.id;
        }),
      ).toHaveLength(1);
      expect(
        rows.find((row) => {
          return row.id === archive.id;
        })?.payload?.content,
      ).toBe(archive.content);
    },
    60_000,
  );
});
