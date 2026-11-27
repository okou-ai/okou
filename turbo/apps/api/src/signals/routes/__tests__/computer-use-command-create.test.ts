import { randomUUID } from "node:crypto";
import { chatInputStatusContract } from "@okouai/api-contracts/contracts/chat-input-status";
import {
  computerUseCommandContract,
  computerUseWriteCommandContract,
} from "@okouai/api-contracts/contracts/computer-use";
import {
  computerUseCommandsChangedEvent,
  computerUseHostChannelName,
} from "@okouai/api-contracts/contracts/realtime";
import {
  remoteDevicesContract,
  type RemoteDeviceAccess,
} from "@okouai/api-contracts/contracts/remote-devices";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatInputStatusRoutes } from "../chat-input-status";
import { computerUseRoutes } from "../computer-use";
import { remoteDevicesRoutes } from "../remote-devices";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { countPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  return actor.orgId;
}

function sessionHeaders(context: TestContext, actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

function remoteDevicesClient(context: TestContext) {
  return setupApp({ context, routes: remoteDevicesRoutes })(
    remoteDevicesContract,
  );
}

async function findDesktopDevice(
  context: TestContext,
  actor: ApiTestUser,
  hostId: string,
) {
  const response = await accept(
    remoteDevicesClient(context).list({
      headers: sessionHeaders(context, actor),
    }),
    [200],
  );
  const device = response.body.devices.find((candidate) => {
    return candidate.channels.some((channel) => {
      return channel.kind === "desktop" && channel.id === hostId;
    });
  });
  if (!device) {
    throw new Error(`Expected remote device for desktop host ${hostId}`);
  }
  return device;
}

async function setDeviceAccess(
  context: TestContext,
  actor: ApiTestUser,
  deviceId: string,
  body: RemoteDeviceAccess,
) {
  const response = await accept(
    remoteDevicesClient(context).setAccess({
      headers: sessionHeaders(context, actor),
      params: { deviceId },
      body,
    }),
    [200],
  );
  return response.body;
}

async function launchComputerUseRun(
  context: TestContext,
  actor: ApiTestUser,
  hostId?: string,
) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");

  await Promise.all([
    deliverOrganizationCreated(context, actor),
    runs.configureRunnerGroup(),
  ]);

  const clientEventId = randomUUID();
  const sent = await chat.requestSendEvent(
    actor,
    {
      prompt: "Use the selected Desktop",
      model: null,
      clientEventId,
      computerUseHostId: hostId ?? null,
    },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected an accepted chat send");
  }
  await flushWaitUntilForTest();

  const observed = await accept(
    setupApp({ context, routes: chatInputStatusRoutes })(
      chatInputStatusContract,
    ).get({
      headers: sessionHeaders(context, actor),
      params: { threadId: sent.body.threadId, eventId: clientEventId },
    }),
    [200],
  );
  if (observed.body.status !== "consumed") {
    throw new Error("Expected the chat send to launch a Run");
  }
  const runId = observed.body.runId;
  const execution = await runs.executionInput(runId);
  const token = execution.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected the execution's Okou token");
  }

  let finished = false;
  onTestFinished(async () => {
    if (finished) {
      return;
    }
    finished = true;
    await runs.requestCancelRun(actor, runId, [200, 400]);
    await createWebhookCallbackApi(context).requestAgentComplete(
      { runId, exitCode: 1, error: "Run cancelled" },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200, 400],
    );
    await flushWaitUntilForTest();
  });

  return {
    token,
    runId,
    threadId: sent.body.threadId,
    sandboxToken: execution.sandboxToken,
    async cancel() {
      finished = true;
      await runs.requestCancelRun(actor, runId, [200]);
      await createWebhookCallbackApi(context).requestAgentComplete(
        { runId, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
    },
  };
}

describe("Computer Use command creation", () => {
  const context = testContext();

  it("computer-use-command-create-001 (1/3) preserves exact session command creation, wakeup, readback, claim and zero-audit/storage semantics", async () => {
    const bdd = createBddApi(context);
    const computerUse = createComputerUseBddApi(context);
    const s3Fake = computerUse.installComputerUseS3Fake();
    const sessionActor = bdd.user();
    const sessionOrgId = requireOrgId(sessionActor);

    const sessionHost = await computerUse.startComputerUseHost(sessionActor);
    const sessionCreated = await computerUse.createComputerUseReadCommand(
      sessionActor,
      {
        kind: "apps.list",
        timeoutMs: 11_001,
      },
    );
    expect(sessionCreated).toStrictEqual({
      commandId: expect.any(String),
      status: "queued",
    });
    await flushWaitUntilForTest();
    expect(
      countPublishedTo(context.mocks, {
        channel: computerUseHostChannelName(
          sessionActor.userId,
          sessionOrgId,
          sessionHost.hostId,
          sessionHost.connectionGeneration,
        ),
        topic: computerUseCommandsChangedEvent,
      }),
    ).toBe(1);

    const sessionReadback = await computerUse.readComputerUseCommand(
      sessionActor,
      sessionCreated.commandId,
    );
    expect(sessionReadback).toMatchObject({
      id: sessionCreated.commandId,
      hostId: sessionHost.hostId,
      kind: "apps.list",
      status: "queued",
      payload: {},
      timeoutMs: 11_001,
    });

    const sessionClaimed = await computerUse.claimNextComputerUseCommand(
      sessionHost.connection,
    );
    expect(sessionClaimed).toMatchObject({
      status: "command",
      command: {
        id: sessionCreated.commandId,
        hostId: sessionHost.hostId,
        kind: "apps.list",
        payload: {},
        timeoutMs: 11_001,
      },
    });
    await computerUse.completeComputerUseCommandWith(
      sessionHost.connection,
      sessionCreated.commandId,
      { status: "succeeded", result: { apps: ["Safari"] } },
    );
    await expect(
      computerUse.listComputerUseAuditEvents(sessionActor, {
        commandId: sessionCreated.commandId,
      }),
    ).resolves.toStrictEqual({ auditEvents: [] });
    expect(s3Fake.puts).toStrictEqual([]);
  });

  it("computer-use-command-create-001 (2/3) preserves exact organization-admin CLI PAT creation, wakeup, claim and null-run audit semantics", async () => {
    const bdd = createBddApi(context);
    const authOrg = createAuthOrgBddApi(context);
    const computerUse = createComputerUseBddApi(context);
    const cliActor = bdd.user({ orgRole: "org:admin" });
    const cliOrgId = requireOrgId(cliActor);

    const cliHost = await computerUse.startComputerUseHost(cliActor);
    const cli = await authOrg.createCliToken(cliActor);

    mockClerkMembership(context, cliActor, "org:admin");
    const cliCreated = await computerUse.createComputerUseWriteCommand(
      { bearer: cli.token },
      { kind: "app.open", app: "Safari", timeoutMs: 12_002 },
    );
    expect(cliCreated).toStrictEqual({
      commandId: expect.any(String),
      status: "queued",
    });
    await flushWaitUntilForTest();
    expect(
      countPublishedTo(context.mocks, {
        channel: computerUseHostChannelName(
          cliActor.userId,
          cliOrgId,
          cliHost.hostId,
          cliHost.connectionGeneration,
        ),
        topic: computerUseCommandsChangedEvent,
      }),
    ).toBe(1);

    const cliClaimed = await computerUse.claimNextComputerUseCommand(
      cliHost.connection,
    );
    expect(cliClaimed).toMatchObject({
      status: "command",
      command: {
        id: cliCreated.commandId,
        hostId: cliHost.hostId,
        kind: "app.open",
        payload: { app: "Safari" },
        timeoutMs: 12_002,
      },
    });
    await computerUse.completeComputerUseCommand(
      cliHost.connection,
      cliCreated.commandId,
    );

    const cliAudit = await computerUse.listComputerUseAuditEvents(cliActor, {
      commandId: cliCreated.commandId,
    });
    expect(cliAudit.auditEvents).toStrictEqual([
      expect.objectContaining({
        commandId: cliCreated.commandId,
        runId: null,
        hostId: cliHost.hostId,
        kind: "app.open",
        app: "Safari",
        event: "completed",
      }),
    ]);
  });

  it(
    "computer-use-command-create-001 (3/3) preserves bound Run creation semantics, audit evidence and live device policy on earlier token claim",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const computerUse = createComputerUseBddApi(context);
      const agentActor = bdd.user();
      const agentOrgId = requireOrgId(agentActor);

      const agentHost = await computerUse.startComputerUseHost(agentActor);
      const boundRun = await launchComputerUseRun(
        context,
        agentActor,
        agentHost.hostId,
      );

      const created = await computerUse.createComputerUseWriteCommand(
        { bearer: boundRun.token },
        { kind: "app.open", app: "Safari", timeoutMs: 12_002 },
      );
      expect(created).toStrictEqual({
        commandId: expect.any(String),
        status: "queued",
      });
      await flushWaitUntilForTest();
      expect(
        countPublishedTo(context.mocks, {
          channel: computerUseHostChannelName(
            agentActor.userId,
            agentOrgId,
            agentHost.hostId,
            agentHost.connectionGeneration,
          ),
          topic: computerUseCommandsChangedEvent,
        }),
      ).toBe(1);

      const claimed = await computerUse.claimNextComputerUseCommand(
        agentHost.connection,
      );
      expect(claimed).toMatchObject({
        status: "command",
        command: {
          id: created.commandId,
          hostId: agentHost.hostId,
          kind: "app.open",
          payload: { app: "Safari" },
          timeoutMs: 12_002,
        },
      });
      await computerUse.completeComputerUseCommand(
        agentHost.connection,
        created.commandId,
      );

      const audit = await computerUse.listComputerUseAuditEvents(agentActor, {
        commandId: created.commandId,
      });
      expect(audit.auditEvents).toStrictEqual([
        expect.objectContaining({
          commandId: created.commandId,
          runId: boundRun.runId,
          hostId: agentHost.hostId,
          kind: "app.open",
          app: "Safari",
          event: "completed",
        }),
      ]);

      await updateFeatureSwitchesForUser(
        context,
        {
          userId: agentActor.userId,
          orgId: agentOrgId,
          orgRole: agentActor.orgRole,
        },
        { [FeatureSwitchKey.RemoteDevices]: true },
      );

      const deniedByDevicePolicy =
        await computerUse.requestCreateComputerUseWriteCommand(
          { bearer: boundRun.token },
          [404],
          { kind: "app.open", app: "Safari", timeoutMs: 12_002 },
        );
      if (!("error" in deniedByDevicePolicy.body)) {
        throw new Error("Expected denied device policy error");
      }
      expect(deniedByDevicePolicy.body.error.message).toBe(
        "No linked computer-use host found",
      );

      const device = await findDesktopDevice(
        context,
        agentActor,
        agentHost.hostId,
      );
      expect(device).toMatchObject({ accessAllowed: false });
      await setDeviceAccess(context, agentActor, device.id, { mode: "always" });

      const admittedAfterGrant =
        await computerUse.createComputerUseWriteCommand(
          { bearer: boundRun.token },
          { kind: "app.open", app: "Safari", timeoutMs: 12_002 },
        );
      expect(admittedAfterGrant).toStrictEqual({
        commandId: expect.any(String),
        status: "queued",
      });
      const reclaimed = await computerUse.claimNextComputerUseCommand(
        agentHost.connection,
      );
      expect(reclaimed).toMatchObject({
        status: "command",
        command: {
          id: admittedAfterGrant.commandId,
          hostId: agentHost.hostId,
          kind: "app.open",
          payload: { app: "Safari" },
          timeoutMs: 12_002,
        },
      });
      await computerUse.completeComputerUseCommand(
        agentHost.connection,
        admittedAfterGrant.commandId,
      );
    },
  );

  it(
    "pf-060 checks the current device policy for an unbound Run and again when Desktop claims a command",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const computerUse = createComputerUseBddApi(context);
      const actor = bdd.user();
      const orgId = requireOrgId(actor);

      await updateFeatureSwitchesForUser(
        context,
        { userId: actor.userId, orgId, orgRole: actor.orgRole },
        { [FeatureSwitchKey.RemoteDevices]: true },
      );

      const host = await computerUse.startComputerUseHost(actor);
      const device = await findDesktopDevice(context, actor, host.hostId);
      expect(device).toMatchObject({ accessAllowed: false });
      const run = await launchComputerUseRun(context, actor);

      const runHeaders = { authorization: `Bearer ${run.token}` };
      const readClient = setupApp({ context, routes: computerUseRoutes })(
        computerUseCommandContract,
      );
      const writeClient = setupApp({ context, routes: computerUseRoutes })(
        computerUseWriteCommandContract,
      );

      const missingTarget = await accept(
        readClient.create({
          headers: runHeaders,
          body: { kind: "apps.list", timeoutMs: 60_000 },
        }),
        [403],
      );
      expect(missingTarget.body.error.message).toBe(
        "Computer-use host is not authorized for this run",
      );

      await expect(
        computerUse.listComputerUseHosts({ bearer: run.token }),
      ).resolves.toStrictEqual({ hosts: [] });

      const deniedRead = await accept(
        readClient.create({
          headers: runHeaders,
          body: { kind: "apps.list", hostId: host.hostId, timeoutMs: 60_000 },
        }),
        [404],
      );
      expect(deniedRead.body.error.message).toBe(
        "No linked computer-use host found",
      );

      const deniedWrite = await accept(
        writeClient.create({
          headers: runHeaders,
          body: {
            kind: "app.open",
            app: "Safari",
            hostId: host.hostId,
            timeoutMs: 60_000,
          },
        }),
        [404],
      );
      expect(deniedWrite.body.error.message).toBe(
        "No linked computer-use host found",
      );

      await setDeviceAccess(context, actor, device.id, { mode: "always" });
      await expect(
        computerUse.listComputerUseHosts({ bearer: run.token }),
      ).resolves.toStrictEqual({
        hosts: [expect.objectContaining({ id: host.hostId })],
      });

      const created = await accept(
        writeClient.create({
          headers: runHeaders,
          body: {
            kind: "app.open",
            app: "Safari",
            hostId: host.hostId,
            timeoutMs: 60_000,
          },
        }),
        [200],
      );
      expect(created.body).toStrictEqual({
        commandId: expect.any(String),
        status: "queued",
      });
      await expect(
        computerUse.readComputerUseCommand(
          { bearer: run.token },
          created.body.commandId,
        ),
      ).resolves.toMatchObject({
        id: created.body.commandId,
        hostId: host.hostId,
        status: "queued",
      });

      await setDeviceAccess(context, actor, device.id, { mode: "denied" });
      await expect(
        computerUse.claimNextComputerUseCommand(host.connection),
      ).resolves.toStrictEqual({ status: "idle" });
      const unreadableWhileDenied =
        await computerUse.requestReadComputerUseCommand(
          { bearer: run.token },
          created.body.commandId,
          [404],
        );
      expect(unreadableWhileDenied.body.error?.message).toBe(
        "Computer-use command not found",
      );

      await setDeviceAccess(context, actor, device.id, { mode: "always" });
      const claimed = await computerUse.claimNextComputerUseCommand(
        host.connection,
      );
      expect(claimed).toMatchObject({
        status: "command",
        command: {
          id: created.body.commandId,
          hostId: host.hostId,
          kind: "app.open",
          payload: { app: "Safari" },
        },
      });
      await computerUse.completeComputerUseCommand(
        host.connection,
        created.body.commandId,
      );

      const secondQueued = await accept(
        readClient.create({
          headers: runHeaders,
          body: { kind: "apps.list", hostId: host.hostId, timeoutMs: 60_000 },
        }),
        [200],
      );
      expect(secondQueued.body.status).toBe("queued");
      await run.cancel();
      await expect(
        computerUse.claimNextComputerUseCommand(host.connection),
      ).resolves.toStrictEqual({ status: "idle" });
    },
  );
});
