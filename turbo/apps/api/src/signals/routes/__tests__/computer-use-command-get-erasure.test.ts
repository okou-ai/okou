import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { aroundEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  withErasureSubjectClosureCommitBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import {
  createNullableComputerUseCommandFixture,
  createRunningComputerUseCommandFixture,
  holdOpenErasureSubjectLockFixture,
  withComputerUseCommandGetBarrierFixture,
  withComputerUseCompletionLockBarrierFixture,
} from "../../../test-fixtures/computer-use-command-get-erasure";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  computerUseToken,
  createComputerUseBddApi,
} from "./helpers/api-bdd-computer-use";

const context = testContext();
const bdd = createBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-18T12:00:00.000Z");
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
const CASE_TIMEOUT_MS = 30_000;

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

interface RunningCommand {
  readonly commandId: string;
  readonly agentToken: string;
}

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (actor.orgId === null) {
    throw new Error("Computer Use command reads require an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

function valueOf<T>(settled: Settled<T>): T {
  if (!settled.ok) {
    throw settled.error;
  }
  return settled.value;
}

/**
 * Gives every concurrent operation one callback-local owner. Rejections are
 * observed as soon as work starts; every callback exit releases its selected
 * database statement, aborts only registered controllers, and joins all work.
 */
async function withOperationOwnership<T>(
  release: () => void | Promise<void>,
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
            throw new Error(
              "Expected the owned Computer Use operation to fail",
            );
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
  const cleanupResult = await settleIncludingAbort(async () => {
    const released = Promise.resolve(release());
    for (const controller of controllers) {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException("Test cleanup", "AbortError"));
      }
    }
    await released;
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
      "Concurrent Computer Use command test work and cleanup failed",
    );
  }
  if (!workResult.ok) {
    throw workResult.error;
  }
  return workResult.value;
}

/** Fails immediately if the operation terminates before its selected gate. */
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
  throw new Error(
    "Computer Use command operation completed before barrier entry",
  );
}

/** Registers exact-job cleanup before any later barrier assertion can fail. */
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

/** Projects one dormant closure and retires that exact test-owned job. */
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

function agentTokenFor(
  actor: ApiTestUser & { readonly orgId: string },
  hostId: string | undefined,
  capabilities: readonly Capability[] = ["computer-use:write"],
): string {
  mockClerkMembership(context, actor, "org:admin");
  return computerUseToken({
    userId: actor.userId,
    orgId: actor.orgId,
    capabilities,
    ...(hostId ? { computerUseHostId: hostId } : {}),
    // Command auth deliberately does not require a persisted Run or Agent.
    runId: `run_${randomUUID()}`,
  }).token;
}

async function createRunningWriteCommand(args: {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly host: { readonly hostId: string; readonly hostToken: string };
  readonly timeoutMs: number;
  readonly app?: string;
}): Promise<RunningCommand> {
  const agentToken = agentTokenFor(args.actor, args.host.hostId);
  const created = await computerUse.createComputerUseWriteCommand(
    { bearer: agentToken },
    {
      kind: "app.open",
      app: args.app ?? "Safari",
      timeoutMs: args.timeoutMs,
    },
  );
  const claimed = await computerUse.claimNextComputerUseCommand(
    args.host.hostToken,
  );
  expect(claimed).toMatchObject({
    status: "command",
    command: { id: created.commandId, status: "running" },
  });
  return { commandId: created.commandId, agentToken };
}

function clearExternalEffects(): void {
  context.mocks.ably.publish.mockClear();
  context.mocks.s3.send.mockClear();
}

function expectNoExternalEffects(): void {
  expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  expect(context.mocks.s3.send).not.toHaveBeenCalled();
}

async function captureSqlPath(args: {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly commandId: string;
  readonly status: 200 | 404;
}): Promise<{
  readonly response: Awaited<
    ReturnType<typeof computerUse.requestReadComputerUseCommand>
  >;
  readonly statements: readonly string[];
}> {
  return await withComputerUseCommandGetBarrierFixture(
    {
      orgId: args.actor.orgId,
      userId: args.actor.userId,
      commandId: args.commandId,
      stopAt: "commit",
      work: async (barrier) => {
        return await withOperationOwnership(barrier.release, async (owner) => {
          const reading = owner.start(
            computerUse.requestReadComputerUseCommand(
              args.actor,
              args.commandId,
              [args.status],
            ),
          );
          await waitForBarrierEntry(barrier.entered, reading);
          const statements = [...barrier.statements()];
          barrier.release();
          return {
            response: valueOf(await reading.settled),
            statements,
          };
        });
      },
    },
    context.signal,
  );
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
    statement.includes('from "computer_use_commands"') &&
    statement.includes("for update skip locked")
  ) {
    return "OWNER RUNNING SWEEP SKIP LOCKED";
  }
  if (statement.startsWith('update "computer_use_commands"')) {
    return "TIMEOUT UPDATE RETURNING";
  }
  if (statement.startsWith('insert into "computer_use_command_audit_events"')) {
    return "TIMEOUT AUDIT INSERT";
  }
  if (
    statement.includes('from "computer_use_commands"') &&
    statement.includes('left join "computer_use_hosts"')
  ) {
    return "EXACT COMMAND + HOST PROJECTION LIMIT 1";
  }
  return statement;
}

function sqlShape(statements: readonly string[]): readonly string[] {
  return statements.map(classifySql);
}

describe("GET /api/computer-use/commands/:commandId account-erasure fence", () => {
  it(
    "preserves session, PAT and supported Agent auth with exact owner and host isolation",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const sameOrgPeer = orgScoped(bdd.user({ orgId: actor.orgId }));
      const foreignOrg = orgScoped(bdd.user({ orgId: `org_${randomUUID()}` }));
      const host = await computerUse.startComputerUseHost(actor, {
        hostName: "Bound Desktop",
      });
      const otherHost = await computerUse.startComputerUseHost(actor, {
        hostName: "Wrong Desktop",
      });
      const token = agentTokenFor(actor, host.hostId);
      const created = await computerUse.createComputerUseWriteCommand(
        { bearer: token },
        { kind: "app.open", app: "Safari", timeoutMs: 15_000 },
      );

      const unauthenticated = await computerUse.requestReadComputerUseCommand(
        null,
        created.commandId,
        [401],
      );
      expectApiError(unauthenticated.body);
      const noOrganization = await computerUse.requestReadComputerUseCommand(
        bdd.user({ orgId: null }),
        created.commandId,
        [401],
      );
      expectApiError(noOrganization.body);

      const session = await computerUse.readComputerUseCommand(
        actor,
        created.commandId,
      );
      const { token: pat } = await authOrg.createCliToken(actor);
      mockClerkMembership(context, actor, "org:admin");
      await expect(
        computerUse.readComputerUseCommand({ bearer: pat }, created.commandId),
      ).resolves.toStrictEqual(session);
      await expect(
        computerUse.readComputerUseCommand(
          { bearer: token },
          created.commandId,
        ),
      ).resolves.toStrictEqual(session);

      const wrongHost = agentTokenFor(actor, otherHost.hostId);
      const wrongHostRead = await computerUse.requestReadComputerUseCommand(
        { bearer: wrongHost },
        created.commandId,
        [404],
      );
      expect(wrongHostRead.body).toStrictEqual({
        error: {
          message: "Computer-use command not found",
          code: "NOT_FOUND",
        },
      });
      const missingCapability = agentTokenFor(actor, host.hostId, []);
      const capabilityDenied = await computerUse.requestReadComputerUseCommand(
        { bearer: missingCapability },
        created.commandId,
        [403],
      );
      expectApiError(capabilityDenied.body);
      const unbound = agentTokenFor(actor, undefined);
      const bindingDenied = await computerUse.requestReadComputerUseCommand(
        { bearer: unbound },
        created.commandId,
        [403],
      );
      expect(bindingDenied.body).toStrictEqual({
        error: {
          message: "Computer-use host is not authorized for this run",
          code: "FORBIDDEN",
        },
      });

      for (const foreignActor of [sameOrgPeer, foreignOrg]) {
        const denied = await computerUse.requestReadComputerUseCommand(
          foreignActor,
          created.commandId,
          [404],
        );
        expect(denied.body).toStrictEqual({
          error: {
            message: "Computer-use command not found",
            code: "NOT_FOUND",
          },
        });
      }

      const nullable = await createNullableComputerUseCommandFixture({
        orgId: actor.orgId,
        userId: actor.userId,
        createdAt: new Date(STARTED_AT_MS),
      });
      const nullableResponse = await computerUse.readComputerUseCommand(
        actor,
        nullable.commandId,
      );
      expect(nullableResponse).toStrictEqual({
        id: nullable.commandId,
        kind: "apps.list",
        status: "queued",
        hostId: null,
        hostName: null,
        payload: { app: "Finder", text: "fixture 中文🙂" },
        timeoutMs: null,
        createdAt: new Date(STARTED_AT_MS).toISOString(),
        claimedAt: null,
        completedAt: null,
      });
      expect(Buffer.byteLength(JSON.stringify(nullableResponse), "utf8")).toBe(
        259,
      );
    },
  );

  it(
    "preserves queued, running, succeeded, failed and offloaded response fields",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const fake = computerUse.installComputerUseS3Fake();
      const actor = orgScoped(bdd.user());
      const host = await computerUse.startComputerUseHost(actor, {
        hostName: "Projection Desktop",
      });
      const created = await computerUse.createComputerUseReadCommand(actor, {
        kind: "app.state",
        app: "Safari",
        timeoutMs: 15_000,
      });

      const queued = await computerUse.readComputerUseCommand(
        actor,
        created.commandId,
      );
      expect(queued).toStrictEqual({
        id: created.commandId,
        kind: "app.state",
        status: "queued",
        hostId: host.hostId,
        hostName: "Projection Desktop",
        payload: { app: "Safari" },
        timeoutMs: 15_000,
        createdAt: new Date(STARTED_AT_MS).toISOString(),
        claimedAt: null,
        completedAt: null,
      });

      const claimed = await computerUse.claimNextComputerUseCommand(
        host.hostToken,
      );
      expect(claimed).toMatchObject({
        status: "command",
        command: {
          id: created.commandId,
          status: "running",
          claimedAt: new Date(STARTED_AT_MS).toISOString(),
        },
      });
      const running = await computerUse.readComputerUseCommand(
        actor,
        created.commandId,
      );
      expect(running).toMatchObject({
        status: "running",
        claimedAt: new Date(STARTED_AT_MS).toISOString(),
        completedAt: null,
      });

      const screenshot = Buffer.from("private screenshot bytes");
      await computerUse.completeComputerUseCommandWith(
        host.hostToken,
        created.commandId,
        {
          status: "succeeded",
          result: {
            snapshotId: "snapshot_projection",
            visibleText: "你好🙂",
            screenshot: `data:image/png;base64,${screenshot.toString("base64")}`,
            screenshotWidth: 1280,
            screenshotHeight: 720,
          },
        },
      );
      const succeeded = await computerUse.readComputerUseCommand(
        actor,
        created.commandId,
      );
      expect(succeeded).toMatchObject({
        status: "succeeded",
        result: {
          snapshotId: "snapshot_projection",
          visibleText: "你好🙂",
          screenshot: {
            type: "s3",
            mimeType: "image/png",
            sizeBytes: screenshot.length,
            width: 1280,
            height: 720,
          },
        },
        completedAt: new Date(STARTED_AT_MS).toISOString(),
      });
      expect(JSON.stringify(succeeded)).not.toContain(
        screenshot.toString("base64"),
      );
      expect(fake.puts).toHaveLength(1);

      const failedCommand = await computerUse.createComputerUseWriteCommand(
        actor,
        { kind: "app.open", app: "Finder", timeoutMs: 15_000 },
      );
      await computerUse.claimNextComputerUseCommand(host.hostToken);
      await computerUse.completeComputerUseCommandWith(
        host.hostToken,
        failedCommand.commandId,
        {
          status: "failed",
          error: {
            code: "app_not_found",
            message: "Finder is unavailable 中文🙂",
          },
        },
      );
      const failed = await computerUse.readComputerUseCommand(
        actor,
        failedCommand.commandId,
      );
      expect(failed).toMatchObject({
        id: failedCommand.commandId,
        status: "failed",
        error: {
          code: "app_not_found",
          message: "Finder is unavailable 中文🙂",
        },
      });
      expect(failed).not.toHaveProperty("result");
    },
  );

  it.each([
    [
      "user",
      (actor: ApiTestUser & { readonly orgId: string }) => {
        return actor.userId;
      },
    ],
    [
      "organization",
      (actor: ApiTestUser & { readonly orgId: string }) => {
        return actor.orgId;
      },
    ],
  ] as const)(
    "returns opaque 404 for a closed %s without timeout/audit/external effects and restores durable state",
    { timeout: CASE_TIMEOUT_MS },
    async (subjectKind, subjectId) => {
      const actor = orgScoped(bdd.user());
      const host = await computerUse.startComputerUseHost(actor, {
        hostName: "Closure Desktop",
      });
      const running = await createRunningWriteCommand({
        actor,
        host,
        timeoutMs: 1000,
      });
      mockNow(STARTED_AT_MS + 2000);
      const closed = await closeSubject({
        subjectKind,
        subjectId: subjectId(actor),
      });
      clearExternalEffects();

      const denied = await computerUse.requestReadComputerUseCommand(
        actor,
        randomUUID(),
        [404],
      );
      expect(denied.body).toStrictEqual({
        error: {
          message: "Computer-use command not found",
          code: "NOT_FOUND",
        },
      });
      expect(JSON.stringify(denied.body)).not.toContain(running.commandId);
      expectNoExternalEffects();

      await removeErasureSubjectsFixture([closed.jobId]);
      const auditBeforeCompletion =
        await computerUse.listComputerUseAuditEvents(actor, {
          commandId: running.commandId,
        });
      expect(auditBeforeCompletion.auditEvents).toStrictEqual([]);
      await computerUse.completeComputerUseCommand(
        host.hostToken,
        running.commandId,
      );
      const restored = await computerUse.readComputerUseCommand(
        actor,
        running.commandId,
      );
      expect(restored).toMatchObject({
        id: running.commandId,
        status: "succeeded",
      });
    },
  );

  it.each(["read-first", "closure-first"] as const)(
    "proves the real B1 edge, joins both branches and recovers after a $0 early callback exit",
    { timeout: CASE_TIMEOUT_MS },
    async (order) => {
      const actor = orgScoped(bdd.user());
      const unrelated = orgScoped(bdd.user());
      const command = await createNullableComputerUseCommandFixture({
        orgId: actor.orgId,
        userId: actor.userId,
        createdAt: new Date(STARTED_AT_MS),
      });
      let earlyRead:
        | OwnedOperation<
            Awaited<
              ReturnType<typeof computerUse.requestReadComputerUseCommand>
            >
          >
        | undefined;
      let earlyClosure: OwnedOperation<{ readonly jobId: string }> | undefined;

      if (order === "read-first") {
        await expect(
          withComputerUseCommandGetBarrierFixture(
            {
              orgId: actor.orgId,
              userId: actor.userId,
              commandId: command.commandId,
              stopAt: "commit",
              work: async (barrier) => {
                await withOperationOwnership(barrier.release, async (owner) => {
                  earlyRead = owner.start(
                    computerUse.requestReadComputerUseCommand(
                      actor,
                      command.commandId,
                      [200],
                    ),
                  );
                  await waitForBarrierEntry(barrier.entered, earlyRead);
                  earlyClosure = startClosure(owner, {
                    subjectKind: "user",
                    subjectId: actor.userId,
                  });
                  await expect
                    .poll(barrier.blockedWaiterCount, BLOCKED)
                    .toBeGreaterThanOrEqual(1);
                  await expect(
                    computerUse.requestReadComputerUseCommand(
                      unrelated,
                      randomUUID(),
                      [404],
                    ),
                  ).resolves.toMatchObject({ status: 404 });
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
                subjectId: actor.userId,
              });
              await waitForBarrierEntry(barrier.entered, earlyClosure);
              earlyRead = owner.start(
                computerUse.requestReadComputerUseCommand(
                  actor,
                  command.commandId,
                  [404],
                ),
              );
              await expect
                .poll(barrier.blockedWaiterCount, BLOCKED)
                .toBeGreaterThanOrEqual(1);
              await expect(
                computerUse.requestReadComputerUseCommand(
                  unrelated,
                  randomUUID(),
                  [404],
                ),
              ).resolves.toMatchObject({ status: 404 });
              throw new Error("deliberate closure-first callback exit");
            });
          }, context.signal),
        ).rejects.toThrow("deliberate closure-first callback exit");
      }

      if (!earlyRead || !earlyClosure) {
        throw new Error("Expected both early-exit operations to start");
      }
      expect(valueOf(await earlyRead.settled)).toMatchObject({
        status: order === "read-first" ? 200 : 404,
      });
      const closed = valueOf(await earlyClosure.settled);
      await removeErasureSubjectsFixture([closed.jobId]);
      await expect(
        computerUse.requestReadComputerUseCommand(
          actor,
          command.commandId,
          [200],
        ),
      ).resolves.toMatchObject({ status: 200 });
    },
  );

  it(
    "keeps same-owner GETs compatible while the first retains admission through COMMIT",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const command = await createNullableComputerUseCommandFixture({
        orgId: actor.orgId,
        userId: actor.userId,
        createdAt: new Date(STARTED_AT_MS),
      });

      await withComputerUseCommandGetBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId: command.commandId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const first = owner.start(
                computerUse.requestReadComputerUseCommand(
                  actor,
                  command.commandId,
                  [200],
                ),
              );
              await waitForBarrierEntry(barrier.entered, first);
              const second = owner.start(
                computerUse.requestReadComputerUseCommand(
                  actor,
                  command.commandId,
                  [200],
                ),
              );
              expect(valueOf(await second.settled)).toMatchObject({
                status: 200,
              });
              await expect.poll(barrier.blockedWaiterCount, BLOCKED).toBe(0);
              barrier.release();
              expect(valueOf(await first.settled)).toMatchObject({
                status: 200,
              });
            });
          },
        },
        context.signal,
      );
    },
  );

  it(
    "chooses the timeout clock after a real B1 wait crosses the strict boundary",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await computerUse.startComputerUseHost(actor, {
        hostName: "Clock Desktop",
      });
      const running = await createRunningWriteCommand({
        actor,
        host,
        timeoutMs: 1000,
      });
      mockNow(STARTED_AT_MS + 500);
      const holder = await holdOpenErasureSubjectLockFixture({
        subject: { subjectKind: "user", subjectId: actor.userId },
        signal: context.signal,
      });

      await withOperationOwnership(holder.release, async (owner) => {
        const reading = owner.start(
          computerUse.requestReadComputerUseCommand(
            actor,
            running.commandId,
            [200],
          ),
        );
        await expect
          .poll(holder.blockedWaiterCount, BLOCKED)
          .toBeGreaterThanOrEqual(1);
        mockNow(STARTED_AT_MS + 1001);
        await holder.release();
        const response = valueOf(await reading.settled);
        expect(response.body).toMatchObject({
          status: "failed",
          error: {
            code: "timeout",
            message: "Computer-use command timed out after 1000ms",
          },
          completedAt: new Date(STARTED_AT_MS + 1001).toISOString(),
        });
      });
    },
  );

  it(
    "keeps strict explicit/default timeout maintenance owner-wide across hosts and requested foreign ids",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const foreign = orgScoped(bdd.user());
      const explicitHost = await computerUse.startComputerUseHost(actor, {
        hostName: "Explicit Desktop",
      });
      const defaultHost = await computerUse.startComputerUseHost(actor, {
        hostName: "Default Desktop",
      });
      const foreignHost = await computerUse.startComputerUseHost(foreign, {
        hostName: "Foreign Desktop",
      });
      const explicit = await createRunningWriteCommand({
        actor,
        host: explicitHost,
        timeoutMs: 1000,
      });
      const defaultTimeout = await createRunningComputerUseCommandFixture({
        orgId: actor.orgId,
        userId: actor.userId,
        hostId: defaultHost.hostId,
        createdAt: new Date(STARTED_AT_MS),
        claimedAt: new Date(STARTED_AT_MS),
      });
      const foreignRunning = await createRunningWriteCommand({
        actor: foreign,
        host: foreignHost,
        timeoutMs: 1000,
      });

      mockNow(STARTED_AT_MS + 1000);
      await expect(
        computerUse.requestReadComputerUseCommand(
          actor,
          foreignRunning.commandId,
          [404],
        ),
      ).resolves.toMatchObject({ status: 404 });
      await expect(
        computerUse.readComputerUseCommand(actor, explicit.commandId),
      ).resolves.toMatchObject({ status: "running" });

      mockNow(STARTED_AT_MS + 1001);
      const wrongHostToken = agentTokenFor(actor, defaultHost.hostId);
      await computerUse.requestReadComputerUseCommand(
        { bearer: wrongHostToken },
        explicit.commandId,
        [404],
      );
      await expect(
        computerUse.readComputerUseCommand(actor, explicit.commandId),
      ).resolves.toMatchObject({
        status: "failed",
        error: { message: "Computer-use command timed out after 1000ms" },
      });
      await expect(
        computerUse.readComputerUseCommand(actor, defaultTimeout.commandId),
      ).resolves.toMatchObject({ status: "running", timeoutMs: null });
      await computerUse.completeComputerUseCommand(
        foreignHost.hostToken,
        foreignRunning.commandId,
      );

      mockNow(STARTED_AT_MS + 120_000);
      await expect(
        computerUse.readComputerUseCommand(actor, defaultTimeout.commandId),
      ).resolves.toMatchObject({ status: "running" });
      mockNow(STARTED_AT_MS + 120_001);
      await expect(
        computerUse.readComputerUseCommand(actor, defaultTimeout.commandId),
      ).resolves.toMatchObject({
        status: "failed",
        error: { message: "Computer-use command timed out after 120000ms" },
      });

      const audit = await computerUse.listComputerUseAuditEvents(actor);
      expect(
        new Set(
          audit.auditEvents.map((event) => {
            return event.commandId;
          }),
        ),
      ).toStrictEqual(new Set([explicit.commandId, defaultTimeout.commandId]));
      await expect(
        computerUse.readComputerUseCommand(foreign, foreignRunning.commandId),
      ).resolves.toMatchObject({ status: "succeeded" });
    },
  );

  it(
    "retains SKIP LOCKED and lets an existing completion win without narrowing the remaining owner sweep",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const lockedHost = await computerUse.startComputerUseHost(actor, {
        hostName: "Completion Desktop",
      });
      const sweepHost = await computerUse.startComputerUseHost(actor, {
        hostName: "Sweep Desktop",
      });
      const locked = await createRunningWriteCommand({
        actor,
        host: lockedHost,
        timeoutMs: 1000,
      });
      const swept = await createRunningWriteCommand({
        actor,
        host: sweepHost,
        timeoutMs: 1000,
      });
      mockNow(STARTED_AT_MS + 1500);

      await withComputerUseCompletionLockBarrierFixture(
        {
          commandId: locked.commandId,
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const completion = owner.start(
                computerUse.completeComputerUseCommand(
                  lockedHost.hostToken,
                  locked.commandId,
                ),
              );
              await waitForBarrierEntry(barrier.entered, completion);

              const missing = owner.start(
                computerUse.requestReadComputerUseCommand(
                  actor,
                  randomUUID(),
                  [404],
                ),
              );
              expect(valueOf(await missing.settled)).toMatchObject({
                status: 404,
              });
              const lockedRead = owner.start(
                computerUse.requestReadComputerUseCommand(
                  actor,
                  locked.commandId,
                  [200],
                ),
              );
              expect(valueOf(await lockedRead.settled).body).toMatchObject({
                status: "running",
              });
              await expect.poll(barrier.blockedWaiterCount, BLOCKED).toBe(0);
              await expect(
                computerUse.readComputerUseCommand(actor, swept.commandId),
              ).resolves.toMatchObject({ status: "failed" });

              barrier.release();
              valueOf(await completion.settled);
            });
          },
        },
        context.signal,
      );

      await expect(
        computerUse.readComputerUseCommand(actor, locked.commandId),
      ).resolves.toMatchObject({ status: "succeeded" });
      const audit = await computerUse.listComputerUseAuditEvents(actor, {
        commandId: swept.commandId,
      });
      expect(audit.auditEvents).toHaveLength(1);
      expect(audit.auditEvents[0]).toMatchObject({
        commandId: swept.commandId,
        error: {
          code: "timeout",
          message: "Computer-use command timed out after 1000ms",
        },
      });
    },
  );

  it(
    "rolls back timeout and audit mutations when abort arrives after projection but before the final check",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await computerUse.startComputerUseHost(actor, {
        hostName: "Rollback Desktop",
      });
      const running = await createRunningWriteCommand({
        actor,
        host,
        timeoutMs: 1000,
      });
      mockNow(STARTED_AT_MS + 1500);
      clearExternalEffects();

      await withComputerUseCommandGetBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId: running.commandId,
          stopAt: "projection",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const cancelled = new AbortController();
              owner.abortOnExit(cancelled);
              const reading = owner.start(
                computerUse.requestReadComputerUseCommand(
                  actor,
                  running.commandId,
                  [200],
                  cancelled.signal,
                ),
              );
              await waitForBarrierEntry(barrier.entered, reading);
              expect(sqlShape(barrier.statements())).toContain(
                "TIMEOUT AUDIT INSERT",
              );
              cancelled.abort(
                new DOMException("Operation ended", "AbortError"),
              );
              barrier.release();
              await reading.acceptFailureAfter((error) => {
                expect(error).toStrictEqual(
                  expect.objectContaining({
                    message: expect.stringMatching(/500|abort/i),
                  }),
                );
              });
            });
          },
        },
        context.signal,
      );

      const audit = await computerUse.listComputerUseAuditEvents(actor, {
        commandId: running.commandId,
      });
      expect(audit.auditEvents).toStrictEqual([]);
      expectNoExternalEffects();
      await computerUse.completeComputerUseCommand(
        host.hostToken,
        running.commandId,
      );
      await expect(
        computerUse.readComputerUseCommand(actor, running.commandId),
      ).resolves.toMatchObject({ status: "succeeded" });
    },
  );

  it(
    "documents the lost-response boundary when abort arrives after the final check at COMMIT",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await computerUse.startComputerUseHost(actor, {
        hostName: "Commit Desktop",
      });
      const running = await createRunningWriteCommand({
        actor,
        host,
        timeoutMs: 1000,
      });
      mockNow(STARTED_AT_MS + 1500);

      await withComputerUseCommandGetBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId: running.commandId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const cancelled = new AbortController();
              owner.abortOnExit(cancelled);
              const reading = owner.start(
                computerUse.requestReadComputerUseCommand(
                  actor,
                  running.commandId,
                  [200],
                  cancelled.signal,
                ),
              );
              await waitForBarrierEntry(barrier.entered, reading);
              expect(sqlShape(barrier.statements())).toContain(
                "TIMEOUT AUDIT INSERT",
              );
              cancelled.abort(
                new DOMException("Operation ended", "AbortError"),
              );
              barrier.release();
              await reading.acceptFailureAfter((error) => {
                expect(error).toStrictEqual(
                  expect.objectContaining({
                    message: expect.stringMatching(/500|abort/i),
                  }),
                );
              });
            });
          },
        },
        context.signal,
      );

      const durable = await computerUse.readComputerUseCommand(
        actor,
        running.commandId,
      );
      expect(durable).toMatchObject({ status: "failed" });
      const audit = await computerUse.listComputerUseAuditEvents(actor, {
        commandId: running.commandId,
      });
      expect(audit.auditEvents).toHaveLength(1);
    },
  );

  it(
    "propagates a real admission lock timeout instead of fabricating 404 and then recovers",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const command = await createNullableComputerUseCommandFixture({
        orgId: actor.orgId,
        userId: actor.userId,
        createdAt: new Date(STARTED_AT_MS),
      });
      let closure: OwnedOperation<{ readonly jobId: string }> | undefined;

      await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
        await withOperationOwnership(barrier.release, async (owner) => {
          closure = startClosure(owner, {
            subjectKind: "user",
            subjectId: actor.userId,
          });
          await waitForBarrierEntry(barrier.entered, closure);
          const reading = owner.start(
            computerUse.requestReadComputerUseCommand(
              actor,
              command.commandId,
              [200],
            ),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          await reading.acceptFailureAfter((error) => {
            expect(error).toStrictEqual(
              expect.objectContaining({
                message: expect.stringMatching(/500/),
              }),
            );
          });
          barrier.release();
        });
      }, context.signal);

      if (!closure) {
        throw new Error("Expected the timed-out closure operation");
      }
      const closed = valueOf(await closure.settled);
      await removeErasureSubjectsFixture([closed.jobId]);
      await expect(
        computerUse.readComputerUseCommand(actor, command.commandId),
      ).resolves.toMatchObject({ status: "queued" });
    },
  );

  it(
    "surfaces pre-entry and setup failures without hanging or suppressing errors",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const command = await createNullableComputerUseCommandFixture({
        orgId: actor.orgId,
        userId: actor.userId,
        createdAt: new Date(STARTED_AT_MS),
      });

      await withComputerUseCommandGetBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId: command.commandId,
          stopAt: "projection",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const failedBeforeEntry = owner.start(
                computerUse.requestReadComputerUseCommand(
                  null,
                  command.commandId,
                  [200],
                ),
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

              const unbound = agentTokenFor(actor, undefined);
              const completedBeforeEntry = owner.start(
                computerUse.requestReadComputerUseCommand(
                  { bearer: unbound },
                  command.commandId,
                  [403],
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
                  message:
                    "Computer Use command operation completed before barrier entry",
                }),
              );
              expect(valueOf(await completedBeforeEntry.settled)).toMatchObject(
                {
                  status: 403,
                },
              );
              expect(barrier.enteredYet()).toBeFalsy();

              const preCancelled = new AbortController();
              preCancelled.abort(
                new DOMException("Cancelled before GET", "AbortError"),
              );
              const cancelledBeforeEntry = owner.start(
                computerUse.requestReadComputerUseCommand(
                  actor,
                  command.commandId,
                  [200],
                  preCancelled.signal,
                ),
              );
              const cancellationSurfaced = await settleIncludingAbort(
                waitForBarrierEntry(barrier.entered, cancelledBeforeEntry),
              );
              expect(cancellationSurfaced.ok).toBeFalsy();
              await cancelledBeforeEntry.acceptFailureAfter((error) => {
                expect(error).toStrictEqual(
                  expect.objectContaining({
                    message: expect.stringMatching(/500|abort|cancel/i),
                  }),
                );
              });
              expect(barrier.enteredYet()).toBeFalsy();

              const recovery = owner.start(
                computerUse.requestReadComputerUseCommand(
                  actor,
                  command.commandId,
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
        withComputerUseCommandGetBarrierFixture(
          {
            orgId: actor.orgId,
            userId: actor.userId,
            commandId: command.commandId,
            stopAt: "projection",
            work: () => {
              return Promise.reject(new Error("setup must not enter work"));
            },
          },
          rejectedSetup.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(
        computerUse.readComputerUseCommand(actor, command.commandId),
      ).resolves.toMatchObject({ status: "queued" });
    },
  );

  it(
    "owns B1 holder pre-abort, pending readiness, transaction failure and recovery",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const command = await createNullableComputerUseCommandFixture({
        orgId: actor.orgId,
        userId: actor.userId,
        createdAt: new Date(STARTED_AT_MS),
      });
      const subject = {
        subjectKind: "user" as const,
        subjectId: actor.userId,
      };

      const preAbortReason = new DOMException(
        "Cancelled before holder setup",
        "AbortError",
      );
      const preAborted = new AbortController();
      preAborted.abort(preAbortReason);
      await expect(
        holdOpenErasureSubjectLockFixture({
          subject,
          signal: preAborted.signal,
          beforeReady: () => {
            throw new Error("Pre-aborted holder started database work");
          },
        }),
      ).rejects.toBe(preAbortReason);

      const startupFailure = new Error("Controlled holder startup failure");
      let failedHolderPid: number | undefined;
      await expect(
        holdOpenErasureSubjectLockFixture({
          subject,
          signal: context.signal,
          beforeReady: (holderPid) => {
            failedHolderPid = holderPid;
            throw startupFailure;
          },
        }),
      ).rejects.toBe(startupFailure);
      expect(failedHolderPid).toStrictEqual(expect.any(Number));

      const readinessEntered = createDeferredPromise<number>(context.signal);
      const finishReadiness = createDeferredPromise<void>(context.signal);
      const cancelled = new AbortController();
      const cancellationReason = new DOMException(
        "Cancelled during holder readiness",
        "AbortError",
      );
      const transactionFailure = new Error(
        "Controlled failure after readiness cancellation",
      );

      await withOperationOwnership(
        () => {
          if (!finishReadiness.settled()) {
            finishReadiness.resolve(undefined);
          }
        },
        async (owner) => {
          owner.abortOnExit(cancelled);
          const setup = owner.start(
            holdOpenErasureSubjectLockFixture({
              subject,
              signal: cancelled.signal,
              beforeReady: async (holderPid) => {
                readinessEntered.resolve(holderPid);
                await finishReadiness.promise;
                throw transactionFailure;
              },
            }),
          );
          await expect(readinessEntered.promise).resolves.toStrictEqual(
            expect.any(Number),
          );
          cancelled.abort(cancellationReason);
          expect(finishReadiness.settled()).toBeFalsy();
          finishReadiness.resolve(undefined);
          await setup.acceptFailureAfter((error) => {
            expect(error).toBeInstanceOf(AggregateError);
            if (!(error instanceof AggregateError)) {
              throw new Error("Expected distinct holder setup failures");
            }
            expect(error.errors).toStrictEqual([
              cancellationReason,
              transactionFailure,
            ]);
          });
        },
      );

      const holder = await holdOpenErasureSubjectLockFixture({
        subject,
        signal: context.signal,
      });
      await withOperationOwnership(holder.release, async (owner) => {
        const reading = owner.start(
          computerUse.requestReadComputerUseCommand(
            actor,
            command.commandId,
            [200],
          ),
        );
        await expect
          .poll(holder.blockedWaiterCount, BLOCKED)
          .toBeGreaterThanOrEqual(1);
        await holder.release();
        expect(valueOf(await reading.settled)).toMatchObject({ status: 200 });
      });
    },
  );

  it(
    "pins open, missing, closed and variable-maintenance SQL/control sequences",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await computerUse.startComputerUseHost(actor, {
        hostName: "SQL Desktop",
      });
      const created = await computerUse.createComputerUseWriteCommand(
        { bearer: agentTokenFor(actor, host.hostId) },
        { kind: "app.open", app: "Safari", timeoutMs: 1000 },
      );
      const open = await captureSqlPath({
        actor,
        commandId: created.commandId,
        status: 200,
      });
      const missing = await captureSqlPath({
        actor,
        commandId: randomUUID(),
        status: 404,
      });
      const closedJob = await closeSubject({
        subjectKind: "organization",
        subjectId: actor.orgId,
      });
      const closed = await captureSqlPath({
        actor,
        commandId: created.commandId,
        status: 404,
      });
      await removeErasureSubjectsFixture([closedJob.jobId]);

      const claimed = await computerUse.claimNextComputerUseCommand(
        host.hostToken,
      );
      expect(claimed).toMatchObject({
        status: "command",
        command: { id: created.commandId, status: "running" },
      });
      mockNow(STARTED_AT_MS + 1001);
      const maintained = await captureSqlPath({
        actor,
        commandId: created.commandId,
        status: 200,
      });

      const variableHost = await computerUse.startComputerUseHost(actor, {
        hostName: "Variable SQL Desktop",
      });
      const variableCommands = [
        await computerUse.createComputerUseWriteCommand(
          { bearer: agentTokenFor(actor, host.hostId) },
          { kind: "app.open", app: "Finder", timeoutMs: 1000 },
        ),
        await computerUse.createComputerUseWriteCommand(
          { bearer: agentTokenFor(actor, variableHost.hostId) },
          { kind: "app.open", app: "Notes", timeoutMs: 1000 },
        ),
      ] as const;
      const variableClaims = [
        await computerUse.claimNextComputerUseCommand(host.hostToken),
        await computerUse.claimNextComputerUseCommand(variableHost.hostToken),
      ] as const;
      const variableClaimIds = new Set(
        variableClaims.map((claim) => {
          if (claim.status !== "command") {
            throw new Error("Expected a variable-maintenance command claim");
          }
          return claim.command.id;
        }),
      );
      expect(variableClaimIds).toStrictEqual(
        new Set(
          variableCommands.map((command) => {
            return command.commandId;
          }),
        ),
      );
      mockNow(STARTED_AT_MS + 2002);
      const variableMaintenance = await captureSqlPath({
        actor,
        commandId: variableCommands[0].commandId,
        status: 200,
      });

      expect(open.response.status).toBe(200);
      expect(missing.response.status).toBe(404);
      expect(closed.response.status).toBe(404);
      expect(maintained.response.body).toMatchObject({ status: "failed" });
      expect(variableMaintenance.response.body).toMatchObject({
        status: "failed",
      });
      expect(sqlShape(open.statements)).toStrictEqual([
        "BEGIN READ COMMITTED",
        "LOCK TIMEOUT",
        "STATEMENT TIMEOUT",
        "B1 ISOLATION + FIRST SHARED LOCK",
        "B1 SHARED LOCK",
        "B1 CLOSED LOOKUP",
        "OWNER RUNNING SWEEP SKIP LOCKED",
        "EXACT COMMAND + HOST PROJECTION LIMIT 1",
        "COMMIT",
      ]);
      expect(sqlShape(missing.statements)).toStrictEqual(
        sqlShape(open.statements),
      );
      expect(sqlShape(closed.statements)).toStrictEqual([
        "BEGIN READ COMMITTED",
        "LOCK TIMEOUT",
        "STATEMENT TIMEOUT",
        "B1 ISOLATION + FIRST SHARED LOCK",
        "B1 SHARED LOCK",
        "B1 CLOSED LOOKUP",
        "COMMIT",
      ]);
      expect(sqlShape(maintained.statements)).toStrictEqual([
        "BEGIN READ COMMITTED",
        "LOCK TIMEOUT",
        "STATEMENT TIMEOUT",
        "B1 ISOLATION + FIRST SHARED LOCK",
        "B1 SHARED LOCK",
        "B1 CLOSED LOOKUP",
        "OWNER RUNNING SWEEP SKIP LOCKED",
        "TIMEOUT UPDATE RETURNING",
        "TIMEOUT AUDIT INSERT",
        "EXACT COMMAND + HOST PROJECTION LIMIT 1",
        "COMMIT",
      ]);
      expect(sqlShape(variableMaintenance.statements)).toStrictEqual([
        "BEGIN READ COMMITTED",
        "LOCK TIMEOUT",
        "STATEMENT TIMEOUT",
        "B1 ISOLATION + FIRST SHARED LOCK",
        "B1 SHARED LOCK",
        "B1 CLOSED LOOKUP",
        "OWNER RUNNING SWEEP SKIP LOCKED",
        "TIMEOUT UPDATE RETURNING",
        "TIMEOUT AUDIT INSERT",
        "TIMEOUT UPDATE RETURNING",
        "TIMEOUT AUDIT INSERT",
        "EXACT COMMAND + HOST PROJECTION LIMIT 1",
        "COMMIT",
      ]);

      const maintenanceSql = maintained.statements.find((statement) => {
        return classifySql(statement) === "OWNER RUNNING SWEEP SKIP LOCKED";
      });
      const projectionSql = maintained.statements.find((statement) => {
        return (
          classifySql(statement) === "EXACT COMMAND + HOST PROJECTION LIMIT 1"
        );
      });
      expect(maintenanceSql).toContain('"computer_use_commands"."org_id" =');
      expect(maintenanceSql).toContain('"computer_use_commands"."user_id" =');
      expect(maintenanceSql).toContain('"computer_use_commands"."status" =');
      expect(maintenanceSql).not.toContain(" limit ");
      expect(projectionSql).toContain('"computer_use_commands"."id" =');
      expect(projectionSql).toContain('left join "computer_use_hosts"');
      expect(projectionSql).toContain(" limit ");
    },
  );
});
