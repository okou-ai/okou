import { randomUUID } from "node:crypto";

import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  transferAgentOwnerFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import {
  setChatThreadAgentFixture,
  withChatThreadContentBarrierFixture,
} from "../../../test-fixtures/chat-thread-content-erasure";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const BLOCKED = { interval: 10, timeout: 10_000 } as const;

interface ContentFixture {
  readonly actor: ReturnType<typeof bdd.user>;
  readonly agentId: string;
  readonly threadId: string;
}

async function createContentFixture(): Promise<ContentFixture> {
  const actor = bdd.user();
  const agent = await chat.createAgentForChatThread(actor);
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: `Content ${randomUUID()}`,
  });
  return { actor, agentId: agent.agentId, threadId: thread.id };
}

function draftBody(text: string) {
  return {
    draftUserMessage: {
      version: 1 as const,
      parts: [{ type: "text" as const, text }],
    },
    draftAttachments: null,
  };
}

/** Projects one dormant B1 closure and retires it with the test. */
function closeSubject(
  subject: ErasureSubject,
): Promise<{ readonly jobId: string }> {
  const closing = closeErasureSubjectFixture(subject);
  onTestFinished(async () => {
    const { jobId } = await closing;
    await removeErasureSubjectsFixture([jobId]);
  });
  return closing;
}

async function expectDraftText(
  fixture: ContentFixture,
  text: string | null,
): Promise<void> {
  const draft = await chat.readThreadDraft(fixture.actor, fixture.threadId);
  expect(draft.draftUserMessage).toStrictEqual(
    text === null ? null : { version: 1, parts: [{ type: "text", text }] },
  );
}

interface SidebarRename {
  readonly seqId: number;
  readonly title: string | null;
}

/** The thread's own sidebar rename events, as a client reads them. */
async function sidebarRenames(
  fixture: ContentFixture,
): Promise<readonly SidebarRename[]> {
  const response = await chat.requestThreadEvents(fixture.actor, {}, [200]);
  if (!("events" in response.body)) {
    throw new Error("Expected the sidebar event page");
  }
  return response.body.events
    .filter((event) => {
      return (
        event.kind === "renamed" && event.chatThreadId === fixture.threadId
      );
    })
    .map((event) => {
      return { seqId: event.seqId, title: event.title };
    });
}

function renameTitle(event: SidebarRename): string | null {
  return event.title;
}

function actorOrgId(fixture: ContentFixture): string {
  const { orgId } = fixture.actor;
  if (orgId === null) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  return orgId;
}

async function expectThreadTitle(
  fixture: ContentFixture,
  title: string,
): Promise<void> {
  const metadata = await chat.readThreadMetadata(
    fixture.actor,
    fixture.threadId,
  );
  expect(metadata.title).toBe(title);
}

describe("account erasure fences direct chat-thread content writes", () => {
  it("denies a draft write for a closed thread user and leaves the stored draft", async () => {
    const fixture = await createContentFixture();
    await chat.patchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("kept draft"),
    );

    await closeSubject({
      subjectKind: "user",
      subjectId: fixture.actor.userId,
    });

    await chat.requestPatchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("erased draft"),
      [404],
    );
    await expectDraftText(fixture, "kept draft");
  });

  it("denies a draft write for a closed distinct Agent owner and for a closed organization", async () => {
    const shared = await createContentFixture();
    const sharedOwner = `user_${randomUUID()}`;
    await transferAgentOwnerFixture({
      agentId: shared.agentId,
      owner: sharedOwner,
    });
    await closeSubject({ subjectKind: "user", subjectId: sharedOwner });

    await chat.requestPatchThread(
      shared.actor,
      shared.threadId,
      draftBody("shared owner draft"),
      [404],
    );
    await expectDraftText(shared, null);

    const organization = await createContentFixture();
    await closeSubject({
      subjectKind: "organization",
      subjectId: actorOrgId(organization),
    });

    await chat.requestPatchThread(
      organization.actor,
      organization.threadId,
      draftBody("organization draft"),
      [404],
    );
    await expectDraftText(organization, null);
  });

  it("keeps an unrelated owner writable while another subject is closed", async () => {
    const closed = await createContentFixture();
    const unrelated = await createContentFixture();
    await closeSubject({ subjectKind: "user", subjectId: closed.actor.userId });

    await chat.requestPatchThread(
      closed.actor,
      closed.threadId,
      draftBody("closed draft"),
      [404],
    );
    await chat.patchThread(
      unrelated.actor,
      unrelated.threadId,
      draftBody("unrelated draft"),
    );
    await expectDraftText(unrelated, "unrelated draft");
  });

  it("preserves a draft write on a thread without an Agent and still fences its user", async () => {
    const fixture = await createContentFixture();
    await setChatThreadAgentFixture({
      chatThreadId: fixture.threadId,
      agentId: null,
    });

    await chat.patchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("null agent draft"),
    );
    await setChatThreadAgentFixture({
      chatThreadId: fixture.threadId,
      agentId: fixture.agentId,
    });
    await expectDraftText(fixture, "null agent draft");

    await setChatThreadAgentFixture({
      chatThreadId: fixture.threadId,
      agentId: null,
    });
    await closeSubject({
      subjectKind: "user",
      subjectId: fixture.actor.userId,
    });
    await chat.requestPatchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("closed null agent draft"),
      [404],
    );

    await setChatThreadAgentFixture({
      chatThreadId: fixture.threadId,
      agentId: fixture.agentId,
    });
    await expectDraftText(fixture, "null agent draft");
  });

  it("denies a rename for a closed subject without consuming a sidebar sequence", async () => {
    const fixture = await createContentFixture();
    await chat.renameThread(fixture.actor, fixture.threadId, "First title");
    const before = await sidebarRenames(fixture);
    const lastSeqId = before.at(-1)?.seqId;
    expect(before.map(renameTitle)).toStrictEqual(["First title"]);
    expect(lastSeqId).toBeGreaterThan(0);

    const closed = await closeSubject({
      subjectKind: "user",
      subjectId: fixture.actor.userId,
    });
    await chat.requestRenameThread(
      fixture.actor,
      fixture.threadId,
      "Erased title",
      [404],
    );

    await expectThreadTitle(fixture, "First title");
    await expect(sidebarRenames(fixture)).resolves.toStrictEqual(before);

    // The denied attempt left the durable sequence untouched, so the next
    // accepted rename takes the very next sidebar sequence id.
    await removeErasureSubjectsFixture([closed.jobId]);
    await chat.renameThread(fixture.actor, fixture.threadId, "Second title");
    const after = await sidebarRenames(fixture);
    expect(after.map(renameTitle)).toStrictEqual([
      "First title",
      "Second title",
    ]);
    expect(after.at(-1)?.seqId).toBe((lastSeqId ?? 0) + 1);
    await expectThreadTitle(fixture, "Second title");
  });

  it("denies a rename for a closed organization while the Agent organization is the subject", async () => {
    const fixture = await createContentFixture();
    await chat.renameThread(fixture.actor, fixture.threadId, "Org title");
    await closeSubject({
      subjectKind: "organization",
      subjectId: actorOrgId(fixture),
    });

    await chat.requestRenameThread(
      fixture.actor,
      fixture.threadId,
      "Closed org title",
      [404],
    );
    await expectThreadTitle(fixture, "Org title");
  });

  it("makes a closure wait for an admitted writer and fences the next write", async () => {
    const fixture = await createContentFixture();

    const closed = await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const writing = chat.patchThread(
            fixture.actor,
            fixture.threadId,
            draftBody("admitted draft"),
          );
          const settings = await barrier.entered;
          expect(settings.lockTimeout).toBe("1s");
          expect(settings.statementTimeout).toBe("5s");

          const closing = closeErasureSubjectFixture({
            subjectKind: "user",
            subjectId: fixture.actor.userId,
          });
          // The admitted writer still holds its shared subject barrier with the
          // draft already written, so the exclusive closure cannot commit first.
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);

          barrier.release();
          await writing;
          return await closing;
        },
      },
      context.signal,
    );
    onTestFinished(async () => {
      await removeErasureSubjectsFixture([closed.jobId]);
    });

    await expectDraftText(fixture, "admitted draft");
    await chat.requestPatchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("post closure draft"),
      [404],
    );
    await expectDraftText(fixture, "admitted draft");
  });

  it("re-resolves a transferred Agent owner under the locks instead of writing under a stale label", async () => {
    const fixture = await createContentFixture();
    const newOwner = `user_${randomUUID()}`;
    await closeSubject({ subjectKind: "user", subjectId: newOwner });

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const writing = chat.requestPatchThread(
            fixture.actor,
            fixture.threadId,
            draftBody("stale owner draft"),
            [404],
          );
          await barrier.entered;
          await transferAgentOwnerFixture({
            agentId: fixture.agentId,
            owner: newOwner,
          });
          barrier.release();
          await writing;
        },
      },
      context.signal,
    );

    await expectDraftText(fixture, null);
  });

  it("finds a thread deleted under the locks and recreates no content", async () => {
    const fixture = await createContentFixture();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "agent-lock",
        work: async (barrier) => {
          const writing = chat.requestPatchThread(
            fixture.actor,
            fixture.threadId,
            draftBody("deleted thread draft"),
            [404],
          );
          await barrier.entered;
          await chat.deleteThread(fixture.actor, fixture.threadId);
          barrier.release();
          await writing;
        },
      },
      context.signal,
    );

    await chat.requestReadThreadDraft(fixture.actor, fixture.threadId, [404]);
    await expect(chat.listThreadDrafts(fixture.actor)).resolves.not.toContain(
      fixture.threadId,
    );
  });

  it("propagates a held parent lock as a failure rather than a closure 404", async () => {
    const fixture = await createContentFixture();
    await chat.patchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("locked draft"),
    );

    const holder = await holdChatThreadRowLockFixture({
      threadId: fixture.threadId,
      signal: context.signal,
    });
    // Neither an accepted 204 nor the closure 404: a real blocked parent lock
    // keeps its own database failure instead of being reported as erasure.
    await expect(
      chat.requestPatchThread(
        fixture.actor,
        fixture.threadId,
        draftBody("blocked draft"),
        [204, 404],
      ),
    ).rejects.toThrow();
    holder.release();
    await holder.done;

    await expectDraftText(fixture, "locked draft");
    await chat.patchThread(
      fixture.actor,
      fixture.threadId,
      draftBody("recovered draft"),
    );
    await expectDraftText(fixture, "recovered draft");
  });
});
