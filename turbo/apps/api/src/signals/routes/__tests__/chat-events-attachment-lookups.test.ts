import { HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { buildArtifactKeyV2 } from "../../../lib/file-url";
import { createDeferredPromise } from "../../utils";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import {
  installS3Fixture,
  uploadTemplateFile,
} from "./helpers/template-publish-fixture";

const context = testContext();
const {
  api,
  chat,
  entitledNativeChatActor,
  sendChatRun,
  cancelChatRun,
  requestSendEventRaw,
} = createChatEventsFixture(context);

describe("chat attachment lookup ownership", () => {
  it("reuses the original shared by annotated and plain file parts", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const files = [
      { id: randomUUID(), filename: "screen.png", size: 42 },
      { id: randomUUID(), filename: "screen.annotated.png", size: 54 },
    ];
    const [original, annotated] = files;
    if (!original || !annotated) {
      throw new Error("Expected original and annotated files");
    }
    chat.mockCompletedUploadObjects(actor, files);
    const originalSend = context.mocks.s3.send.getMockImplementation();
    if (!originalSend) {
      throw new Error("Expected the external object store");
    }
    const heads: string[] = [];
    context.mocks.s3.send.mockImplementation(async (request: unknown) => {
      if (request instanceof HeadObjectCommand && request.input.Key) {
        heads.push(request.input.Key);
      }
      return await originalSend(request);
    });
    const plain = {
      type: "file" as const,
      fileId: original.id,
      filenameSnapshot: original.filename,
      contentType: "image/png",
    };
    const marked = {
      ...plain,
      annotatedFileId: annotated.id,
      annotations: {
        marks: [
          {
            id: "mark",
            ordinal: 1,
            shape: "box" as const,
            rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
            ink: "#5E6AD2",
            note: "Check spacing",
          },
        ],
      },
    };
    const parts = [marked, plain, marked];
    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "compare marked and original",
      userMessage: { version: 1, parts },
    });
    expect([...heads].sort()).toStrictEqual(
      [
        buildArtifactKeyV2(annotated.id, annotated.filename),
        buildArtifactKeyV2(original.id, original.filename),
      ].sort(),
    );
    const messages = userMessages(
      (await chat.listThreadEvents(actor, sent.threadId)).events,
    );
    const input = messages.find((message) => {
      return message.runId === sent.runId;
    });
    if (input?.eventType !== "input.prompt") {
      throw new Error("Expected the launched input");
    }
    expect(
      input.userMessage.parts.filter((part) => {
        return part.type === "file";
      }),
    ).toStrictEqual(parts);
    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toContain(`[ID] ${annotated.id}`);
    expect(run.prompt).toContain(`[ID] ${original.id}`);
    await cancelChatRun(actor, sent.runId);
  });

  it("resolves different filename hints independently and retains both snapshots", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const fileId = randomUUID();
    const storedFilename = "current.png";
    const storedKey = buildArtifactKeyV2(fileId, storedFilename);
    const heads: string[] = [];
    context.mocks.s3.send.mockImplementation(
      (request: unknown): Promise<unknown> => {
        if (request instanceof HeadObjectCommand && request.input.Key) {
          heads.push(request.input.Key);
          if (request.input.Key === storedKey) {
            return Promise.resolve({
              ContentLength: 42,
              ContentType: "image/png",
              LastModified: new Date("2026-08-24T00:00:00.000Z"),
              Metadata: {
                "artifact-id": fileId,
                filename: encodeURIComponent(storedFilename),
                "user-id": encodeURIComponent(actor.userId),
              },
            });
          }
          return Promise.reject(
            Object.assign(new Error("Stale extension"), { name: "NotFound" }),
          );
        }
        return Promise.resolve(
          request instanceof ListObjectsV2Command
            ? {
                Contents: [
                  {
                    Key: storedKey,
                    Size: 42,
                    LastModified: new Date("2026-08-24T00:00:00.000Z"),
                  },
                ],
              }
            : {},
        );
      },
    );
    const parts = ["stale.txt", storedFilename].map((filenameSnapshot) => {
      return {
        type: "file" as const,
        fileId,
        filenameSnapshot,
        contentType: "image/png",
      };
    });
    const sent = await sendChatRun(actor, {
      agentId,
      prompt: "keep both filename snapshots",
      userMessage: { version: 1, parts },
    });
    expect(heads).toContain(buildArtifactKeyV2(fileId, "stale.txt"));
    expect(
      heads.filter((key) => {
        return key === buildArtifactKeyV2(fileId, storedFilename);
      }),
    ).toHaveLength(2);
    const run = await api.readRun(actor, sent.runId);
    expect(run.prompt).toContain("[Web file] stale.txt (image/png)");
    expect(run.prompt).toContain("[Web file] current.png (image/png)");
    await cancelChatRun(actor, sent.runId);
  });

  it.each(["user", "organization"] as const)(
    "does not reuse private attachment authorization for a different %s",
    async (identity) => {
      const owner = await entitledNativeChatActor();
      const other = await entitledNativeChatActor(
        identity === "user"
          ? { orgId: owner.actor.orgId }
          : { userId: owner.actor.userId },
      );
      const fixture = installS3Fixture(context);
      const filename = "owned.txt";
      const fileId = await uploadTemplateFile(
        context,
        owner.actor,
        fixture,
        { filename, contentType: "text/plain" },
        Buffer.from("private bytes"),
      );
      const userMessage = {
        version: 1 as const,
        parts: [
          {
            type: "file" as const,
            fileId,
            filenameSnapshot: filename,
            contentType: "text/plain",
          },
        ],
      };
      const allowed = await sendChatRun(owner.actor, {
        agentId: owner.agentId,
        prompt: "read my private file",
        userMessage,
      });
      expect((await api.readRun(owner.actor, allowed.runId)).prompt).toContain(
        `[ID] ${fileId}`,
      );
      await cancelChatRun(owner.actor, allowed.runId);

      const thread = await chat.createThread(other.actor, {
        agentId: other.agentId,
      });
      const denied = await requestSendEventRaw(other.actor, {
        agentId: other.agentId,
        threadId: thread.id,
        prompt: "deny another identity's file",
        userMessage,
        hasTextContent: true,
      });
      expect(denied).toStrictEqual({
        status: 500,
        body: { error: "Internal server error" },
      });
      expect(
        userMessages(
          (await chat.listThreadEvents(other.actor, thread.id)).events,
        ),
      ).toStrictEqual([]);
    },
  );

  it.each(["failure", "cancellation"] as const)(
    "stops refilling and joins four in-flight lookups on %s without publishing input",
    async (outcome) => {
      const { actor, agentId } = await entitledNativeChatActor();
      const thread = await chat.createThread(actor, { agentId });
      const files = Array.from({ length: 8 }, (_, index) => {
        return { id: randomUUID(), filename: `file-${index}.txt`, size: 42 };
      });
      chat.mockCompletedUploadObjects(actor, files);
      const originalSend = context.mocks.s3.send.getMockImplementation();
      if (!originalSend) {
        throw new Error("Expected the external object store");
      }
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const keys = files.map((file) => {
        return buildArtifactKeyV2(file.id, file.filename);
      });
      const started: string[] = [];
      const finished: string[] = [];
      context.mocks.s3.send.mockImplementation(async (request: unknown) => {
        if (
          request instanceof HeadObjectCommand &&
          request.input.Key &&
          keys.includes(request.input.Key)
        ) {
          started.push(request.input.Key);
          if (started.length === 4) {
            entered.resolve(undefined);
          }
          await release.promise;
          finished.push(request.input.Key);
          if (outcome === "failure") {
            throw new Error("Object storage unavailable");
          }
        }
        return await originalSend(request);
      });
      const controller = new AbortController();
      const sending = requestSendEventRaw(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "do not publish a partial attachment input",
          userMessage: {
            version: 1,
            parts: files.map((file) => {
              return {
                type: "file" as const,
                fileId: file.id,
                filenameSnapshot: file.filename,
                contentType: "text/plain",
              };
            }),
          },
          hasTextContent: true,
        },
        AbortSignal.any([context.signal, controller.signal]),
      );
      onTestFinished(async () => {
        controller.abort();
        if (!release.settled()) {
          release.resolve(undefined);
        }
        await sending;
      });
      await entered.promise;
      expect([...started].sort()).toStrictEqual(keys.slice(0, 4).sort());
      if (outcome === "cancellation") {
        controller.abort(new DOMException("Client disconnected", "AbortError"));
      }
      release.resolve(undefined);
      await expect(sending).resolves.toStrictEqual({
        status: 500,
        body: { error: "Internal server error" },
      });
      expect([...started].sort()).toStrictEqual(keys.slice(0, 4).sort());
      expect(finished).toStrictEqual(started);
      expect(
        userMessages((await chat.listThreadEvents(actor, thread.id)).events),
      ).toStrictEqual([]);
    },
  );

  it("joins later reads already started before a slow first attachment fails", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const thread = await chat.createThread(actor, { agentId });
    const files = Array.from({ length: 8 }, (_, index) => {
      return {
        id: randomUUID(),
        filename: `slow-first-${index}.txt`,
        size: 42,
      };
    });
    chat.mockCompletedUploadObjects(actor, files);
    const originalSend = context.mocks.s3.send.getMockImplementation();
    if (!originalSend) {
      throw new Error("Expected the external object store");
    }
    const keys = files.map((file) => {
      return buildArtifactKeyV2(file.id, file.filename);
    });
    const allStarted = createDeferredPromise<void>(context.signal);
    const failFirst = createDeferredPromise<void>(context.signal);
    const started: string[] = [];
    context.mocks.s3.send.mockImplementation(async (request: unknown) => {
      if (
        request instanceof HeadObjectCommand &&
        request.input.Key &&
        keys.includes(request.input.Key)
      ) {
        started.push(request.input.Key);
        if (started.length === files.length) {
          allStarted.resolve(undefined);
        }
        if (request.input.Key === keys[0]) {
          await failFirst.promise;
          throw new Error("The slow first attachment failed");
        }
      }
      return await originalSend(request);
    });
    const sending = requestSendEventRaw(actor, {
      agentId,
      threadId: thread.id,
      prompt: "fail atomically after later lookups have used free slots",
      userMessage: {
        version: 1,
        parts: files.map((file) => {
          return {
            type: "file" as const,
            fileId: file.id,
            filenameSnapshot: file.filename,
            contentType: "text/plain",
          };
        }),
      },
      hasTextContent: true,
    });
    onTestFinished(async () => {
      if (!failFirst.settled()) {
        failFirst.resolve(undefined);
      }
      await sending;
    });
    await allStarted.promise;
    expect([...started].sort()).toStrictEqual([...keys].sort());
    failFirst.resolve(undefined);
    await expect(sending).resolves.toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });
    expect(
      userMessages((await chat.listThreadEvents(actor, thread.id)).events),
    ).toStrictEqual([]);
  });
});
