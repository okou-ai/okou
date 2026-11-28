import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import {
  createChatFilesBddApi,
  persistedAttachment,
} from "./helpers/api-bdd-chat-files";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { nowDate } from "../../../lib/time";

const context = testContext();

function siteFile(path: string, content: string) {
  return {
    path,
    size: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    contentType: "text/html; charset=utf-8",
  };
}

describe("uploads, storage and host APIs", () => {
  it("chat-files.bdd-009 prepares and completes an upload through storage", async () => {
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const member = bdd.user();
    const other = bdd.user();
    bdd.acceptStorageWrites();

    const prepared = await chat.prepareUpload(member, {
      filename: "notes.txt",
      contentType: "Text/Plain; Charset=UTF-8",
      size: 12,
    });
    if ("multipart" in prepared) {
      throw new Error("Expected a single-part upload");
    }
    expect(prepared.filename).toBe("notes.txt");
    expect(prepared.contentType).toBe("text/plain; charset=utf-8");
    expect(prepared.size).toBe(12);
    expect(prepared.uploadUrl).toMatch(/^https?:\/\//);
    expect(new URL(prepared.url).pathname).toMatch(
      /^\/artifacts\/[A-Za-z0-9_-]{10}\.txt$/,
    );
    expect(prepared.url).not.toContain(member.userId);

    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({
          ContentLength: 12,
          LastModified: nowDate(),
        });
      }
      if (command instanceof GetObjectCommand) {
        if (!command.input.Key?.startsWith("private-artifacts/")) {
          return Promise.reject(
            Object.assign(new Error("Missing object"), { name: "NoSuchKey" }),
          );
        }
        return Promise.resolve({
          ContentLength: 12,
          LastModified: nowDate(),
          Body: Readable.from([Buffer.alloc(12, 0x61)]),
        });
      }
      if (command instanceof PutObjectCommand) {
        return Promise.resolve({ ETag: '"etag-1"' });
      }
      return Promise.resolve({});
    });
    await expect(
      chat.completeUpload(member, { id: prepared.id }),
    ).resolves.toMatchObject({
      id: prepared.id,
      filename: "notes.txt",
      contentType: "text/plain; charset=utf-8",
      size: 12,
      url: new URL(
        `/artifacts/${prepared.id.replace(/-/gu, "")}.txt`,
        prepared.url,
      ).href,
    });
    const foreign = await chat.requestCompleteUpload(
      other,
      { id: prepared.id },
      [404],
    );
    if (!("error" in foreign.body)) {
      throw new Error("Expected an error body");
    }
    expect(foreign.body.error.code).toBe("NOT_FOUND");

    bdd.acceptStorageWrites();
    const custom = await chat.prepareUpload(member, {
      filename: "capture.custom",
      contentType: "application/x-custom",
      size: 10,
    });
    expect(custom.contentType).toBe("application/octet-stream");
  });

  it("chat-files.bdd-010 prepares and completes a hosted-site deployment through host APIs", async () => {
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const host = createHostBddApi(context);
    const member = bdd.user();
    const other = bdd.user();
    host.captureHostedSitesS3();

    const prepared = await chat.prepareHostedSite(member, {
      site: `site-${randomUUID().slice(0, 8)}`,
      title: "Launch site",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [
        siteFile("/index.html", "<h1>Launch</h1>"),
        {
          ...siteFile("/assets/app-3f9a1c2b.js", "console.info('launch')"),
          contentType: "text/javascript",
          immutable: true,
        },
      ],
    });
    expect(prepared.aliasUrl).toBe(prepared.url);
    expect(new URL(prepared.url).hostname.split(".")[0]).toBe(
      prepared.publicSlug,
    );
    expect(prepared.deploymentVersion).toBe(1);
    expect(prepared.artifactUrl).toContain(`dpl-${prepared.deploymentId}.`);
    expect(prepared.uploads).toHaveLength(2);

    const foreign = await chat.requestCompleteHostedSite(
      other,
      prepared.deploymentId,
      [404],
    );
    if (!("error" in foreign.body)) {
      throw new Error("Expected an error body");
    }
    expect(foreign.body.error.code).toBe("NOT_FOUND");
    await expect(
      chat.completeHostedSite(member, prepared.deploymentId),
    ).resolves.toMatchObject({
      status: "ready",
      deploymentVersion: 1,
      isActive: true,
      activeDeploymentVersion: 1,
      url: prepared.url,
      aliasUrl: prepared.aliasUrl,
      artifactUrl: prepared.artifactUrl,
    });

    const missingIndex = await chat.requestPrepareHostedSite(
      member,
      {
        site: `site-${randomUUID().slice(0, 8)}`,
        title: "About only",
        artifactKind: "hosted-site",
        spaFallback: false,
        files: [siteFile("/about.html", "<h1>About</h1>")],
      },
      [400],
    );
    if (!("error" in missingIndex.body)) {
      throw new Error("Expected an error body");
    }
    expect(missingIndex.body.error.message).toContain(
      "must include /index.html",
    );
  });
});

describe("chat thread lifecycle", () => {
  it("chat-files.bdd-001 (1/2) creates a thread and saves then clears its composer draft", async () => {
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const member = bdd.user();

    const created = await chat.createThread(member, { title: "Launch notes" });
    expect(created.title).toBe("Launch notes");
    const initial = await chat.readThread(member, created.id);
    expect(initial.lastReadAt).toBeTruthy();
    expect(initial.cancellationRecoveryPending).toBeFalsy();
    await expect(
      chat.readThreadDraft(member, created.id),
    ).resolves.toMatchObject({
      draftUserMessage: null,
      draftAttachments: null,
    });

    const attachment = persistedAttachment(
      randomUUID(),
      "brief.txt",
      "text/plain",
      12,
    );
    const draftUserMessage = {
      version: 1 as const,
      parts: [
        { type: "text" as const, text: "Draft launch notes" },
        {
          type: "chat_thread" as const,
          threadId: created.id,
          titleSnapshot: "Launch notes",
        },
      ],
    };
    await chat.patchThread(member, created.id, {
      draftUserMessage,
      draftAttachments: [attachment],
    });
    const saved = await chat.readThreadDraft(member, created.id);
    expect(saved.draftUserMessage).toStrictEqual(draftUserMessage);
    expect(saved.draftAttachments).toHaveLength(1);
    await expect(chat.listThreadDrafts(member)).resolves.toContain(created.id);

    await chat.patchThread(member, created.id, {
      draftUserMessage: null,
      draftAttachments: null,
    });
    await expect(
      chat.readThreadDraft(member, created.id),
    ).resolves.toMatchObject({
      draftUserMessage: null,
      draftAttachments: null,
    });
    await expect(chat.listThreadDrafts(member)).resolves.not.toContain(
      created.id,
    );
  });

  it("chat-files.bdd-001 (2/2) renames, pins, marks read state, searches and deletes the thread", async () => {
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const member = bdd.user();
    const created = await chat.createThread(member, { title: "Launch notes" });

    await chat.renameThread(member, created.id, "Launch notes v2");
    await chat.pinThread(member, created.id);
    await chat.unpinThread(member, created.id);

    const read = await chat.markThreadRead(member, created.id);
    expect(read.lastReadAt).toBeTruthy();
    await flushWaitUntilForTest();
    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();
    const unread = await chat.markThreadUnread(member, created.id);
    expect(unread.lastReadAt).toBeNull();
    await flushWaitUntilForTest();
    expect(
      channelsPublishedTo(context.mocks, "chatThreadReadCursorUpdated"),
    ).toStrictEqual([`user-org:${member.userId}:${member.orgId}`]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "chatThreadReadCursorUpdated",
      { threadId: created.id, lastReadAt: null },
    );
    await expect(chat.readThread(member, created.id)).resolves.toMatchObject({
      lastReadAt: null,
    });

    await chat.updateThreadModelSelection(member, created.id, null);
    await expect(
      chat.listThreadEvents(member, created.id),
    ).resolves.toStrictEqual({ events: [] });
    await expect(
      chat.listThreadArtifacts(member, created.id),
    ).resolves.toStrictEqual({ runs: [] });
    const search = await chat.searchChat(member, "launch");
    expect(search.results).toStrictEqual([]);

    await chat.deleteThread(member, created.id);
    const deleted = await chat.requestReadThread(member, created.id, [404]);
    if (!("error" in deleted.body)) {
      throw new Error("Expected an error body");
    }
    expect(deleted.body.error.code).toBe("NOT_FOUND");
  });

  it("chat-files.bdd-002 hides owned threads from peer users and other organizations", async () => {
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const owner = bdd.user();
    const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const outsider = bdd.user();
    const thread = await chat.createThread(owner, {
      title: "Private planning",
    });

    await expect(chat.readThread(owner, thread.id)).resolves.toMatchObject({
      cancellationRecoveryPending: false,
    });
    const peerRead = await chat.requestReadThread(peer, thread.id, [404]);
    if (!("error" in peerRead.body)) {
      throw new Error("Expected an error body");
    }
    expect(peerRead.body.error.code).toBe("NOT_FOUND");
    const outsiderRead = await chat.requestReadThread(
      outsider,
      thread.id,
      [404],
    );
    if (!("error" in outsiderRead.body)) {
      throw new Error("Expected an error body");
    }
    expect(outsiderRead.body.error.code).toBe("NOT_FOUND");
    await chat.requestReadThreadDraft(peer, thread.id, [404]);

    const draftUserMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Private draft" }],
    };
    await chat.patchThread(owner, thread.id, {
      draftUserMessage,
      draftAttachments: null,
    });
    await expect(chat.readThreadDraft(owner, thread.id)).resolves.toMatchObject(
      { draftUserMessage },
    );

    await chat.requestReadThreadDraft(peer, thread.id, [404]);
    await expect(chat.listThreadDrafts(peer)).resolves.not.toContain(thread.id);
    const peerEvents = await chat.requestThreadEvents(peer, {}, [200]);
    if (peerEvents.status !== 200) {
      throw new Error("Expected the peer thread events");
    }
    expect(JSON.stringify(peerEvents.body.events)).not.toContain(thread.id);
  });
});
