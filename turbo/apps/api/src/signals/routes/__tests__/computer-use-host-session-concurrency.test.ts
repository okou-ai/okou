import { aroundEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";

const context = testContext();

const STARTED_AT_MS = Date.parse("2026-09-23T08:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

/**
 * Host session routes hold no transaction or row lock; each write is a
 * single-row compare-and-set. These run concurrent requests against real
 * PostgreSQL and assert that every interleaving has exactly one winner.
 */
function createScenario() {
  const scenario = createPublicComputerUseScenario(context);
  const bdd = { user: scenario.user };
  const authOrg = { createCliToken: scenario.createCliToken };
  const computerUse = scenario.computerUse;

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
  return {
    ...scenario,
    bdd,
    authOrg,
    computerUse,
    orgScoped,
    startHost,
    commandStatus,
  };
}
describe("Computer Use host session concurrency", () => {
  it(
    "lets only one of several concurrent claims start a command on a host",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const scenario = createScenario();
      const { bdd, computerUse, orgScoped, startHost, commandStatus } =
        scenario;
      return await scenario.run(async () => {
        const actor = orgScoped(bdd.user());
        const host = await startHost(actor);
        const first = await computerUse.createComputerUseReadCommand(actor, {
          kind: "apps.list",
        });
        const second = await computerUse.createComputerUseReadCommand(actor, {
          kind: "apps.list",
        });

        // Claims hold no lock. The queued-status compare-and-set and the
        // one-running-command-per-host unique index make every losing poll
        // report idle, whatever the interleaving.
        const claims = await Promise.all([
          computerUse.claimNextComputerUseCommand(host.connection),
          computerUse.claimNextComputerUseCommand(host.connection),
          computerUse.claimNextComputerUseCommand(host.connection),
        ]);

        expect(
          claims.filter((claim) => {
            return claim.status === "command";
          }),
        ).toMatchObject([{ command: { id: first.commandId } }]);
        await expect(commandStatus(actor, first.commandId)).resolves.toBe(
          "running",
        );
        await expect(commandStatus(actor, second.commandId)).resolves.toBe(
          "queued",
        );
      });
    },
  );

  it(
    "broadcasts one online transition when concurrent heartbeats revive a host",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const scenario = createScenario();
      const { bdd, computerUse, orgScoped, startHost } = scenario;
      return await scenario.run(async () => {
        const actor = orgScoped(bdd.user());
        const host = await startHost(actor);
        // Past the 90s online window, so the next heartbeat is a transition.
        mockNow(STARTED_AT_MS + 120_000);
        context.mocks.ably.publish.mockClear();

        // Whichever heartbeat writes second either reads the revived row or
        // loses its row-version guard and re-reads it, so only one publishes.
        const beats = await Promise.all([
          computerUse.heartbeatComputerUseHost(host.connection),
          computerUse.heartbeatComputerUseHost(host.connection),
          computerUse.heartbeatComputerUseHost(host.connection),
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
      });
    },
  );

  it(
    "records exactly one completion when a host reports the same command concurrently",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const scenario = createScenario();
      const { bdd, computerUse, orgScoped, startHost, commandStatus } =
        scenario;
      return await scenario.run(async () => {
        const actor = orgScoped(bdd.user());
        const host = await startHost(actor);
        // Write commands are the ones that record a completion audit event.
        const created = await computerUse.createComputerUseWriteCommand(actor, {
          kind: "app.open",
          app: "Finder",
          timeoutMs: 15_000,
        });
        await computerUse.claimNextComputerUseCommand(host.connection);

        const responses = await Promise.all([
          computerUse.requestCompleteComputerUseCommand(
            host.connection,
            created.commandId,
            { status: "succeeded", result: {} },
            [200],
          ),
          computerUse.requestCompleteComputerUseCommand(
            host.connection,
            created.commandId,
            { status: "succeeded", result: {} },
            [200],
          ),
        ]);
        expect(
          responses.map((response) => {
            return response.status;
          }),
        ).toStrictEqual([200, 200]);
        await expect(commandStatus(actor, created.commandId)).resolves.toBe(
          "succeeded",
        );
        const audit = await computerUse.listComputerUseAuditEvents(actor, {
          commandId: created.commandId,
        });
        expect(audit.auditEvents).toHaveLength(1);
      });
    },
  );

  it(
    "lets only one of two concurrent stops end the host session",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const scenario = createScenario();
      const { bdd, computerUse, orgScoped, startHost } = scenario;
      return await scenario.run(async () => {
        const actor = orgScoped(bdd.user());
        const host = await startHost(actor);

        const responses = await Promise.all([
          computerUse.requestStopComputerUseHost(host.connection, [200, 409]),
          computerUse.requestStopComputerUseHost(host.connection, [200, 409]),
        ]);
        expect(
          responses
            .map((response) => {
              return response.status;
            })
            .sort(),
        ).toStrictEqual([200, 409]);
        const afterStop = await computerUse.requestComputerUseHeartbeat(
          host.connection,
          [409],
        );
        expect(afterStop.status).toBe(409);
        const listed = await computerUse.listComputerUseHosts(actor);
        expect(listed.hosts).toMatchObject([
          { id: host.hostId, status: "offline" },
        ]);
      });
    },
  );
});
