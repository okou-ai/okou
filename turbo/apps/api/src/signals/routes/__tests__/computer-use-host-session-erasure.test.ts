import type { ErasureSubject } from "@okouai/db/operations/account-erasure";
import { aroundEach, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { withMockNowForTest } from "../../../lib/time";
import {
  classifyErasureFenceStatement,
  closeErasureSubjectFixture,
  erasureFenceStatementKinds,
  removeErasureSubjectsFixture,
} from "../../../test-fixtures/account-erasure-subject";
import {
  classifyComputerUseHostSessionSql,
  withComputerUseHostSessionBarrierFixture,
} from "../../../test-fixtures/computer-use-host-session-erasure";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";

const context = testContext();
const bdd = createBddApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-21T08:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function orgScoped(
  actor: ApiTestUser,
): ApiTestUser & { readonly orgId: string } {
  if (actor.orgId === null) {
    throw new Error("Computer Use host sessions require an organization");
  }
  return { ...actor, orgId: actor.orgId };
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

function classifySql(statement: string): string {
  return (
    classifyComputerUseHostSessionSql(statement) ??
    classifyErasureFenceStatement(statement) ??
    statement
  );
}

async function startHost(actor: ApiTestUser & { readonly orgId: string }) {
  return await computerUse.startComputerUseHost(actor, {
    hostName: "Session Desktop",
  });
}

/**
 * These four endpoints authenticate by host token, so their erasure subjects
 * are only known after the host row is read. They are also the highest
 * frequency Computer Use calls, which is why the fence here is the folded
 * write template rather than the original per-subject one.
 */
describe("Computer Use host session account-erasure fence", () => {
  it.each(["user", "organization"] as const)(
    "refuses heartbeat for a closed %s and writes nothing to the host row",
    { timeout: CASE_TIMEOUT_MS },
    async (subjectKind) => {
      const actor = orgScoped(bdd.user());
      const host = await startHost(actor);
      const before = await computerUse.listComputerUseHosts(actor);
      const closed = await closeSubject({
        subjectKind,
        subjectId: subjectKind === "user" ? actor.userId : actor.orgId,
      });

      const refused = await computerUse.requestComputerUseHeartbeat(
        host.hostToken,
        [403],
      );
      expect(refused.status).toBe(403);
      expectApiError(refused.body);

      await removeErasureSubjectsFixture([closed.jobId]);
      const after = await computerUse.listComputerUseHosts(actor);
      expect(after.hosts).toStrictEqual(before.hosts);
      await expect(
        computerUse.heartbeatComputerUseHost(host.hostToken),
      ).resolves.toMatchObject({ ok: true, hostId: host.hostId });
    },
  );

  it.each(["user", "organization"] as const)(
    "refuses stop for a closed %s and leaves the host unrevoked",
    { timeout: CASE_TIMEOUT_MS },
    async (subjectKind) => {
      const actor = orgScoped(bdd.user());
      const host = await startHost(actor);
      const closed = await closeSubject({
        subjectKind,
        subjectId: subjectKind === "user" ? actor.userId : actor.orgId,
      });

      const refused = await computerUse.requestStopComputerUseHost(
        host.hostToken,
        [403],
      );
      expect(refused.status).toBe(403);
      expectApiError(refused.body);

      await removeErasureSubjectsFixture([closed.jobId]);
      const after = await computerUse.listComputerUseHosts(actor);
      expect(
        after.hosts.map((item) => {
          return item.id;
        }),
      ).toStrictEqual([host.hostId]);
      await expect(
        computerUse.stopComputerUseHost(host.hostToken),
      ).resolves.toMatchObject({ ok: true, hostId: host.hostId });
    },
  );

  it.each(["user", "organization"] as const)(
    "refuses a command claim for a closed %s and leaves the command queued",
    { timeout: CASE_TIMEOUT_MS },
    async (subjectKind) => {
      const actor = orgScoped(bdd.user());
      const host = await startHost(actor);
      const created = await computerUse.createComputerUseReadCommand(actor, {
        kind: "apps.list",
      });
      const closed = await closeSubject({
        subjectKind,
        subjectId: subjectKind === "user" ? actor.userId : actor.orgId,
      });

      const refused = await computerUse.requestClaimNextComputerUseCommand(
        host.hostToken,
        [403],
      );
      expect(refused.status).toBe(403);
      expectApiError(refused.body);

      // The claim is a write: it flips the command to running and stamps the
      // host. Refusing it must leave both untouched, which the successful
      // claim after restoration proves by still finding the same command.
      await removeErasureSubjectsFixture([closed.jobId]);
      await expect(
        computerUse.claimNextComputerUseCommand(host.hostToken),
      ).resolves.toMatchObject({
        status: "command",
        command: { id: created.commandId },
      });
    },
  );

  it.each(["user", "organization"] as const)(
    "refuses a command completion for a closed %s and keeps it running",
    { timeout: CASE_TIMEOUT_MS },
    async (subjectKind) => {
      const actor = orgScoped(bdd.user());
      const host = await startHost(actor);
      const created = await computerUse.createComputerUseReadCommand(actor, {
        kind: "apps.list",
      });
      await computerUse.claimNextComputerUseCommand(host.hostToken);
      const closed = await closeSubject({
        subjectKind,
        subjectId: subjectKind === "user" ? actor.userId : actor.orgId,
      });

      const refused = await computerUse.requestCompleteComputerUseCommand(
        host.hostToken,
        created.commandId,
        { status: "succeeded", result: { apps: [] } },
        [403],
      );
      expect(refused.status).toBe(403);
      expectApiError(refused.body);

      await removeErasureSubjectsFixture([closed.jobId]);
      await expect(
        computerUse.requestCompleteComputerUseCommand(
          host.hostToken,
          created.commandId,
          { status: "succeeded", result: { apps: [] } },
          [200],
        ),
      ).resolves.toMatchObject({ status: 200 });
    },
  );

  it(
    "takes subject admission before any host row lock and pays only the write template",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startHost(actor);

      const statements = await withComputerUseHostSessionBarrierFixture(
        {
          orgId: actor.orgId,
          stopAt: "commit",
          work: async (barrier) => {
            const beating = computerUse.heartbeatComputerUseHost(
              host.hostToken,
            );
            const entered = await barrier.entered;
            expect(entered).toMatchObject({
              lockTimeout: "1s",
              statementTimeout: "5s",
              transactionTimeout: "0",
            });
            const captured = barrier.statements();
            barrier.release();
            await beating;
            return captured;
          },
        },
        context.signal,
      );

      const shape = statements.map(classifySql);
      // Deadlines, then the unlocked resolution that tells admission which
      // subjects to lock, then the folded write template, then the business
      // row lock. The unlocked read is the only statement this fence adds
      // beyond the template, and it is what makes the order possible.
      expect(shape).toStrictEqual([
        "BEGIN READ COMMITTED",
        "FENCE DEADLINES",
        "UNLOCKED HOST IDENTITY BY TOKEN",
        ...erasureFenceStatementKinds("write").filter((kind) => {
          return kind !== "FENCE DEADLINES";
        }),
        "LOCKED HOST ROW BY TOKEN",
        "HOST UPDATE",
        "COMMIT",
      ]);

      // The whole point of resolving the host without a lock first: admission
      // is complete before any business row is locked, so this path cannot
      // deadlock against a closure that locks subjects first and rows after.
      const subjectLock = shape.indexOf("B1 SUBJECT LOCKS");
      const closedLookup = shape.indexOf("B1 CLOSED LOOKUP");
      const lockedRow = shape.indexOf("LOCKED HOST ROW BY TOKEN");
      expect(subjectLock).toBeGreaterThanOrEqual(0);
      expect(closedLookup).toBeGreaterThan(subjectLock);
      expect(lockedRow).toBeGreaterThan(closedLookup);
      expect(
        statements.filter((statement) => {
          return statement.includes("pg_advisory_xact_lock");
        }),
      ).toHaveLength(1);
    },
  );
});
