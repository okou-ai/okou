import { randomUUID } from "node:crypto";

import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { aroundEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import {
  closeErasureSubjectFixture,
  removeErasureSubjectsFixture,
  withErasureSubjectClosureCommitBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { withComputerUseHostDirectoryBarrierFixture } from "../../../test-fixtures/computer-use-host-directory-erasure";
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
      "Concurrent host-directory test work and cleanup failed",
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
  throw new Error("Host-directory operation completed before barrier entry");
}

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (actor.orgId === null) {
    throw new Error("Computer Use host directories require an organization");
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

async function startRetainedHost(actor: ApiTestUser, hostName: string) {
  return await computerUse.startComputerUseHost(actor, {
    installationId: randomUUID(),
    hostName,
    supportedCapabilities: ["apps.list", "element.click"],
    permissions: { accessibility: true, screenRecording: false },
  });
}

describe("standalone Computer Use host directory account-erasure fence", () => {
  it(
    "preserves session, PAT and Agent auth controls at the route boundary",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startRetainedHost(actor, "Auth Desktop");

      const unauthenticated = await computerUse.requestListComputerUseHosts(
        null,
        [401],
      );
      expectApiError(unauthenticated.body);

      const noOrganization = bdd.user({ orgId: null });
      const missingOrganization = await computerUse.requestListComputerUseHosts(
        noOrganization,
        [401],
      );
      expectApiError(missingOrganization.body);

      const session = await computerUse.listComputerUseHosts(actor);
      expect(
        session.hosts.map((item) => {
          return item.id;
        }),
      ).toStrictEqual([host.hostId]);

      const { token: pat } = await authOrg.createCliToken(actor);
      mockClerkMembership(context, actor, "org:admin");
      const personalAccessToken = await computerUse.listComputerUseHosts({
        bearer: pat,
      });
      expect(personalAccessToken).toStrictEqual(session);

      const missingCapability = computerUseToken({
        userId: actor.userId,
        orgId: actor.orgId,
        capabilities: [],
        computerUseHostId: host.hostId,
      });
      const capabilityDenied = await computerUse.requestListComputerUseHosts(
        { bearer: missingCapability.token },
        [403],
      );
      expectApiError(capabilityDenied.body);

      const unbound = computerUseToken({
        userId: actor.userId,
        orgId: actor.orgId,
        capabilities: ["computer-use:write"],
      });
      const bindingDenied = await computerUse.requestListComputerUseHosts(
        { bearer: unbound.token },
        [403],
      );
      expect(bindingDenied.body).toStrictEqual({
        error: {
          message: "Computer-use host is not authorized for this run",
          code: "FORBIDDEN",
        },
      });
    },
  );

  it(
    "returns the complete ordered online, stale and stopped-installation directory without foreign or revoked hosts",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const sameOrgPeer = orgScoped(bdd.user({ orgId: actor.orgId }));
      const foreignOrg = orgScoped(bdd.user({ orgId: `org_${randomUUID()}` }));

      const stale = await computerUse.startComputerUseHost(actor, {
        hostName: "Stale Desktop",
        supportedCapabilities: ["apps.list"],
        permissions: { accessibility: false, screenRecording: true },
      });
      mockNow(STARTED_AT_MS + 1000);
      const stopped = await startRetainedHost(actor, "Stopped Desktop");
      await computerUse.stopComputerUseHost(stopped.hostToken);
      mockNow(STARTED_AT_MS + 2000);
      const current = await computerUse.startComputerUseHost(actor, {
        hostName: "Current Desktop",
        supportedCapabilities: ["apps.list", "element.click"],
        permissions: { accessibility: true, screenRecording: false },
      });
      const revoked = await computerUse.startComputerUseHost(actor, {
        hostName: "Revoked Desktop",
      });
      await computerUse.stopComputerUseHost(revoked.hostToken);
      const peer = await computerUse.startComputerUseHost(sameOrgPeer, {
        hostName: "Peer Desktop",
      });
      const foreign = await computerUse.startComputerUseHost(foreignOrg, {
        hostName: "Foreign Desktop",
      });

      mockNow(STARTED_AT_MS + 120_000);
      await computerUse.heartbeatComputerUseHost(current.hostToken, {
        hostName: "Current Desktop",
        supportedCapabilities: ["apps.list", "element.click"],
        permissions: { accessibility: true, screenRecording: false },
      });
      clearPublications();

      const directory = await computerUse.listComputerUseHosts(actor);
      expect(
        directory.hosts.map((host) => {
          return host.id;
        }),
      ).toStrictEqual([current.hostId, stopped.hostId, stale.hostId]);
      expect(
        directory.hosts.map((host) => {
          return host.status;
        }),
      ).toStrictEqual(["online", "offline", "offline"]);
      expect(directory.hosts[0]).toStrictEqual({
        id: current.hostId,
        hostName: "Current Desktop",
        displayName: "Current Desktop",
        appVersion: "0.1.0",
        osVersion: "macOS 15",
        supportedCapabilities: ["apps.list", "element.click"],
        permissions: {
          accessibility: true,
          screenRecording: false,
          automation: {
            chrome: { status: "unknown", updatedAt: null, reason: null },
            safari: { status: "unknown", updatedAt: null, reason: null },
          },
        },
        status: "online",
        lastSeenAt: new Date(STARTED_AT_MS + 120_000).toISOString(),
        createdAt: new Date(STARTED_AT_MS + 2000).toISOString(),
      });
      expect(JSON.stringify(directory)).not.toContain(revoked.hostId);
      expect(JSON.stringify(directory)).not.toContain(peer.hostId);
      expect(JSON.stringify(directory)).not.toContain(foreign.hostId);
      expectNoPublications();
    },
  );

  it(
    "keeps Agent discovery bound to its one valid host without requiring a persisted run, Agent or thread",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const peer = orgScoped(bdd.user({ orgId: actor.orgId }));
      const other = await startRetainedHost(actor, "Other Desktop");
      const bound = await startRetainedHost(actor, "Bound Offline Desktop");
      await computerUse.stopComputerUseHost(bound.hostToken);
      const foreign = await startRetainedHost(peer, "Peer Desktop");
      const revoked = await computerUse.startComputerUseHost(actor, {
        hostName: "Revoked Desktop",
      });
      await computerUse.stopComputerUseHost(revoked.hostToken);
      mockClerkMembership(context, actor, "org:admin");

      const tokenFor = (computerUseHostId: string) => {
        return computerUseToken({
          userId: actor.userId,
          orgId: actor.orgId,
          capabilities: ["computer-use:write"],
          computerUseHostId,
          // This run label deliberately has no persisted Run, Agent or thread.
          runId: randomUUID(),
        }).token;
      };

      const listed = await computerUse.listComputerUseHosts({
        bearer: tokenFor(bound.hostId),
      });
      expect(listed.hosts).toStrictEqual([
        expect.objectContaining({
          id: bound.hostId,
          hostName: "Bound Offline Desktop",
          status: "offline",
        }),
      ]);
      expect(JSON.stringify(listed)).not.toContain(other.hostId);

      for (const absentBinding of [
        randomUUID(),
        foreign.hostId,
        revoked.hostId,
      ]) {
        const absent = await computerUse.listComputerUseHosts({
          bearer: tokenFor(absentBinding),
        });
        expect(absent.hosts).toStrictEqual([]);
      }
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
    "denies a closed %s with a generic 403 and restores the exact directory",
    { timeout: CASE_TIMEOUT_MS },
    async (subjectKind, subjectId) => {
      const actor = orgScoped(bdd.user());
      const first = await startRetainedHost(actor, "Private Alpha");
      mockNow(STARTED_AT_MS + 1000);
      const second = await startRetainedHost(actor, "Private Beta");
      await computerUse.stopComputerUseHost(second.hostToken);
      const before = await computerUse.listComputerUseHosts(actor);
      clearPublications();

      const closed = await closeSubject({
        subjectKind,
        subjectId: subjectId(actor),
      });
      const denied = await computerUse.requestListComputerUseHosts(
        actor,
        [403],
      );
      expect(denied.body).toStrictEqual({
        error: {
          message: "Computer-use host directory is not available",
          code: "FORBIDDEN",
        },
      });
      const deniedBytes = JSON.stringify(denied.body);
      for (const secret of [
        first.hostId,
        second.hostId,
        "Private Alpha",
        "Private Beta",
        "permissions",
        "lastSeenAt",
        "createdAt",
      ]) {
        expect(deniedBytes).not.toContain(secret);
      }
      expectNoPublications();

      await removeErasureSubjectsFixture([closed.jobId]);
      const restored = await computerUse.listComputerUseHosts(actor);
      expect(restored).toStrictEqual(before);
      expectNoPublications();
    },
  );

  it(
    "lets read-first return while closure waits on its real B1 edge, then denies the next read",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const unrelated = orgScoped(bdd.user());
      const host = await startRetainedHost(actor, "Read First Desktop");
      const unrelatedHost = await startRetainedHost(
        unrelated,
        "Unrelated Desktop",
      );

      await withComputerUseHostDirectoryBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const reading = owner.start(
                computerUse.listComputerUseHosts(actor),
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
                await computerUse.listComputerUseHosts(unrelated);
              expect(
                progressing.hosts.map((item) => {
                  return item.id;
                }),
              ).toStrictEqual([unrelatedHost.hostId]);

              barrier.release();
              const admitted = valueOf(await reading.settled);
              expect(
                admitted.hosts.map((item) => {
                  return item.id;
                }),
              ).toStrictEqual([host.hostId]);
              valueOf(await closing.settled);
            });
          },
        },
        context.signal,
      );

      const denied = await computerUse.requestListComputerUseHosts(
        actor,
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
      const host = await startRetainedHost(actor, "Closure First Desktop");

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
            computerUse.requestListComputerUseHosts(actor, [403]),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);

          barrier.release();
          valueOf(await closing.settled);
          const denied = valueOf(await reading.settled);
          expect(denied.status).toBe(403);
          expect(JSON.stringify(denied.body)).not.toContain(host.hostId);
        });
      }, context.signal);
    },
  );

  it(
    "allows two same-owner reads to complete without a lock-upgrade cycle",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startRetainedHost(actor, "Concurrent Desktop");

      await withComputerUseHostDirectoryBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const first = owner.start(
                computerUse.listComputerUseHosts(actor),
              );
              await waitForBarrierEntry(barrier.entered, first);
              const second = owner.start(
                computerUse.listComputerUseHosts(actor),
              );
              const concurrent = valueOf(await second.settled);
              expect(
                concurrent.hosts.map((item) => {
                  return item.id;
                }),
              ).toStrictEqual([host.hostId]);
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
    "propagates the scoped admission lock timeout instead of fabricating closure",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const unrelated = orgScoped(bdd.user());
      await startRetainedHost(actor, "Timed Desktop");
      const unrelatedHost = await startRetainedHost(
        unrelated,
        "Progress Desktop",
      );

      await withErasureSubjectClosureCommitBarrierFixture(async (barrier) => {
        await withOperationOwnership(barrier.release, async (owner) => {
          const closing = owner.start(
            closeSubject({ subjectKind: "user", subjectId: actor.userId }),
          );
          await waitForBarrierEntry(barrier.entered, closing);
          const reading = owner.start(
            computerUse.requestListComputerUseHosts(actor, [200, 403]),
          );
          await expect
            .poll(barrier.blockedWaiterCount, BLOCKED)
            .toBeGreaterThanOrEqual(1);
          const progress = await computerUse.listComputerUseHosts(unrelated);
          expect(
            progress.hosts.map((item) => {
              return item.id;
            }),
          ).toStrictEqual([unrelatedHost.hostId]);

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
    "propagates operation abort after the host projection and releases the transaction",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startRetainedHost(actor, "Abort Desktop");
      const cancelled = new AbortController();

      await withComputerUseHostDirectoryBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          stopAt: "hosts",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              owner.abortOnExit(cancelled);
              const reading = owner.start(
                computerUse.requestListComputerUseHosts(
                  actor,
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

      const recovered = await computerUse.listComputerUseHosts(actor);
      expect(
        recovered.hosts.map((item) => {
          return item.id;
        }),
      ).toStrictEqual([host.hostId]);
    },
  );

  it(
    "records the folded B1 probe, exact host query, cardinality and response bytes",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      await startRetainedHost(actor, "Measured Alpha");
      mockNow(STARTED_AT_MS + 1000);
      const second = await startRetainedHost(actor, "Measured Beta");
      await computerUse.stopComputerUseHost(second.hostToken);
      let responseBytes = 0;

      await withComputerUseHostDirectoryBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          stopAt: "commit",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const reading = owner.start(
                computerUse.listComputerUseHosts(actor),
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
              expect(statements[3]).toContain('from "computer_use_hosts"');
              expect(statements[3]).toContain(
                '"computer_use_hosts"."revoked_at" is null',
              );
              expect(statements[3]).toContain(
                'order by "computer_use_hosts"."last_seen_at" desc',
              );
              expect(statements[3]).not.toContain(" limit ");
              expect(statements[3]).not.toContain(" for ");
              expect(statements[4]).toBe("commit");

              barrier.release();
              const response = valueOf(await reading.settled);
              expect(response.hosts).toHaveLength(2);
              responseBytes = Buffer.byteLength(JSON.stringify(response));
              expect(responseBytes).toBe(1006);
            });
          },
        },
        context.signal,
      );
      expect(responseBytes).toBeGreaterThan(0);
    },
  );

  it(
    "joins reader and closure on early exit and surfaces failure before barrier entry",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startRetainedHost(actor, "Lifecycle Desktop");

      let earlyRead:
        | OwnedOperation<
            Awaited<ReturnType<typeof computerUse.listComputerUseHosts>>
          >
        | undefined;
      let earlyClosure: OwnedOperation<{ readonly jobId: string }> | undefined;
      await expect(
        withComputerUseHostDirectoryBarrierFixture(
          {
            orgId: actor.orgId,
            userId: actor.userId,
            stopAt: "hosts",
            work: async (barrier) => {
              await withOperationOwnership(barrier.release, async (owner) => {
                earlyRead = owner.start(
                  computerUse.listComputerUseHosts(actor),
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
                throw new Error("deliberate host-directory early exit");
              });
            },
          },
          context.signal,
        ),
      ).rejects.toThrow("deliberate host-directory early exit");
      if (!earlyRead || !earlyClosure) {
        throw new Error("Expected the early-exit operations to start");
      }
      expect(
        valueOf(await earlyRead.settled).hosts.map((item) => {
          return item.id;
        }),
      ).toStrictEqual([host.hostId]);
      const closed = valueOf(await earlyClosure.settled);
      await removeErasureSubjectsFixture([closed.jobId]);

      await withComputerUseHostDirectoryBarrierFixture(
        {
          orgId: actor.orgId,
          userId: actor.userId,
          stopAt: "hosts",
          work: async (barrier) => {
            await withOperationOwnership(barrier.release, async (owner) => {
              const failedBeforeEntry = owner.start(
                computerUse.listComputerUseHosts(null),
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
                computerUse.listComputerUseHosts(actor),
              );
              await waitForBarrierEntry(barrier.entered, recovery);
              barrier.release();
              expect(
                valueOf(await recovery.settled).hosts.map((item) => {
                  return item.id;
                }),
              ).toStrictEqual([host.hostId]);
            });
          },
        },
        context.signal,
      );

      const rejectedSetup = new AbortController();
      rejectedSetup.abort(new DOMException("Rejected setup", "AbortError"));
      await expect(
        withComputerUseHostDirectoryBarrierFixture(
          {
            orgId: actor.orgId,
            userId: actor.userId,
            stopAt: "hosts",
            work: () => {
              return Promise.reject(new Error("setup must not enter work"));
            },
          },
          rejectedSetup.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });

      const healthy = await computerUse.listComputerUseHosts(actor);
      expect(
        healthy.hosts.map((item) => {
          return item.id;
        }),
      ).toStrictEqual([host.hostId]);
    },
  );
});
