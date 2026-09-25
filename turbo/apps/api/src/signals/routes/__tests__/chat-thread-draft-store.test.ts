import { randomUUID } from "node:crypto";

import type {
  PersistedAttachment,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { settleIncludingAbort } from "../../utils";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);

interface DraftFixture {
  readonly actor: ReturnType<typeof bdd.user>;
  readonly agentId: string;
  readonly threadId: string;
}

async function createDraftFixture(): Promise<DraftFixture> {
  const actor = bdd.user();
  const agent = await chat.createAgentForChatThread(actor);
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: `Draft ${randomUUID()}`,
  });
  return { actor, agentId: agent.agentId, threadId: thread.id };
}

async function sendWithoutCredits(fixture: DraftFixture): Promise<void> {
  const sent = await chat.requestSendEvent(
    fixture.actor,
    {
      agentId: fixture.agentId,
      threadId: fixture.threadId,
      prompt: "Send the saved draft",
      clientEventId: randomUUID(),
    },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected a no-credit message send");
  }
  expect(sent.body.runId).toBeNull();
}

function draftDocument(text: string): UserMessageInputDocument {
  return { version: 1, parts: [{ type: "text", text }] };
}

function draftBody(text: string) {
  return { draftUserMessage: draftDocument(text), draftAttachments: null };
}

function draftAttachment(): PersistedAttachment {
  return {
    id: "attachment-1",
    url: "https://files.example.com/attachment-1",
    filename: "notes.txt",
    contentType: "text/plain",
    size: 12,
  };
}

async function servedDraftText(fixture: DraftFixture): Promise<string | null> {
  const draft = await chat.readThreadDraft(fixture.actor, fixture.threadId);
  if (draft.draftUserMessage === null) {
    return null;
  }
  const [part] = draft.draftUserMessage.parts;
  if (part === undefined || part.type !== "text") {
    throw new Error("Expected a single text draft part");
  }
  return part.text;
}

function listedDraftIds(fixture: DraftFixture): Promise<readonly string[]> {
  return chat.listThreadDrafts(fixture.actor);
}

describe("thread drafts", () => {
  it("saves, replaces and clears the document and its attachments", async () => {
    const fixture = await createDraftFixture();
    await expect(servedDraftText(fixture)).resolves.toBeNull();
    await expect(listedDraftIds(fixture)).resolves.not.toContain(
      fixture.threadId,
    );

    await chat.patchThread(fixture.actor, fixture.threadId, {
      draftUserMessage: draftDocument("first draft"),
      draftAttachments: [draftAttachment()],
    });
    const saved = await chat.readThreadDraft(fixture.actor, fixture.threadId);
    expect(saved.draftUserMessage).toStrictEqual(draftDocument("first draft"));
    expect(saved.draftAttachments).toStrictEqual([draftAttachment()]);
    await expect(listedDraftIds(fixture)).resolves.toContain(fixture.threadId);

    await chat.patchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("second draft"),
    );
    const replaced = await chat.readThreadDraft(
      fixture.actor,
      fixture.threadId,
    );
    expect(replaced.draftUserMessage).toStrictEqual(
      draftDocument("second draft"),
    );
    expect(replaced.draftAttachments).toBeNull();

    await chat.patchThread(fixture.actor, fixture.threadId, {
      draftUserMessage: null,
      draftAttachments: null,
    });
    await expect(servedDraftText(fixture)).resolves.toBeNull();
    await expect(listedDraftIds(fixture)).resolves.not.toContain(
      fixture.threadId,
    );
  });

  it("keeps drafts separate per thread and per user", async () => {
    const fixture = await createDraftFixture();
    const sibling = await chat.createThread(fixture.actor, {
      agentId: fixture.agentId,
      title: `Sibling ${randomUUID()}`,
    });
    await chat.patchThread(fixture.actor, fixture.threadId, draftBody("mine"));

    await expect(
      chat.readThreadDraft(fixture.actor, sibling.id),
    ).resolves.toStrictEqual({
      draftUserMessage: null,
      draftAttachments: null,
    });
    const foreign = bdd.user({ orgId: fixture.actor.orgId });
    await expect(chat.listThreadDrafts(foreign)).resolves.not.toContain(
      fixture.threadId,
    );
    // Another user's thread and a missing thread read as the empty draft.
    await expect(
      chat.readThreadDraft(foreign, fixture.threadId),
    ).resolves.toStrictEqual({
      draftUserMessage: null,
      draftAttachments: null,
    });
    await expect(
      chat.readThreadDraft(fixture.actor, randomUUID()),
    ).resolves.toStrictEqual({
      draftUserMessage: null,
      draftAttachments: null,
    });
  });

  it("returns 404 for a foreign or missing thread and leaves the owner's draft", async () => {
    const fixture = await createDraftFixture();
    await chat.patchThread(fixture.actor, fixture.threadId, draftBody("owned"));
    const foreign = bdd.user({ orgId: fixture.actor.orgId });

    await chat.requestPatchThread(
      foreign,
      fixture.threadId,
      draftBody("not mine"),
      [404],
    );
    await chat.requestPatchThread(
      fixture.actor,
      randomUUID(),
      draftBody("no thread"),
      [404],
    );

    await expect(servedDraftText(fixture)).resolves.toBe("owned");
  });

  it("saves while another writer holds the thread row", async () => {
    const fixture = await createDraftFixture();
    // Event projection, the run queue and the read cursor all lock the thread
    // row. The draft save reads the owner without a lock and writes only its
    // own row, so it must not queue behind even the strongest row lock
    // (#36173).
    const holder = await holdChatThreadRowLockFixture({
      threadId: fixture.threadId,
      mode: "update",
      signal: context.signal,
    });
    const saving = await settleIncludingAbort(
      chat.patchThread(
        fixture.actor,
        fixture.threadId,
        draftBody("saved beside the lock"),
      ),
    );
    holder.release();
    await holder.done;
    if (!saving.ok) {
      throw saving.error;
    }

    await expect(servedDraftText(fixture)).resolves.toBe(
      "saved beside the lock",
    );
  });

  it("removes the draft with the thread it belongs to", async () => {
    const fixture = await createDraftFixture();
    await chat.patchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("deleted draft"),
    );
    await expect(listedDraftIds(fixture)).resolves.toContain(fixture.threadId);

    await chat.deleteThread(fixture.actor, fixture.threadId);

    await expect(listedDraftIds(fixture)).resolves.not.toContain(
      fixture.threadId,
    );
    await chat.requestPatchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("after delete"),
      [404],
    );
  });
});

describe("sends and drafts", () => {
  it("leaves the saved draft for the client to clear when a message is sent", async () => {
    const fixture = await createDraftFixture();
    await runs.ensureOrgModelProvider(fixture.actor);
    await chat.patchThread(fixture.actor, fixture.threadId, {
      draftUserMessage: draftDocument("saved before send"),
      draftAttachments: [draftAttachment()],
    });

    // The web client clears its draft with its own PATCH alongside the send;
    // the send itself does not touch `chat_thread_drafts`.
    await sendWithoutCredits(fixture);

    await expect(servedDraftText(fixture)).resolves.toBe("saved before send");
    await chat.patchThread(fixture.actor, fixture.threadId, {
      draftUserMessage: null,
      draftAttachments: null,
    });
    await expect(servedDraftText(fixture)).resolves.toBeNull();
    await expect(listedDraftIds(fixture)).resolves.not.toContain(
      fixture.threadId,
    );
  });
});
