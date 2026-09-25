import { aroundEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { withComputerUseHostSessionBarrierFixture } from "../../../test-fixtures/computer-use-host-session-erasure";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";

const context = testContext();
const bdd = createBddApi(context);
const computerUse = createComputerUseBddApi(context);

const STARTED_AT_MS = Date.parse("2026-09-23T08:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;
const BLOCKED = { interval: 10, timeout: 10_000 } as const;

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

async function startHost(actor: ApiTestUser & { readonly orgId: string }) {
  return await computerUse.startComputerUseHost(actor, {
    hostName: "Lock Desktop",
  });
}

async function commandStatus(
  actor: ApiTestUser,
  commandId: string,
): Promise<string> {
  const command = await computerUse.readComputerUseCommand(actor, commandId);
  return command.status;
}

/**
 * Real PostgreSQL interleavings for the host row lock each host session route
 * holds. The barrier pauses the first route's transaction right after its
 * locked host read, so its lock is held while a second session runs; nothing
 * is mocked and no statement is changed.
 */
describe("Computer Use host session row locks", () => {
  it(
    "lets a new command reference the host while a claim holds its host row",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startHost(actor);

      const outcome = await withComputerUseHostSessionBarrierFixture(
        {
          orgId: actor.orgId,
          stopAt: "locked-host",
          work: async (barrier) => {
            const holding = computerUse.claimNextComputerUseCommand(
              host.hostToken,
            );
            const entered = await barrier.entered;
            expect(entered).toMatchObject({
              rowCount: 1,
              lockTimeout: "1s",
              statementTimeout: "5s",
            });

            // The command INSERT's foreign-key check takes KEY SHARE on the
            // host row. It must not queue behind the held host lock, where
            // it would spend the command route's own 1s lock budget.
            const created = await computerUse.createComputerUseReadCommand(
              actor,
              { kind: "apps.list" },
            );
            await expect(barrier.blockedWaiterCount()).resolves.toBe(0);

            barrier.release();
            return { created, held: await holding };
          },
        },
        context.signal,
      );

      // The command committed while the claim held the host, so the same
      // poll's later candidate read dispatches it.
      expect(outcome.held).toMatchObject({
        status: "command",
        command: { id: outcome.created.commandId, status: "running" },
      });
    },
  );

  it(
    "still makes a new command reference wait for a stop that holds the host",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startHost(actor);

      const created = await withComputerUseHostSessionBarrierFixture(
        {
          orgId: actor.orgId,
          stopAt: "locked-host",
          work: async (barrier) => {
            const stopping = computerUse.stopComputerUseHost(host.hostToken);
            await barrier.entered;

            // Stop keeps FOR UPDATE, which conflicts with the foreign-key
            // KEY SHARE, so this is the contrast the non-stop routes avoid.
            const creating = computerUse.createComputerUseReadCommand(actor, {
              kind: "apps.list",
            });
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            barrier.release();
            await expect(stopping).resolves.toMatchObject({
              ok: true,
              hostId: host.hostId,
            });
            return await creating;
          },
        },
        context.signal,
      );

      await expect(commandStatus(actor, created.commandId)).resolves.toBe(
        "queued",
      );
    },
  );

  it(
    "serializes concurrent claims so one host runs at most one command",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startHost(actor);
      const first = await computerUse.createComputerUseReadCommand(actor, {
        kind: "apps.list",
      });
      const second = await computerUse.createComputerUseReadCommand(actor, {
        kind: "apps.list",
      });

      const claims = await withComputerUseHostSessionBarrierFixture(
        {
          orgId: actor.orgId,
          stopAt: "locked-host",
          work: async (barrier) => {
            const firstClaim = computerUse.claimNextComputerUseCommand(
              host.hostToken,
            );
            await barrier.entered;

            // Each poll picks a different queued row under SKIP LOCKED, so
            // only the host row lock keeps the second poll from starting a
            // second running command.
            const secondClaim = computerUse.claimNextComputerUseCommand(
              host.hostToken,
            );
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            barrier.release();
            return [await firstClaim, await secondClaim] as const;
          },
        },
        context.signal,
      );

      expect(claims).toMatchObject([
        { status: "command", command: { id: first.commandId } },
        { status: "idle" },
      ]);
      await expect(commandStatus(actor, first.commandId)).resolves.toBe(
        "running",
      );
      await expect(commandStatus(actor, second.commandId)).resolves.toBe(
        "queued",
      );
    },
  );

  it(
    "makes a claim wait for a concurrent stop and then refuse the rotated token",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startHost(actor);
      const created = await computerUse.createComputerUseReadCommand(actor, {
        kind: "apps.list",
      });

      const refused = await withComputerUseHostSessionBarrierFixture(
        {
          orgId: actor.orgId,
          stopAt: "locked-host",
          work: async (barrier) => {
            const stopping = computerUse.stopComputerUseHost(host.hostToken);
            await barrier.entered;

            const claiming = computerUse.requestClaimNextComputerUseCommand(
              host.hostToken,
              [401],
            );
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            barrier.release();
            await expect(stopping).resolves.toMatchObject({ ok: true });
            return await claiming;
          },
        },
        context.signal,
      );

      expect(refused.status).toBe(401);
      await expect(commandStatus(actor, created.commandId)).resolves.toBe(
        "queued",
      );
    },
  );

  it(
    "makes a completion wait for a concurrent stop and then refuse the rotated token",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startHost(actor);
      const created = await computerUse.createComputerUseReadCommand(actor, {
        kind: "apps.list",
      });
      await computerUse.claimNextComputerUseCommand(host.hostToken);

      const refused = await withComputerUseHostSessionBarrierFixture(
        {
          orgId: actor.orgId,
          stopAt: "locked-host",
          work: async (barrier) => {
            const stopping = computerUse.stopComputerUseHost(host.hostToken);
            await barrier.entered;

            const completing = computerUse.requestCompleteComputerUseCommand(
              host.hostToken,
              created.commandId,
              { status: "succeeded", result: { apps: [] } },
              [401],
            );
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            barrier.release();
            await expect(stopping).resolves.toMatchObject({ ok: true });
            return await completing;
          },
        },
        context.signal,
      );

      expect(refused.status).toBe(401);
      await expect(commandStatus(actor, created.commandId)).resolves.toBe(
        "running",
      );
    },
  );

  it(
    "makes a stop wait for an in-flight claim before rotating the token",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startHost(actor);
      const created = await computerUse.createComputerUseReadCommand(actor, {
        kind: "apps.list",
      });

      const claimed = await withComputerUseHostSessionBarrierFixture(
        {
          orgId: actor.orgId,
          stopAt: "locked-host",
          work: async (barrier) => {
            const claiming = computerUse.claimNextComputerUseCommand(
              host.hostToken,
            );
            await barrier.entered;

            // The claim's NO KEY UPDATE still excludes stop's FOR UPDATE.
            const stopping = computerUse.stopComputerUseHost(host.hostToken);
            await expect
              .poll(barrier.blockedWaiterCount, BLOCKED)
              .toBeGreaterThanOrEqual(1);

            barrier.release();
            const result = await claiming;
            await expect(stopping).resolves.toMatchObject({
              ok: true,
              hostId: host.hostId,
            });
            return result;
          },
        },
        context.signal,
      );

      expect(claimed).toMatchObject({
        status: "command",
        command: { id: created.commandId },
      });
      const afterStop = await computerUse.requestComputerUseHeartbeat(
        host.hostToken,
        [401],
      );
      expect(afterStop.status).toBe(401);
    },
  );

  it(
    "broadcasts one online transition when concurrent heartbeats revive a host",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const actor = orgScoped(bdd.user());
      const host = await startHost(actor);
      // Past the 90s online window, so the next heartbeat is a transition.
      mockNow(STARTED_AT_MS + 120_000);
      context.mocks.ably.publish.mockClear();

      // Whichever heartbeat writes second either reads the revived row or
      // loses its row-version guard and re-reads it, so only one publishes.
      const beats = await Promise.all([
        computerUse.heartbeatComputerUseHost(host.hostToken),
        computerUse.heartbeatComputerUseHost(host.hostToken),
        computerUse.heartbeatComputerUseHost(host.hostToken),
      ]);
      expect(beats).toMatchObject([
        { ok: true, hostId: host.hostId },
        { ok: true, hostId: host.hostId },
        { ok: true, hostId: host.hostId },
      ]);

      expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        "computerUseHostsChanged",
        null,
      );
      const listed = await computerUse.listComputerUseHosts(actor);
      expect(listed.hosts).toMatchObject([
        { id: host.hostId, status: "online" },
      ]);
    },
  );
});
