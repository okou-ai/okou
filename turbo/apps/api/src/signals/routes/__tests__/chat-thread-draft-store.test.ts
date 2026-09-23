import { randomUUID } from "node:crypto";

import type {
  PersistedAttachment,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import {
  readStoredChatThreadDraftRowFixture,
  withChatThreadContentBarrierFixture,
  type StoredChatThreadDraftRow,
} from "../../../test-fixtures/chat-thread-content-erasure";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

interface DraftFixture {
  readonly actor: ReturnType<typeof bdd.user>;
  readonly threadId: string;
}

async function createDraftFixture(): Promise<DraftFixture> {
  const actor = bdd.user();
  const agent = await chat.createAgentForChatThread(actor);
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: `Draft ${randomUUID()}`,
  });
  return { actor, threadId: thread.id };
}

function draftDocument(text: string): UserMessageInputDocument {
  return { version: 1, parts: [{ type: "text", text }] };
}

function draftBody(text: string) {
  return { draftUserMessage: draftDocument(text), draftAttachments: null };
}

function draftText(document: UserMessageInputDocument | null): string | null {
  if (document === null) {
    return null;
  }
  const [part] = document.parts;
  if (part === undefined || part.type !== "text") {
    throw new Error("Expected a single text draft part");
  }
  return part.text;
}

/** The draft text every current reader still serves, from `chat_threads`. */
async function servedDraftText(fixture: DraftFixture): Promise<string | null> {
  const draft = await chat.readThreadDraft(fixture.actor, fixture.threadId);
  return draftText(draft.draftUserMessage);
}

function storedDraftRow(
  fixture: DraftFixture,
): Promise<StoredChatThreadDraftRow | null> {
  return readStoredChatThreadDraftRowFixture(fixture.threadId);
}

/** The draft text in the child row, or `null` when it is cleared or absent. */
async function storedDraftText(fixture: DraftFixture): Promise<string | null> {
  const stored = await storedDraftRow(fixture);
  return draftText(stored?.draftUserMessage ?? null);
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

describe("thread drafts are written to chat_thread_drafts and chat_threads", () => {
  it("stores the document and its attachments in both places", async () => {
    const fixture = await createDraftFixture();
    // Nothing has touched this thread's draft, so it has no child row at all.
    await expect(storedDraftRow(fixture)).resolves.toBeNull();

    await chat.patchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("first draft"),
    );
    await expect(servedDraftText(fixture)).resolves.toBe("first draft");
    const saved = await storedDraftRow(fixture);
    expect(draftText(saved?.draftUserMessage ?? null)).toBe("first draft");
    expect(saved?.draftAttachments).toBeNull();

    await chat.patchThread(fixture.actor, fixture.threadId, {
      draftUserMessage: draftDocument("second draft"),
      draftAttachments: [draftAttachment()],
    });
    const served = await chat.readThreadDraft(fixture.actor, fixture.threadId);
    expect(draftText(served.draftUserMessage)).toBe("second draft");
    expect(served.draftAttachments).toStrictEqual([draftAttachment()]);

    const updated = await storedDraftRow(fixture);
    expect(draftText(updated?.draftUserMessage ?? null)).toBe("second draft");
    expect(updated?.draftAttachments).toStrictEqual([draftAttachment()]);
    // One row per thread: the second write updated the first one in place.
    expect(updated?.createdAt).toBe(saved?.createdAt);
  });

  it("records a cleared draft as a retained row with null values", async () => {
    const fixture = await createDraftFixture();
    await chat.patchThread(fixture.actor, fixture.threadId, {
      draftUserMessage: draftDocument("kept draft"),
      draftAttachments: [draftAttachment()],
    });
    const saved = await storedDraftRow(fixture);
    expect(saved).not.toBeNull();

    await chat.patchThread(fixture.actor, fixture.threadId, {
      draftUserMessage: null,
      draftAttachments: null,
    });
    await expect(servedDraftText(fixture)).resolves.toBeNull();

    // Deleting on clear, the way `agent_drafts` does, would make this thread
    // indistinguishable from one the table has never held. The later read
    // cutover falls back to `chat_threads` for a missing row, so it would hand
    // the user back the draft they just cleared.
    const cleared = await storedDraftRow(fixture);
    expect(cleared).not.toBeNull();
    expect(cleared?.draftUserMessage).toBeNull();
    expect(cleared?.draftAttachments).toBeNull();
    expect(cleared?.createdAt).toBe(saved?.createdAt);

    const untouched = await createDraftFixture();
    await expect(storedDraftRow(untouched)).resolves.toBeNull();
  });

  it("writes the child row before it locks the thread row", async () => {
    const fixture = await createDraftFixture();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "draft-child-upsert",
        work: async (barrier) => {
          const writing = chat.patchThread(
            fixture.actor,
            fixture.threadId,
            draftBody("ordered draft"),
          );
          await barrier.entered;
          // The child upsert has run and the legacy statement that upgrades the
          // thread row to FOR NO KEY UPDATE has not, so the hot parent row is
          // exclusively locked for the shortest part of the transaction. Both
          // writes are still uncommitted and invisible from here.
          await expect(servedDraftText(fixture)).resolves.toBeNull();
          await expect(storedDraftRow(fixture)).resolves.toBeNull();
          barrier.release();
          await writing;
        },
      },
      context.signal,
    );

    await expect(servedDraftText(fixture)).resolves.toBe("ordered draft");
    await expect(storedDraftText(fixture)).resolves.toBe("ordered draft");
  });

  it("commits neither store when the thread-row update loses its lock", async () => {
    const fixture = await createDraftFixture();
    await chat.patchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("saved draft"),
    );
    const before = await storedDraftRow(fixture);

    // FOR NO KEY UPDATE is compatible with the fence's own FOR KEY SHARE, so
    // the writer is admitted, stages its child row and then fails at the legacy
    // `chat_threads` UPDATE — the exact shape of the production 55P03 in
    // #36173. Phase 1 still writes that row, so it is still exposed to it.
    const holder = await holdChatThreadRowLockFixture({
      threadId: fixture.threadId,
      mode: "no key update",
      signal: context.signal,
    });
    await expect(
      chat.requestPatchThread(
        fixture.actor,
        fixture.threadId,
        draftBody("blocked draft"),
        [204, 404],
      ),
    ).rejects.toThrow(/Unknown response status 500/);
    holder.release();
    await holder.done;

    // The staged child row rolled back with the failed thread-row update: no
    // half-written draft and no new `updated_at`.
    await expect(storedDraftRow(fixture)).resolves.toStrictEqual(before);
    await expect(servedDraftText(fixture)).resolves.toBe("saved draft");

    await chat.patchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("recovered draft"),
    );
    await expect(servedDraftText(fixture)).resolves.toBe("recovered draft");
    await expect(storedDraftText(fixture)).resolves.toBe("recovered draft");
  });

  it("leaves the two stores agreeing after competing writes", async () => {
    const fixture = await createDraftFixture();
    const texts = ["competing draft a", "competing draft b"] as const;

    await Promise.all(
      texts.map((text) => {
        return chat.patchThread(
          fixture.actor,
          fixture.threadId,
          draftBody(text),
        );
      }),
    );

    // Both writers take the child row's lock before the thread row's, so they
    // commit in one order and the two stores cannot disagree about the winner.
    const served = await servedDraftText(fixture);
    expect(texts).toContain(served);
    await expect(storedDraftText(fixture)).resolves.toBe(served);
  });

  it("removes the child row with the thread it belongs to", async () => {
    const fixture = await createDraftFixture();
    await chat.patchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("deleted draft"),
    );
    await expect(storedDraftRow(fixture)).resolves.not.toBeNull();

    await chat.deleteThread(fixture.actor, fixture.threadId);

    await expect(storedDraftRow(fixture)).resolves.toBeNull();
  });
});
