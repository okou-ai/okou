import type { ComputerUseTestConnection } from "./helpers/api-bdd-computer-use";
import { randomUUID } from "node:crypto";

import { aroundEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { expectApiError, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";

const context = testContext();

const STARTED_AT_MS = Date.parse("2026-09-18T12:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;

interface RunningCommand {
  readonly commandId: string;
  readonly agentToken: string;
}

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

function createScenario() {
  const scenario = createPublicComputerUseScenario(context);
  const bdd = { user: scenario.user };
  const computerUse = scenario.computerUse;
  const authOrg = { createCliToken: scenario.createCliToken };

  function orgScoped(
    actor: ApiTestUser,
  ): ApiTestUser & { readonly orgId: string } {
    if (actor.orgId === null) {
      throw new Error("Computer Use command reads require an organization");
    }
    return { ...actor, orgId: actor.orgId };
  }

  async function agentTokenFor(
    actor: ApiTestUser,
    hostId: string | undefined,
  ): Promise<string> {
    return (await scenario.claim(actor, hostId)).token;
  }

  async function createRunningWriteCommand(args: {
    readonly actor: ApiTestUser & { readonly orgId: string };
    readonly host: {
      readonly hostId: string;
      readonly connection: ComputerUseTestConnection;
    };
    readonly timeoutMs: number;
    readonly app?: string;
  }): Promise<RunningCommand> {
    const agentToken = await agentTokenFor(args.actor, args.host.hostId);
    const created = await computerUse.createComputerUseWriteCommand(
      { bearer: agentToken },
      {
        kind: "app.open",
        app: args.app ?? "Safari",
        timeoutMs: args.timeoutMs,
      },
    );
    const claimed = await computerUse.claimNextComputerUseCommand(
      args.host.connection,
    );
    expect(claimed).toMatchObject({
      status: "command",
      command: { id: created.commandId, status: "running" },
    });
    return { commandId: created.commandId, agentToken };
  }
  return {
    ...scenario,
    bdd,
    authOrg,
    computerUse,
    orgScoped,
    agentTokenFor,
    createRunningWriteCommand,
  };
}

describe("GET /api/computer-use/commands/:commandId", () => {
  it(
    "preserves session, PAT and supported Agent auth with exact owner and host isolation",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const scenario = createScenario();
      const { bdd, authOrg, computerUse, orgScoped, agentTokenFor } = scenario;
      return await scenario.run(async () => {
        const actor = orgScoped(bdd.user());
        const sameOrgPeer = orgScoped(bdd.user({ orgId: actor.orgId }));
        const foreignOrg = orgScoped(
          bdd.user({ orgId: `org_${randomUUID()}` }),
        );
        const host = await computerUse.startComputerUseHost(actor, {
          hostName: "Bound Desktop",
        });
        const otherHost = await computerUse.startComputerUseHost(actor, {
          hostName: "Wrong Desktop",
        });
        const token = await agentTokenFor(actor, host.hostId);
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
          computerUse.readComputerUseCommand(
            { bearer: pat },
            created.commandId,
          ),
        ).resolves.toStrictEqual(session);
        await expect(
          computerUse.readComputerUseCommand(
            { bearer: token },
            created.commandId,
          ),
        ).resolves.toStrictEqual(session);

        const wrongHost = await agentTokenFor(actor, otherHost.hostId);
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
        const unbound = await agentTokenFor(actor, undefined);
        const capabilityDenied =
          await computerUse.requestReadComputerUseCommand(
            { bearer: unbound },
            created.commandId,
            [403],
          );
        expectApiError(capabilityDenied.body);

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
      });
    },
  );

  it(
    "preserves queued, running, succeeded, failed and offloaded response fields",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const scenario = createScenario();
      const { bdd, computerUse, orgScoped } = scenario;
      return await scenario.run(async () => {
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
          host.connection,
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
          host.connection,
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
        await computerUse.claimNextComputerUseCommand(host.connection);
        await computerUse.completeComputerUseCommandWith(
          host.connection,
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
      });
    },
  );

  it(
    "fails a running command once it passes its timeout, audits it once and keeps late completions from overwriting it",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const scenario = createScenario();
      const { bdd, computerUse, orgScoped, createRunningWriteCommand } =
        scenario;
      return await scenario.run(async () => {
        const actor = orgScoped(bdd.user());
        const host = await computerUse.startComputerUseHost(actor, {
          hostName: "Timeout Desktop",
        });
        const running = await createRunningWriteCommand({
          actor,
          host,
          timeoutMs: 1000,
        });

        mockNow(STARTED_AT_MS + 500);
        await expect(
          computerUse.readComputerUseCommand(actor, running.commandId),
        ).resolves.toMatchObject({ status: "running" });

        mockNow(STARTED_AT_MS + 2000);
        const [first, second] = await Promise.all([
          computerUse.readComputerUseCommand(actor, running.commandId),
          computerUse.readComputerUseCommand(actor, running.commandId),
        ]);
        const timedOut = await computerUse.readComputerUseCommand(
          actor,
          running.commandId,
        );
        expect(timedOut).toMatchObject({
          status: "failed",
          error: {
            code: "timeout",
            message: "Computer-use command timed out after 1000ms",
          },
          completedAt: new Date(STARTED_AT_MS + 2000).toISOString(),
        });
        for (const read of [first, second]) {
          expect(["running", "failed"]).toContain(read.status);
        }
        const audit = await computerUse.listComputerUseAuditEvents(actor, {
          commandId: running.commandId,
        });
        expect(audit.auditEvents).toHaveLength(1);

        await computerUse.completeComputerUseCommand(
          host.connection,
          running.commandId,
        );
        await expect(
          computerUse.readComputerUseCommand(actor, running.commandId),
        ).resolves.toMatchObject({ status: "failed" });
      });
    },
  );
});
