import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import {
  COMPUTER_USE_FILESYSTEM_PLUGIN,
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUsePluginCapability,
  computerUsePluginToolCapability,
} from "@okouai/api-contracts/contracts/computer-use-plugins";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
  installComputerUseCommandInsertFaultFixture,
  withComputerUseCommandCreateBarrierFixture,
} from "../../../test-fixtures/computer-use-command-create-erasure";
import { holdOpenErasureSubjectLockFixture } from "../../../test-fixtures/computer-use-command-get-erasure";
import { settleIncludingAbort } from "../../utils";
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
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-19T01:00:00.000Z");
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
const CASE_TIMEOUT_MS = 30_000;
const PLUGIN_BODY = {
  plugin: "filesystem",
  tool: "read_text_file",
  arguments: { path: "/tmp/r21.txt" },
} as const;
const HOST_CAPABILITIES = [
  "apps.list",
  "app.open",
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUsePluginCapability(COMPUTER_USE_FILESYSTEM_PLUGIN),
  computerUsePluginToolCapability(
    COMPUTER_USE_FILESYSTEM_PLUGIN,
    "read_text_file",
  ),
] as const;

type CommandKind = "read" | "write" | "plugin";
type ComputerUseAuth = ApiTestUser | { readonly bearer: string } | null;
type CreationStatus = 200 | 400 | 401 | 403 | 404 | 409;
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

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (!actor.orgId) {
    throw new Error("Computer Use command creation requires an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

function valueOf<T>(settled: Settled<T>): T {
  if (!settled.ok) {
    throw settled.error;
  }
  return settled.value;
}

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
              "Expected the owned Computer Use creation operation to fail",
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
      "Concurrent Computer Use creation work and cleanup failed",
    );
  }
  if (!workResult.ok) {
    throw workResult.error;
  }
  return workResult.value;
}

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
    "Computer Use creation operation completed before barrier entry",
  );
}

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

async function enablePlugins(
  actor: ApiTestUser & { readonly orgId: string },
): Promise<void> {
  await updateFeatureSwitchesForUser(
    context,
    {
      userId: actor.userId,
      orgId: actor.orgId,
      orgRole: actor.orgRole,
    },
    { [FeatureSwitchKey.ComputerUseDesktopPlugins]: true },
  );
}

function agentAuth(args: {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly hostId?: string;
  readonly runId?: string;
  readonly capabilities?: readonly Capability[];
}): { readonly bearer: string; readonly runId: string } {
  mockClerkMembership(context, args.actor, "org:admin");
  const token = computerUseToken({
    userId: args.actor.userId,
    orgId: args.actor.orgId,
    capabilities: args.capabilities ?? ["computer-use:write"],
    ...(args.hostId ? { computerUseHostId: args.hostId } : {}),
    ...(args.runId ? { runId: args.runId } : {}),
  });
  return { bearer: token.token, runId: token.runId };
}

function requestCreate(
  kind: CommandKind,
  auth: ComputerUseAuth,
  statuses: readonly CreationStatus[],
  signal?: AbortSignal,
) {
  if (kind === "read") {
    return computerUse.requestCreateComputerUseReadCommand(
      auth,
      { kind: "apps.list", timeoutMs: 11_001 },
      statuses,
      signal,
    );
  }
  if (kind === "write") {
    return computerUse.requestCreateComputerUseWriteCommand(
      auth,
      statuses,
      { kind: "app.open", app: "Safari", timeoutMs: 12_002 },
      signal,
    );
  }
  return computerUse.requestCreateComputerUsePluginCommand(
    auth,
    { ...PLUGIN_BODY, timeoutMs: 13_003 },
    statuses,
    signal,
  );
}

async function createCommand(
  kind: CommandKind,
  auth: Exclude<ComputerUseAuth, null>,
  signal?: AbortSignal,
): Promise<{ readonly commandId: string; readonly status: "queued" }> {
  const response = await requestCreate(kind, auth, [200], signal);
  if (!("commandId" in response.body)) {
    throw new Error(`Expected ${kind} command creation response`);
  }
  return response.body;
}

async function startCapableHost(actor: ApiTestUser, name = "R21 Desktop") {
  return await computerUse.startComputerUseHost(actor, {
    hostName: name,
    supportedCapabilities: HOST_CAPABILITIES,
  });
}

function expectClosedCreation(response: {
  readonly status: number;
  readonly body: unknown;
}): void {
  expect(response.status).toBe(403);
  expectApiError(response.body);
  expect(response.body).toStrictEqual({
    error: {
      message: "Computer-use command creation is not available",
      code: "FORBIDDEN",
    },
  });
}

function clearExternalEffects(): void {
  context.mocks.ably.publish.mockClear();
  context.mocks.s3.send.mockClear();
}

function expectNoExternalEffects(): void {
  expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  expect(context.mocks.s3.send).not.toHaveBeenCalled();
}

async function claimAndComplete(args: {
  readonly hostToken: string;
  readonly commandId: string;
  readonly capabilities?: readonly string[];
}): Promise<void> {
  const claimed = await computerUse.claimNextComputerUseCommand(
    args.hostToken,
    args.capabilities ?? HOST_CAPABILITIES,
  );
  expect(claimed).toMatchObject({
    status: "command",
    command: { id: args.commandId, status: "running" },
  });
  await computerUse.completeComputerUseCommandWith(
    args.hostToken,
    args.commandId,
    {
      status: "failed",
      error: { code: "app_not_found", message: "R21 test completion" },
    },
  );
}

describe("Computer Use command creation account-erasure admission", () => {
  it(
    "preserves exact session, PAT and bound Agent creation semantics with public read/claim/audit evidence",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const sessionActor = orgScoped(bdd.user());
      const sessionHost = await startCapableHost(
        sessionActor,
        "Session Desktop",
      );
      clearExternalEffects();
      const sessionCreated = await createCommand("read", sessionActor);
      expect(sessionCreated).toStrictEqual({
        commandId: expect.any(String),
        status: "queued",
      });
      const sessionRead = await computerUse.readComputerUseCommand(
        sessionActor,
        sessionCreated.commandId,
      );
      expect(sessionRead).toMatchObject({
        id: sessionCreated.commandId,
        hostId: sessionHost.hostId,
        kind: "apps.list",
        status: "queued",
        timeoutMs: 11_001,
        payload: {},
      });
      expect(
        (
          await computerUse.listComputerUseAuditEvents(sessionActor, {
            commandId: sessionCreated.commandId,
          })
        ).auditEvents,
      ).toStrictEqual([]);
      expectNoExternalEffects();
      await claimAndComplete({
        hostToken: sessionHost.hostToken,
        commandId: sessionCreated.commandId,
      });

      const patActor = orgScoped(bdd.user());
      const patHost = await startCapableHost(patActor, "PAT Desktop");
      const { token: pat } = await authOrg.createCliToken(patActor);
      mockClerkMembership(context, patActor, "org:admin");
      const patCreated = await createCommand("write", { bearer: pat });
      const patClaimed = await computerUse.claimNextComputerUseCommand(
        patHost.hostToken,
        HOST_CAPABILITIES,
      );
      expect(patClaimed).toMatchObject({
        status: "command",
        command: {
          id: patCreated.commandId,
          hostId: patHost.hostId,
          kind: "app.open",
          timeoutMs: 12_002,
          payload: { app: "Safari" },
        },
      });
      await computerUse.completeComputerUseCommand(
        patHost.hostToken,
        patCreated.commandId,
      );
      const patAudit = await computerUse.listComputerUseAuditEvents(patActor, {
        commandId: patCreated.commandId,
      });
      expect(patAudit.auditEvents).toHaveLength(1);
      expect(patAudit.auditEvents[0]).toMatchObject({
        commandId: patCreated.commandId,
        runId: null,
      });

      const agentActor = orgScoped(bdd.user());
      await enablePlugins(agentActor);
      const agentHost = await startCapableHost(agentActor, "Agent Desktop");
      const agent = agentAuth({
        actor: agentActor,
        hostId: agentHost.hostId,
        runId: `run_${randomUUID()}`,
      });
      const agentCreated = await createCommand("plugin", {
        bearer: agent.bearer,
      });
      const agentClaimed = await computerUse.claimNextComputerUseCommand(
        agentHost.hostToken,
        HOST_CAPABILITIES,
      );
      expect(agentClaimed).toMatchObject({
        status: "command",
        command: {
          id: agentCreated.commandId,
          hostId: agentHost.hostId,
          kind: "plugin.call",
          timeoutMs: 13_003,
          payload: PLUGIN_BODY,
        },
      });
      await computerUse.completeComputerUseCommandWith(
        agentHost.hostToken,
        agentCreated.commandId,
        {
          status: "succeeded",
          result: {
            plugin: "filesystem",
            tool: "read_text_file",
            sizeBytes: 0,
          },
        },
      );
      const agentAudit = await computerUse.listComputerUseAuditEvents(
        agentActor,
        { commandId: agentCreated.commandId },
      );
      expect(agentAudit.auditEvents).toHaveLength(1);
      expect(agentAudit.auditEvents[0]).toMatchObject({
        commandId: agentCreated.commandId,
        hostId: agentHost.hostId,
        runId: agent.runId,
        kind: "plugin.call",
      });
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
    "returns one fixed 403 for all command kinds while the %s is closed and creates exactly one after restoration",
    { timeout: CASE_TIMEOUT_MS },
    async (subjectKind, subjectId) => {
      const actor = orgScoped(bdd.user());
      await enablePlugins(actor);
      const host = await startCapableHost(actor);
      const closed = await closeSubject({
        subjectKind,
        subjectId: subjectId(actor),
      });
      clearExternalEffects();

      for (const kind of ["read", "write", "plugin"] as const) {
        expectClosedCreation(await requestCreate(kind, actor, [403]));
      }
      await expect(
        computerUse.claimNextComputerUseCommand(
          host.hostToken,
          HOST_CAPABILITIES,
        ),
      ).resolves.toStrictEqual({ status: "idle" });
      expectNoExternalEffects();

      await removeErasureSubjectsFixture([closed.jobId]);
      for (const kind of ["read", "write", "plugin"] as const) {
        const created = await createCommand(kind, actor);
        await claimAndComplete({
          hostToken: host.hostToken,
          commandId: created.commandId,
        });
      }
    },
  );

  it(
    "keeps authentication, feature, bound-host and 404/409 eligibility precedence unchanged",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      expect((await requestCreate("read", null, [401])).status).toBe(401);

      const disabled = await requestCreate("plugin", actor, [403]);
      expectApiError(disabled.body);
      expect(disabled.body.error.message).toBe(
        "Computer Use Desktop plugins are disabled",
      );

      const unbound = agentAuth({ actor });
      const unboundResponse = await requestCreate(
        "read",
        { bearer: unbound.bearer },
        [403],
      );
      expectApiError(unboundResponse.body);
      expect(unboundResponse.body.error.message).toBe(
        "Computer-use host is not authorized for this run",
      );

      const noHost = await requestCreate("read", actor, [404]);
      expectApiError(noHost.body);
      expect(noHost.body.error.message).toBe(
        "No linked computer-use host found",
      );

      await computerUse.startComputerUseHost(actor, {
        hostName: "Unsupported Desktop",
        supportedCapabilities: ["apps.list"],
      });
      const unsupported = await requestCreate("write", actor, [409]);
      expectApiError(unsupported.body);
      expect(unsupported.body.error.message).toBe(
        "No online computer-use host supports this command",
      );

      await startCapableHost(actor, "Second Desktop");
      const ambiguous = await requestCreate("read", actor, [409]);
      expectApiError(ambiguous.body);
      expect(ambiguous.body.error.message).toBe(
        "Multiple active computer-use hosts are online",
      );

      mockNow(STARTED_AT_MS + 91_000);
      const offline = await requestCreate("read", actor, [409]);
      expectApiError(offline.body);
      expect(offline.body.error.message).toBe(
        "No online computer-use host found",
      );
    },
  );

  it.each(["writer-first", "closure-first"] as const)(
    "proves the real B1 $0 edge and observe/release/abort/join cleanup after an early callback exit",
    { timeout: CASE_TIMEOUT_MS },
    async (order) => {
      const actor = orgScoped(bdd.user());
      const unrelated = orgScoped(bdd.user());
      const host = await startCapableHost(actor);
      let earlyCreation:
        | OwnedOperation<Awaited<ReturnType<typeof requestCreate>>>
        | undefined;
      let earlyClosure: OwnedOperation<{ readonly jobId: string }> | undefined;

      if (order === "writer-first") {
        await expect(
          withComputerUseCommandCreateBarrierFixture(
            {
              orgId: actor.orgId,
              stopAt: "commit",
              work: async (barrier) => {
                await withOperationOwnership(barrier.release, async (owner) => {
                  earlyCreation = owner.start(
                    requestCreate("read", actor, [200]),
                  );
                  await waitForBarrierEntry(barrier.entered, earlyCreation);
                  earlyClosure = startClosure(owner, {
                    subjectKind: "user",
                    subjectId: actor.userId,
                  });
                  await expect
                    .poll(barrier.blockedWaiterCount, BLOCKED)
                    .toBeGreaterThanOrEqual(1);
                  expect(
                    (await requestCreate("read", unrelated, [404])).status,
                  ).toBe(404);
                  throw new Error("deliberate writer-first callback exit");
                });
              },
            },
            context.signal,
          ),
        ).rejects.toThrow("deliberate writer-first callback exit");
      } else {
        await expect(
          withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              earlyClosure = startClosure(owner, {
                subjectKind: "user",
                subjectId: actor.userId,
              });
              await waitForBarrierEntry(barrier.entered, earlyClosure);
              earlyCreation = owner.start(requestCreate("read", actor, [403]));
              await expect
                .poll(barrier.blockedWaiterCount, BLOCKED)
                .toBeGreaterThanOrEqual(1);
              expect(
                (await requestCreate("read", unrelated, [404])).status,
              ).toBe(404);
              throw new Error("deliberate closure-first callback exit");
            });
          }, context.signal),
        ).rejects.toThrow("deliberate closure-first callback exit");
      }

      if (!earlyCreation || !earlyClosure) {
        throw new Error("Expected both early-exit operations to start");
      }
      const creation = valueOf(await earlyCreation.settled);
      expect(creation.status).toBe(order === "writer-first" ? 200 : 403);
      const closed = valueOf(await earlyClosure.settled);
      await removeErasureSubjectsFixture([closed.jobId]);

      if (order === "writer-first") {
        if (!("commandId" in creation.body)) {
          throw new Error("Expected the writer-first command id");
        }
        await expect(
          computerUse.readComputerUseCommand(actor, creation.body.commandId),
        ).resolves.toMatchObject({
          id: creation.body.commandId,
          hostId: host.hostId,
          kind: "apps.list",
          payload: {},
          status: "queued",
          timeoutMs: 11_001,
        });
      } else {
        expectClosedCreation(creation);
        const recovered = await createCommand("read", actor);
        await expect(
          computerUse.readComputerUseCommand(actor, recovered.commandId),
        ).resolves.toMatchObject({
          id: recovered.commandId,
          status: "queued",
        });
      }
    },
  );

  it(
    "allows compatible same-owner creators while one INSERT RETURNING result is paused",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      await startCapableHost(actor);

      await withComputerUseCommandCreateBarrierFixture(
        {
          orgId: actor.orgId,
          stopAt: "insert",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const first = owner.start(requestCreate("read", actor, [200]));
              const entry = await waitForBarrierEntry(barrier.entered, first);
              expect(entry).toMatchObject({
                lockTimeout: "1s",
                statementTimeout: "5s",
                rowCount: 1,
              });
              const second = await requestCreate("read", actor, [200]);
              expect(second.status).toBe(200);
              if (!("commandId" in second.body)) {
                throw new Error("Expected the second command id");
              }
              await expect(barrier.blockedWaiterCount()).resolves.toBe(0);
              barrier.release();
              const firstResponse = valueOf(await first.settled);
              expect(firstResponse.status).toBe(200);
              if (!("commandId" in firstResponse.body)) {
                throw new Error("Expected the first command id");
              }
              expect(firstResponse.body.commandId).not.toBe(
                second.body.commandId,
              );
            });
          },
        },
        context.signal,
      );
    },
  );

  it(
    "samples host liveness only after a waited admission lock and leaves no stale-time command",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startCapableHost(actor);
      mockNow(STARTED_AT_MS + 89_000);
      const holder = await holdOpenErasureSubjectLockFixture({
        subject: { subjectKind: "user", subjectId: actor.userId },
        signal: context.signal,
      });

      await withOperationOwnership(holder.release, async (owner) => {
        const creating = owner.start(requestCreate("read", actor, [409]));
        await expect
          .poll(holder.blockedWaiterCount, BLOCKED)
          .toBeGreaterThanOrEqual(1);
        mockNow(STARTED_AT_MS + 91_000);
        await holder.release();
        const response = valueOf(await creating.settled);
        expectApiError(response.body);
        expect(response.body.error.message).toBe(
          "No online computer-use host found",
        );
      });

      await computerUse.heartbeatComputerUseHost(host.hostToken, {
        supportedCapabilities: HOST_CAPABILITIES,
      });
      await expect(
        computerUse.claimNextComputerUseCommand(
          host.hostToken,
          HOST_CAPABILITIES,
        ),
      ).resolves.toStrictEqual({ status: "idle" });
      const recovered = await createCommand("read", actor);
      await claimAndComplete({
        hostToken: host.hostToken,
        commandId: recovered.commandId,
      });
    },
  );

  it(
    "rolls back a late real PostgreSQL INSERT fault and recovers without publication or audit",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startCapableHost(actor);
      const fault = await installComputerUseCommandInsertFaultFixture({
        userId: actor.userId,
      });
      clearExternalEffects();

      await expect(createCommand("read", actor)).rejects.toThrow(
        "Unknown response status 500 for POST /api/computer-use/commands",
      );
      await expect(
        computerUse.claimNextComputerUseCommand(
          host.hostToken,
          HOST_CAPABILITIES,
        ),
      ).resolves.toStrictEqual({ status: "idle" });
      const audit = await computerUse.listComputerUseAuditEvents(actor, {
        limit: 100,
      });
      expect(audit.auditEvents).toStrictEqual([]);
      expectNoExternalEffects();

      await fault.restore();
      const recovered = await createCommand("read", actor);
      await claimAndComplete({
        hostToken: host.hostToken,
        commandId: recovered.commandId,
      });
    },
  );

  it(
    "rolls back when aborted after INSERT RETURNING but before the in-transaction final abort check",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startCapableHost(actor);

      await withComputerUseCommandCreateBarrierFixture(
        {
          orgId: actor.orgId,
          stopAt: "insert",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const controller = new AbortController();
              owner.abortOnExit(controller);
              const creating = owner.start(
                requestCreate("read", actor, [200], controller.signal),
              );
              const entry = await waitForBarrierEntry(
                barrier.entered,
                creating,
              );
              expect(entry.rowCount).toBe(1);
              controller.abort(
                new DOMException("post-row abort", "AbortError"),
              );
              barrier.release();
              await creating.acceptFailureAfter((error) => {
                expect(error).toBeInstanceOf(Error);
                expect(String(error)).toContain(
                  "Unknown response status 500 for POST /api/computer-use/commands",
                );
              });
            });
          },
        },
        context.signal,
      );

      await expect(
        computerUse.claimNextComputerUseCommand(
          host.hostToken,
          HOST_CAPABILITIES,
        ),
      ).resolves.toStrictEqual({ status: "idle" });
      const recovered = await createCommand("read", actor);
      await claimAndComplete({
        hostToken: host.hostToken,
        commandId: recovered.commandId,
      });
    },
  );

  it(
    "keeps a committed command when the outer abort fires at COMMIT but never returns a false success",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startCapableHost(actor);

      await withComputerUseCommandCreateBarrierFixture(
        {
          orgId: actor.orgId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const controller = new AbortController();
              owner.abortOnExit(controller);
              const creating = owner.start(
                requestCreate("read", actor, [200], controller.signal),
              );
              await waitForBarrierEntry(barrier.entered, creating);
              controller.abort(
                new DOMException("commit-boundary abort", "AbortError"),
              );
              barrier.release();
              await creating.acceptFailureAfter((error) => {
                expect(error).toBeInstanceOf(Error);
                expect(String(error)).toContain(
                  "Unknown response status 500 for POST /api/computer-use/commands",
                );
              });
            });
          },
        },
        context.signal,
      );

      const claimed = await computerUse.claimNextComputerUseCommand(
        host.hostToken,
        HOST_CAPABILITIES,
      );
      expect(claimed).toMatchObject({
        status: "command",
        command: { kind: "apps.list", status: "running" },
      });
    },
  );

  it(
    "aborts an actual admission wait, rolls back, joins the holder and recovers",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startCapableHost(actor);
      const holder = await holdOpenErasureSubjectLockFixture({
        subject: { subjectKind: "user", subjectId: actor.userId },
        signal: context.signal,
      });

      await withOperationOwnership(holder.release, async (owner) => {
        const controller = new AbortController();
        owner.abortOnExit(controller);
        const creating = owner.start(
          requestCreate("read", actor, [200], controller.signal),
        );
        await expect
          .poll(holder.blockedWaiterCount, BLOCKED)
          .toBeGreaterThanOrEqual(1);
        controller.abort(new DOMException("admission abort", "AbortError"));
        await holder.release();
        await creating.acceptFailureAfter((error) => {
          expect(String(error)).toContain(
            "Unknown response status 500 for POST /api/computer-use/commands",
          );
        });
      });

      await expect(
        computerUse.claimNextComputerUseCommand(
          host.hostToken,
          HOST_CAPABILITIES,
        ),
      ).resolves.toStrictEqual({ status: "idle" });
      const recovered = await createCommand("read", actor);
      await claimAndComplete({
        hostToken: host.hostToken,
        commandId: recovered.commandId,
      });
    },
  );

  it(
    "fails an admission lock wait at the real 1s local timeout without mapping it to closed",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      await startCapableHost(actor);
      let closing: OwnedOperation<{ readonly jobId: string }> | undefined;

      await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
        await withOperationOwnership(barrier.release, async (owner) => {
          closing = startClosure(owner, {
            subjectKind: "organization",
            subjectId: actor.orgId,
          });
          await waitForBarrierEntry(barrier.entered, closing);
          const creating = owner.start(requestCreate("read", actor, [200]));
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          await creating.acceptFailureAfter((error) => {
            expect(String(error)).toContain(
              "Unknown response status 500 for POST /api/computer-use/commands",
            );
          });
          barrier.release();
        });
      }, context.signal);

      if (!closing) {
        throw new Error("Expected the closure to start");
      }
      const closed = valueOf(await closing.settled);
      await removeErasureSubjectsFixture([closed.jobId]);
      expect((await requestCreate("read", actor, [200])).status).toBe(200);
    },
  );

  it(
    "rejects pre-entry auth, bound-host and pre-aborted exits, then reuses the deterministic gate for a valid creator",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startCapableHost(actor);
      const unbound = agentAuth({ actor });
      let validCommandId: string | undefined;

      await withComputerUseCommandCreateBarrierFixture(
        {
          orgId: actor.orgId,
          stopAt: "insert",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const preAbortedController = new AbortController();
              preAbortedController.abort(
                new DOMException("pre-entry abort", "AbortError"),
              );
              owner.abortOnExit(preAbortedController);

              const preAborted = owner.start(
                requestCreate(
                  "read",
                  actor,
                  [200],
                  preAbortedController.signal,
                ),
              );
              await preAborted.acceptFailureAfter((error) => {
                expect(String(error)).toContain(
                  "Unknown response status 500 for POST /api/computer-use/commands",
                );
              });
              expect(barrier.enteredYet()).toBeFalsy();
              expect(barrier.startedTransactionCount()).toBe(0);
              await expect(
                computerUse.claimNextComputerUseCommand(
                  host.hostToken,
                  HOST_CAPABILITIES,
                ),
              ).resolves.toStrictEqual({ status: "idle" });

              const unauthenticated = owner.start(
                requestCreate("read", null, [401]),
              );
              await expect(
                waitForBarrierEntry(barrier.entered, unauthenticated),
              ).rejects.toThrow(
                "Computer Use creation operation completed before barrier entry",
              );
              expect(valueOf(await unauthenticated.settled).status).toBe(401);

              const unboundAgent = owner.start(
                requestCreate("read", { bearer: unbound.bearer }, [403]),
              );
              await expect(
                waitForBarrierEntry(barrier.entered, unboundAgent),
              ).rejects.toThrow(
                "Computer Use creation operation completed before barrier entry",
              );
              expect(valueOf(await unboundAgent.settled).status).toBe(403);

              const valid = owner.start(requestCreate("read", actor, [200]));
              const entry = await waitForBarrierEntry(barrier.entered, valid);
              expect(entry.rowCount).toBe(1);
              barrier.release();
              const validResponse = valueOf(await valid.settled);
              expect(validResponse.status).toBe(200);
              if (!("commandId" in validResponse.body)) {
                throw new Error("Expected the valid retry command id");
              }
              validCommandId = validResponse.body.commandId;
            });
          },
        },
        context.signal,
      );

      if (!validCommandId) {
        throw new Error("Expected the valid retry to create one command");
      }
      const claimed = await computerUse.claimNextComputerUseCommand(
        host.hostToken,
        HOST_CAPABILITIES,
      );
      expect(claimed).toMatchObject({
        status: "command",
        command: { id: validCommandId, status: "running" },
      });
      await computerUse.completeComputerUseCommandWith(
        host.hostToken,
        validCommandId,
        {
          status: "failed",
          error: { code: "app_not_found", message: "R21 retry completion" },
        },
      );
      await expect(
        computerUse.claimNextComputerUseCommand(
          host.hostToken,
          HOST_CAPABILITIES,
        ),
      ).resolves.toStrictEqual({ status: "idle" });
    },
  );

  it(
    "executes one bounded READ COMMITTED transaction with a complete uncapped owner-wide host query",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      await Promise.all([
        startCapableHost(actor, "Owner Host A"),
        startCapableHost(actor, "Owner Host B"),
        startCapableHost(actor, "Owner Host C"),
      ]);

      await withComputerUseCommandCreateBarrierFixture(
        {
          orgId: actor.orgId,
          stopAt: "host_selection",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const creating = owner.start(requestCreate("read", actor, [409]));
              const entry = await waitForBarrierEntry(
                barrier.entered,
                creating,
              );
              expect(entry).toMatchObject({
                lockTimeout: "1s",
                statementTimeout: "5s",
                rowCount: 3,
              });
              const statements = barrier.statements();
              expect(statements).toHaveLength(7);
              const hostSelection = statements[6];
              expect(hostSelection).toContain('from "computer_use_hosts"');
              expect(hostSelection).toContain(
                '"computer_use_hosts"."org_id" =',
              );
              expect(hostSelection).toContain(
                '"computer_use_hosts"."user_id" =',
              );
              expect(hostSelection).toContain(
                '"computer_use_hosts"."revoked_at" is null',
              );
              expect(hostSelection).toContain(
                'order by "computer_use_hosts"."last_seen_at" desc',
              );
              expect(hostSelection).not.toContain(" limit ");
              expect(statements.join(" ")).not.toContain(" for update");
              barrier.release();
              const response = valueOf(await creating.settled);
              expectApiError(response.body);
              expect(response.body.error.message).toBe(
                "Multiple active computer-use hosts are online",
              );
            });
          },
        },
        context.signal,
      );
    },
  );

  it(
    "commits a created path in nine statements and a closed path before protected host projection in seven",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const openActor = orgScoped(bdd.user());
      await startCapableHost(openActor);
      await withComputerUseCommandCreateBarrierFixture(
        {
          orgId: openActor.orgId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const creating = owner.start(
                requestCreate("read", openActor, [200]),
              );
              const entry = await waitForBarrierEntry(
                barrier.entered,
                creating,
              );
              expect(entry).toMatchObject({
                lockTimeout: "1s",
                statementTimeout: "5s",
                rowCount: null,
              });
              expect(barrier.statements()).toHaveLength(9);
              expect(barrier.statements()[7]).toContain(
                'insert into "computer_use_commands"',
              );
              barrier.release();
              expect(valueOf(await creating.settled).status).toBe(200);
            });
          },
        },
        context.signal,
      );

      const closedActor = orgScoped(bdd.user());
      await startCapableHost(closedActor);
      const closed = await closeSubject({
        subjectKind: "user",
        subjectId: closedActor.userId,
      });
      await withComputerUseCommandCreateBarrierFixture(
        {
          orgId: closedActor.orgId,
          stopAt: "commit",
          path: "closed",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const creating = owner.start(
                requestCreate("read", closedActor, [403]),
              );
              await waitForBarrierEntry(barrier.entered, creating);
              expect(barrier.statements()).toHaveLength(7);
              expect(barrier.statements().join(" ")).not.toContain(
                "computer_use_hosts",
              );
              expect(barrier.statements().join(" ")).not.toContain(
                "computer_use_commands",
              );
              barrier.release();
              expectClosedCreation(valueOf(await creating.settled));
            });
          },
        },
        context.signal,
      );
      await removeErasureSubjectsFixture([closed.jobId]);
    },
  );
});
