import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { integrationsGithubUploadInitContract } from "@okouai/api-contracts/contracts/integrations";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { integrationsGithubUploadInitRoutes } from "../integrations-github-upload-init";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsMultipartRoutes } from "../uploads-multipart";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRouteMocks } from "./helpers/route-test";
import { createDeferredPromise } from "../../utils";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import {
  installS3Fixture,
  uploadTemplateFile,
} from "./helpers/template-publish-fixture";

const context = testContext();
const reads = createRunReadsApi(context);
const {
  api,
  chat,
  entitledChatActor,
  sendChatRun,
  cancelChatRun,
  requestSendEventRaw,
} = createChatEventsFixture(context);

describe("private attachments through normal chat send", () => {
  it.each([
    { name: "no files", count: 0, references: [], annotated: false },
    { name: "one file", count: 1, references: [0], annotated: false },
    { name: "empty file", count: 1, references: [0], annotated: false },
    {
      name: "multiple files",
      count: 3,
      references: [2, 0, 1],
      annotated: false,
    },
    { name: "repeated file", count: 1, references: [0, 0], annotated: false },
    { name: "annotated file", count: 2, references: [0], annotated: true },
  ])("preserves $name in the input and run", async (scenario) => {
    const { actor } = await entitledChatActor();
    await api.updateUserModelPreference(actor, "claude-fable-5-1");
    const storage = installS3Fixture(context);
    const files: { id: string; filename: string; contentType: string }[] = [];
    for (let index = 0; index < scenario.count; index++) {
      const filename =
        scenario.annotated && index === 1
          ? "file-0.annotated.png"
          : `file-${index}.png`;
      const file = { filename, contentType: "image/png" };
      const id = await uploadTemplateFile(
        context,
        actor,
        storage,
        file,
        scenario.name === "empty file"
          ? Buffer.alloc(0)
          : Buffer.from(`private file ${index}`),
      );
      files.push({ ...file, id });
    }
    const fileParts = scenario.references.map((index) => {
      const file = files[index]!;
      return {
        type: "file" as const,
        fileId: file.id,
        filenameSnapshot: file.filename,
        contentType: file.contentType,
        ...(scenario.annotated
          ? {
              annotatedFileId: files[1]!.id,
              annotations: {
                marks: [
                  {
                    id: "mark",
                    ordinal: 1,
                    shape: "box" as const,
                    rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
                    ink: "#5E6AD2",
                    note: "Review this region",
                  },
                ],
              },
            }
          : {}),
      };
    });
    const prompt = `Read ${scenario.name}`;
    const userMessage: UserMessageInputDocument = {
      version: 1,
      parts: [...fileParts, { type: "text", text: prompt }],
    };
    const beforeSend = context.mocks.s3.send.mock.calls.length;
    const sent = await sendChatRun(actor, { prompt, userMessage });
    const attachmentHeads = context.mocks.s3.send.mock.calls
      .slice(beforeSend)
      .filter(([command]) => {
        return (
          command instanceof HeadObjectCommand &&
          files.some((file) => {
            return (
              command.input.Key ===
              `private-artifacts/${file.id}/${file.filename}`
            );
          })
        );
      });
    expect(attachmentHeads).toStrictEqual([]);
    const messages = await chat.listThreadEvents(actor, sent.threadId);
    const input = userMessages(messages.events).find((message) => {
      return message.runId === sent.runId;
    });
    if (!input || input.eventType !== "input.prompt") {
      throw new Error("Expected the launched input prompt");
    }
    expect(
      input.userMessage.parts.filter((part) => {
        return part.type === "file";
      }),
    ).toStrictEqual(fileParts);
    const run = await api.readRun(actor, sent.runId);
    const promptIds = [...run.prompt.matchAll(/\[ID\] (\S+)/gu)].map(
      (match) => {
        return match[1];
      },
    );
    expect(promptIds).toStrictEqual(
      scenario.annotated
        ? [files[1]!.id]
        : fileParts.map((part) => {
            return part.fileId;
          }),
    );
    for (const file of files) {
      const resolved = await chat.resolveWebFileUrl(actor, file.id);
      expect(storage.signedKey(resolved.url)).toBe(
        `private-artifacts/${file.id}/${file.filename}`,
      );
    }
    await cancelChatRun(actor, sent.runId);
  });

  it("reuses completed metadata across same-length PUT retries and repeated sends", async () => {
    const { actor } = await entitledChatActor();
    const storage = installS3Fixture(context);
    const file = { filename: "retry.txt", contentType: "text/plain", size: 5 };
    const prepared = await chat.prepareUpload(actor, file);
    if (!("uploadUrl" in prepared)) {
      throw new Error("Expected a single-part upload");
    }
    const signing = context.mocks.s3.getSignedUrl.mock.calls.find(
      ([, command]) => {
        return (
          command instanceof PutObjectCommand &&
          command.input.Key ===
            `private-artifacts/${prepared.id}/${file.filename}`
        );
      },
    );
    expect(signing?.[1]).toMatchObject({ input: { ContentLength: file.size } });
    expect(signing?.[2]).toMatchObject({
      signableHeaders: new Set(["content-length"]),
    });
    expect(() => {
      return storage.put(
        prepared.uploadUrl,
        Buffer.from("wrong size"),
        file.contentType,
      );
    }).toThrow("SignatureDoesNotMatch");
    storage.put(prepared.uploadUrl, Buffer.from("first"), file.contentType);
    await chat.completeUpload(actor, { id: prepared.id });
    storage.put(prepared.uploadUrl, Buffer.from("retry"), file.contentType);
    await chat.completeUpload(actor, { id: prepared.id });
    const original = context.mocks.s3.send.getMockImplementation()!;
    context.mocks.s3.send.mockImplementation((command) => {
      if (
        command instanceof HeadObjectCommand &&
        command.input.Key ===
          `private-artifacts/${prepared.id}/${file.filename}`
      ) {
        return Promise.reject(
          new Error("Completed attachments must not require HEAD to start"),
        );
      }
      return original(command);
    });
    const parts = [prepared.id, prepared.id.toUpperCase(), prepared.id].map(
      (fileId) => {
        return {
          type: "file" as const,
          fileId,
          filenameSnapshot: file.filename,
          contentType: file.contentType,
        };
      },
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sent = await sendChatRun(actor, {
        prompt: "read the same completed file again",
        userMessage: { version: 1, parts },
      });
      expect((await api.readRun(actor, sent.runId)).prompt).toContain(
        `[ID] ${prepared.id.toUpperCase()}`,
      );
      await cancelChatRun(actor, sent.runId);
    }
  });

  it("verifies a pending upload once before reusing its registered metadata", async () => {
    const { actor } = await entitledChatActor();
    const storage = installS3Fixture(context);
    const file = {
      filename: "pending.txt",
      contentType: "text/plain",
      size: 7,
    };
    const prepared = await chat.prepareUpload(actor, file);
    if (!("uploadUrl" in prepared)) {
      throw new Error("Expected a single-part upload");
    }
    storage.put(prepared.uploadUrl, Buffer.from("pending"), file.contentType);
    const heads: string[] = [];
    const original = context.mocks.s3.send.getMockImplementation()!;
    context.mocks.s3.send.mockImplementation((command) => {
      if (
        command instanceof HeadObjectCommand &&
        command.input.Key ===
          `private-artifacts/${prepared.id}/${file.filename}`
      ) {
        heads.push(command.input.Key);
      }
      return original(command);
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sent = await sendChatRun(actor, {
        prompt: "read without a separate complete call",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: prepared.id,
              filenameSnapshot: file.filename,
              contentType: file.contentType,
            },
          ],
        },
      });
      expect((await api.readRun(actor, sent.runId)).prompt).toContain(
        `[ID] ${prepared.id}`,
      );
      expect(heads).toHaveLength(1);
      await cancelChatRun(actor, sent.runId);
    }
  });

  it("reuses completed multipart metadata after part upload credentials stop writing", async () => {
    const { actor } = await entitledChatActor();
    const storage = installS3Fixture(context);
    createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
    const uploads = setupApp({
      context,
      routes: [...uploadsPrepareRoutes, ...uploadsMultipartRoutes],
    })(uploadsContract);
    const headers = { authorization: "Bearer clerk-session" };
    const content = Buffer.alloc(5 * 1024 * 1024 + 4, "x");
    const prepared = await accept(
      uploads.prepare({
        headers,
        body: {
          filename: "multipart.txt",
          contentType: "text/plain",
          size: content.length,
          multipart: true,
        },
      }),
      [200],
    );
    if (!("multipart" in prepared.body)) {
      throw new Error("Expected multipart credentials");
    }
    const { multipart, id, filename, contentType } = prepared.body;
    for (const part of multipart.parts) {
      const start = (part.partNumber - 1) * multipart.partSize;
      storage.put(
        part.uploadUrl,
        content.subarray(start, start + multipart.partSize),
        contentType,
      );
    }
    await accept(
      uploads.completeMultipart({
        headers,
        body: {
          id,
          filename,
          uploadId: multipart.uploadId,
          partCount: multipart.parts.length,
        },
      }),
      [200],
    );
    expect(() => {
      return storage.put(
        multipart.parts[0]!.uploadUrl,
        Buffer.from("late"),
        contentType,
      );
    }).toThrow("NoSuchUpload");
    const original = context.mocks.s3.send.getMockImplementation()!;
    context.mocks.s3.send.mockImplementation((command) => {
      if (
        command instanceof HeadObjectCommand &&
        command.input.Key === `private-artifacts/${id}/${filename}`
      ) {
        return Promise.reject(
          new Error("Completed multipart metadata must be reused"),
        );
      }
      return original(command);
    });
    const sent = await sendChatRun(actor, {
      prompt: "read multipart input",
      userMessage: {
        version: 1,
        parts: [
          { type: "file", fileId: id, filenameSnapshot: filename, contentType },
        ],
      },
    });
    expect((await api.readRun(actor, sent.runId)).prompt).toContain(
      `[ID] ${id}`,
    );
    await cancelChatRun(actor, sent.runId);
  });

  it("verifies pending private uploads via storage head and reuses completed file size metadata", async () => {
    const { actor } = await entitledChatActor();
    const storage = installS3Fixture(context);
    createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
    const prepared = await accept(
      setupApp({ context, routes: integrationsGithubUploadInitRoutes })(
        integrationsGithubUploadInitContract,
      ).init({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          filename: "unbounded.txt",
          contentType: "text/plain",
          length: 5,
        },
      }),
      [200],
    );
    storage.put(prepared.body.uploadUrl, Buffer.from("first"), "text/plain");
    const key = `private-artifacts/${prepared.body.uploadId}/unbounded.txt`;

    // Pending (not-yet-completed) upload still verifies bytes via HeadObjectCommand.
    const beforePendingSend = context.mocks.s3.send.mock.calls.length;
    const pendingSent = await sendChatRun(actor, {
      prompt: "read a pending integration upload",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId: prepared.body.uploadId,
            filenameSnapshot: "unbounded.txt",
            contentType: "text/plain",
          },
        ],
      },
    });
    expect(
      context.mocks.s3.send.mock.calls
        .slice(beforePendingSend)
        .filter(([command]) => {
          return (
            command instanceof HeadObjectCommand && command.input.Key === key
          );
        }),
    ).toHaveLength(1);
    expect((await api.readRun(actor, pendingSent.runId)).prompt).toContain(
      `[ID] ${prepared.body.uploadId}`,
    );
    await cancelChatRun(actor, pendingSent.runId);

    // Once completed in `files`, sizeBytes is persisted and reused without re-heading R2.
    await chat.completeUpload(actor, { id: prepared.body.uploadId });
    const beforeCompletedSend = context.mocks.s3.send.mock.calls.length;
    const completedSent = await sendChatRun(actor, {
      prompt: "read a completed integration upload",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId: prepared.body.uploadId,
            filenameSnapshot: "unbounded.txt",
            contentType: "text/plain",
          },
        ],
      },
    });
    expect(
      context.mocks.s3.send.mock.calls
        .slice(beforeCompletedSend)
        .filter(([command]) => {
          return (
            command instanceof HeadObjectCommand && command.input.Key === key
          );
        }),
    ).toHaveLength(0);
    expect((await api.readRun(actor, completedSent.runId)).prompt).toContain(
      `[ID] ${prepared.body.uploadId}`,
    );
    await cancelChatRun(actor, completedSent.runId);
  });

  it("accepts an uppercase private UUID without changing its reference", async () => {
    const { actor } = await entitledChatActor();
    await api.updateUserModelPreference(actor, "claude-fable-5-1");
    const storage = installS3Fixture(context);
    const filename = "uppercase.txt";
    const id = await uploadTemplateFile(
      context,
      actor,
      storage,
      { filename, contentType: "text/plain" },
      Buffer.from("case insensitive UUID"),
    );
    const sent = await sendChatRun(actor, {
      prompt: "Read the uppercase reference",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId: id.toUpperCase(),
            filenameSnapshot: filename,
            contentType: "text/plain",
          },
        ],
      },
    });
    expect((await api.readRun(actor, sent.runId)).prompt).toContain(
      `[ID] ${id.toUpperCase()}`,
    );
    await cancelChatRun(actor, sent.runId);
  });

  it.each(["before selection", "after selection"] as const)(
    "keeps Library-deleted files usable in chat attachments %s (Principle 4)",
    async (when) => {
      const { actor } = await entitledChatActor();
      await api.updateUserModelPreference(actor, "claude-fable-5-1");
      const storage = installS3Fixture(context);
      const file = {
        filename: "deleted.txt",
        contentType: "text/plain",
        size: 7,
      };
      const prepared = await chat.prepareUpload(actor, {
        ...file,
        purpose: "artifact",
      });
      if (!("uploadUrl" in prepared)) {
        throw new Error("Expected a single-part upload");
      }
      storage.put(prepared.uploadUrl, Buffer.from("deleted"), file.contentType);
      await chat.completeUpload(actor, { id: prepared.id });
      createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
      const catalog = setupApp({ context, routes: artifactCatalogRoutes })(
        artifactCatalogContract,
      );
      const headers = { authorization: "Bearer clerk-session" };
      const listed = await accept(catalog.list({ headers }), [200]);
      const artifactId = listed.body.artifacts[0]?.id;
      if (!artifactId) {
        throw new Error("Expected the completed artifact in the catalog");
      }
      const pending = await chat.prepareUpload(actor, {
        filename: "held.txt",
        contentType: "text/plain",
        size: 4,
      });
      if (!("uploadUrl" in pending)) {
        throw new Error("Expected a pending single-part upload");
      }
      storage.put(pending.uploadUrl, Buffer.from("held"), "text/plain");
      const held =
        when === "after selection"
          ? {
              started: createDeferredPromise<void>(context.signal),
              release: createDeferredPromise<void>(context.signal),
            }
          : undefined;
      if (held) {
        const original = context.mocks.s3.send.getMockImplementation()!;
        context.mocks.s3.send.mockImplementation(async (command) => {
          if (
            command instanceof HeadObjectCommand &&
            command.input.Key === `private-artifacts/${pending.id}/held.txt`
          ) {
            held.started.resolve(undefined);
            await held.release.promise;
          }
          return await original(command);
        });
      } else {
        // Principle 4: deleting from Library soft-deletes `artifacts.deleted_at`
        // only and keeps the underlying `files` row readable by the owner.
        await accept(
          catalog.delete({ headers, params: { artifactId } }),
          [200],
        );
      }
      const thread = await chat.createThread(actor, {});
      const sending = requestSendEventRaw(actor, {
        threadId: thread.id,
        prompt: "read the accepted attachments",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: prepared.id,
              filenameSnapshot: file.filename,
              contentType: file.contentType,
            },
            {
              type: "file",
              fileId: pending.id,
              filenameSnapshot: "held.txt",
              contentType: "text/plain",
            },
          ],
        },
        hasTextContent: true,
      });
      onTestFinished(async () => {
        if (held && !held.release.settled()) {
          held.release.resolve(undefined);
        }
        await sending;
      });
      if (held) {
        await held.started.promise;
        await accept(
          catalog.delete({ headers, params: { artifactId } }),
          [200],
        );
        held.release.resolve(undefined);
      }
      expect((await sending).status).toBe(201);
      await flushWaitUntilForTest();
      const messages = userMessages(
        (await chat.listThreadEvents(actor, thread.id)).events,
      );
      const runId = messages.find((message) => {
        return message.runId;
      })?.runId;
      if (!runId) {
        throw new Error("Expected a Run for the accepted attachments");
      }
      const run = await api.readRun(actor, runId);
      expect(run.prompt).toContain(`[ID] ${prepared.id}`);
      expect(run.prompt).toContain(`[ID] ${pending.id}`);
      await cancelChatRun(actor, runId);
      expect(
        (await chat.requestWebFileUrl(actor, prepared.id, [200])).status,
      ).toBe(200);
    },
  );

  it.each(["missing object", "foreign owner"] as const)(
    "rejects a set containing a %s without publishing its input",
    async (failure) => {
      const { actor } = await entitledChatActor();
      const uploadActor =
        failure === "foreign owner" ? (await entitledChatActor()).actor : actor;
      const storage = installS3Fixture(context);
      const file = { filename: "owned.txt", contentType: "text/plain" };
      const ownedId = await uploadTemplateFile(
        context,
        actor,
        storage,
        file,
        Buffer.from("owned"),
      );
      const invalid = await chat.prepareUpload(uploadActor, {
        filename: "unavailable.txt",
        contentType: "text/plain",
        size: 7,
      });
      if (!("uploadUrl" in invalid)) {
        throw new Error("Expected a single-part upload");
      }
      if (failure === "foreign owner") {
        storage.put(invalid.uploadUrl, Buffer.from("foreign"), "text/plain");
      }
      const prompt = `Reject ${failure}`;
      const clientThreadId = randomUUID();
      const response = await requestSendEventRaw(actor, {
        clientThreadId,
        model: "claude-fable-5-1",
        prompt,
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [ownedId, invalid.id].map((fileId) => {
            return {
              type: "file",
              fileId,
              filenameSnapshot: file.filename,
              contentType: file.contentType,
            };
          }),
        },
      });
      expect(response).toStrictEqual({
        status: 500,
        body: { error: "Internal server error" },
      });
      const thread = await chat.requestReadThread(actor, clientThreadId, [404]);
      expect(thread.status).toBe(404);
      const runs = await reads.requestListLogs(actor, { limit: 100 }, [200]);
      expect(
        runs.body.data.some((run) => {
          return run.prompt === prompt;
        }),
      ).toBeFalsy();
      const resolved = await chat.resolveWebFileUrl(actor, ownedId);
      expect(storage.signedKey(resolved.url)).toBe(
        `private-artifacts/${ownedId}/${file.filename}`,
      );
    },
  );

  it("accepts completion of a private upload while its send HEAD is pending", async () => {
    const { actor } = await entitledChatActor();
    await api.updateUserModelPreference(actor, "claude-fable-5-1");
    const storage = installS3Fixture(context);
    const file = {
      filename: "concurrent.txt",
      contentType: "text/plain",
      size: 10,
    };
    const prepared = await chat.prepareUpload(actor, file);
    if (!("uploadUrl" in prepared)) {
      throw new Error("Expected a single-part upload");
    }
    storage.put(
      prepared.uploadUrl,
      Buffer.from("completion"),
      file.contentType,
    );
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const original = context.mocks.s3.send.getMockImplementation()!;
    let held = false;
    context.mocks.s3.send.mockImplementation(async (command) => {
      const response = await original(command);
      if (command instanceof HeadObjectCommand && !held) {
        held = true;
        started.resolve(undefined);
        await release.promise;
      }
      return response;
    });
    const sent = sendChatRun(actor, {
      prompt: "Read the concurrently completed file",
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId: prepared.id,
            filenameSnapshot: file.filename,
            contentType: file.contentType,
          },
        ],
      },
    });
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
      await sent;
    });
    await started.promise;
    const completed = await chat.completeUpload(actor, { id: prepared.id });
    expect(completed).toMatchObject({ id: prepared.id, size: file.size });
    release.resolve(undefined);
    const run = await sent;
    expect((await api.readRun(actor, run.runId)).prompt).toContain(
      `[ID] ${prepared.id}`,
    );
    const resolved = await chat.resolveWebFileUrl(actor, prepared.id);
    expect(storage.signedKey(resolved.url)).toBe(
      `private-artifacts/${prepared.id}/${file.filename}`,
    );
    await cancelChatRun(actor, run.runId);
  });
});
