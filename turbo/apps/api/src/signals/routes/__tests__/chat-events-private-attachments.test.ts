import { HeadObjectCommand } from "@aws-sdk/client-s3";
import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
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
    {
      name: "multiple files",
      count: 3,
      references: [2, 0, 1],
      annotated: false,
    },
    { name: "repeated file", count: 1, references: [0, 0], annotated: false },
    { name: "annotated file", count: 2, references: [0], annotated: true },
  ])("preserves $name in the input and run", async (scenario) => {
    const { actor, agentId } = await entitledChatActor();
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
        Buffer.from(`private file ${index}`),
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
    const sent = await sendChatRun(actor, { agentId, prompt, userMessage });
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

  it("accepts an uppercase private UUID without changing its reference", async () => {
    const { actor, agentId } = await entitledChatActor();
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
      agentId,
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

  it.each(["missing object", "foreign owner"] as const)(
    "rejects a set containing a %s without publishing its input",
    async (failure) => {
      const { actor, agentId } = await entitledChatActor();
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
        size: 8,
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
        agentId,
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
      ).toBe(false);
      const resolved = await chat.resolveWebFileUrl(actor, ownedId);
      expect(storage.signedKey(resolved.url)).toBe(
        `private-artifacts/${ownedId}/${file.filename}`,
      );
    },
  );

  it("accepts completion of a private upload while its send HEAD is pending", async () => {
    const { actor, agentId } = await entitledChatActor();
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
      agentId,
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
