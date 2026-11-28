import { randomUUID } from "node:crypto";
import type { input } from "zod";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadsContract,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function newMember(orgId = `org_${randomUUID()}`): Member {
  return { userId: `user_${randomUUID()}`, orgId };
}

function signIn(member: Member): void {
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
}

function textDocument(text: string): UserMessageInputDocument {
  return { version: 1, parts: [{ type: "text", text }] };
}

function threadsClient(member: Member) {
  signIn(member);
  return setupApp({ context, routes: chatThreadRoutes });
}

async function createThread(member: Member): Promise<string> {
  const created = await accept(
    threadsClient(member)(chatThreadsContract).create({
      headers: sessionHeaders,
      body: {},
    }),
    [201],
  );
  return created.body.id;
}

function readDraft(member: Member, threadId: string) {
  return threadsClient(member)(chatThreadDraftContract).readComposer({
    headers: sessionHeaders,
    params: { id: threadId },
  });
}

function saveDraft(
  member: Member,
  threadId: string,
  body: input<typeof chatThreadDraftContract.saveComposer.body>,
) {
  return threadsClient(member)(chatThreadDraftContract).saveComposer({
    headers: sessionHeaders,
    params: { id: threadId },
    body,
  });
}

async function draftThreadIds(member: Member): Promise<string[]> {
  const listed = await accept(
    threadsClient(member)(chatThreadsContract).drafts({
      headers: sessionHeaders,
      query: {},
    }),
    [200],
  );
  return listed.body.draftThreadIds;
}

describe("thread drafts", () => {
  it("chat-thread-draft-store-001 saves, replaces and clears a draft with its attachment and preset", async () => {
    const owner = newMember();
    const threadId = await createThread(owner);

    await expect(readDraft(owner, threadId)).resolves.toMatchObject({
      status: 200,
      body: { draftUserMessage: null, draftAttachments: null },
    });
    await expect(draftThreadIds(owner)).resolves.not.toContain(threadId);

    const attachment = {
      id: randomUUID(),
      url: "https://cdn.example.test/artifacts/brief.pdf",
      filename: "brief.pdf",
      contentType: "application/pdf",
      size: 2048,
    };
    const suggestionPreset = {
      suggestion_id: randomUUID(),
      impression_id: randomUUID(),
      option_id: "outline",
      option_position: 2,
    };
    await accept(
      saveDraft(owner, threadId, {
        draftUserMessage: textDocument("Summarize the attached brief"),
        draftAttachments: [attachment],
        suggestionPreset,
      }),
      [204],
    );
    const saved = await accept(readDraft(owner, threadId), [200]);

    expect(saved.body).toStrictEqual({
      draftUserMessage: textDocument("Summarize the attached brief"),
      draftAttachments: [attachment],
      suggestionPreset,
    });
    await expect(draftThreadIds(owner)).resolves.toContain(threadId);

    await accept(
      saveDraft(owner, threadId, {
        draftUserMessage: textDocument("Just the text now"),
      }),
      [204],
    );
    const replaced = await accept(readDraft(owner, threadId), [200]);

    expect(replaced.body).toStrictEqual({
      draftUserMessage: textDocument("Just the text now"),
      draftAttachments: null,
    });

    await accept(saveDraft(owner, threadId, { draftUserMessage: null }), [204]);
    const cleared = await accept(readDraft(owner, threadId), [200]);

    expect(cleared.body).toStrictEqual({
      draftUserMessage: null,
      draftAttachments: null,
    });
    await expect(draftThreadIds(owner)).resolves.not.toContain(threadId);
  });

  it("chat-thread-draft-store-004 keeps drafts separate per thread and per member", async () => {
    const owner = newMember();
    const peer = newMember(owner.orgId);
    const clearedThreadId = await createThread(owner);
    const savedThreadId = await createThread(owner);

    await accept(
      saveDraft(owner, clearedThreadId, { draftUserMessage: null }),
      [204],
    );
    await accept(
      saveDraft(owner, savedThreadId, {
        draftUserMessage: textDocument("Owner's private note"),
      }),
      [204],
    );

    await expect(readDraft(owner, clearedThreadId)).resolves.toMatchObject({
      status: 200,
      body: { draftUserMessage: null, draftAttachments: null },
    });
    await expect(draftThreadIds(peer)).resolves.not.toContain(savedThreadId);
    await expect(readDraft(peer, savedThreadId)).resolves.toMatchObject({
      status: 404,
    });
    await expect(readDraft(owner, randomUUID())).resolves.toMatchObject({
      status: 404,
    });
  });

  it("chat-thread-draft-store-006 hides another member's private thread from draft writes", async () => {
    const owner = newMember();
    const peer = newMember(owner.orgId);
    const threadId = await createThread(owner);
    await accept(
      saveDraft(owner, threadId, {
        draftUserMessage: textDocument("Original owner draft"),
      }),
      [204],
    );

    await expect(
      saveDraft(peer, threadId, {
        draftUserMessage: textDocument("Peer overwrite"),
      }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      saveDraft(peer, threadId, { draftUserMessage: null }),
    ).resolves.toMatchObject({ status: 404 });

    const ownerDraft = await accept(readDraft(owner, threadId), [200]);

    expect(ownerDraft.body.draftUserMessage).toStrictEqual(
      textDocument("Original owner draft"),
    );
  });

  it("chat-thread-draft-store-008 removes the draft together with its deleted thread", async () => {
    const owner = newMember();
    const threadId = await createThread(owner);
    await accept(
      saveDraft(owner, threadId, {
        draftUserMessage: textDocument("Draft before deletion"),
      }),
      [204],
    );
    await expect(draftThreadIds(owner)).resolves.toContain(threadId);

    await accept(
      threadsClient(owner)(chatThreadByIdContract).delete({
        headers: sessionHeaders,
        params: { id: threadId },
      }),
      [204],
    );

    const read = await readDraft(owner, threadId);
    const lateSave = await saveDraft(owner, threadId, {
      draftUserMessage: textDocument("Late draft"),
    });
    const clear = await saveDraft(owner, threadId, { draftUserMessage: null });

    expect(read).toMatchObject({
      status: 404,
      body: { error: { code: "CHAT_THREAD_NOT_FOUND" } },
    });
    expect(lateSave).toMatchObject({
      status: 404,
      body: { error: { code: "CHAT_THREAD_NOT_FOUND" } },
    });
    expect(clear.status).toBe(404);
    await expect(draftThreadIds(owner)).resolves.not.toContain(threadId);
  });
});

describe("sends and drafts", () => {
  it("chat-thread-draft-store-010 keeps the saved draft after a send until the client clears it", async () => {
    const owner = newMember();
    const threadId = await createThread(owner);
    const attachment = {
      id: randomUUID(),
      url: "https://cdn.example.test/artifacts/notes.txt",
      filename: "notes.txt",
      contentType: "text/plain",
      size: 12,
    };
    await accept(
      saveDraft(owner, threadId, {
        draftUserMessage: textDocument("Unsent follow-up"),
        draftAttachments: [attachment],
      }),
      [204],
    );

    signIn(owner);
    await accept(
      setupApp({ context, routes: chatEventsRoutes })(chatEventsContract).send({
        headers: sessionHeaders,
        body: {
          threadId,
          prompt: "Hello there",
          hasTextContent: true,
          clientEventId: randomUUID(),
          userMessage: textDocument("Hello there"),
        },
      }),
      [201],
    );
    const afterSend = await accept(readDraft(owner, threadId), [200]);

    expect(afterSend.body.draftUserMessage).toStrictEqual(
      textDocument("Unsent follow-up"),
    );

    await accept(saveDraft(owner, threadId, { draftUserMessage: null }), [204]);
    const cleared = await accept(readDraft(owner, threadId), [200]);

    expect(cleared.body).toStrictEqual({
      draftUserMessage: null,
      draftAttachments: null,
    });
    await expect(draftThreadIds(owner)).resolves.not.toContain(threadId);
  });
});
