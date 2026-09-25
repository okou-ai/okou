import { randomUUID } from "node:crypto";

import type {
  PersistedAttachment,
  UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  holdChatThreadDraftRowFixture,
  readStoredChatThreadDraftRowFixture,
  setLegacyChatThreadDraftFixture,
  type StoredChatThreadDraftRow,
} from "../../../test-fixtures/chat-thread-draft";
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

describe("send-coupled draft clears", () => {
  it("clears a saved child in the send transaction and retains its row", async () => {
    const fixture = await createDraftFixture();
    await runs.ensureOrgModelProvider(fixture.actor);
    await chat.patchThread(fixture.actor, fixture.threadId, {
      draftUserMessage: draftDocument("saved before send"),
      draftAttachments: [draftAttachment()],
    });
    const before = await storedDraftRow(fixture);

    await sendWithoutCredits(fixture);

    await expect(servedDraftText(fixture)).resolves.toBeNull();
    const after = await storedDraftRow(fixture);
    expect(after).not.toBeNull();
    expect(after?.draftUserMessage).toBeNull();
    expect(after?.draftAttachments).toBeNull();
    expect(after?.createdAt).toBe(before?.createdAt);
  });

  it("clears a legacy-only draft without creating a child row", async () => {
    const fixture = await createDraftFixture();
    await runs.ensureOrgModelProvider(fixture.actor);
    await setLegacyChatThreadDraftFixture({
      chatThreadId: fixture.threadId,
      draftUserMessage: draftDocument("old API draft"),
    });
    await expect(storedDraftRow(fixture)).resolves.toBeNull();
    await expect(servedDraftText(fixture)).resolves.toBe("old API draft");

    await sendWithoutCredits(fixture);

    await expect(servedDraftText(fixture)).resolves.toBeNull();
    await expect(storedDraftRow(fixture)).resolves.toBeNull();
  });

  it("keeps the committed message when the draft clear fails", async () => {
    const fixture = await createDraftFixture();
    await runs.ensureOrgModelProvider(fixture.actor);
    await chat.patchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("retained"),
    );
    const child = await storedDraftRow(fixture);
    const before = await chat.listThreadEvents(fixture.actor, fixture.threadId);

    const held = await holdChatThreadDraftRowFixture({
      chatThreadId: fixture.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });
    const send = sendWithoutCredits(fixture);
    await expect
      .poll(held.blockedWaiterCount, { interval: 10, timeout: 750 })
      .toBeGreaterThan(0);
    await expect(held.cancelBlockedQueries()).resolves.toBe(1);
    // The draft clear is a weak side effect after the event commit.
    await send;
    held.release();
    await held.done;

    // Each draft copy is cleared independently: the served draft is cleared
    // while the failed child clear leaves its row unchanged.
    await expect(servedDraftText(fixture)).resolves.toBeNull();
    await expect(storedDraftRow(fixture)).resolves.toStrictEqual(child);
    const after = await chat.listThreadEvents(fixture.actor, fixture.threadId);
    expect(
      after.events.filter((event) => {
        return event.eventType === "input.prompt";
      }),
    ).toHaveLength(
      before.events.filter((event) => {
        return event.eventType === "input.prompt";
      }).length + 1,
    );
  });

  it("leaves a foreign or deleted thread's child untouched", async () => {
    const fixture = await createDraftFixture();
    await runs.ensureOrgModelProvider(fixture.actor);
    await chat.patchThread(fixture.actor, fixture.threadId, draftBody("owned"));
    const before = await storedDraftRow(fixture);
    const foreign = bdd.user({ orgId: fixture.actor.orgId });
    const denied = await chat.requestSendEvent(
      foreign,
      {
        agentId: fixture.agentId,
        threadId: fixture.threadId,
        prompt: "Not my thread",
      },
      [403],
    );
    expect(denied.status).toBe(403);
    await expect(storedDraftRow(fixture)).resolves.toStrictEqual(before);

    await chat.deleteThread(fixture.actor, fixture.threadId);
    await expect(storedDraftRow(fixture)).resolves.toBeNull();
    const deleted = await chat.requestSendEvent(
      fixture.actor,
      {
        agentId: fixture.agentId,
        threadId: fixture.threadId,
        prompt: "Deleted thread",
      },
      [404],
    );
    expect(deleted.status).toBe(404);
    await expect(storedDraftRow(fixture)).resolves.toBeNull();
  });
});
