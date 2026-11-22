import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  cronProjectChatEventSearchContract,
  cronSnapshotChatEventsContract,
} from "@okouai/api-contracts/contracts/cron";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { chatThreadRoutes } from "../chat-threads";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { cronSnapshotChatEventsRoutes } from "../cron-snapshot-chat-events";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { CHAT_RUN_USAGE_LIMIT_MESSAGE } from "@okouai/api-contracts/contracts/errors";

const context = testContext();

function snapshotCronClient() {
  return setupApp({ context, routes: cronSnapshotChatEventsRoutes })(
    cronSnapshotChatEventsContract,
  );
}

function mockSnapshotStorage(
  beforePut?: () => Promise<void>,
): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation(async (request: unknown) => {
    if (request instanceof PutObjectCommand) {
      const { Bucket, Key, Body } = request.input;
      if (!Bucket || !Key || !Buffer.isBuffer(Body)) {
        throw new Error("Expected snapshot upload bytes and object identity");
      }
      await beforePut?.();
      objects.set(`${Bucket}/${Key}`, Buffer.from(Body));
      return {};
    }
    if (request instanceof GetObjectCommand) {
      const body = objects.get(`${request.input.Bucket}/${request.input.Key}`);
      if (!body) {
        throw new Error("Requested snapshot object was not uploaded");
      }
      return {
        Body: Readable.from([body]),
        ContentLength: body.length,
      };
    }
    if (request instanceof ListObjectsV2Command) {
      return { Contents: [], IsTruncated: false };
    }
    throw new Error("Unexpected snapshot storage request");
  });
  server.use(
    http.get("https://r2.example.com/storage/archive.tar.gz", ({ request }) => {
      const object = new URL(request.url).searchParams.get("object");
      const body = object === null ? undefined : objects.get(object);
      if (!body) {
        return new HttpResponse(null, { status: 404 });
      }
      return new HttpResponse(new Uint8Array(body), {
        headers: {
          "content-type": "application/x-ndjson",
          "content-encoding": "gzip",
        },
      });
    }),
  );
  return objects;
}

describe("cron snapshot chat events", () => {
  it("keeps r1 snapshots readable and immutable as failed-run history grows", async () => {
    const app = await setupApp({
      context,
      routes: [
        ...cronProjectChatEventSearchRoutes,
        ...cronSnapshotChatEventsRoutes,
        ...chatThreadRoutes,
      ],
      isolatePg: true,
    });
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const run = await owned.sendChatRun(owned.actor, {
        prompt: "Archive a provider usage-limit failure",
      });
      const execution = await owned.executionInput(run.runId);
      await createWebhookCallbackApi(context).requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 1,
          failureReason: "usage_limit",
          error: "Private quota details https://private.invalid/token",
        },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
      const chat = createChatFilesBddApi(context);
      const rows = await chat.listThreadEventRows(owned.actor, run.threadId);
      expect(rows).toContainEqual(
        expect.objectContaining({
          runId: run.runId,
          eventType: "run.failed",
          failureReason: "usage_limit",
          payload: {
            content: CHAT_RUN_USAGE_LIMIT_MESSAGE,
          },
        }),
      );
      const objects = mockSnapshotStorage();
      const headers = { authorization: "Bearer test-cron-secret" };
      await accept(
        app(cronProjectChatEventSearchContract).project({ headers }),
        [200],
      );
      await accept(
        app(cronSnapshotChatEventsContract).snapshot({ headers }),
        [200],
      );
      createRouteMocks(context).clerk.session(
        owned.actor.userId,
        owned.actor.orgId,
        owned.actor.orgRole,
      );
      const snapshot = await accept(
        app(chatThreadEventsContract).snapshot({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: run.threadId },
        }),
        [200],
      );
      expect(snapshot.body.url).toContain("-r1-");
      const downloaded = await fetch(snapshot.body.url);
      expect(downloaded.status).toBe(200);
      const originalText = await downloaded.text();
      const archived = originalText
        .trimEnd()
        .split("\n")
        .map((line) => {
          return chatEventRowSchema.parse(JSON.parse(line));
        });
      expect(archived).toStrictEqual(rows);
      const originalObjects = new Map(
        [...objects].map(([key, body]) => {
          return [key, Buffer.from(body)];
        }),
      );
      await accept(
        app(cronSnapshotChatEventsContract).snapshot({ headers }),
        [200],
      );
      for (const [key, body] of originalObjects) {
        expect(objects.get(key)).toStrictEqual(body);
      }

      const clientEventId = randomUUID();
      await chat.requestSendEvent(
        owned.actor,
        {
          threadId: run.threadId,
          clientEventId,
          prompt: "Continue after the archived failure",
        },
        [201],
      );
      await flushWaitUntilForTest();
      const followUp = (
        await chat.listThreadEventRows(owned.actor, run.threadId, snapshot.body)
      ).find((row) => {
        return (
          row.eventType === "input.prompt" &&
          row.revokesEventId === clientEventId
        );
      });
      if (followUp?.runId === undefined || followUp.runId === null) {
        throw new Error("Expected the follow-up input to launch a run");
      }
      const followUpExecution = await owned.executionInput(followUp.runId);
      await createWebhookCallbackApi(context).requestAgentComplete(
        {
          runId: followUp.runId,
          exitCode: 1,
          failureReason: "usage_limit",
          error: "Private follow-up diagnostics",
        },
        { authorization: `Bearer ${followUpExecution.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
      const tailRows = await chat.listThreadEventRows(
        owned.actor,
        run.threadId,
        snapshot.body,
      );
      await accept(
        app(cronProjectChatEventSearchContract).project({ headers }),
        [200],
      );
      await accept(
        app(cronSnapshotChatEventsContract).snapshot({ headers }),
        [200],
      );
      createRouteMocks(context).clerk.session(
        owned.actor.userId,
        owned.actor.orgId,
        owned.actor.orgRole,
      );
      const advanced = await accept(
        app(chatThreadEventsContract).snapshot({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: run.threadId },
        }),
        [200],
      );
      expect(advanced.body.url).toContain("-r1-");
      expect(advanced.body.lastSeqId).toBeGreaterThan(snapshot.body.lastSeqId);
      const advancedDownload = await fetch(advanced.body.url);
      expect(advancedDownload.status).toBe(200);
      const advancedText = await advancedDownload.text();
      expect(advancedText.startsWith(originalText)).toBeTruthy();
      const advancedRows = advancedText
        .trimEnd()
        .split("\n")
        .map((line) => {
          return chatEventRowSchema.parse(JSON.parse(line));
        });
      expect(advancedRows).toStrictEqual([...archived, ...tailRows]);
      for (const [key, body] of originalObjects) {
        expect(objects.get(key)).toStrictEqual(body);
      }
    });
  });

  it("requires the cron secret", async () => {
    const response = await accept(
      snapshotCronClient().snapshot({ headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("keeps a surviving archive downloadable during another thread deletion", async () => {
    const app = await setupApp({
      context,
      routes: [
        ...cronProjectChatEventSearchRoutes,
        ...cronSnapshotChatEventsRoutes,
        ...chatThreadRoutes,
      ],
      isolatePg: true,
    });
    const bdd = createBddApi(context);
    bdd.acceptStorageWrites();
    const chat = createChatFilesBddApi(context);
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const marker = `snapshot-deletion-${randomUUID()}`;
    const threadIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const thread = await chat.createThread(owner, {});
      const sent = await chat.requestSendEvent(
        owner,
        { threadId: thread.id, model: null, prompt: marker },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the no-credit Auto input to be accepted");
      }
      threadIds.push(sent.body.threadId);
      await flushWaitUntilForTest();
    }
    const deletedThreadId = threadIds[1]!;
    const survivingThreadId = threadIds[0]!;
    const headers = { authorization: "Bearer test-cron-secret" };
    await accept(
      app(cronProjectChatEventSearchContract).project({ headers }),
      [200],
    );

    const uploadStarted = createDeferredPromise<void>(context.signal);
    const releaseUploads = createDeferredPromise<void>(context.signal);
    mockSnapshotStorage(async () => {
      if (!uploadStarted.settled()) {
        uploadStarted.resolve(undefined);
      }
      await releaseUploads.promise;
    });
    const snapshot = accept(
      app(cronSnapshotChatEventsContract).snapshot({ headers }),
      [200],
    );
    onTestFinished(async () => {
      if (!releaseUploads.settled()) {
        releaseUploads.resolve(undefined);
      }
      await snapshot;
    });
    await uploadStarted.promise;
    await chat.deleteThread(owner, deletedThreadId);
    releaseUploads.resolve(undefined);

    await snapshot;
    createRouteMocks(context).clerk.session(
      owner.userId,
      owner.orgId,
      owner.orgRole,
    );
    const events = app(chatThreadEventsContract);
    const userHeaders = { authorization: "Bearer clerk-session" };
    await accept(
      events.snapshot({
        headers: userHeaders,
        params: { threadId: deletedThreadId },
      }),
      [404],
    );
    const surviving = await accept(
      events.snapshot({
        headers: userHeaders,
        params: { threadId: survivingThreadId },
      }),
      [200],
    );
    const downloaded = await fetch(surviving.body.url);
    expect(downloaded.status).toBe(200);
    const rows = (await downloaded.text())
      .trimEnd()
      .split("\n")
      .map((line) => {
        return chatEventRowSchema.parse(JSON.parse(line));
      });
    expect(rows.map(chatEventFromRow)).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        userMessage: expect.objectContaining({
          parts: [{ type: "text", text: marker }],
        }),
      }),
    );
  }, 60_000);

  it("recovers a downloadable snapshot after an S3 read failure without leaking private diagnostics", async () => {
    const app = await setupApp({
      context,
      routes: [
        ...cronProjectChatEventSearchRoutes,
        ...cronSnapshotChatEventsRoutes,
        ...chatThreadRoutes,
      ],
      isolatePg: true,
    });
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const objects = mockSnapshotStorage();

    const markers = [
      `snapshot-first-${randomUUID()}`,
      `snapshot-second-${randomUUID()}`,
    ];
    const { id: threadId } = await chat.createThread(owner, {});
    let priorRows: ChatEventRow[] = [];
    let priorSeqId = 0;
    for (const marker of markers) {
      const sent = await chat.requestSendEvent(
        owner,
        {
          threadId,
          model: null,
          prompt: marker,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the no-credit Auto input to be accepted");
      }

      await flushWaitUntilForTest();

      const headers = { authorization: "Bearer test-cron-secret" };
      await accept(
        app(cronProjectChatEventSearchContract).project({ headers }),
        [200],
      );
      if (priorSeqId > 0) {
        // One redaction check at the real operator boundary; the same public
        // lifecycle also verifies that skipped work remains eligible to recover.
        const output = context.mocks.console.log;
        onTestFinished(context.mocks.console.capture());
        const privateContext = `private-snapshot-credential ${threadId} ${[...objects.keys()].join(" ")}`;
        output.mockClear();
        context.mocks.s3.send.mockRejectedValueOnce(
          Object.assign(new Error(privateContext), {
            name: "AccessDenied",
            cause: new Error(privateContext),
            $metadata: {
              httpStatusCode: 403,
              attempts: 1,
              requestId: privateContext,
            },
            request: { url: `https://storage.example/${privateContext}` },
          }),
        );
        await accept(
          app(cronSnapshotChatEventsContract).snapshot({ headers }),
          [200],
        );
        const warnings = output.mock.calls.filter(([message]) => {
          return (
            typeof message === "string" &&
            message.includes("Skipped Chat Event Snapshot pointer")
          );
        });
        expect(warnings.length).toBeGreaterThan(0);
        expect(JSON.stringify(warnings)).not.toContain(privateContext);
        expect(JSON.stringify(warnings)).not.toContain(threadId);
        createRouteMocks(context).clerk.session(
          owner.userId,
          owner.orgId,
          owner.orgRole,
        );
        const previous = await accept(
          app(chatThreadEventsContract).snapshot({
            headers: { authorization: "Bearer clerk-session" },
            params: { threadId },
          }),
          [200],
        );
        expect(previous.body.lastSeqId).toBe(priorSeqId);
        expect(previous.body.lastEventId).toBe(priorRows.at(-1)?.id);
        const downloaded = await fetch(previous.body.url);
        expect(downloaded.status).toBe(200);
        const previousRows = (await downloaded.text())
          .trimEnd()
          .split("\n")
          .map((line) => {
            return chatEventRowSchema.parse(JSON.parse(line));
          });
        expect(previousRows).toStrictEqual(priorRows);
      }
      await accept(
        app(cronSnapshotChatEventsContract).snapshot({ headers }),
        [200],
      );
      createRouteMocks(context).clerk.session(
        owner.userId,
        owner.orgId,
        owner.orgRole,
      );
      const snapshot = await accept(
        app(chatThreadEventsContract).snapshot({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId },
        }),
        [200],
      );
      const downloaded = await fetch(snapshot.body.url);
      expect(downloaded.status).toBe(200);
      const rows = (await downloaded.text())
        .trimEnd()
        .split("\n")
        .map((line) => {
          return chatEventRowSchema.parse(JSON.parse(line));
        });
      expect(rows.length).toBeGreaterThan(0);
      for (const [index, row] of rows.entries()) {
        expect(row.chatThreadId).toBe(threadId);
        if (index > 0) {
          expect(row.seqId).toBeGreaterThan(rows[index - 1]!.seqId);
        }
      }
      expect(snapshot.body.lastSeqId).toBe(rows.at(-1)?.seqId);
      expect(snapshot.body.lastEventId).toBe(rows.at(-1)?.id);
      expect(snapshot.body.lastSeqId).toBeGreaterThan(priorSeqId);
      expect(rows.slice(0, priorRows.length)).toStrictEqual(priorRows);
      expect(rows.map(chatEventFromRow)).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "input.prompt",
            userMessage: expect.objectContaining({
              parts: expect.arrayContaining([{ type: "text", text: marker }]),
            }),
          }),
        ]),
      );
      priorRows = rows;
      priorSeqId = snapshot.body.lastSeqId;
    }
  }, 60_000);
});
