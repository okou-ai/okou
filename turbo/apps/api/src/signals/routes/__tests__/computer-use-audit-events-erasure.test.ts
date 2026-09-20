import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import type {
  ComputerUseCommandError,
  ComputerUseCommandResult,
} from "@okouai/api-contracts/contracts/computer-use";
import {
  COMPUTER_USE_FILESYSTEM_PLUGIN,
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUsePluginCapability,
  computerUsePluginToolCapability,
} from "@okouai/api-contracts/contracts/computer-use-plugins";
import { aroundEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { generateSandboxToken } from "../../auth/tokens";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  withErasureSubjectClosureCommitBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { withComputerUseAuditEventsBarrierFixture } from "../../../test-fixtures/computer-use-audit-events-erasure";
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

const STARTED_AT_MS = Date.parse("2026-09-18T13:00:00.000Z");
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
const CASE_TIMEOUT_MS = 30_000;

type Settled<T> = Awaited<ReturnType<typeof settleIncludingAbort<T>>>;

interface OwnedOperation<T> {
  readonly settled: Promise<Settled<T>>;
  readonly acceptFailure: () => void;
}

interface OperationOwner {
  readonly start: <T>(operation: Promise<T>) => OwnedOperation<T>;
  readonly abortOnExit: (controller: AbortController) => void;
}

interface OperationRecord {
  readonly settled: Promise<Settled<unknown>>;
  failureAccepted: boolean;
}

/**
 * Gives every concurrent test operation one local owner. Cleanup releases the
 * selected PostgreSQL statement, aborts owned controllers and joins every
 * started operation before propagating callback or operation failures.
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
      const record: OperationRecord = {
        settled,
        failureAccepted: false,
      };
      operations.push(record);
      return {
        settled,
        acceptFailure: () => {
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
    if (!result.ok && !record.failureAccepted) {
      errors.push(result.error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Concurrent audit-event test work and cleanup failed",
    );
  }
  if (!workResult.ok) {
    throw workResult.error;
  }
  return workResult.value;
}

/** Fails immediately when the operation terminates before its expected gate. */
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
    operation.acceptFailure();
    throw first.result.error;
  }
  throw new Error("Audit-event operation completed before barrier entry");
}

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (actor.orgId === null) {
    throw new Error("Computer Use audit events require an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

function valueOf<T>(settled: Settled<T>): T {
  if (!settled.ok) {
    throw settled.error;
  }
  return settled.value;
}

/** Projects one dormant B1 closure and retires exactly that test-owned job. */
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

function clearPublications(): void {
  context.mocks.ably.publish.mockClear();
}

function expectNoPublications(): void {
  expect(context.mocks.ably.publish).not.toHaveBeenCalled();
}

async function startAuditHost(actor: ApiTestUser, hostName: string) {
  return await computerUse.startComputerUseHost(actor, {
    installationId: randomUUID(),
    hostName,
    supportedCapabilities: [
      "apps.list",
      "app.state",
      "app.open",
      "element.click",
      COMPUTER_USE_PLUGIN_CALL_KIND,
      computerUsePluginCapability(COMPUTER_USE_FILESYSTEM_PLUGIN),
      computerUsePluginToolCapability(
        COMPUTER_USE_FILESYSTEM_PLUGIN,
        "read_text_file",
      ),
    ],
    permissions: { accessibility: true, screenRecording: true },
  });
}

async function claimAndComplete(
  hostToken: string,
  commandId: string,
  body:
    | {
        readonly status: "succeeded";
        readonly result: ComputerUseCommandResult;
      }
    | {
        readonly status: "failed";
        readonly error: ComputerUseCommandError;
      },
  supportedCapabilities?: readonly string[],
): Promise<void> {
  const claimed = await computerUse.claimNextComputerUseCommand(
    hostToken,
    supportedCapabilities,
  );
  expect(claimed.status).toBe("command");
  if (claimed.status !== "command") {
    throw new Error("Expected the audit fixture command to be claimed");
  }
  expect(claimed.command.id).toBe(commandId);
  await computerUse.completeComputerUseCommandWith(hostToken, commandId, body);
}

async function createSimpleAuditEvent(actor: ApiTestUser, label: string) {
  const host = await startAuditHost(actor, `${label} Desktop`);
  const created = await computerUse.createComputerUseWriteCommand(actor, {
    kind: "app.open",
    app: label,
  });
  await claimAndComplete(host.hostToken, created.commandId, {
    status: "succeeded",
    result: { app: label, opened: true },
  });
  return { host, commandId: created.commandId };
}

async function enableComputerUseDesktopPlugins(
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

const PLUGIN_CAPABILITIES = [
  COMPUTER_USE_PLUGIN_CALL_KIND,
  computerUsePluginCapability(COMPUTER_USE_FILESYSTEM_PLUGIN),
  computerUsePluginToolCapability(
    COMPUTER_USE_FILESYSTEM_PLUGIN,
    "read_text_file",
  ),
] as const;

describe("Computer Use audit-event account-erasure fence", () => {
  it(
    "preserves session, Clerk OAuth session, PAT, organization and sandbox-token auth controls",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const { host, commandId } = await createSimpleAuditEvent(actor, "Auth");

      const unauthenticated =
        await computerUse.requestListComputerUseAuditEvents(null, {}, [401]);
      expectApiError(unauthenticated.body);

      const noOrganization = bdd.user({ orgId: null });
      const missingOrganization =
        await computerUse.requestListComputerUseAuditEvents(
          noOrganization,
          {},
          [401],
        );
      expectApiError(missingOrganization.body);

      const session = await computerUse.listComputerUseAuditEvents(actor);
      expect(
        session.auditEvents.map((event) => {
          return event.commandId;
        }),
      ).toStrictEqual([commandId]);

      // Clerk OAuth-backed browser sessions reach this route through the same
      // externally authenticated Clerk request boundary as cookie sessions.
      const oauthSession = await computerUse.listComputerUseAuditEvents({
        bearer: "clerk-oauth-session",
      });
      expect(oauthSession).toStrictEqual(session);

      const { token: pat } = await authOrg.createCliToken(actor);
      mockClerkMembership(context, actor, "org:admin");
      const personalAccessToken = await computerUse.listComputerUseAuditEvents({
        bearer: pat,
      });
      expect(personalAccessToken).toStrictEqual(session);

      const agent = computerUseToken({
        userId: actor.userId,
        orgId: actor.orgId,
        capabilities: ["computer-use:write"],
        computerUseHostId: host.hostId,
      });
      const agentDenied = await computerUse.requestListComputerUseAuditEvents(
        { bearer: agent.token },
        {},
        [403],
      );
      expect(agentDenied.body).toStrictEqual({
        error: {
          message: "This endpoint is not available for sandbox tokens",
          code: "FORBIDDEN",
        },
      });

      const sandbox = generateSandboxToken(
        actor.userId,
        randomUUID(),
        actor.orgId,
      );
      const sandboxDenied = await computerUse.requestListComputerUseAuditEvents(
        { bearer: sandbox },
        {},
        [403],
      );
      expect(sandboxDenied.body).toStrictEqual(agentDenied.body);
    },
  );

  it(
    "preserves exact owner isolation, every selector, nulls and complete redacted payloads",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const peer = orgScoped(bdd.user({ orgId: actor.orgId }));
      const foreign = orgScoped(bdd.user({ orgId: `org_${randomUUID()}` }));
      await enableComputerUseDesktopPlugins(actor);
      const s3 = computerUse.installComputerUseS3Fake();
      const host = await startAuditHost(actor, "Payload Desktop");
      mockClerkMembership(context, actor, "org:admin");
      const granted = computerUseToken({
        userId: actor.userId,
        orgId: actor.orgId,
        capabilities: ["computer-use:write"],
        computerUseHostId: host.hostId,
      });

      const succeeded = await computerUse.createComputerUseWriteCommand(
        { bearer: granted.token },
        {
          kind: "element.click",
          app: "Safari",
          snapshotId: "snap_audit",
          elementIndex: 7,
          button: "left",
          clickCount: 1,
        },
      );
      await claimAndComplete(host.hostToken, succeeded.commandId, {
        status: "succeeded",
        result: {
          summary: "Clicked elementIndex=7",
          elementIndex: 7,
          dispatchMode: "accessibility_action",
          dispatchTarget: "element",
          inputRisk: "targeted_app_action",
          appState: "private state",
          truncated: true,
          truncationReasons: ["max_nodes"],
          metrics: {
            helperDurationMs: 42,
            settle: true,
            rawNodeCount: 5,
            nodeCount: 3,
            appStateChars: 13,
            visibleElementCount: 2,
          },
        },
      });

      mockNow(STARTED_AT_MS + 1000);
      const failed = await computerUse.createComputerUseWriteCommand(actor, {
        kind: "app.open",
        app: "Finder",
      });
      await claimAndComplete(host.hostToken, failed.commandId, {
        status: "failed",
        error: { code: "app_not_found", message: "Finder is unavailable" },
      });

      mockNow(STARTED_AT_MS + 2000);
      await computerUse.heartbeatComputerUseHost(host.hostToken, {
        hostName: "Payload Desktop",
        supportedCapabilities: [
          "apps.list",
          "app.state",
          "app.open",
          "element.click",
          ...PLUGIN_CAPABILITIES,
        ],
        permissions: { accessibility: true, screenRecording: true },
      });
      const plugin = await computerUse.createComputerUsePluginCommand(actor, {
        plugin: "filesystem",
        tool: "read_text_file",
        arguments: { path: "/tmp/private.txt" },
      });
      const privateContent = Buffer.from("private plugin payload");
      await claimAndComplete(
        host.hostToken,
        plugin.commandId,
        {
          status: "succeeded",
          result: {
            plugin: "filesystem",
            tool: "read_text_file",
            sizeBytes: privateContent.length,
            pluginContent: {
              dataBase64: privateContent.toString("base64"),
              mimeType: "text/plain",
              fileName: "private.txt",
            },
          },
        },
        PLUGIN_CAPABILITIES,
      );
      expect(s3.puts).toHaveLength(1);

      const peerEvent = await createSimpleAuditEvent(peer, "Peer Secret");
      const foreignEvent = await createSimpleAuditEvent(
        foreign,
        "Foreign Secret",
      );
      clearPublications();

      const all = await computerUse.listComputerUseAuditEvents(actor, {
        limit: 200,
      });
      expect(
        all.auditEvents.map((event) => {
          return event.commandId;
        }),
      ).toStrictEqual([
        plugin.commandId,
        failed.commandId,
        succeeded.commandId,
      ]);
      expect(all.auditEvents[0]).toStrictEqual({
        id: expect.any(String),
        commandId: plugin.commandId,
        runId: null,
        hostId: host.hostId,
        kind: "plugin.call",
        app: null,
        event: "completed",
        redactedResult: {
          plugin: "filesystem",
          tool: "read_text_file",
          status: "succeeded",
          destructive: false,
          path: "/tmp/private.txt",
          offloaded: true,
          sizeBytes: privateContent.length,
          fileName: "private.txt",
          mimeType: "text/plain",
        },
        error: null,
        createdAt: new Date(STARTED_AT_MS + 2000).toISOString(),
      });
      expect(all.auditEvents[1]).toStrictEqual({
        id: expect.any(String),
        commandId: failed.commandId,
        runId: null,
        hostId: host.hostId,
        kind: "app.open",
        app: "Finder",
        event: "completed",
        redactedResult: null,
        error: { code: "app_not_found", message: "Finder is unavailable" },
        createdAt: new Date(STARTED_AT_MS + 1000).toISOString(),
      });
      expect(all.auditEvents[2]).toStrictEqual({
        id: expect.any(String),
        commandId: succeeded.commandId,
        runId: granted.runId,
        hostId: host.hostId,
        kind: "element.click",
        app: "Safari",
        event: "completed",
        redactedResult: {
          summary: "Clicked elementIndex=7",
          elementIndex: 7,
          dispatchMode: "accessibility_action",
          dispatchTarget: "element",
          inputRisk: "targeted_app_action",
          appStateLength: 13,
          truncated: true,
          truncationReasons: ["max_nodes"],
          metrics: {
            helperDurationMs: 42,
            settle: true,
            rawNodeCount: 5,
            nodeCount: 3,
            appStateChars: 13,
            visibleElementCount: 2,
          },
        },
        error: null,
        createdAt: new Date(STARTED_AT_MS).toISOString(),
      });
      expect(JSON.stringify(all)).not.toContain("private state");
      expect(JSON.stringify(all)).not.toContain("private plugin payload");
      expect(JSON.stringify(all)).not.toContain("Peer Secret");
      expect(JSON.stringify(all)).not.toContain("Foreign Secret");

      const byCommand = await computerUse.listComputerUseAuditEvents(actor, {
        commandId: succeeded.commandId,
      });
      expect(byCommand.auditEvents).toStrictEqual([all.auditEvents[2]]);
      const byHost = await computerUse.listComputerUseAuditEvents(actor, {
        hostId: host.hostId,
      });
      expect(byHost).toStrictEqual(all);
      const byRun = await computerUse.listComputerUseAuditEvents(actor, {
        runId: granted.runId,
      });
      expect(byRun.auditEvents).toStrictEqual([all.auditEvents[2]]);
      const combined = await computerUse.listComputerUseAuditEvents(actor, {
        commandId: succeeded.commandId,
        hostId: host.hostId,
        runId: granted.runId,
      });
      expect(combined).toStrictEqual(byRun);

      for (const foreignSelector of [
        { commandId: peerEvent.commandId },
        { hostId: peerEvent.host.hostId },
        { commandId: foreignEvent.commandId },
        { hostId: foreignEvent.host.hostId },
      ]) {
        const hidden = await computerUse.listComputerUseAuditEvents(
          actor,
          foreignSelector,
        );
        expect(hidden.auditEvents).toStrictEqual([]);
      }
      expectNoPublications();
    },
  );

  it(
    "preserves default 50, explicit limits, max 200, descending order and empty results",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startAuditHost(actor, "Limit Desktop");
      const commandIds: string[] = [];
      for (let index = 0; index < 51; index += 1) {
        mockNow(STARTED_AT_MS + index * 1000);
        const created = await computerUse.createComputerUseWriteCommand(actor, {
          kind: "app.open",
          app: `Limit ${index}`,
        });
        await claimAndComplete(host.hostToken, created.commandId, {
          status: "succeeded",
          result: { app: `Limit ${index}`, opened: true },
        });
        commandIds.push(created.commandId);
      }

      const expectedDescending = [...commandIds].reverse();
      const defaultPage = await computerUse.listComputerUseAuditEvents(actor);
      expect(defaultPage.auditEvents).toHaveLength(50);
      expect(
        defaultPage.auditEvents.map((event) => {
          return event.commandId;
        }),
      ).toStrictEqual(expectedDescending.slice(0, 50));

      const explicit = await computerUse.listComputerUseAuditEvents(actor, {
        limit: 7,
      });
      expect(
        explicit.auditEvents.map((event) => {
          return event.commandId;
        }),
      ).toStrictEqual(expectedDescending.slice(0, 7));

      const maximum = await computerUse.listComputerUseAuditEvents(actor, {
        limit: 200,
      });
      expect(
        maximum.auditEvents.map((event) => {
          return event.commandId;
        }),
      ).toStrictEqual(expectedDescending);

      const empty = await computerUse.listComputerUseAuditEvents(actor, {
        runId: `missing_${randomUUID()}`,
      });
      expect(empty.auditEvents).toStrictEqual([]);

      await expect(
        computerUse.requestListComputerUseAuditEvents(
          actor,
          { limit: 201 },
          [200],
        ),
      ).rejects.toThrow(/status 400/);
    },
  );

  it(
    "preserves empty-string and malformed selector behavior without poisoning later reads",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const { commandId } = await createSimpleAuditEvent(actor, "Selector");
      const unfiltered = await computerUse.listComputerUseAuditEvents(actor);
      const emptySelectors = await computerUse.listComputerUseAuditEvents(
        actor,
        {
          commandId: "",
          hostId: "",
          runId: "",
        },
      );
      expect(emptySelectors).toStrictEqual(unfiltered);

      for (const malformed of [
        { commandId: "not-a-uuid" },
        { hostId: "not-a-uuid" },
      ]) {
        await expect(
          computerUse.requestListComputerUseAuditEvents(
            actor,
            malformed,
            [200, 403],
          ),
        ).rejects.toThrow(/Unknown response status 500/);
      }
      const textSelector = await computerUse.listComputerUseAuditEvents(actor, {
        runId: "not-a-uuid",
      });
      expect(textSelector.auditEvents).toStrictEqual([]);

      const recovered = await computerUse.listComputerUseAuditEvents(actor, {
        commandId,
      });
      expect(recovered.auditEvents).toHaveLength(1);
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
    "denies a closed %s with a generic 403, no content or side effects, then restores exactly",
    { timeout: CASE_TIMEOUT_MS },
    async (subjectKind, subjectId) => {
      const actor = orgScoped(bdd.user());
      const { host, commandId } = await createSimpleAuditEvent(
        actor,
        "Private Audit",
      );
      const before = await computerUse.listComputerUseAuditEvents(actor);
      const commandBefore = await computerUse.readComputerUseCommand(
        actor,
        commandId,
      );
      const hostsBefore = await computerUse.listComputerUseHosts(actor);
      clearPublications();

      const closed = await closeSubject({
        subjectKind,
        subjectId: subjectId(actor),
      });
      const denied = await computerUse.requestListComputerUseAuditEvents(
        actor,
        {},
        [403],
      );
      expect(denied.body).toStrictEqual({
        error: {
          message: "Computer-use audit events are not available",
          code: "FORBIDDEN",
        },
      });
      const deniedBytes = JSON.stringify(denied.body);
      for (const secret of [
        commandId,
        host.hostId,
        "Private Audit",
        "redactedResult",
        "createdAt",
      ]) {
        expect(deniedBytes).not.toContain(secret);
      }
      expectNoPublications();

      await removeErasureSubjectsFixture([closed.jobId]);
      const restored = await computerUse.listComputerUseAuditEvents(actor);
      expect(restored).toStrictEqual(before);
      await expect(
        computerUse.readComputerUseCommand(actor, commandId),
      ).resolves.toStrictEqual(commandBefore);
      await expect(
        computerUse.listComputerUseHosts(actor),
      ).resolves.toStrictEqual(hostsBefore);
      expectNoPublications();
    },
  );

  it(
    "lets read-first return while closure waits on its real B1 edge, then denies the next read",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const unrelated = orgScoped(bdd.user());
      const { commandId } = await createSimpleAuditEvent(actor, "Read First");
      const unrelatedEvent = await createSimpleAuditEvent(
        unrelated,
        "Unrelated",
      );

      await withComputerUseAuditEventsBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const reading = owner.start(
                computerUse.listComputerUseAuditEvents(actor, { commandId }),
              );
              const entered = await waitForBarrierEntry(
                barrier.entered,
                reading,
              );
              expect(entered).toMatchObject({
                lockTimeout: "1s",
                statementTimeout: "5s",
                transactionTimeout: "0",
              });
              const closing = owner.start(
                closeSubject({
                  subjectKind: "user",
                  subjectId: actor.userId,
                }),
              );
              await expect
                .poll(barrier.blockedWaiterCount, BLOCKED)
                .toBeGreaterThanOrEqual(1);

              const progressing =
                await computerUse.listComputerUseAuditEvents(unrelated);
              expect(
                progressing.auditEvents.map((event) => {
                  return event.commandId;
                }),
              ).toStrictEqual([unrelatedEvent.commandId]);

              barrier.release();
              const admitted = valueOf(await reading.settled);
              expect(
                admitted.auditEvents.map((event) => {
                  return event.commandId;
                }),
              ).toStrictEqual([commandId]);
              valueOf(await closing.settled);
            });
          },
        },
        context.signal,
      );

      const denied = await computerUse.requestListComputerUseAuditEvents(
        actor,
        {},
        [403],
      );
      expectApiError(denied.body);
    },
  );

  it(
    "makes closure-first win before projection and exposes the real blocking edge",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const { commandId } = await createSimpleAuditEvent(
        actor,
        "Closure First",
      );

      await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
        await withOperationOwnership(barrier.release, async (owner) => {
          const closing = owner.start(
            closeSubject({
              subjectKind: "organization",
              subjectId: actor.orgId,
            }),
          );
          await waitForBarrierEntry(barrier.entered, closing);
          const reading = owner.start(
            computerUse.requestListComputerUseAuditEvents(actor, {}, [403]),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);

          barrier.release();
          valueOf(await closing.settled);
          const denied = valueOf(await reading.settled);
          expect(denied.status).toBe(403);
          expect(JSON.stringify(denied.body)).not.toContain(commandId);
        });
      }, context.signal);
    },
  );

  it(
    "allows two same-owner reads to complete without a lock-upgrade cycle",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const { commandId } = await createSimpleAuditEvent(actor, "Concurrent");

      await withComputerUseAuditEventsBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const first = owner.start(
                computerUse.listComputerUseAuditEvents(actor, { commandId }),
              );
              await waitForBarrierEntry(barrier.entered, first);
              const second = owner.start(
                computerUse.listComputerUseAuditEvents(actor, { commandId }),
              );
              const concurrent = valueOf(await second.settled);
              expect(concurrent.auditEvents).toHaveLength(1);
              barrier.release();
              expect(valueOf(await first.settled)).toStrictEqual(concurrent);
            });
          },
        },
        context.signal,
      );
    },
  );

  it(
    "propagates the scoped admission lock timeout instead of fabricating closure or an empty page",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const unrelated = orgScoped(bdd.user());
      await createSimpleAuditEvent(actor, "Timed");
      const unrelatedEvent = await createSimpleAuditEvent(
        unrelated,
        "Progress",
      );

      await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
        await withOperationOwnership(barrier.release, async (owner) => {
          const closing = owner.start(
            closeSubject({ subjectKind: "user", subjectId: actor.userId }),
          );
          await waitForBarrierEntry(barrier.entered, closing);
          const reading = owner.start(
            computerUse.requestListComputerUseAuditEvents(
              actor,
              {},
              [200, 403],
            ),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          const progress =
            await computerUse.listComputerUseAuditEvents(unrelated);
          expect(
            progress.auditEvents.map((event) => {
              return event.commandId;
            }),
          ).toStrictEqual([unrelatedEvent.commandId]);

          const failed = await reading.settled;
          expect(failed.ok).toBeFalsy();
          if (!failed.ok) {
            expect(String(failed.error)).toMatch(/Unknown response status 500/);
          }
          reading.acceptFailure();
          barrier.release();
          valueOf(await closing.settled);
        });
      }, context.signal);
    },
  );

  it(
    "propagates operation abort after projection and releases the transaction",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const { commandId } = await createSimpleAuditEvent(actor, "Abort");
      const cancelled = new AbortController();

      await withComputerUseAuditEventsBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId,
          stopAt: "audit-events",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              owner.abortOnExit(cancelled);
              const reading = owner.start(
                computerUse.requestListComputerUseAuditEvents(
                  actor,
                  { commandId },
                  [200, 403],
                  cancelled.signal,
                ),
              );
              const entered = await waitForBarrierEntry(
                barrier.entered,
                reading,
              );
              expect(entered.rowCount).toBe(1);
              cancelled.abort(
                new DOMException("Operation ended", "AbortError"),
              );
              barrier.release();
              const failed = await reading.settled;
              expect(failed.ok).toBeFalsy();
              if (!failed.ok) {
                expect(String(failed.error)).toMatch(
                  /Unknown response status 500/,
                );
              }
              reading.acceptFailure();
            });
          },
        },
        context.signal,
      );

      const recovered = await computerUse.listComputerUseAuditEvents(actor, {
        commandId,
      });
      expect(recovered.auditEvents).toHaveLength(1);
    },
  );

  it(
    "records folded admission, exact selectors, projection, limit, cardinality and response bytes",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startAuditHost(actor, "Measured Desktop");
      mockClerkMembership(context, actor, "org:admin");
      const granted = computerUseToken({
        userId: actor.userId,
        orgId: actor.orgId,
        capabilities: ["computer-use:write"],
        computerUseHostId: host.hostId,
      });
      const created = await computerUse.createComputerUseWriteCommand(
        { bearer: granted.token },
        { kind: "app.open", app: "Measured" },
      );
      await claimAndComplete(host.hostToken, created.commandId, {
        status: "succeeded",
        result: { app: "Measured", opened: true },
      });
      let responseBytes = 0;

      await withComputerUseAuditEventsBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId: created.commandId,
          hostId: host.hostId,
          runId: granted.runId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const reading = owner.start(
                computerUse.listComputerUseAuditEvents(actor, {
                  commandId: created.commandId,
                  hostId: host.hostId,
                  runId: granted.runId,
                  limit: 200,
                }),
              );
              const entered = await waitForBarrierEntry(
                barrier.entered,
                reading,
              );
              expect(entered).toMatchObject({
                lockTimeout: "1s",
                statementTimeout: "5s",
                transactionTimeout: "0",
              });
              const statements = barrier.statements();
              expect(statements).toHaveLength(5);
              expect(statements[0]).toContain("erasure_isolation_probe");
              expect(statements[0]).toContain("pg_advisory_xact_lock_shared");
              expect(statements[1]).toContain("pg_advisory_xact_lock_shared");
              expect(statements[2]).toContain('from "account_erasure_jobs"');
              expect(statements[2]).toContain("limit");
              expect(statements[3]).toContain(
                'from "computer_use_command_audit_events"',
              );
              expect(statements[3]).toContain(
                '"computer_use_command_audit_events"."org_id" =',
              );
              expect(statements[3]).toContain(
                '"computer_use_command_audit_events"."user_id" =',
              );
              expect(statements[3]).toContain(
                '"computer_use_command_audit_events"."command_id" =',
              );
              expect(statements[3]).toContain(
                '"computer_use_command_audit_events"."host_id" =',
              );
              expect(statements[3]).toContain(
                '"computer_use_command_audit_events"."run_id" =',
              );
              expect(statements[3]).toContain(
                'order by "computer_use_command_audit_events"."created_at" desc',
              );
              expect(statements[3]).toContain(" limit ");
              expect(statements[3]).not.toContain(" for ");
              expect(statements[4]).toBe("commit");

              barrier.release();
              const response = valueOf(await reading.settled);
              expect(response.auditEvents).toHaveLength(1);
              responseBytes = Buffer.byteLength(JSON.stringify(response));
              expect(responseBytes).toBe(356);
            });
          },
        },
        context.signal,
      );
      expect(responseBytes).toBe(356);
    },
  );

  it(
    "joins reader and closure on callback early exit and surfaces pre-entry and setup rejection before recovery",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const { commandId } = await createSimpleAuditEvent(actor, "Lifecycle");

      let earlyRead:
        | OwnedOperation<
            Awaited<ReturnType<typeof computerUse.listComputerUseAuditEvents>>
          >
        | undefined;
      let earlyClosure: OwnedOperation<{ readonly jobId: string }> | undefined;
      await expect(
        withComputerUseAuditEventsBarrierFixture(
          {
            orgId: actor.orgId,
            userId: actor.userId,
            commandId,
            stopAt: "audit-events",
            work: async (barrier) => {
              await withOperationOwnership(barrier.release, async (owner) => {
                earlyRead = owner.start(
                  computerUse.listComputerUseAuditEvents(actor, { commandId }),
                );
                await waitForBarrierEntry(barrier.entered, earlyRead);
                earlyClosure = owner.start(
                  closeSubject({
                    subjectKind: "user",
                    subjectId: actor.userId,
                  }),
                );
                await expect
                  .poll(barrier.blockedWaiterCount, BLOCKED)
                  .toBeGreaterThanOrEqual(1);
                throw new Error("deliberate audit-event callback exit");
              });
            },
          },
          context.signal,
        ),
      ).rejects.toThrow("deliberate audit-event callback exit");
      if (!earlyRead || !earlyClosure) {
        throw new Error("Expected the early-exit operations to start");
      }
      expect(valueOf(await earlyRead.settled).auditEvents).toHaveLength(1);
      const closed = valueOf(await earlyClosure.settled);
      await removeErasureSubjectsFixture([closed.jobId]);

      await withComputerUseAuditEventsBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          commandId,
          stopAt: "audit-events",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const failedBeforeEntry = owner.start(
                computerUse.requestListComputerUseAuditEvents(null, {}, [200]),
              );
              const surfaced = await settleIncludingAbort(
                waitForBarrierEntry(barrier.entered, failedBeforeEntry),
              );
              expect(surfaced.ok).toBeFalsy();
              if (!surfaced.ok) {
                expect(String(surfaced.error)).toMatch(/received 401/);
              }
              expect(barrier.enteredYet()).toBeFalsy();

              const recovery = owner.start(
                computerUse.listComputerUseAuditEvents(actor, { commandId }),
              );
              await waitForBarrierEntry(barrier.entered, recovery);
              barrier.release();
              expect(valueOf(await recovery.settled).auditEvents).toHaveLength(
                1,
              );
            });
          },
        },
        context.signal,
      );

      const rejectedSetup = new AbortController();
      rejectedSetup.abort(new DOMException("Rejected setup", "AbortError"));
      await expect(
        withComputerUseAuditEventsBarrierFixture(
          {
            orgId: actor.orgId,
            userId: actor.userId,
            commandId,
            stopAt: "audit-events",
            work: () => {
              return Promise.reject(new Error("setup must not enter work"));
            },
          },
          rejectedSetup.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });

      const healthy = await computerUse.listComputerUseAuditEvents(actor, {
        commandId,
      });
      expect(healthy.auditEvents).toHaveLength(1);
    },
  );
});
