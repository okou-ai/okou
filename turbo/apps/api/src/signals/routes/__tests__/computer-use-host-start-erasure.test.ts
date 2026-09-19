import { randomUUID } from "node:crypto";

import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { aroundEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import {
  closeErasureSubjectFixture,
  erasureSubjectJobExistsFixture,
  removeErasureSubjectsFixture,
  withErasureSubjectClosureCommitBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { holdOpenErasureSubjectLockFixture } from "../../../test-fixtures/computer-use-command-get-erasure";
import {
  failComputerUseHostStartWriteFixture,
  withComputerUseHostStartTransactionBarrierFixture,
  type ComputerUseHostStartTarget,
} from "../../../test-fixtures/computer-use-host-start-erasure";
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
import {
  channelsPublishedTo,
  countPublishedTo,
} from "./helpers/realtime-publications";

const context = testContext();
const bdd = createBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-20T02:00:00.000Z");
const BLOCKED = { interval: 10, timeout: 10_000 } as const;
const CASE_TIMEOUT_MS = 30_000;
const HOSTS_CHANGED = "computerUseHostsChanged";

type Settled<T> = Awaited<ReturnType<typeof settleIncludingAbort<T>>>;
type StartMode = "legacy" | "installation";
type SubjectKind = "user" | "organization";

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
  if (actor.orgId === null) {
    throw new Error("Computer Use host START requires an organization");
  }
  return { ...actor, orgId: actor.orgId };
}

function valueOf<T>(settled: Settled<T>): T {
  if (!settled.ok) {
    throw settled.error;
  }
  return settled.value;
}

/** Every concurrent operation is released, aborted when owned, and joined. */
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
            throw new Error("Expected the owned host START operation to fail");
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
      "Concurrent Computer Use host START work and cleanup failed",
    );
  }
  if (!workResult.ok) {
    throw workResult.error;
  }
  return workResult.value;
}

/** The race only observes entry; the operation remains owner-joined. */
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
  throw new Error("Host START completed before barrier entry");
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

async function closeSubject(
  subject: ErasureSubject,
): Promise<{ readonly jobId: string }> {
  const closed = await closeErasureSubjectFixture(subject);
  onTestFinished(async () => {
    await removeErasureSubjectsFixture([closed.jobId]);
  });
  return closed;
}

function subjectFor(
  actor: ApiTestUser & { readonly orgId: string },
  kind: SubjectKind,
): ErasureSubject {
  return kind === "user"
    ? { subjectKind: "user", subjectId: actor.userId }
    : { subjectKind: "organization", subjectId: actor.orgId };
}

function targetFor(
  actor: ApiTestUser & { readonly orgId: string },
  installationId?: string,
): ComputerUseHostStartTarget {
  return {
    orgId: actor.orgId,
    userId: actor.userId,
    ...(installationId ? { installationId } : {}),
  };
}

function startOptions(
  mode: StartMode,
  installationId: string,
  hostName: string,
) {
  return {
    ...(mode === "installation" ? { installationId } : {}),
    hostName,
    appVersion: "2.3.4",
    osVersion: "macOS 16",
    supportedCapabilities: ["apps.list", "element.click"],
    permissions: { accessibility: true, screenRecording: false },
  };
}

async function clearPublications(): Promise<void> {
  await flushWaitUntilForTest();
  context.mocks.ably.channelGet.mockClear();
  context.mocks.ably.publish.mockClear();
}

async function expectNoPublications(): Promise<void> {
  await flushWaitUntilForTest();
  expect(context.mocks.ably.channelGet).not.toHaveBeenCalled();
  expect(context.mocks.ably.publish).not.toHaveBeenCalled();
}

async function expectOneOwnerPublication(userId: string): Promise<void> {
  await flushWaitUntilForTest();
  expect(
    countPublishedTo(context.mocks, {
      channel: `user:${userId}`,
      topic: HOSTS_CHANGED,
    }),
  ).toBe(1);
  expect(channelsPublishedTo(context.mocks, HOSTS_CHANGED)).toStrictEqual([
    `user:${userId}`,
  ]);
}

function expectClosedResponse(body: unknown): void {
  expect(body).toStrictEqual({
    error: { message: "Account unavailable", code: "FORBIDDEN" },
  });
}

function startedBody(
  response: Awaited<ReturnType<typeof computerUse.requestStartComputerUseHost>>,
): { readonly hostId: string; readonly hostToken: string } {
  if (response.status !== 200) {
    throw new Error(`Expected host START 200, received ${response.status}`);
  }
  return response.body;
}

function hostById(
  hosts: Awaited<ReturnType<typeof computerUse.listComputerUseHosts>>["hosts"],
  hostId: string,
) {
  const host = hosts.find((candidate) => {
    return candidate.id === hostId;
  });
  if (!host) {
    throw new Error(`Expected Computer Use host ${hostId}`);
  }
  return host;
}

function classifyStartStatements(statements: readonly string[]): string[] {
  return statements.map((statement) => {
    if (statement.startsWith("begin")) {
      return "begin-read-committed";
    }
    if (statement.includes("set_config('lock_timeout'")) {
      return "lock-timeout";
    }
    if (statement.includes("set_config('statement_timeout'")) {
      return "statement-timeout";
    }
    if (statement.includes("erasure_isolation_probe")) {
      return "first-b1-lock";
    }
    if (statement.includes("pg_advisory_xact_lock_shared")) {
      return "second-b1-lock";
    }
    if (statement.includes('from "account_erasure_jobs"')) {
      return "closure-lookup";
    }
    if (statement.startsWith('insert into "computer_use_hosts"')) {
      return statement.includes("on conflict")
        ? "installation-upsert"
        : "legacy-insert";
    }
    if (statement === "commit") {
      return "commit";
    }
    return `unexpected:${statement}`;
  });
}

const closureCases = [
  { mode: "legacy", subjectKind: "user" },
  { mode: "legacy", subjectKind: "organization" },
  { mode: "installation", subjectKind: "user" },
  { mode: "installation", subjectKind: "organization" },
] as const;

describe("Computer Use host START account-erasure admission", () => {
  it(
    "preserves START auth, validation and normalization without importing the command capability gate",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());

      const unauthenticated = await computerUse.requestStartComputerUseHost(
        null,
        [401],
      );
      expectApiError(unauthenticated.body);
      const noOrganization = await computerUse.requestStartComputerUseHost(
        bdd.user({ orgId: null }),
        [401],
      );
      expectApiError(noOrganization.body);

      const session = await computerUse.requestStartComputerUseHost(
        actor,
        [200],
        {
          installationId: randomUUID(),
          hostName: "  Normalized Desktop  ",
          appVersion: " 1.2.3 ",
          osVersion: " macOS 16.0 ",
          supportedCapabilities: [
            " apps.list ",
            "apps.list",
            " element.click ",
          ],
          permissions: { accessibility: false, screenRecording: true },
        },
      );
      const normalized = hostById(
        (await computerUse.listComputerUseHosts(actor)).hosts,
        startedBody(session).hostId,
      );
      expect(normalized).toMatchObject({
        displayName: "Normalized Desktop",
        appVersion: "1.2.3",
        osVersion: "macOS 16.0",
        supportedCapabilities: ["apps.list", "element.click"],
        permissions: { accessibility: false, screenRecording: true },
      });

      const { token: pat } = await authOrg.createCliToken(actor);
      mockClerkMembership(context, actor, "org:admin");
      await computerUse.requestStartComputerUseHost({ bearer: pat }, [200], {
        installationId: randomUUID(),
        hostName: "PAT Desktop",
      });

      const agent = computerUseToken({
        userId: actor.userId,
        orgId: actor.orgId,
        capabilities: [],
      });
      const sandboxDenied = await computerUse.requestStartComputerUseHost(
        { bearer: agent.token },
        [403],
        { installationId: randomUUID(), hostName: "Agent Desktop" },
      );
      expect(sandboxDenied.body).toStrictEqual({
        error: {
          message: "This endpoint is not available for sandbox tokens",
          code: "FORBIDDEN",
        },
      });

      const beforeInvalid = await computerUse.listComputerUseHosts(actor);
      const invalid = await settleIncludingAbort(
        computerUse.requestStartComputerUseHost(actor, [200], {
          hostName: "   ",
        }),
      );
      expect(invalid.ok).toBeFalsy();
      if (!invalid.ok) {
        expect(String(invalid.error)).toMatch(/Unknown response status 400/);
      }
      await expect(
        computerUse.listComputerUseHosts(actor),
      ).resolves.toStrictEqual(beforeInvalid);
    },
  );

  it(
    "retains installation identity, token rotation, partial-index ownership, revoked-row and concurrent upsert semantics",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const peer = orgScoped(bdd.user({ orgId: actor.orgId }));
      const foreign = orgScoped(bdd.user({ orgId: `org_${randomUUID()}` }));
      const installationId = randomUUID();
      const initial = await computerUse.startComputerUseHost(
        actor,
        startOptions("installation", installationId, "Initial Desktop"),
      );
      const initialProjection = hostById(
        (await computerUse.listComputerUseHosts(actor)).hosts,
        initial.hostId,
      );

      mockNow(STARTED_AT_MS + 1000);
      await clearPublications();
      const restarted = await computerUse.startComputerUseHost(
        actor,
        startOptions("installation", installationId, "Restarted Desktop"),
      );
      expect(restarted.hostId).toBe(initial.hostId);
      const restartedProjection = hostById(
        (await computerUse.listComputerUseHosts(actor)).hosts,
        restarted.hostId,
      );
      expect(restartedProjection.createdAt).toBe(initialProjection.createdAt);
      expect(restartedProjection).toMatchObject({
        displayName: "Restarted Desktop",
        appVersion: "2.3.4",
        osVersion: "macOS 16",
        supportedCapabilities: ["apps.list", "element.click"],
        permissions: { accessibility: true, screenRecording: false },
      });
      await expectOneOwnerPublication(actor.userId);
      await computerUse.requestComputerUseHeartbeat(initial.hostToken, [401]);
      await computerUse.requestComputerUseHeartbeat(restarted.hostToken, [200]);

      const peerHost = await computerUse.startComputerUseHost(
        peer,
        startOptions("installation", installationId, "Peer Desktop"),
      );
      const foreignHost = await computerUse.startComputerUseHost(
        foreign,
        startOptions("installation", installationId, "Foreign Desktop"),
      );
      expect(
        new Set([restarted.hostId, peerHost.hostId, foreignHost.hostId]).size,
      ).toBe(3);

      await computerUse.stopComputerUseHost(restarted.hostToken);
      const afterStop = await computerUse.startComputerUseHost(
        actor,
        startOptions("installation", installationId, "After Stop"),
      );
      expect(afterStop.hostId).toBe(initial.hostId);
      expect(
        hostById(
          (await computerUse.listComputerUseHosts(actor)).hosts,
          afterStop.hostId,
        ).createdAt,
      ).toBe(initialProjection.createdAt);

      const revokedLegacy = await computerUse.startComputerUseHost(actor, {
        hostName: "Revoked Legacy",
      });
      await computerUse.stopComputerUseHost(revokedLegacy.hostToken);
      const replacementLegacy = await computerUse.startComputerUseHost(actor, {
        hostName: "Replacement Legacy",
      });
      expect(replacementLegacy.hostId).not.toBe(revokedLegacy.hostId);
      expect(
        (await computerUse.listComputerUseHosts(actor)).hosts.some((host) => {
          return host.id === revokedLegacy.hostId;
        }),
      ).toBeFalsy();

      const concurrentInstallation = randomUUID();
      const [first, second] = await Promise.all([
        computerUse.startComputerUseHost(
          actor,
          startOptions("installation", concurrentInstallation, "Concurrent A"),
        ),
        computerUse.startComputerUseHost(
          actor,
          startOptions("installation", concurrentInstallation, "Concurrent B"),
        ),
      ]);
      expect(first.hostId).toBe(second.hostId);
      const credentialStatuses = await Promise.all([
        computerUse.requestComputerUseHeartbeat(first.hostToken, [200, 401]),
        computerUse.requestComputerUseHeartbeat(second.hostToken, [200, 401]),
      ]);
      expect(
        credentialStatuses
          .map((response) => {
            return response.status;
          })
          .sort(),
      ).toStrictEqual([200, 401]);
    },
  );

  it.each(closureCases)(
    "returns fixed 403 and preserves $mode state for a closed $subjectKind, then writes once after restore",
    { timeout: CASE_TIMEOUT_MS },
    async ({ mode, subjectKind }) => {
      const actor = orgScoped(bdd.user());
      const installationId = randomUUID();
      const baseline = await computerUse.startComputerUseHost(
        actor,
        startOptions(mode, installationId, "Baseline Desktop"),
      );
      const before = await computerUse.listComputerUseHosts(actor);
      const closed = await closeSubject(subjectFor(actor, subjectKind));
      await expect(
        erasureSubjectJobExistsFixture(closed.jobId),
      ).resolves.toBeTruthy();
      await clearPublications();

      const denied = await computerUse.requestStartComputerUseHost(
        actor,
        [403],
        startOptions(mode, installationId, "Denied Desktop"),
      );
      expectClosedResponse(denied.body);
      await expectNoPublications();

      await removeErasureSubjectsFixture([closed.jobId]);
      await expect(
        erasureSubjectJobExistsFixture(closed.jobId),
      ).resolves.toBeFalsy();
      await expect(
        computerUse.listComputerUseHosts(actor),
      ).resolves.toStrictEqual(before);
      if (mode === "installation") {
        await computerUse.requestComputerUseHeartbeat(
          baseline.hostToken,
          [200],
        );
      }

      await clearPublications();
      const restored = await computerUse.requestStartComputerUseHost(
        actor,
        [200],
        startOptions(mode, installationId, "Restored Desktop"),
      );
      const restoredBody = startedBody(restored);
      if (mode === "installation") {
        expect(restoredBody.hostId).toBe(baseline.hostId);
        await computerUse.requestComputerUseHeartbeat(
          baseline.hostToken,
          [401],
        );
        await computerUse.heartbeatComputerUseHost(
          restoredBody.hostToken,
          startOptions(mode, installationId, "Restored Desktop"),
        );
      } else {
        expect(restoredBody.hostId).not.toBe(baseline.hostId);
      }
      await expectOneOwnerPublication(actor.userId);
    },
  );

  it.each(closureCases)(
    "orders closure-first against $mode START for a $subjectKind while unrelated owners progress",
    { timeout: CASE_TIMEOUT_MS },
    async ({ mode, subjectKind }) => {
      const actor = orgScoped(bdd.user());
      const unrelated = orgScoped(
        bdd.user({
          orgId: subjectKind === "user" ? actor.orgId : `org_${randomUUID()}`,
        }),
      );
      const installationId = randomUUID();
      const baseline = await computerUse.startComputerUseHost(
        actor,
        startOptions(mode, installationId, "Before Closure"),
      );
      const before = await computerUse.listComputerUseHosts(actor);
      let closedJobId = "";
      let deniedBody: unknown;
      await clearPublications();

      await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
        await withOperationOwnership(barrier.release, async (owner) => {
          const closing = startClosure(owner, subjectFor(actor, subjectKind));
          await waitForBarrierEntry(barrier.entered, closing);
          const starting = owner.start(
            computerUse.requestStartComputerUseHost(
              actor,
              [200, 403],
              startOptions(mode, installationId, "Must Be Denied"),
            ),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);

          const unrelatedStart = await computerUse.requestStartComputerUseHost(
            unrelated,
            [200],
            {
              installationId: randomUUID(),
              hostName: "Unrelated Desktop",
            },
          );
          expect(unrelatedStart.status).toBe(200);
          expect(
            countPublishedTo(context.mocks, {
              channel: `user:${actor.userId}`,
              topic: HOSTS_CHANGED,
            }),
          ).toBe(0);

          barrier.release();
          const closed = valueOf(await closing.settled);
          closedJobId = closed.jobId;
          const denied = valueOf(await starting.settled);
          expect(denied.status).toBe(403);
          deniedBody = denied.body;
        });
      }, context.signal);

      expectClosedResponse(deniedBody);
      await expect(
        erasureSubjectJobExistsFixture(closedJobId),
      ).resolves.toBeTruthy();
      expect(
        countPublishedTo(context.mocks, {
          channel: `user:${actor.userId}`,
          topic: HOSTS_CHANGED,
        }),
      ).toBe(0);
      expect(
        countPublishedTo(context.mocks, {
          channel: `user:${unrelated.userId}`,
          topic: HOSTS_CHANGED,
        }),
      ).toBe(1);

      await removeErasureSubjectsFixture([closedJobId]);
      await expect(
        erasureSubjectJobExistsFixture(closedJobId),
      ).resolves.toBeFalsy();
      await expect(
        computerUse.listComputerUseHosts(actor),
      ).resolves.toStrictEqual(before);
      if (mode === "installation") {
        await computerUse.requestComputerUseHeartbeat(
          baseline.hostToken,
          [200],
        );
      }
      const recovered = await computerUse.requestStartComputerUseHost(
        actor,
        [200],
        startOptions(mode, installationId, "Recovered Desktop"),
      );
      expect(recovered.status).toBe(200);
    },
  );

  it.each(closureCases)(
    "retains writer-first $mode admission through result construction against a $subjectKind closure",
    { timeout: CASE_TIMEOUT_MS },
    async ({ mode, subjectKind }) => {
      const actor = orgScoped(bdd.user());
      const unrelated = orgScoped(
        bdd.user({
          orgId: subjectKind === "user" ? actor.orgId : `org_${randomUUID()}`,
        }),
      );
      const installationId = randomUUID();
      const baseline =
        mode === "installation"
          ? await computerUse.startComputerUseHost(
              actor,
              startOptions(mode, installationId, "Before Writer"),
            )
          : undefined;
      let closedJobId = "";
      let startedHostId = "";
      await clearPublications();

      await withComputerUseHostStartTransactionBarrierFixture(
        {
          target: targetFor(
            actor,
            mode === "installation" ? installationId : undefined,
          ),
          stopAt: "commit",
          writeMode: mode,
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const starting = owner.start(
                computerUse.requestStartComputerUseHost(
                  actor,
                  [200],
                  startOptions(mode, installationId, "Admitted Writer"),
                ),
              );
              const entry = await waitForBarrierEntry(
                barrier.entered,
                starting,
              );
              expect(entry).toMatchObject({
                lockTimeout: "1s",
                statementTimeout: "5s",
                transactionTimeout: "0",
                rowCount: null,
              });
              expect(
                classifyStartStatements(barrier.statements()),
              ).toStrictEqual([
                "begin-read-committed",
                "lock-timeout",
                "statement-timeout",
                "first-b1-lock",
                "second-b1-lock",
                "closure-lookup",
                mode === "installation"
                  ? "installation-upsert"
                  : "legacy-insert",
                "commit",
              ]);
              expect(
                countPublishedTo(context.mocks, {
                  channel: `user:${actor.userId}`,
                  topic: HOSTS_CHANGED,
                }),
              ).toBe(0);

              const closing = startClosure(
                owner,
                subjectFor(actor, subjectKind),
              );
              await expect
                .poll(barrier.blockedWaiterCount, BLOCKED)
                .toBeGreaterThanOrEqual(1);
              const unrelatedStart =
                await computerUse.requestStartComputerUseHost(
                  unrelated,
                  [200],
                  {
                    installationId: randomUUID(),
                    hostName: "Unrelated Writer",
                  },
                );
              expect(unrelatedStart.status).toBe(200);

              barrier.release();
              const started = valueOf(await starting.settled);
              expect(started.status).toBe(200);
              startedHostId = startedBody(started).hostId;
              const closed = valueOf(await closing.settled);
              closedJobId = closed.jobId;
            });
          },
        },
        context.signal,
      );

      await flushWaitUntilForTest();
      expect(
        countPublishedTo(context.mocks, {
          channel: `user:${actor.userId}`,
          topic: HOSTS_CHANGED,
        }),
      ).toBe(1);
      expect(
        countPublishedTo(context.mocks, {
          channel: `user:${unrelated.userId}`,
          topic: HOSTS_CHANGED,
        }),
      ).toBe(1);
      const repeated = await computerUse.requestStartComputerUseHost(
        actor,
        [403],
        startOptions(mode, installationId, "Later Writer"),
      );
      expectClosedResponse(repeated.body);

      await removeErasureSubjectsFixture([closedJobId]);
      await expect(
        erasureSubjectJobExistsFixture(closedJobId),
      ).resolves.toBeFalsy();
      const projection = hostById(
        (await computerUse.listComputerUseHosts(actor)).hosts,
        startedHostId,
      );
      expect(projection.displayName).toBe("Admitted Writer");
      if (baseline) {
        expect(startedHostId).toBe(baseline.hostId);
        await computerUse.requestComputerUseHeartbeat(
          baseline.hostToken,
          [401],
        );
      }
    },
  );

  it(
    "records the exact closed SQL controls and recovers the barrier after validation exits before transaction entry",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const closed = await closeSubject(subjectFor(actor, "user"));
      await clearPublications();

      await withComputerUseHostStartTransactionBarrierFixture(
        {
          target: targetFor(actor),
          stopAt: "commit",
          writeMode: "none",
          work: async (barrier) => {
            const invalid = await settleIncludingAbort(
              computerUse.requestStartComputerUseHost(actor, [200], {
                hostName: "   ",
              }),
            );
            expect(invalid.ok).toBeFalsy();
            if (!invalid.ok) {
              expect(String(invalid.error)).toMatch(
                /Unknown response status 400/,
              );
            }
            expect(barrier.enteredYet()).toBeFalsy();

            await withOperationOwnership(barrier.release, async (owner) => {
              const denied = owner.start(
                computerUse.requestStartComputerUseHost(actor, [403], {
                  hostName: "Closed Desktop",
                }),
              );
              const entry = await waitForBarrierEntry(barrier.entered, denied);
              expect(entry).toMatchObject({
                lockTimeout: "1s",
                statementTimeout: "5s",
                transactionTimeout: "0",
                rowCount: null,
              });
              expect(
                classifyStartStatements(barrier.statements()),
              ).toStrictEqual([
                "begin-read-committed",
                "lock-timeout",
                "statement-timeout",
                "first-b1-lock",
                "second-b1-lock",
                "closure-lookup",
                "commit",
              ]);
              barrier.release();
              expectClosedResponse(valueOf(await denied.settled).body);
            });
          },
        },
        context.signal,
      );

      await expectNoPublications();
      await removeErasureSubjectsFixture([closed.jobId]);
      const recovered = await computerUse.requestStartComputerUseHost(
        actor,
        [200],
        { hostName: "Healthy Desktop" },
      );
      expect(recovered.status).toBe(200);
    },
  );

  it.each(["legacy", "installation"] as const)(
    "rolls back an actual %s write fault, leaves credentials/state intact, and recovers",
    { timeout: CASE_TIMEOUT_MS },
    async (mode) => {
      const actor = orgScoped(bdd.user());
      const unrelated = orgScoped(bdd.user());
      const installationId = randomUUID();
      const baseline =
        mode === "installation"
          ? await computerUse.startComputerUseHost(
              actor,
              startOptions(mode, installationId, "Fault Baseline"),
            )
          : undefined;
      const before = await computerUse.listComputerUseHosts(actor);
      const fault = await failComputerUseHostStartWriteFixture({
        target: targetFor(
          actor,
          mode === "installation" ? installationId : undefined,
        ),
        operation: mode === "installation" ? "update" : "insert",
      });
      await clearPublications();

      const failed = await settleIncludingAbort(
        computerUse.requestStartComputerUseHost(
          actor,
          [200],
          startOptions(mode, installationId, "Faulted Desktop"),
        ),
      );
      expect(failed.ok).toBeFalsy();
      if (!failed.ok) {
        expect(String(failed.error)).toMatch(/Unknown response status 500/);
      }
      await expect(
        computerUse.listComputerUseHosts(actor),
      ).resolves.toStrictEqual(before);
      expect(
        countPublishedTo(context.mocks, {
          channel: `user:${actor.userId}`,
          topic: HOSTS_CHANGED,
        }),
      ).toBe(0);

      const unrelatedStart = await computerUse.requestStartComputerUseHost(
        unrelated,
        [200],
        { installationId: randomUUID(), hostName: "Unrelated Healthy" },
      );
      expect(unrelatedStart.status).toBe(200);
      await fault.restore();
      if (baseline) {
        await computerUse.requestComputerUseHeartbeat(
          baseline.hostToken,
          [200],
        );
      }
      const recovered = await computerUse.requestStartComputerUseHost(
        actor,
        [200],
        startOptions(mode, installationId, "Recovered After Fault"),
      );
      expect(recovered.status).toBe(200);
    },
  );

  it.each(["timeout", "abort"] as const)(
    "owns a real B1-wait %s failure without writing or publishing, while unrelated START progresses",
    { timeout: CASE_TIMEOUT_MS },
    async (failureMode) => {
      const actor = orgScoped(bdd.user());
      const unrelated = orgScoped(bdd.user());
      const before = await computerUse.listComputerUseHosts(actor);
      const controller = new AbortController();
      let closedJobId = "";
      await clearPublications();

      await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
        await withOperationOwnership(barrier.release, async (owner) => {
          owner.abortOnExit(controller);
          const closing = startClosure(owner, subjectFor(actor, "user"));
          await waitForBarrierEntry(barrier.entered, closing);
          const starting = owner.start(
            computerUse.requestStartComputerUseHost(
              actor,
              [200, 403],
              { hostName: "Blocked Desktop" },
              controller.signal,
            ),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          expect(
            (
              await computerUse.requestStartComputerUseHost(unrelated, [200], {
                hostName: "Unrelated Desktop",
              })
            ).status,
          ).toBe(200);

          if (failureMode === "abort") {
            controller.abort(
              new DOMException("Abort during B1 wait", "AbortError"),
            );
            barrier.release();
          }
          await starting.acceptFailureAfter((error) => {
            expect(String(error)).toMatch(
              /AbortError|Unknown response status 500/,
            );
          });
          barrier.release();
          closedJobId = valueOf(await closing.settled).jobId;
        });
      }, context.signal);

      expect(
        countPublishedTo(context.mocks, {
          channel: `user:${actor.userId}`,
          topic: HOSTS_CHANGED,
        }),
      ).toBe(0);
      expect(
        countPublishedTo(context.mocks, {
          channel: `user:${unrelated.userId}`,
          topic: HOSTS_CHANGED,
        }),
      ).toBe(1);
      await removeErasureSubjectsFixture([closedJobId]);
      await expect(
        erasureSubjectJobExistsFixture(closedJobId),
      ).resolves.toBeFalsy();
      await expect(
        computerUse.listComputerUseHosts(actor),
      ).resolves.toStrictEqual(before);
      expect(
        (
          await computerUse.requestStartComputerUseHost(actor, [200], {
            hostName: "Recovered Desktop",
          })
        ).status,
      ).toBe(200);
    },
  );

  it(
    "takes one fresh clock after a real admission wait",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const holder = await holdOpenErasureSubjectLockFixture({
        subject: subjectFor(actor, "user"),
        signal: context.signal,
      });
      await clearPublications();

      await withOperationOwnership(holder.release, async (owner) => {
        const starting = owner.start(
          computerUse.requestStartComputerUseHost(actor, [200], {
            installationId: randomUUID(),
            hostName: "Fresh Clock Desktop",
          }),
        );
        await expect
          .poll(holder.blockedWaiterCount, BLOCKED)
          .toBeGreaterThanOrEqual(1);
        mockNow(STARTED_AT_MS + 12_345);
        await holder.release();
        const response = valueOf(await starting.settled);
        const host = hostById(
          (await computerUse.listComputerUseHosts(actor)).hosts,
          startedBody(response).hostId,
        );
        expect(host.createdAt).toBe("2026-09-20T02:00:12.345Z");
        expect(host.lastSeenAt).toBe("2026-09-20T02:00:12.345Z");
      });
      await expectOneOwnerPublication(actor.userId);
    },
  );

  it(
    "rejects a pre-aborted START before admission and retains healthy recovery",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const before = await computerUse.listComputerUseHosts(actor);
      const controller = new AbortController();
      controller.abort(new DOMException("Pre-aborted", "AbortError"));
      await clearPublications();

      const failed = await settleIncludingAbort(
        computerUse.requestStartComputerUseHost(
          actor,
          [200, 403],
          { hostName: "Never Written" },
          controller.signal,
        ),
      );
      expect(failed.ok).toBeFalsy();
      if (!failed.ok) {
        expect(String(failed.error)).toMatch(
          /AbortError|Unknown response status 500/,
        );
      }
      await expect(
        computerUse.listComputerUseHosts(actor),
      ).resolves.toStrictEqual(before);
      await expectNoPublications();
      expect(
        (
          await computerUse.requestStartComputerUseHost(actor, [200], {
            hostName: "Healthy Recovery",
          })
        ).status,
      ).toBe(200);
    },
  );

  it.each(["legacy", "installation"] as const)(
    "rolls back a %s write when aborted after PostgreSQL returned its row",
    { timeout: CASE_TIMEOUT_MS },
    async (mode) => {
      const actor = orgScoped(bdd.user());
      const installationId = randomUUID();
      const baseline =
        mode === "installation"
          ? await computerUse.startComputerUseHost(
              actor,
              startOptions(mode, installationId, "Returned Row Baseline"),
            )
          : undefined;
      const before = await computerUse.listComputerUseHosts(actor);
      const controller = new AbortController();
      await clearPublications();

      await withComputerUseHostStartTransactionBarrierFixture(
        {
          target: targetFor(
            actor,
            mode === "installation" ? installationId : undefined,
          ),
          stopAt: "write",
          writeMode: mode,
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              owner.abortOnExit(controller);
              const starting = owner.start(
                computerUse.requestStartComputerUseHost(
                  actor,
                  [200, 403],
                  startOptions(mode, installationId, "Returned Then Aborted"),
                  controller.signal,
                ),
              );
              const entry = await waitForBarrierEntry(
                barrier.entered,
                starting,
              );
              expect(entry.rowCount).toBe(1);
              controller.abort(
                new DOMException("After returned write", "AbortError"),
              );
              barrier.release();
              await starting.acceptFailureAfter((error) => {
                expect(String(error)).toMatch(
                  /AbortError|Unknown response status 500/,
                );
              });
            });
          },
        },
        context.signal,
      );

      await expect(
        computerUse.listComputerUseHosts(actor),
      ).resolves.toStrictEqual(before);
      await expectNoPublications();
      if (baseline) {
        await computerUse.requestComputerUseHeartbeat(
          baseline.hostToken,
          [200],
        );
      }
    },
  );

  it(
    "releases and joins writer plus closure when the concurrency callback exits early, then removes only its job",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const sentinel = new Error("intentional host START callback exit");
      let closureSettlement:
        | Promise<Settled<{ readonly jobId: string }>>
        | undefined;

      const exited = await settleIncludingAbort(
        withComputerUseHostStartTransactionBarrierFixture(
          {
            target: targetFor(actor),
            stopAt: "commit",
            writeMode: "legacy",
            work: async (barrier) => {
              await withOperationOwnership(barrier.release, async (owner) => {
                const starting = owner.start(
                  computerUse.requestStartComputerUseHost(actor, [200], {
                    hostName: "Early Exit Writer",
                  }),
                );
                await waitForBarrierEntry(barrier.entered, starting);
                const closing = startClosure(owner, subjectFor(actor, "user"));
                closureSettlement = closing.settled;
                await expect
                  .poll(barrier.blockedWaiterCount, BLOCKED)
                  .toBeGreaterThanOrEqual(1);
                throw sentinel;
              });
            },
          },
          context.signal,
        ),
      );
      expect(exited).toStrictEqual({ ok: false, error: sentinel });
      if (!closureSettlement) {
        throw new Error("Expected the early-exit closure to be owned");
      }
      const closed = valueOf(await closureSettlement);
      await expect(
        erasureSubjectJobExistsFixture(closed.jobId),
      ).resolves.toBeTruthy();

      await removeErasureSubjectsFixture([closed.jobId]);
      await expect(
        erasureSubjectJobExistsFixture(closed.jobId),
      ).resolves.toBeFalsy();
      expect(
        (await computerUse.listComputerUseHosts(actor)).hosts.map((host) => {
          return host.displayName;
        }),
      ).toContain("Early Exit Writer");
      expect(
        (
          await computerUse.requestStartComputerUseHost(actor, [200], {
            hostName: "After Early Exit",
          })
        ).status,
      ).toBe(200);
    },
  );

  it(
    "does not claim rollback when abort arrives after COMMIT has executed",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const installationId = randomUUID();
      const baseline = await computerUse.startComputerUseHost(
        actor,
        startOptions("installation", installationId, "Commit Baseline"),
      );
      const createdAt = hostById(
        (await computerUse.listComputerUseHosts(actor)).hosts,
        baseline.hostId,
      ).createdAt;
      const controller = new AbortController();
      await clearPublications();

      await withComputerUseHostStartTransactionBarrierFixture(
        {
          target: targetFor(actor, installationId),
          stopAt: "commit",
          writeMode: "installation",
          pauseAfterCommit: true,
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              owner.abortOnExit(controller);
              const starting = owner.start(
                computerUse.requestStartComputerUseHost(
                  actor,
                  [200, 403],
                  startOptions(
                    "installation",
                    installationId,
                    "Committed Without Response",
                  ),
                  controller.signal,
                ),
              );
              await waitForBarrierEntry(barrier.entered, starting);
              controller.abort(
                new DOMException("After final check", "AbortError"),
              );
              barrier.release();
              await starting.acceptFailureAfter((error) => {
                expect(String(error)).toMatch(
                  /AbortError|Unknown response status 500/,
                );
              });
            });
          },
        },
        context.signal,
      );

      const committed = hostById(
        (await computerUse.listComputerUseHosts(actor)).hosts,
        baseline.hostId,
      );
      expect(committed).toMatchObject({
        createdAt,
        displayName: "Committed Without Response",
      });
      await computerUse.requestComputerUseHeartbeat(baseline.hostToken, [401]);
      await expectNoPublications();
    },
  );
});
