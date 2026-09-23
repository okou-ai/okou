import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import {
  classifyErasureFenceStatement,
  closeErasureSubjectFixture,
  erasureFenceStatementKinds,
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
const CASE_TIMEOUT_MS = 30_000;

interface MetadataFixture {
  readonly actor: ApiTestUser;
  readonly agentOwner: ApiTestUser;
  readonly orgId: string;
  readonly agentId: string;
  readonly threadId: string;
}

type Settled<T> = Awaited<ReturnType<typeof settleIncludingAbort<T>>>;

interface OwnedOperation<T> {
  readonly settled: Promise<Settled<T>>;
  readonly acceptFailureAfter: (
    inspect: (error: unknown) => void | Promise<void>,
  ) => Promise<void>;
}

interface OperationOwner {
  readonly start: <T>(operation: Promise<T>) => OwnedOperation<T>;
  readonly abortOnExit: (controller: AbortController) => void;
}

interface OperationRecord {
  readonly settled: Promise<Settled<unknown>>;
  failureAccepted: boolean;
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

/**
 * Gives every concurrent metadata-test operation one local owner. Rejections
 * are observed when work starts, and every callback exit releases its selected
 * PostgreSQL statement, aborts only registered controllers and joins all work.
 */
async function withOperationOwnership<T>(
  release: () => void,
  work: (owner: OperationOwner) => Promise<T>,
): Promise<T> {
  const operations: OperationRecord[] = [];
  const controllers = new Set<AbortController>();
  const owner: OperationOwner = {
    start: <TValue>(operation: Promise<TValue>) => {
      const settled = settleIncludingAbort(operation);
      const record: OperationRecord = { settled, failureAccepted: false };
      operations.push(record);
      return {
        settled,
        acceptFailureAfter: async (inspect) => {
          const result = await settled;
          if (result.ok) {
            throw new Error("Expected the owned metadata operation to fail");
          }
          await inspect(result.error);
          record.failureAccepted = true;
        },
      };
    },
    abortOnExit: (controller) => {
      controllers.add(controller);
    },
  };

  const workResult = await settleIncludingAbort(work(owner));
  const cleanupResult = await settleIncludingAbort(() => {
    release();
    for (const controller of controllers) {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException("Test cleanup", "AbortError"));
      }
    }
  });
  const joined = await Promise.all(
    operations.map(async (record) => {
      return { record, result: await record.settled };
    }),
  );

  const errors: unknown[] = [];
  if (!workResult.ok) {
    errors.push(workResult.error);
  }
  if (!cleanupResult.ok) {
    errors.push(cleanupResult.error);
  }
  for (const { record, result } of joined) {
    if (
      !result.ok &&
      !record.failureAccepted &&
      (workResult.ok || !Object.is(result.error, workResult.error))
    ) {
      errors.push(result.error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Concurrent metadata test work and cleanup failed",
    );
  }
  if (!workResult.ok) {
    throw workResult.error;
  }
  return workResult.value;
}

/** Fails immediately when an operation terminates before its selected gate. */
async function waitForBarrierEntry<TEntry, TValue>(
  entered: Promise<TEntry>,
  operation: OwnedOperation<TValue>,
): Promise<TEntry> {
  const first = await Promise.race([
    entered.then(
      (value) => {
        return { kind: "entered" as const, value };
      },
      (error: unknown) => {
        return { kind: "entryFailure" as const, error };
      },
    ),
    operation.settled.then((result) => {
      return { kind: "operation" as const, result };
    }),
  ]);
  if (first.kind === "entered") {
    return first.value;
  }
  if (first.kind === "entryFailure") {
    throw first.error;
  }
  if (!first.result.ok) {
    throw first.result.error;
  }
  throw new Error("Metadata operation completed before barrier entry");
}

function valueOf<T>(settled: Settled<T>): T {
  if (!settled.ok) {
    throw settled.error;
  }
  return settled.value;
}

/** Starts one closure and registers exact-job retirement before it can commit. */
function startClosure(
  owner: OperationOwner,
  subject: ErasureSubject,
): OwnedOperation<{ readonly jobId: string }> {
  const closing = owner.start(closeErasureSubjectFixture(subject));
  onTestFinished(async () => {
    const result = await closing.settled;
    if (result.ok) {
      await removeErasureSubjectsFixture([result.value.jobId]);
    }
  });
  return closing;
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
  return await withChatThreadMetadataSqlControlFixture(async (barrier) => {
    return await withOperationOwnership(barrier.release, async (owner) => {
      const reading = owner.start(
        chat.requestReadThreadMetadata(actor, threadId, [status]),
      );
      await waitForBarrierEntry(barrier.entered, reading);
      const attempts = barrier.attempts().map((attempt) => {
        return [...attempt];
      });
      barrier.release();
      return { attempts, response: valueOf(await reading.settled) };
    });
  }, context.signal);
}

/** Only what this route owns. The route's identity statement carries the
 * folded closure predicate, so it must be recognized before the shared fence
 * classifier, which would otherwise see that subquery and call it a lookup. */
function classifyMetadataSql(statement: string): string | null {
  if (statement.includes('from "chat_threads" left join "agents"')) {
    return "CANONICAL IDENTITY BY THREAD PK";
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
  return null;
}

function classifySql(statement: string): string {
  return (
    classifyMetadataSql(statement) ??
    classifyErasureFenceStatement(statement) ??
    statement
  );
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
    // This chosen complete fixture serializes to 421 UTF-8 bytes. Variable
    // title, model and settings values make this evidence, not a payload bound;
    // transport headers and envelopes are outside the measurement.
    expect(Buffer.byteLength(JSON.stringify(response.body))).toBe(421);
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

  it("lets closure commit while a metadata read is in flight, then denies later reads", async () => {
    const fixture = await createMetadataFixture();
    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        admission: "read",
        work: async (barrier) => {
          return await withOperationOwnership(
            barrier.release,
            async (owner) => {
              const reading = owner.start(
                chat.requestReadThreadMetadata(
                  fixture.actor,
                  fixture.threadId,
                  [200],
                ),
              );
              await waitForBarrierEntry(barrier.entered, reading);
              // The read holds no advisory lock, so closure is not blocked by
              // it. Making closure wait for a statement that creates nothing
              // bought no resurrection safety, and this read was admitted
              // before the decision existed, so serving it stays correct.
              const closing = startClosure(owner, {
                subjectKind: "user",
                subjectId: fixture.actor.userId,
              });
              const closed = valueOf(await closing.settled);
              await expect(barrier.blockedWaiterCount()).resolves.toBe(0);
              barrier.release();
              expect(valueOf(await reading.settled)).toMatchObject({
                status: 200,
              });
              return closed;
            },
          );
        },
      },
      context.signal,
    );

    await expectMetadata404(fixture);
  });

  it("serves a metadata read that starts before a closure commits, then denies after it", async () => {
    const fixture = await createMetadataFixture();
    await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
      await withOperationOwnership(barrier.release, async (owner) => {
        const closing = startClosure(owner, {
          subjectKind: "user",
          subjectId: fixture.actor.userId,
        });
        await waitForBarrierEntry(barrier.entered, closing);
        // Without the shared advisory lock the read never waits on the
        // uncommitted closure, and under READ COMMITTED it cannot observe an
        // uncommitted decision either, so it is served.
        const reading = owner.start(
          chat.requestReadThreadMetadata(
            fixture.actor,
            fixture.threadId,
            [200],
          ),
        );
        expect(valueOf(await reading.settled)).toMatchObject({ status: 200 });
        await expect(barrier.blockedWaiterCount()).resolves.toBe(0);
        barrier.release();
        valueOf(await closing.settled);
      });
    }, context.signal);

    await expectMetadata404(fixture);
  });

  it("runs concurrent same-thread metadata GETs without serializing them", async () => {
    const fixture = await createMetadataFixture();
    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        admission: "read",
        work: async (barrier) => {
          await withOperationOwnership(barrier.release, async (owner) => {
            const first = owner.start(
              chat.requestReadThreadMetadata(
                fixture.actor,
                fixture.threadId,
                [200],
              ),
            );
            await waitForBarrierEntry(barrier.entered, first);
            // #35311 had to take the thread row FOR UPDATE here to break a KEY
            // SHARE -> UPDATE upgrade cycle between two of these GETs. Neither
            // reader locks the row now, so the second one completes while the
            // first is still paused inside its own transaction.
            const second = owner.start(
              chat.requestReadThreadMetadata(
                fixture.actor,
                fixture.threadId,
                [200],
              ),
            );
            const secondResult = valueOf(await second.settled);
            await expect(barrier.blockedWaiterCount()).resolves.toBe(0);
            barrier.release();
            const firstResult = valueOf(await first.settled);
            expect(firstResult.body).toStrictEqual(secondResult.body);
          });
        },
      },
      context.signal,
    );
  });

  it(
    "completes a same-thread metadata GET while a rename holds the thread row",
    async () => {
      const fixture = await createMetadataFixture();
      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "commit",
          admission: "write",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const renaming = owner.start(
                chat.renameThread(
                  fixture.actor,
                  fixture.threadId,
                  "Writer won",
                ),
              );
              await waitForBarrierEntry(barrier.entered, renaming);
              // The rename retains `agents` KEY SHARE and the thread row
              // through COMMIT. The reader takes neither, so it is served the
              // pre-rename state instead of waiting behind the writer.
              const reading = owner.start(
                chat.requestReadThreadMetadata(
                  fixture.actor,
                  fixture.threadId,
                  [200],
                ),
              );
              expect(valueOf(await reading.settled)).toMatchObject({
                status: 200,
              });
              await expect(barrier.blockedWaiterCount()).resolves.toBe(0);
              barrier.release();
              valueOf(await renaming.settled);
            });
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
    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "admission",
        admission: "read",
        work: async (barrier) => {
          await withOperationOwnership(barrier.release, async (owner) => {
            const reading = owner.start(
              chat.requestReadThreadMetadata(
                fixture.actor,
                fixture.threadId,
                [404],
              ),
            );
            await waitForBarrierEntry(barrier.entered, reading);
            await setChatThreadUserFixture({
              chatThreadId: fixture.threadId,
              userId: `user_${randomUUID()}`,
            });
            barrier.release();
            expect(valueOf(await reading.settled)).toMatchObject({
              status: 404,
            });
          });
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

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "admission",
        admission: "read",
        work: async (barrier) => {
          await withOperationOwnership(barrier.release, async (owner) => {
            const reading = owner.start(
              chat.requestReadThreadMetadata(
                fixture.actor,
                fixture.threadId,
                [404],
              ),
            );
            await waitForBarrierEntry(barrier.entered, reading);
            // No product endpoint rebinds a thread's Agent. This focused fixture
            // mutates only that canonical FK so the real route must reselect it.
            await setChatThreadAgentFixture({
              chatThreadId: fixture.threadId,
              agentId: nextAgent.agentId,
            });
            barrier.release();
            expect(valueOf(await reading.settled)).toMatchObject({
              status: 404,
            });
          });
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
      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "admission",
          admission: "read",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const reading = owner.start(
                chat.requestReadThreadMetadata(
                  fixture.actor,
                  fixture.threadId,
                  [404],
                ),
              );
              await waitForBarrierEntry(barrier.entered, reading);
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
              expect(valueOf(await reading.settled)).toMatchObject({
                status: 404,
              });
            });
          },
        },
        context.signal,
      );
    },
  );

  it("does not block an Agent owner transfer while the read is in flight", async () => {
    const fixture = await createMetadataFixture();
    const nextOwner = `user_${randomUUID()}`;

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "commit",
        admission: "read",
        work: async (barrier) => {
          await withOperationOwnership(barrier.release, async (owner) => {
            const reading = owner.start(
              chat.requestReadThreadMetadata(
                fixture.actor,
                fixture.threadId,
                [200],
              ),
            );
            await waitForBarrierEntry(barrier.entered, reading);
            // The read no longer retains `agents` KEY SHARE, so a transfer is
            // not held behind it. The read is already past its own
            // revalidation here, which is its linearization point, so it
            // still reports the identity it was admitted for.
            const transferring = owner.start(
              transferAgentOwnerFixture({
                agentId: fixture.agentId,
                owner: nextOwner,
              }),
            );
            valueOf(await transferring.settled);
            await expect(barrier.blockedWaiterCount()).resolves.toBe(0);
            barrier.release();
            valueOf(await reading.settled);
          });
        },
      },
      context.signal,
    );

    await expect(
      chat.requestReadThreadMetadata(fixture.actor, fixture.threadId, [200]),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("does not block thread deletion, and returns missing once it commits", async () => {
    const fixture = await createMetadataFixture();
    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "admission",
        admission: "read",
        work: async (barrier) => {
          await withOperationOwnership(barrier.release, async (owner) => {
            const reading = owner.start(
              chat.requestReadThreadMetadata(
                fixture.actor,
                fixture.threadId,
                [404],
              ),
            );
            await waitForBarrierEntry(barrier.entered, reading);
            // Deletion takes the thread row FOR UPDATE. The paused read holds
            // no lock, so the delete commits immediately; the read's own
            // revalidation then finds the thread gone and reports missing
            // rather than projecting a deleted thread.
            const deleting = owner.start(
              chat.deleteThread(fixture.actor, fixture.threadId),
            );
            valueOf(await deleting.settled);
            await expect(barrier.blockedWaiterCount()).resolves.toBe(0);
            barrier.release();
            expect(valueOf(await reading.settled)).toMatchObject({
              status: 404,
            });
          });
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
      context.mocks.ably.publish.mockClear();

      await withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "metadata-read",
          admission: "read",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              owner.abortOnExit(controller);
              const reading = owner.start(
                chat.requestReadThreadMetadata(
                  fixture.actor,
                  fixture.threadId,
                  [200, 404],
                  controller.signal,
                ),
              );
              const entered = await waitForBarrierEntry(
                barrier.entered,
                reading,
              );
              expect(entered.rowCount).toBe(1);
              controller.abort(
                new DOMException("Operation ended", "AbortError"),
              );
              barrier.release();
              await reading.acceptFailureAfter((error) => {
                expect(error).toStrictEqual(
                  expect.objectContaining({
                    message: expect.stringMatching(
                      /Unknown response status 500/,
                    ),
                  }),
                );
              });
            });
          },
        },
        context.signal,
      );

      await expect(
        readStoredChatThreadMetadataFixture(fixture.threadId),
      ).resolves.toStrictEqual(stored);
      expect(context.mocks.ably.publish).not.toHaveBeenCalled();
      await expect(
        chat.requestReadThreadMetadata(fixture.actor, fixture.threadId, [200]),
      ).resolves.toMatchObject({ status: 200 });
    },
    CASE_TIMEOUT_MS,
  );

  it("propagates holder setup failures and is not blocked by a held thread row", async () => {
    const fixture = await createMetadataFixture();
    await expect(
      holdChatThreadRowLockFixture({
        threadId: randomUUID(),
        signal: context.signal,
      }),
    ).rejects.toThrow("Expected the chat thread row");
    await expect(
      chat.requestReadThreadMetadata(fixture.actor, fixture.threadId, [200]),
    ).resolves.toMatchObject({ status: 200 });

    const holder = await holdChatThreadRowLockFixture({
      threadId: fixture.threadId,
      signal: context.signal,
    });
    await withOperationOwnership(holder.release, async (owner) => {
      const holding = owner.start(holder.done);
      // This route used to wait for the thread row and surface the bounded
      // `lock_timeout` as a 500. It takes no row lock now, so a held row is
      // simply not its problem: it neither waits nor fabricates a 404.
      const reading = owner.start(
        chat.requestReadThreadMetadata(fixture.actor, fixture.threadId, [200]),
      );
      expect(valueOf(await reading.settled)).toMatchObject({ status: 200 });
      holder.release();
      valueOf(await holding.settled);
    });

    await expect(
      chat.requestReadThreadMetadata(fixture.actor, fixture.threadId, [200]),
    ).resolves.toMatchObject({ status: 200 });
  });

  it.each(["read-first", "closure-first"] as const)(
    "joins reader and closure, retires the exact job, and recovers after a $0 callback exit",
    async (order) => {
      const fixture = await createMetadataFixture();
      let earlyRead:
        | OwnedOperation<
            Awaited<ReturnType<typeof chat.requestReadThreadMetadata>>
          >
        | undefined;
      let earlyClosure: OwnedOperation<{ readonly jobId: string }> | undefined;

      if (order === "read-first") {
        await expect(
          withChatThreadContentBarrierFixture(
            {
              chatThreadId: fixture.threadId,
              stopAt: "commit",
              admission: "read",
              work: async (barrier) => {
                await withOperationOwnership(barrier.release, async (owner) => {
                  earlyRead = owner.start(
                    chat.requestReadThreadMetadata(
                      fixture.actor,
                      fixture.threadId,
                      [200],
                    ),
                  );
                  await waitForBarrierEntry(barrier.entered, earlyRead);
                  earlyClosure = startClosure(owner, {
                    subjectKind: "user",
                    subjectId: fixture.actor.userId,
                  });
                  // Closure is not held behind the lock-free read, so joining
                  // its settlement is what proves both operations are in
                  // flight before the deliberate exit.
                  valueOf(await earlyClosure.settled);
                  throw new Error("deliberate read-first callback exit");
                });
              },
            },
            context.signal,
          ),
        ).rejects.toThrow("deliberate read-first callback exit");
      } else {
        await expect(
          withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              earlyClosure = startClosure(owner, {
                subjectKind: "user",
                subjectId: fixture.actor.userId,
              });
              await waitForBarrierEntry(barrier.entered, earlyClosure);
              // The read neither waits for the uncommitted closure nor can
              // observe it under READ COMMITTED, so it settles on its own.
              earlyRead = owner.start(
                chat.requestReadThreadMetadata(
                  fixture.actor,
                  fixture.threadId,
                  [200],
                ),
              );
              valueOf(await earlyRead.settled);
              throw new Error("deliberate closure-first callback exit");
            });
          }, context.signal),
        ).rejects.toThrow("deliberate closure-first callback exit");
      }

      if (!earlyRead || !earlyClosure) {
        throw new Error("Expected both early-exit operations to start");
      }
      expect(valueOf(await earlyRead.settled)).toMatchObject({ status: 200 });
      const closed = valueOf(await earlyClosure.settled);
      await removeErasureSubjectsFixture([closed.jobId]);

      await expect(
        chat.requestReadThreadMetadata(fixture.actor, fixture.threadId, [200]),
      ).resolves.toMatchObject({ status: 200 });
    },
    CASE_TIMEOUT_MS,
  );

  it("reports an unaccepted non-abort request failure together with a callback failure", async () => {
    const fixture = await createMetadataFixture();
    let pending:
      | OwnedOperation<
          Awaited<ReturnType<typeof chat.requestReadThreadMetadata>>
        >
      | undefined;

    const combined = await settleIncludingAbort(
      withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "commit",
          admission: "read",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              pending = owner.start(
                chat.requestReadThreadMetadata(
                  fixture.actor,
                  fixture.threadId,
                  [200],
                ),
              );
              await waitForBarrierEntry(barrier.entered, pending);
              const rejected = owner.start(
                chat.requestReadThreadMetadata(null, fixture.threadId, [200]),
              );
              await rejected.settled;
              throw new Error("deliberate callback failure");
            });
          },
        },
        context.signal,
      ),
    );
    expect(combined.ok).toBeFalsy();
    if (combined.ok || !(combined.error instanceof AggregateError)) {
      throw new Error("Expected callback and operation failures to aggregate");
    }
    expect(combined.error.errors).toHaveLength(2);
    expect(combined.error.errors).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "deliberate callback failure" }),
        expect.objectContaining({
          message: expect.stringMatching(/received 401/),
        }),
      ]),
    );
    if (!pending) {
      throw new Error("Expected the contended metadata read to start");
    }
    expect(valueOf(await pending.settled)).toMatchObject({ status: 200 });
  });

  it("surfaces pre-entry and setup failures before a healthy metadata read", async () => {
    const fixture = await createMetadataFixture();

    await withChatThreadContentBarrierFixture(
      {
        chatThreadId: fixture.threadId,
        stopAt: "metadata-read",
        admission: "read",
        work: async (barrier) => {
          await withOperationOwnership(barrier.release, async (owner) => {
            const failedBeforeEntry = owner.start(
              chat.requestReadThreadMetadata(null, fixture.threadId, [200]),
            );
            const surfaced = await settleIncludingAbort(
              waitForBarrierEntry(barrier.entered, failedBeforeEntry),
            );
            expect(surfaced.ok).toBeFalsy();
            await failedBeforeEntry.acceptFailureAfter((error) => {
              expect(error).toStrictEqual(
                expect.objectContaining({
                  message: expect.stringMatching(/received 401/),
                }),
              );
            });
            expect(barrier.enteredYet()).toBeFalsy();

            const completedBeforeEntry = owner.start(
              chat.requestReadThreadMetadata(
                fixture.actor,
                randomUUID(),
                [404],
              ),
            );
            const missedEntry = await settleIncludingAbort(
              waitForBarrierEntry(barrier.entered, completedBeforeEntry),
            );
            expect(missedEntry.ok).toBeFalsy();
            if (missedEntry.ok) {
              throw new Error("Expected successful completion before entry");
            }
            expect(missedEntry.error).toStrictEqual(
              expect.objectContaining({
                message: "Metadata operation completed before barrier entry",
              }),
            );
            expect(valueOf(await completedBeforeEntry.settled)).toMatchObject({
              status: 404,
            });
            expect(barrier.enteredYet()).toBeFalsy();

            const recovery = owner.start(
              chat.requestReadThreadMetadata(
                fixture.actor,
                fixture.threadId,
                [200],
              ),
            );
            await waitForBarrierEntry(barrier.entered, recovery);
            barrier.release();
            expect(valueOf(await recovery.settled)).toMatchObject({
              status: 200,
            });
          });
        },
      },
      context.signal,
    );

    const rejectedSetup = new AbortController();
    rejectedSetup.abort(new DOMException("Rejected setup", "AbortError"));
    await expect(
      withChatThreadContentBarrierFixture(
        {
          chatThreadId: fixture.threadId,
          stopAt: "metadata-read",
          admission: "read",
          work: () => {
            return Promise.reject(new Error("setup must not enter work"));
          },
        },
        rejectedSetup.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

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
    // Admission is folded into the identity statement this route already
    // issues, so the open path costs six statements where it cost twelve, and
    // an open, missing or closed subject is decided without one advisory lock
    // or one extra round trip.
    expect(sqlShape(open.attempts)).toStrictEqual([
      [
        "BEGIN READ COMMITTED",
        ...erasureFenceStatementKinds("folded"),
        "CANONICAL IDENTITY BY THREAD PK",
        "FIXED METADATA PROJECTION BY THREAD PK",
        "CANONICAL IDENTITY BY THREAD PK",
        "COMMIT",
      ],
    ]);
    expect(sqlShape(missing.attempts)).toStrictEqual([
      [
        "BEGIN READ COMMITTED",
        ...erasureFenceStatementKinds("folded"),
        "CANONICAL IDENTITY BY THREAD PK",
        "COMMIT",
      ],
    ]);
    expect(sqlShape(closed.attempts)).toStrictEqual([
      [
        "BEGIN READ COMMITTED",
        ...erasureFenceStatementKinds("folded"),
        "CANONICAL IDENTITY BY THREAD PK",
        "COMMIT",
      ],
    ]);
    expect(
      open.attempts
        .flat()
        .concat(closed.attempts.flat())
        .some((statement) => {
          return statement.includes("pg_advisory_xact_lock");
        }),
    ).toBeFalsy();

    const openSql = open.attempts.flat().join("\n");
    expect(openSql).toContain('where "chat_threads"."id" =');
    expect(openSql).toContain('on "chat_threads"."agent_id" = "agents"."id"');
    expect(openSql).toContain('from "account_erasure_jobs"');
    expect(openSql).not.toContain("select *");
    // LIMIT 1/cardinality and primary-key predicates bound returned rows and
    // select only fixed columns. They do not claim a physical scan bound; that
    // remains PostgreSQL planner/index behavior rather than a suite-time proxy.
    expect(openSql.match(/limit/g)?.length).toBeGreaterThanOrEqual(3);

    const retryFixture = await createMetadataFixture();
    const retry = await withChatThreadMetadataRetrySqlControlFixture(
      {
        chatThreadId: retryFixture.threadId,
        work: async (barrier) => {
          return await withOperationOwnership(
            barrier.release,
            async (owner) => {
              const reading = owner.start(
                chat.requestReadThreadMetadata(
                  retryFixture.actor,
                  retryFixture.threadId,
                  [404],
                ),
              );
              await waitForBarrierEntry(barrier.entered, reading);
              await setChatThreadUserFixture({
                chatThreadId: retryFixture.threadId,
                userId: `user_${randomUUID()}`,
              });
              barrier.release();
              return {
                response: valueOf(await reading.settled),
                attempts: barrier.attempts().map((attempt) => {
                  return [...attempt];
                }),
              };
            },
          );
        },
      },
      context.signal,
    );
    expect(retry.response.status).toBe(404);
    expect(sqlShape(retry.attempts)).toStrictEqual([
      [
        "BEGIN READ COMMITTED",
        ...erasureFenceStatementKinds("folded"),
        "CANONICAL IDENTITY BY THREAD PK",
        "FIXED METADATA PROJECTION BY THREAD PK",
        "CANONICAL IDENTITY BY THREAD PK",
        "ROLLBACK",
      ],
      [
        "BEGIN READ COMMITTED",
        ...erasureFenceStatementKinds("folded"),
        "CANONICAL IDENTITY BY THREAD PK",
        "COMMIT",
      ],
    ]);

    await removeErasureSubjectsFixture([closedJob.jobId]);
  });
});
