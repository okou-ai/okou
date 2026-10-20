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
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";
import { cronSnapshotChatEventsRoutes } from "../cron-snapshot-chat-events";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

function snapshotCronClient() {
  return setupApp({ context, routes: cronSnapshotChatEventsRoutes })(
    cronSnapshotChatEventsContract,
  );
}

function mockSnapshotStorage(): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((request: unknown) => {
    if (request instanceof PutObjectCommand) {
      const { Bucket, Key, Body } = request.input;
      if (!Bucket || !Key || !Buffer.isBuffer(Body)) {
        throw new Error("Expected snapshot upload bytes and object identity");
      }
      objects.set(`${Bucket}/${Key}`, Buffer.from(Body));
      return Promise.resolve({});
    }
    if (request instanceof GetObjectCommand) {
      const body = objects.get(`${request.input.Bucket}/${request.input.Key}`);
      if (!body) {
        throw new Error("Requested snapshot object was not uploaded");
      }
      return Promise.resolve({
        Body: Readable.from([body]),
        ContentLength: body.length,
      });
    }
    if (request instanceof ListObjectsV2Command) {
      return Promise.resolve({ Contents: [], IsTruncated: false });
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
  it("requires the cron secret", async () => {
    const response = await accept(
      snapshotCronClient().snapshot({ headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("paginates dense and sparse candidates in thread order and recovers unreadable tail work", async () => {
    const app = await setupApp({
      context,
      routes: [
        ...cronProjectChatEventSearchRoutes,
        ...cronSnapshotChatEventsRoutes,
        ...chatThreadRoutes,
      ],
      isolatePg: true,
    });
    mockOptionalEnv("CHAT_EVENT_SNAPSHOT_BATCH_SIZE", "1");
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const chat = createChatFilesBddApi(context);
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot pagination agent",
    });
    mockSnapshotStorage();
    const threadIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const sent = await chat.requestSendEvent(
        owner,
        {
          agentId: agent.agentId,
          model: null,
          prompt: `initial-${randomUUID()}`,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the no-credit Auto input to be accepted");
      }
      threadIds.push(sent.body.threadId);
      await flushWaitUntilForTest();
    }
    threadIds.sort();
    const headers = { authorization: "Bearer test-cron-secret" };
    const userHeaders = { authorization: "Bearer clerk-session" };
    const events = app(chatThreadEventsContract);
    await accept(
      app(cronProjectChatEventSearchContract).project({ headers }),
      [200],
    );

    // More than one candidate lies inside each four-key window. Advancing to
    // the window boundary instead of the attempted thread would skip pages.
    const originalSeqIds = new Map<string, number>();
    for (const [index, threadId] of threadIds.entries()) {
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
        events.snapshot({ headers: userHeaders, params: { threadId } }),
        [200],
      );
      originalSeqIds.set(threadId, snapshot.body.lastSeqId);
      const nextThreadId = threadIds[index + 1];
      if (nextThreadId !== undefined) {
        await accept(
          events.snapshot({
            headers: userHeaders,
            params: { threadId: nextThreadId },
          }),
          [404],
        );
      }
    }

    const changedThreadIds = [threadIds[0]!, threadIds[1]!, threadIds[7]!];
    const markers = new Map<string, string>();
    for (const threadId of changedThreadIds) {
      const marker = `snapshot-next-page-${randomUUID()}`;
      markers.set(threadId, marker);
      await chat.requestSendEvent(
        owner,
        { agentId: agent.agentId, threadId, model: null, prompt: marker },
        [201],
      );
      await flushWaitUntilForTest();
    }
    await accept(
      app(cronProjectChatEventSearchContract).project({ headers }),
      [200],
    );

    for (let page = 0; page < changedThreadIds.length; page += 1) {
      if (page === 2) {
        // The remaining candidate is beyond four unchanged source keys. A
        // provider failure must preserve its published prefix and permit repair
        // after the global cycle wraps, without stalling earlier pages.
        context.mocks.s3.send.mockImplementationOnce((request: unknown) => {
          if (!(request instanceof GetObjectCommand)) {
            throw new Error(
              "Expected the sparse candidate's existing snapshot",
            );
          }
          return Promise.reject(
            Object.assign(new Error("Snapshot unavailable"), {
              name: "NoSuchKey",
            }),
          );
        });
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
      for (const [index, threadId] of changedThreadIds.entries()) {
        const snapshot = await accept(
          events.snapshot({ headers: userHeaders, params: { threadId } }),
          [200],
        );
        if (index <= page && index < 2) {
          expect(snapshot.body.lastSeqId).toBeGreaterThan(
            originalSeqIds.get(threadId)!,
          );
        } else {
          expect(snapshot.body.lastSeqId).toBe(originalSeqIds.get(threadId));
        }
      }
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
    for (const threadId of changedThreadIds) {
      const snapshot = await accept(
        events.snapshot({ headers: userHeaders, params: { threadId } }),
        [200],
      );
      expect(snapshot.body.lastSeqId).toBeGreaterThan(
        originalSeqIds.get(threadId)!,
      );
      const downloaded = await fetch(snapshot.body.url);
      expect(downloaded.status).toBe(200);
      const rows = (await downloaded.text())
        .trimEnd()
        .split("\n")
        .map((line) => {
          return chatEventRowSchema.parse(JSON.parse(line));
        });
      expect(rows.map(chatEventFromRow)).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "input.prompt",
            userMessage: expect.objectContaining({
              parts: expect.arrayContaining([
                { type: "text", text: markers.get(threadId) },
              ]),
            }),
          }),
        ]),
      );
    }
  }, 60_000);

  it("publishes downloadable snapshots and recovers from failures with private diagnostics", async () => {
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
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot publication agent",
    });
    const objects = mockSnapshotStorage();

    const markers = [
      `snapshot-first-${randomUUID()}`,
      `snapshot-second-${randomUUID()}`,
    ];
    let threadId: string | undefined;
    let priorRows: ChatEventRow[] = [];
    let priorSeqId = 0;
    for (const marker of markers) {
      const sent = await chat.requestSendEvent(
        owner,
        {
          agentId: agent.agentId,
          ...(threadId === undefined ? {} : { threadId }),
          model: null,
          prompt: marker,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the no-credit Auto input to be accepted");
      }
      threadId = sent.body.threadId;
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
        const failures: readonly {
          readonly name?: string;
          readonly code?: string;
          readonly metadata?: Readonly<Record<string, unknown>>;
          readonly body?: boolean;
          readonly expected: Readonly<Record<string, unknown>>;
        }[] = [
          {
            name: "NoSuchKey",
            metadata: { httpStatusCode: 404, attempts: 1 },
            expected: {
              failureClass: "not_found",
              providerStatus: 404,
              providerAttempts: 1,
              providerRetries: 0,
            },
          },
          {
            name: "AccessDenied",
            metadata: { httpStatusCode: 403, attempts: 3 },
            expected: {
              failureClass: "access_denied",
              providerStatus: 403,
              providerAttempts: 3,
              providerRetries: 2,
            },
          },
          {
            name: "SlowDown",
            metadata: { httpStatusCode: 503, attempts: 2 },
            expected: {
              failureClass: "throttled",
              providerStatus: 503,
              providerAttempts: 2,
              providerRetries: 1,
            },
          },
          {
            metadata: { httpStatusCode: 502, attempts: 3 },
            expected: {
              failureClass: "upstream",
              providerStatus: 502,
              providerAttempts: 3,
              providerRetries: 2,
            },
          },
          { name: "TimeoutError", expected: { failureClass: "timeout" } },
          {
            code: "ECONNRESET",
            metadata: { attempts: 2 },
            expected: {
              failureClass: "transport",
              providerAttempts: 2,
              providerRetries: 1,
            },
          },
          { expected: { failureClass: "unknown" } },
          {
            body: true,
            metadata: { httpStatusCode: 200, attempts: 2 },
            expected: {
              failureClass: "body",
              providerStatus: 200,
              providerAttempts: 2,
              providerRetries: 1,
            },
          },
        ];
        for (const failure of failures) {
          output.mockClear();
          context.mocks.s3.send.mockImplementationOnce((request: unknown) => {
            if (!(request instanceof GetObjectCommand)) {
              throw new Error("Expected the existing snapshot download");
            }
            const metadata = {
              requestId: privateContext,
              ...failure.metadata,
            };
            if (failure.body) {
              const body = objects.get(
                `${request.input.Bucket}/${request.input.Key}`,
              );
              if (!body) {
                throw new Error("Expected a previously uploaded snapshot");
              }
              return Promise.resolve({
                Body: Readable.from([body]),
                ContentLength: body.length + 1,
                $metadata: metadata,
              });
            }
            return Promise.reject(
              Object.assign(new Error(privateContext), {
                name: failure.name ?? privateContext,
                code: failure.code ?? privateContext,
                $metadata: metadata,
                cause: new Error(privateContext),
                request: { url: `https://storage.example/${privateContext}` },
              }),
            );
          });
          const skipped = await accept(
            app(cronSnapshotChatEventsContract).snapshot({ headers }),
            [200],
          );
          expect(skipped.body.skippedUnreadableHeads).toBe(1);
          const warnings = output.mock.calls.filter(([message]) => {
            return (
              typeof message === "string" &&
              message.includes("Skipped Chat Event Snapshot pointer")
            );
          });
          expect(warnings).toStrictEqual([
            [
              "[WARN][api:cron:snapshot-chat-events] Skipped Chat Event Snapshot pointer",
              {
                type: "chat_event_snapshot_head_skipped",
                reason: "unreadable",
                downloadStage: failure.body ? "read_body" : "get_object",
                ...failure.expected,
              },
            ],
          ]);
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
        }
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
