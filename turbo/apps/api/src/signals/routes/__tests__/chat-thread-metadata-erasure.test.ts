import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  transferAgentOrganizationFixture,
  transferAgentOwnerFixture,
  withErasureSubjectClosureCommitBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import {
  readStoredChatThreadMetadataFixture,
  setChatThreadAgentFixture,
  setChatThreadUserFixture,
  withChatThreadContentBarrierFixture,
  withChatThreadMetadataRetrySqlControlFixture,
  withChatThreadMetadataSqlControlFixture,
} from "../../../test-fixtures/chat-thread-content-erasure";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { settleIncludingAbort } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const computerUse = createComputerUseBddApi(context);
const runs = createRunsApi(context);
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
const CASE_TIMEOUT_MS = 30_000;

interface MetadataFixture {
  readonly actor: ApiTestUser;
  readonly agentOwner: ApiTestUser;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
}

async function createMetadataFixture(options?: {
  readonly sharedAgentOwner?: boolean;
  readonly title?: string;
}): Promise<MetadataFixture> {
  const actor = bdd.user();
  const { orgId } = actor;
  if (orgId === null) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  const agentOwner = options?.sharedAgentOwner
    ? bdd.user({ orgId, orgRole: "org:member" })
    : actor;
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(agentOwner, {
    displayName: `Metadata ${randomUUID().slice(0, 8)}`,
    visibility: options?.sharedAgentOwner ? "public" : "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: options?.title ?? "Metadata baseline",
  });
  return {
    actor,
    agentOwner,
    orgId,
    agentId: agent.agentId,
    threadId: thread.id,
  };
}

/** Projects one dormant B1 closure and retires it even after an assertion. */
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

/** Own every concurrent operation through test cleanup as well as normal flow. */
function operationOwner() {
  const operations: Promise<unknown>[] = [];
  onTestFinished(async () => {
    await Promise.allSettled(operations);
  });
  return <T>(operation: Promise<T>): Promise<T> => {
    operations.push(operation);
    return operation;
  };
}

async function eventSeqIds(
  fixture: MetadataFixture,
): Promise<readonly number[]> {
  const response = await chat.requestThreadEvents(fixture.actor, {}, [200]);
  if (!("events" in response.body)) {
    throw new Error("Expected the sidebar event page");
  }
  return response.body.events.map((event) => {
    return event.seqId;
  });
}

function okouTokenFor(
  actor: ApiTestUser,
  capabilities: readonly Capability[],
): string {
  if (actor.orgId === null) {
    throw new Error("Expected an org-scoped actor");
  }
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: actor.userId,
    orgId: actor.orgId,
    // Deliberately synthetic: metadata authorization is capability-scoped and
    // must not acquire a new active-run existence requirement.
    runId: `run_${randomUUID()}`,
    capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

function noContentLeak(body: unknown, fixture: MetadataFixture): void {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("Metadata baseline");
  expect(serialized).not.toContain(fixture.agentId);
}

async function expectMetadata404(fixture: MetadataFixture): Promise<void> {
  const response = await chat.requestReadThreadMetadata(
    fixture.actor,
    fixture.threadId,
    [404],
  );
  expect(response.status).toBe(404);
  expect(response.body).toStrictEqual({
    error: { message: "Chat thread not found", code: "NOT_FOUND" },
  });
  noContentLeak(response.body, fixture);
}

async function captureSqlPath(
  actor: ApiTestUser,
  threadId: string,
  status: 200 | 404,
): Promise<{
  readonly attempts: readonly (readonly string[])[];
  readonly response: Awaited<ReturnType<typeof chat.requestReadThreadMetadata>>;
}> {
  const own = operationOwner();
  return await withChatThreadMetadataSqlControlFixture(async (barrier) => {
    const reading = own(
      chat.requestReadThreadMetadata(actor, threadId, [status]),
    );
    await barrier.entered;
    const attempts = barrier.attempts().map((attempt) => {
      return [...attempt];
    });
    barrier.release();
    return { attempts, response: await reading };
  }, context.signal);
}

function classifySql(statement: string): string {
  if (statement.startsWith("begin")) {
    return "BEGIN READ COMMITTED";
  }
  if (statement === "commit") {
    return "COMMIT";
  }
  if (statement === "rollback") {
    return "ROLLBACK";
  }
  if (statement.includes("set_config('lock_timeout'")) {
    return "LOCK TIMEOUT";
  }
  if (statement.includes("set_config('statement_timeout'")) {
    return "STATEMENT TIMEOUT";
  }
  if (statement.includes('from "chat_threads" left join "agents"')) {
    return "CANONICAL IDENTITY BY THREAD PK";
  }
  if (statement.includes("erasure_isolation_probe")) {
    return "B1 ISOLATION + FIRST SHARED LOCK";
  }
  if (statement.includes("pg_advisory_xact_lock_shared")) {
    return "B1 SHARED LOCK";
  }
  if (statement.includes('from "account_erasure_jobs"')) {
    return "B1 CLOSED LOOKUP";
  }
  if (
    statement.includes('from "agents"') &&
    statement.includes("for key share")
  ) {
    return "AGENT KEY SHARE";
  }
  if (
    statement.includes('from "chat_threads"') &&
    statement.includes("for update")
  ) {
    return "THREAD UPDATE";
  }
  if (
    statement.includes('"model_settings"') &&
    statement.includes('"selected_image_model"')
  ) {
    return "FIXED METADATA PROJECTION BY THREAD PK";
  }
  return statement;
}

function sqlShape(
  attempts: readonly (readonly string[])[],
): readonly string[][] {
  return attempts.map((attempt) => {
    return attempt.map(classifySql);
  });
}

describe("GET /api/chat-threads/:id/metadata B1 closure fence", () => {
  it("preserves the complete projection and fixed response shape through the real route", async () => {
    const fixture = await createMetadataFixture({
      title: "Metadata projection",
    });
    const selectedModel = await chat.getDefaultCreateThreadModel(fixture.actor);
    await chat.updateThreadModelSelection(
      fixture.actor,
      fixture.threadId,
      selectedModel,
      { reasoningEffort: "high", codexServiceTier: "fast" },
    );
    await chat.pinThread(fixture.actor, fixture.threadId, { pinOrder: "a0" });
    const host = await computerUse.startComputerUseHost(fixture.actor);
    await chat.updateThreadComputerUseHost(
      fixture.actor,
      fixture.threadId,
      host.hostId,
    );
    await chat.updateThreadImageModel(
      fixture.actor,
      fixture.threadId,
      "gpt-image-2",
    );
    await chat.updateThreadVideoModel(
      fixture.actor,
      fixture.threadId,
      "MiniMax-H3",
    );

    const response = await chat.requestReadThreadMetadata(
      fixture.actor,
      fixture.threadId,
      [200],
    );
    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      id: fixture.threadId,
      agentId: fixture.agentId,
      title: "Metadata projection",
      selectedModel,
      modelSettings: { [selectedModel]: { effort: "high" } },
      serviceTier: "priority",
      pinnedAt: expect.any(String),
      computerUseHostId: host.hostId,
      cloudBrowserEnabled: false,
      selectedVideoModel: "MiniMax-H3",
      selectedImageModel: "gpt-image-2",
    });
    expect(Object.keys(response.body)).toStrictEqual([
      "id",
      "agentId",
      "title",
      "selectedModel",
      "modelSettings",
      "serviceTier",
      "pinnedAt",
      "computerUseHostId",
      "cloudBrowserEnabled",
      "selectedVideoModel",
      "selectedImageModel",
    ]);
    // UUIDs and ISO timestamps are fixed width. This bounds the complete JSON
    // projection itself; transport headers/envelopes are outside this contract.
    expect(Buffer.byteLength(JSON.stringify(response.body))).toBe(425);
  });

  it("keeps session, PAT and synthetic Okou capability credentials equivalent", async () => {
    const fixture = await createMetadataFixture();
    const session = await chat.requestReadThreadMetadata(
      fixture.actor,
      fixture.threadId,
      [200],
    );

    const apiKey = await runs.createCliToken(fixture.actor);
    mockClerkMembership(context, fixture.actor, "org:member");
    const pat = await chat.requestReadThreadMetadataWithBearer(
      `Bearer ${apiKey.token}`,
      fixture.threadId,
      [200],
    );
    const capability = await chat.requestReadThreadMetadataWithBearer(
      `Bearer ${okouTokenFor(fixture.actor, ["chat-thread:read"])}`,
      fixture.threadId,
      [200],
    );

    expect(pat.body).toStrictEqual(session.body);
    expect(capability.body).toStrictEqual(session.body);
  });

  it("keeps user ownership when selected org differs or is absent", async () => {
    const fixture = await createMetadataFixture();
    const differentSelectedOrg = bdd.user({
      userId: fixture.actor.userId,
      orgId: `org_${randomUUID()}`,
    });
    const noSelectedOrg = bdd.user({
      userId: fixture.actor.userId,
      orgId: null,
    });

    await expect(
      chat.requestReadThreadMetadata(
        differentSelectedOrg,
        fixture.threadId,
        [200],
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      chat.requestReadThreadMetadata(noSelectedOrg, fixture.threadId, [200]),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("keeps foreign, missing and Agent-less metadata opaque while nullable draft remains readable", async () => {
    const fixture = await createMetadataFixture();
    const foreign = bdd.user({ orgId: fixture.orgId });
    await chat.patchThread(fixture.actor, fixture.threadId, {
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "Agent-less draft survives" }],
      },
      draftAttachments: null,
    });

    await expect(
      chat.requestReadThreadMetadata(foreign, fixture.threadId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      chat.requestReadThreadMetadata(fixture.actor, randomUUID(), [404]),
    ).resolves.toMatchObject({ status: 404 });

    await setChatThreadAgentFixture({
      chatThreadId: fixture.threadId,
      agentId: null,
    });
    await expectMetadata404(fixture);
    // Draft write semantics deliberately remain nullable-Agent compatible even
    // though metadata's successful contract requires a concrete Agent UUID.
    await chat.patchThread(fixture.actor, fixture.threadId, {
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: "Agent-less draft still writable" }],
      },
      draftAttachments: null,
    });
    await setChatThreadAgentFixture({
      chatThreadId: fixture.threadId,
      agentId: fixture.agentId,
    });
    await expect(
      chat.readThreadDraft(fixture.actor, fixture.threadId),
    ).resolves.toMatchObject({
      draftUserMessage: {
        parts: [{ type: "text", text: "Agent-less draft still writable" }],
      },
    });
  });

  it.each([
    {
      name: "thread user",
      subject: (fixture: MetadataFixture): ErasureSubject => {
        return { subjectKind: "user", subjectId: fixture.actor.userId };
      },
    },
    {
      name: "distinct real shared-Agent owner",
      subject: (fixture: MetadataFixture): ErasureSubject => {
        return { subjectKind: "user", subjectId: fixture.agentOwner.userId };
      },
    },
    {
      name: "canonical Agent organization",
      subject: (fixture: MetadataFixture): ErasureSubject => {
        return { subjectKind: "organization", subjectId: fixture.orgId };
      },
    },
  ])(
    "denies closed $name, preserves durable state, and restores the next writer at baseline + 1",
    async ({ subject }) => {
      const fixture = await createMetadataFixture({ sharedAgentOwner: true });
      expect(fixture.agentOwner.userId).not.toBe(fixture.actor.userId);
      const stored = await readStoredChatThreadMetadataFixture(
        fixture.threadId,
      );
      const seqIds = await eventSeqIds(fixture);
      const lastSeqId = seqIds.at(-1) ?? 0;
      const closed = await closeSubject(subject(fixture));

      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();
      await expectMetadata404(fixture);
      await expect(
        readStoredChatThreadMetadataFixture(fixture.threadId),
      ).resolves.toStrictEqual(stored);
      await expect(eventSeqIds(fixture)).resolves.toStrictEqual(seqIds);
      expect(context.mocks.ably.publish).not.toHaveBeenCalled();

      await removeErasureSubjectsFixture([closed.jobId]);
      await expect(
        chat.requestReadThreadMetadata(fixture.actor, fixture.threadId, [200]),
      ).resolves.toMatchObject({ status: 200 });
      await chat.renameThread(
        fixture.actor,
        fixture.threadId,
        "Restored title",
      );
      const restoredSeqIds = await eventSeqIds(fixture);
      expect(restoredSeqIds.at(-1)).toBe(lastSeqId + 1);
      await expect(
        chat.readThreadMetadata(fixture.actor, fixture.threadId),
      ).resolves.toMatchObject({ title: "Restored title" });
    },
    CASE_TIMEOUT_MS,
  );

  it("makes closure wait for an admitted metadata read and then denies later reads", async () => {
    const fixture = await createMetadataFixture();
    const unrelated = await createMetadataFixture();
    const own = operationOwner();

    const closed = await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const reading = own(
            chat.requestReadThreadMetadata(
              fixture.actor,
              fixture.threadId,
              [200],
            ),
          );
          await barrier.entered;
          const closing = own(
            closeErasureSubjectFixture({
              subjectKind: "user",
              subjectId: fixture.actor.userId,
            }),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          await expect(
            chat.requestReadThreadMetadata(
              unrelated.actor,
              unrelated.threadId,
              [200],
            ),
          ).resolves.toMatchObject({ status: 200 });
          barrier.release();
          await expect(reading).resolves.toMatchObject({ status: 200 });
          return await closing;
        },
      },
      context.signal,
    );
    onTestFinished(async () => {
      await removeErasureSubjectsFixture([closed.jobId]);
    });

    await expectMetadata404(fixture);
  });

  it("makes metadata wait for a closure-first commit, lets unrelated reads progress, then denies", async () => {
    const fixture = await createMetadataFixture();
    const unrelated = await createMetadataFixture();
    const own = operationOwner();
    let closedJobId: string | null = null;

    await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
      const closing = own(
        closeErasureSubjectFixture({
          subjectKind: "user",
          subjectId: fixture.actor.userId,
        }),
      );
      await barrier.entered;
      const reading = own(
        chat.requestReadThreadMetadata(fixture.actor, fixture.threadId, [404]),
      );
      await expect
        .poll(barrier.blockedWaiterCount, BLOCKED)
        .toBeGreaterThanOrEqual(1);
      await expect(
        chat.requestReadThreadMetadata(
          unrelated.actor,
          unrelated.threadId,
          [200],
        ),
      ).resolves.toMatchObject({ status: 200 });
      barrier.release();
      closedJobId = (await closing).jobId;
      await expect(reading).resolves.toMatchObject({ status: 404 });
    }, context.signal);
    onTestFinished(async () => {
      if (closedJobId !== null) {
        await removeErasureSubjectsFixture([closedJobId]);
      }
    });
  });

  it("serializes concurrent same-thread metadata GETs without an upgrade cycle", async () => {
    const fixture = await createMetadataFixture();
    const own = operationOwner();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const first = own(
            chat.requestReadThreadMetadata(
              fixture.actor,
              fixture.threadId,
              [200],
            ),
          );
          await barrier.entered;
          const second = own(
            chat.requestReadThreadMetadata(
              fixture.actor,
              fixture.threadId,
              [200],
            ),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          barrier.release();
          const [firstResult, secondResult] = await Promise.all([
            first,
            second,
          ]);
          expect(firstResult.body).toStrictEqual(secondResult.body);
        },
      },
      context.signal,
    );
  });

  it.each(["metadata-first", "writer-first"] as const)(
    "completes a same-thread metadata GET and rename in $0 order without deadlock",
    async (order) => {
      const fixture = await createMetadataFixture();
      const own = operationOwner();

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "commit",
          work: async (barrier) => {
            const first =
              order === "metadata-first"
                ? own(
                    chat.requestReadThreadMetadata(
                      fixture.actor,
                      fixture.threadId,
                      [200],
                    ),
                  )
                : own(
                    chat.renameThread(
                      fixture.actor,
                      fixture.threadId,
                      "Writer won",
                    ),
                  );
            await barrier.entered;
            const second =
              order === "metadata-first"
                ? own(
                    chat.renameThread(
                      fixture.actor,
                      fixture.threadId,
                      "Writer won",
                    ),
                  )
                : own(
                    chat.requestReadThreadMetadata(
                      fixture.actor,
                      fixture.threadId,
                      [200],
                    ),
                  );
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);
            barrier.release();
            await Promise.all([first, second]);
          },
        },
        context.signal,
      );

      await expect(
        chat.readThreadMetadata(fixture.actor, fixture.threadId),
      ).resolves.toMatchObject({ title: "Writer won" });
    },
    CASE_TIMEOUT_MS,
  );

  it("reselects a changed thread user and denies the stale caller", async () => {
    const fixture = await createMetadataFixture();
    const own = operationOwner();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "admission",
        work: async (barrier) => {
          const reading = own(
            chat.requestReadThreadMetadata(
              fixture.actor,
              fixture.threadId,
              [404],
            ),
          );
          await barrier.entered;
          await setChatThreadUserFixture({
            chatThreadId: fixture.threadId,
            userId: `user_${randomUUID()}`,
          });
          barrier.release();
          await expect(reading).resolves.toMatchObject({ status: 404 });
        },
      },
      context.signal,
    );
  });

  it("reselects a non-null Agent rebind and denies its closed new owner", async () => {
    const fixture = await createMetadataFixture();
    const nextOwner = bdd.user({ orgId: fixture.orgId, orgRole: "org:member" });
    bdd.acceptAgentStorageWrites();
    const nextAgent = await bdd.createAgent(nextOwner, {
      displayName: "Rebound metadata Agent",
      visibility: "public",
    });
    await closeSubject({ subjectKind: "user", subjectId: nextOwner.userId });
    const own = operationOwner();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "admission",
        work: async (barrier) => {
          const reading = own(
            chat.requestReadThreadMetadata(
              fixture.actor,
              fixture.threadId,
              [404],
            ),
          );
          await barrier.entered;
          // No product endpoint rebinds a thread's Agent. This focused fixture
          // mutates only that canonical FK so the real route must reselect it.
          await setChatThreadAgentFixture({
            chatThreadId: fixture.threadId,
            agentId: nextAgent.agentId,
          });
          barrier.release();
          await expect(reading).resolves.toMatchObject({ status: 404 });
        },
      },
      context.signal,
    );
  });

  it.each(["owner", "organization"] as const)(
    "reselects an Agent $0 transfer before the retained Agent lock",
    async (field) => {
      const fixture = await createMetadataFixture();
      const nextSubjectId =
        field === "owner" ? `user_${randomUUID()}` : `org_${randomUUID()}`;
      await closeSubject({
        subjectKind: field === "owner" ? "user" : "organization",
        subjectId: nextSubjectId,
      });
      const own = operationOwner();

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "agent-lock",
          work: async (barrier) => {
            const reading = own(
              chat.requestReadThreadMetadata(
                fixture.actor,
                fixture.threadId,
                [404],
              ),
            );
            await barrier.entered;
            if (field === "owner") {
              await transferAgentOwnerFixture({
                agentId: fixture.agentId,
                owner: nextSubjectId,
              });
            } else {
              await transferAgentOrganizationFixture({
                agentId: fixture.agentId,
                orgId: nextSubjectId,
              });
            }
            barrier.release();
            await expect(reading).resolves.toMatchObject({ status: 404 });
          },
        },
        context.signal,
      );
    },
  );

  it("retains Agent identity against owner transfer until the read commits", async () => {
    const fixture = await createMetadataFixture();
    const own = operationOwner();
    const nextOwner = `user_${randomUUID()}`;

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const reading = own(
            chat.requestReadThreadMetadata(
              fixture.actor,
              fixture.threadId,
              [200],
            ),
          );
          await barrier.entered;
          const transferring = own(
            transferAgentOwnerFixture({
              agentId: fixture.agentId,
              owner: nextOwner,
            }),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          barrier.release();
          await Promise.all([reading, transferring]);
        },
      },
      context.signal,
    );

    await expect(
      chat.requestReadThreadMetadata(fixture.actor, fixture.threadId, [200]),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("retains the thread against production deletion until commit, then returns missing", async () => {
    const fixture = await createMetadataFixture();
    const own = operationOwner();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        work: async (barrier) => {
          const reading = own(
            chat.requestReadThreadMetadata(
              fixture.actor,
              fixture.threadId,
              [200],
            ),
          );
          await barrier.entered;
          const deleting = own(
            chat.deleteThread(fixture.actor, fixture.threadId),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          barrier.release();
          await Promise.all([reading, deleting]);
        },
      },
      context.signal,
    );

    await expect(
      chat.requestReadThreadMetadata(fixture.actor, fixture.threadId, [404]),
    ).resolves.toMatchObject({ status: 404 });
  });

  it(
    "rolls back an operation abort after projection instead of fabricating 404",
    async () => {
      const fixture = await createMetadataFixture();
      const stored = await readStoredChatThreadMetadataFixture(
        fixture.threadId,
      );
      const controller = new AbortController();
      const own = operationOwner();
      context.mocks.ably.publish.mockClear();

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "metadata-read",
          work: async (barrier) => {
            const reading = own(
              chat.requestReadThreadMetadata(
                fixture.actor,
                fixture.threadId,
                [200, 404],
                controller.signal,
              ),
            );
            const entered = await barrier.entered;
            expect(entered.rowCount).toBe(1);
            controller.abort(new DOMException("Operation ended", "AbortError"));
            barrier.release();
            await expect(reading).rejects.toThrow(
              /Unknown response status 500/,
            );
          },
        },
        context.signal,
      );

      await expect(
        readStoredChatThreadMetadataFixture(fixture.threadId),
      ).resolves.toStrictEqual(stored);
      expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    },
    CASE_TIMEOUT_MS,
  );

  it("propagates a real scoped thread-lock timeout instead of fabricating 404", async () => {
    const fixture = await createMetadataFixture();
    const holder = await holdChatThreadRowLockFixture({
      threadId: fixture.threadId,
      signal: context.signal,
    });
    const reading = await settleIncludingAbort(
      chat.requestReadThreadMetadata(
        fixture.actor,
        fixture.threadId,
        [200, 404],
      ),
    );
    holder.release();
    await holder.done;
    expect(reading.ok).toBeFalsy();
    if (reading.ok) {
      throw new Error("Expected the held metadata read to fail");
    }
    expect(reading.error).toStrictEqual(
      expect.objectContaining({
        message: expect.stringMatching(/Unknown response status 500/),
      }),
    );

    await expect(
      chat.requestReadThreadMetadata(fixture.actor, fixture.threadId, [200]),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("joins both readers when a contended barrier callback exits with an assertion-like failure", async () => {
    const fixture = await createMetadataFixture();
    const own = operationOwner();
    let first: Promise<unknown> | null = null;
    let second: Promise<unknown> | null = null;

    await expect(
      withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "commit",
          work: async (barrier) => {
            first = own(
              chat.requestReadThreadMetadata(
                fixture.actor,
                fixture.threadId,
                [200],
              ),
            );
            await barrier.entered;
            second = own(
              chat.requestReadThreadMetadata(
                fixture.actor,
                fixture.threadId,
                [200],
              ),
            );
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);
            throw new Error("synthetic assertion after contention");
          },
        },
        context.signal,
      ),
    ).rejects.toThrow("synthetic assertion after contention");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toMatchObject({ status: 200 });
  });

  it("cleans up a barrier readiness miss after the route exits early", async () => {
    const fixture = await createMetadataFixture();
    let entered = true;

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: randomUUID(),
        stopAt: "metadata-read",
        work: async (barrier) => {
          await expect(
            chat.requestReadThreadMetadata(fixture.actor, randomUUID(), [404]),
          ).resolves.toMatchObject({ status: 404 });
          entered = barrier.enteredYet();
        },
      },
      context.signal,
    );
    expect(entered).toBeFalsy();

    await expect(
      chat.requestReadThreadMetadata(fixture.actor, fixture.threadId, [200]),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("pins exact open, missing and closed SQL/control shapes to primary-key predicates", async () => {
    const fixture = await createMetadataFixture();
    const open = await captureSqlPath(fixture.actor, fixture.threadId, 200);
    const missing = await captureSqlPath(fixture.actor, randomUUID(), 404);
    const closedJob = await closeSubject({
      subjectKind: "user",
      subjectId: fixture.actor.userId,
    });
    const closed = await captureSqlPath(fixture.actor, fixture.threadId, 404);

    expect(open.response.status).toBe(200);
    expect(missing.response.status).toBe(404);
    expect(closed.response.status).toBe(404);
    expect(sqlShape(open.attempts)).toStrictEqual([
      [
        "BEGIN READ COMMITTED",
        "LOCK TIMEOUT",
        "STATEMENT TIMEOUT",
        "CANONICAL IDENTITY BY THREAD PK",
        "B1 ISOLATION + FIRST SHARED LOCK",
        "B1 SHARED LOCK",
        "B1 CLOSED LOOKUP",
        "AGENT KEY SHARE",
        "THREAD UPDATE",
        "CANONICAL IDENTITY BY THREAD PK",
        "FIXED METADATA PROJECTION BY THREAD PK",
        "COMMIT",
      ],
    ]);
    expect(sqlShape(missing.attempts)).toStrictEqual([
      [
        "BEGIN READ COMMITTED",
        "LOCK TIMEOUT",
        "STATEMENT TIMEOUT",
        "CANONICAL IDENTITY BY THREAD PK",
        "COMMIT",
      ],
    ]);
    expect(sqlShape(closed.attempts)).toStrictEqual([
      [
        "BEGIN READ COMMITTED",
        "LOCK TIMEOUT",
        "STATEMENT TIMEOUT",
        "CANONICAL IDENTITY BY THREAD PK",
        "B1 ISOLATION + FIRST SHARED LOCK",
        "B1 SHARED LOCK",
        "B1 CLOSED LOOKUP",
        "COMMIT",
      ],
    ]);

    const openSql = open.attempts.flat().join("\n");
    expect(openSql).toContain('where "chat_threads"."id" =');
    expect(openSql).toContain('where "agents"."id" =');
    expect(openSql).toContain('from "account_erasure_jobs"');
    expect(openSql).not.toContain("select *");
    // LIMIT 1/cardinality and primary-key predicates bound returned rows and
    // select only fixed columns. They do not claim a physical scan bound; that
    // remains PostgreSQL planner/index behavior rather than a suite-time proxy.
    expect(openSql.match(/limit/g)?.length).toBeGreaterThanOrEqual(3);

    const retryFixture = await createMetadataFixture();
    const own = operationOwner();
    const retry = await withChatThreadMetadataRetrySqlControlFixture(
      {
        chatThreadId: retryFixture.threadId,
        work: async (barrier) => {
          const reading = own(
            chat.requestReadThreadMetadata(
              retryFixture.actor,
              retryFixture.threadId,
              [404],
            ),
          );
          await barrier.entered;
          await setChatThreadUserFixture({
            chatThreadId: retryFixture.threadId,
            userId: `user_${randomUUID()}`,
          });
          barrier.release();
          const response = await reading;
          return {
            response,
            attempts: barrier.attempts().map((attempt) => {
              return [...attempt];
            }),
          };
        },
      },
      context.signal,
    );
    expect(retry.response.status).toBe(404);
    expect(sqlShape(retry.attempts)).toStrictEqual([
      [
        "BEGIN READ COMMITTED",
        "LOCK TIMEOUT",
        "STATEMENT TIMEOUT",
        "CANONICAL IDENTITY BY THREAD PK",
        "B1 ISOLATION + FIRST SHARED LOCK",
        "B1 SHARED LOCK",
        "B1 CLOSED LOOKUP",
        "AGENT KEY SHARE",
        "THREAD UPDATE",
        "CANONICAL IDENTITY BY THREAD PK",
        "ROLLBACK",
      ],
      [
        "BEGIN READ COMMITTED",
        "LOCK TIMEOUT",
        "STATEMENT TIMEOUT",
        "CANONICAL IDENTITY BY THREAD PK",
        "COMMIT",
      ],
    ]);

    await removeErasureSubjectsFixture([closedJob.jobId]);
  });
});
