import type { ComputerUseTestConnection } from "./helpers/api-bdd-computer-use";
import { aroundEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { expectApiError, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import { channelsPublishedTo } from "./helpers/realtime-publications";

const context = testContext();

const STARTED_AT_MS = Date.parse("2026-09-19T01:00:00.000Z");
const CASE_TIMEOUT_MS = 30_000;
const HOST_CAPABILITIES = ["apps.list", "app.open"] as const;

type CommandKind = "read" | "write";
type ComputerUseAuth = ApiTestUser | { readonly bearer: string } | null;
type CreationStatus = 200 | 400 | 401 | 403 | 404 | 409;
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
    if (!actor.orgId) {
      throw new Error("Computer Use command creation requires an organization");
    }
    return { ...actor, orgId: actor.orgId };
  }

  async function agentAuth(args: {
    readonly actor: ApiTestUser;
    readonly hostId?: string;
  }) {
    const actual = await scenario.claim(args.actor, args.hostId);
    return { bearer: actual.token, runId: actual.runId };
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
    return computerUse.requestCreateComputerUseWriteCommand(
      auth,
      statuses,
      { kind: "app.open", app: "Safari", timeoutMs: 12_002 },
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

  function clearExternalEffects(): void {
    context.mocks.ably.publish.mockClear();
    context.mocks.s3.send.mockClear();
  }

  function expectCommandNotification(
    connection: ComputerUseTestConnection,
  ): void {
    expect(channelsPublishedTo(context.mocks, "commandsChanged")).toStrictEqual(
      [
        `computer-use-host:${connection.actor.userId}:${connection.actor.orgId}:${connection.hostId}:${connection.connectionGeneration}`,
      ],
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "commandsChanged",
      null,
    );
  }

  async function claimAndComplete(args: {
    readonly connection: ComputerUseTestConnection;
    readonly commandId: string;
    readonly capabilities?: readonly string[];
  }): Promise<void> {
    const claimed = await computerUse.claimNextComputerUseCommand(
      args.connection,
      args.capabilities ?? HOST_CAPABILITIES,
    );
    expect(claimed).toMatchObject({
      status: "command",
      command: { id: args.commandId, status: "running" },
    });
    await computerUse.completeComputerUseCommandWith(
      args.connection,
      args.commandId,
      {
        status: "failed",
        error: { code: "app_not_found", message: "R21 test completion" },
      },
    );
  }
  return {
    ...scenario,
    bdd,
    authOrg,
    computerUse,
    orgScoped,
    agentAuth,
    requestCreate,
    createCommand,
    startCapableHost,
    clearExternalEffects,
    expectCommandNotification,
    claimAndComplete,
  };
}

describe("Computer Use command creation", () => {
  it(
    "preserves exact session, PAT and bound Agent creation semantics with public read/claim/audit evidence",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const scenario = createScenario();
      const {
        bdd,
        authOrg,
        computerUse,
        orgScoped,
        agentAuth,
        createCommand,
        startCapableHost,
        clearExternalEffects,
        expectCommandNotification,
        claimAndComplete,
      } = scenario;
      return await scenario.run(async () => {
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
        expectCommandNotification(sessionHost.connection);
        expect(context.mocks.s3.send).not.toHaveBeenCalled();
        await claimAndComplete({
          connection: sessionHost.connection,
          commandId: sessionCreated.commandId,
        });

        const patActor = orgScoped(bdd.user());
        const patHost = await startCapableHost(patActor, "PAT Desktop");
        const { token: pat } = await authOrg.createCliToken(patActor);
        mockClerkMembership(context, patActor, "org:admin");
        clearExternalEffects();
        const patCreated = await createCommand("write", { bearer: pat });
        expectCommandNotification(patHost.connection);
        const patClaimed = await computerUse.claimNextComputerUseCommand(
          patHost.connection,
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
          patHost.connection,
          patCreated.commandId,
        );
        const patAudit = await computerUse.listComputerUseAuditEvents(
          patActor,
          {
            commandId: patCreated.commandId,
          },
        );
        expect(patAudit.auditEvents).toHaveLength(1);
        expect(patAudit.auditEvents[0]).toMatchObject({
          commandId: patCreated.commandId,
          runId: null,
        });

        const agentActor = orgScoped(bdd.user());
        const agentHost = await startCapableHost(agentActor, "Agent Desktop");
        const agent = await agentAuth({
          actor: agentActor,
          hostId: agentHost.hostId,
        });
        clearExternalEffects();
        const agentCreated = await createCommand("write", {
          bearer: agent.bearer,
        });
        expectCommandNotification(agentHost.connection);
        const agentClaimed = await computerUse.claimNextComputerUseCommand(
          agentHost.connection,
          HOST_CAPABILITIES,
        );
        expect(agentClaimed).toMatchObject({
          status: "command",
          command: {
            id: agentCreated.commandId,
            hostId: agentHost.hostId,
            kind: "app.open",
            timeoutMs: 12_002,
            payload: { app: "Safari" },
          },
        });
        await computerUse.completeComputerUseCommandWith(
          agentHost.connection,
          agentCreated.commandId,
          {
            status: "succeeded",
            result: {
              app: "Safari",
              opened: true,
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
          kind: "app.open",
        });
      });
    },
  );

  it(
    "keeps authentication, bound-host and 404/409 eligibility precedence unchanged",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const scenario = createScenario();
      const {
        bdd,
        computerUse,
        orgScoped,
        agentAuth,
        requestCreate,
        startCapableHost,
      } = scenario;
      return await scenario.run(async () => {
        const actor = orgScoped(bdd.user());
        expect((await requestCreate("read", null, [401])).status).toBe(401);

        const unbound = await agentAuth({ actor });
        const unboundResponse = await requestCreate(
          "read",
          { bearer: unbound.bearer },
          [403],
        );
        expectApiError(unboundResponse.body);

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
      });
    },
  );
});
