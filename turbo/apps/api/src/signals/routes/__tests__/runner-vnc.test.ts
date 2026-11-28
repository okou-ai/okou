import { randomUUID } from "node:crypto";
import { chatInputStatusContract } from "@okouai/api-contracts/contracts/chat-input-status";
import {
  remoteDevicesContract,
  type RemoteDeviceAccess,
} from "@okouai/api-contracts/contracts/remote-devices";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import {
  accept,
  testContext,
  type TestContext,
} from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatInputStatusRoutes } from "../chat-input-status";
import { remoteDevicesRoutes } from "../remote-devices";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { holdDownloadSigning } from "./helpers/hold-download-signing";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { inlineSshKey } from "./helpers/ssh-credential";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncConnectionBody,
  vncPassword,
  vncProfiles,
  vncRunnerHeaders,
  vncSecurity,
  vncSessionHeaders,
} from "./helpers/vnc-runtime";

const DEVICE_POLICY_HEADERS = Object.freeze({
  "X-Okou-Remote-Device-Policy": "1",
});

const TEST_SSH_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\ntest-vnc-hop-key\n-----END OPENSSH PRIVATE KEY-----";

interface VncOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly actor: ApiTestUser;
}

function remoteDevicesClient(context: TestContext) {
  return setupApp({ context, routes: remoteDevicesRoutes })(
    remoteDevicesContract,
  );
}

function sshConnectionsClient(context: TestContext) {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}

function createVncOwner(context: TestContext): VncOwner {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const runtime = createVncRuntimeApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected a VNC owner organization");
  }
  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", "bdd-issued-credential-key");
  const owner = { orgId: actor.orgId, userId: actor.userId, actor };
  runtime.authenticate(owner);
  return owner;
}

async function startVncRun(
  context: TestContext,
  owner: VncOwner,
  options: { readonly bootstrapOrg?: boolean } = {},
) {
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const runtime = createVncRuntimeApi(context);
  const runnerIdentity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 5_000_000_000,
  };
  await Promise.all([
    options.bootstrapOrg === false
      ? Promise.resolve()
      : deliverOrganizationCreated(context, owner.actor),
    runs.configureRunnerGroup({
      runnerIdentity,
      heartbeatAuthorization: vncRunnerHeaders.authorization,
    }),
  ]);

  const clientEventId = randomUUID();
  const sent = await chat.requestSendEvent(
    owner.actor,
    {
      prompt: "Use my configured VNC desktop",
      model: null,
      clientEventId,
    },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected an accepted VNC chat send");
  }
  await flushWaitUntilForTest();

  runtime.authenticate(owner);
  const observed = await accept(
    setupApp({ context, routes: chatInputStatusRoutes })(
      chatInputStatusContract,
    ).get({
      headers: vncSessionHeaders,
      params: { threadId: sent.body.threadId, eventId: clientEventId },
    }),
    [200],
  );
  if (observed.body.status !== "consumed") {
    throw new Error("Expected the VNC chat send to launch a Run");
  }
  const runId = observed.body.runId;
  const input = await runs.executionInput(runId);
  const agentToken = input.platformEnvironment.OKOU_TOKEN;
  if (!agentToken) {
    throw new Error("Expected the execution's Agent credential");
  }

  let terminal = false;
  onTestFinished(async () => {
    if (terminal) {
      return;
    }
    terminal = true;
    runtime.authenticate(owner);
    useSecretKmsProbe();
    await runs.requestCancelRun(owner.actor, runId, [200, 400, 404]);
    await createWebhookCallbackApi(context).requestAgentComplete(
      { runId, exitCode: 137 },
      { authorization: `Bearer ${input.sandboxToken}` },
      [200, 400, 404],
    );
    await flushWaitUntilForTest();
  });

  runtime.authenticate(owner);
  return {
    ...owner,
    runId,
    threadId: sent.body.threadId,
    runnerIdentity,
    sandboxToken: input.sandboxToken,
    agentToken,
    piSessionId: input.piSessionId,
    markTerminal() {
      terminal = true;
    },
  };
}

async function createDefaultVncFixture(context: TestContext) {
  const runtime = createVncRuntimeApi(context);
  const owner = createVncOwner(context);
  const connection = await accept(
    runtime.connections().create({
      headers: vncSessionHeaders,
      body: vncConnectionBody(),
    }),
    [201],
  );
  await runtime.enableDefault(owner, "vnc", connection.body.id);
  const running = await startVncRun(context, owner);
  return { ...running, connectionId: connection.body.id };
}

async function finishRun(
  context: TestContext,
  run: {
    readonly actor: ApiTestUser;
    readonly runId: string;
    readonly sandboxToken: string;
    readonly piSessionId?: string;
    readonly markTerminal: () => void;
  },
  status: "completed" | "cancelled" | "failed",
) {
  const runs = createRunsApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const headers = { authorization: `Bearer ${run.sandboxToken}` };

  if (status === "completed") {
    if (!run.piSessionId) {
      throw new Error("Expected a captured Pi session identity");
    }
    await webhooks.requestAgentEvents(
      { runId: run.runId, events: [{ type: "system", sequenceNumber: 0 }] },
      headers,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        lastEventSequence: 0,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: run.piSessionId,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      headers,
      [200],
    );
  } else if (status === "cancelled") {
    await runs.requestCancelRun(run.actor, run.runId, [200]);
    await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "VNC Run cancelled" },
      headers,
      [200],
    );
  } else {
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 1,
        error: "VNC Run failed",
        failureReason: "guest_root_filesystem_full",
      },
      headers,
      [200],
    );
  }
  run.markTerminal();
  await flushWaitUntilForTest();
  await expect(runs.readRun(run.actor, run.runId)).resolves.toMatchObject({
    status,
  });
}

describe("private Runner VNC authority", () => {
  const context = testContext();

  beforeEach(() => {
    initializeVncRuntimeTest();
  });

  it(
    "pf-121 denies an existing Run's VNC authority after membership-deletion webhook",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const runtime = createVncRuntimeApi(context);
      const fixture = await createDefaultVncFixture(context);
      const kms = useSecretKmsProbe();

      const initial = await accept(
        runtime.runner().resolve({
          headers: vncRunnerHeaders,
          params: { runId: fixture.runId },
          body: {
            connectionId: fixture.connectionId,
            runnerIdentity: fixture.runnerIdentity,
            supportedProfiles: [...vncProfiles],
          },
        }),
        [200],
      );
      expect(initial.body).toMatchObject({
        outcome: "resolved_transport",
        generation: 1,
        authentication: { method: "vnc_password", password: vncPassword },
      });
      const createdAt = initial.headers.get("x-vnc-connection-created-at");
      if (!createdAt) {
        throw new Error("Expected X-VNC-Connection-Created-At header");
      }
      expect(kms.decryptCalls).toBe(1);

      const webhooks = createWebhookCallbackApi(context);
      webhooks.configureClerkWebhookSecret();
      webhooks.verifyNextClerkWebhook({
        type: "organizationMembership.deleted",
        data: {
          organization: { id: fixture.orgId },
          public_user_data: { user_id: fixture.userId },
        },
      });
      await webhooks.requestClerkWebhook("{}", {}, [200]);
      await flushWaitUntilForTest();
      fixture.markTerminal();

      const observedAfterDelete = await accept(
        runtime.runner().observe({
          headers: vncRunnerHeaders,
          params: { runId: fixture.runId },
          body: {
            connectionId: fixture.connectionId,
            runnerIdentity: fixture.runnerIdentity,
            expectedGeneration: 1,
            expectedTransport: { type: "direct" },
            expectedCreatedAt: createdAt,
            observedAt: nowDate().toISOString(),
            failureReason: "authentication_failed",
          },
        }),
        [200],
      );
      expect(observedAfterDelete.body).toStrictEqual({
        outcome: "unavailable",
      });

      await expect(runtime.resolve(fixture)).resolves.toStrictEqual({
        outcome: "unavailable",
      });

      const checkedAfterDelete = await accept(
        runtime.runner().check({
          headers: vncRunnerHeaders,
          params: { runId: fixture.runId },
          body: {
            connectionId: fixture.connectionId,
            runnerIdentity: fixture.runnerIdentity,
            expectedGeneration: 1,
            expectedTransport: { type: "direct" },
          },
        }),
        [200],
      );
      expect(checkedAfterDelete.body).toStrictEqual({
        outcome: "unavailable",
      });
      expect(kms.decryptCalls).toBe(1);
    },
  );

  it(
    "pf-118 requires a separate current device grant for the saved display SSH hop",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const runtime = createVncRuntimeApi(context);
      const owner = createVncOwner(context);
      await updateFeatureSwitchesForUser(context, owner, {
        [FeatureSwitchKey.RemoteDevices]: true,
      });
      runtime.authenticate(owner);

      const sshId = randomUUID();
      await accept(
        sshConnectionsClient(context).create({
          headers: vncSessionHeaders,
          body: {
            id: sshId,
            displayName: "Display SSH hop",
            host: "jump.example.com",
            port: 22,
            credential: inlineSshKey("ops", TEST_SSH_KEY),
          },
        }),
        [201],
      );

      const vncId = randomUUID();
      await accept(
        runtime.connections().create({
          headers: vncSessionHeaders,
          body: {
            ...vncConnectionBody(vncId),
            host: "127.0.0.1",
            transport: { type: "ssh", connectionId: sshId },
          },
        }),
        [201],
      );

      const listed = await accept(
        remoteDevicesClient(context).list({ headers: vncSessionHeaders }),
        [200],
      );
      const vncDevice = listed.body.devices.find((device) => {
        return device.channels.some((channel) => {
          return channel.kind === "vnc" && channel.id === vncId;
        });
      });
      const sshDevice = listed.body.devices.find((device) => {
        return device.channels.some((channel) => {
          return channel.kind === "ssh" && channel.id === sshId;
        });
      });
      if (!vncDevice || !sshDevice) {
        throw new Error(
          "Expected separate remote devices for VNC display and SSH hop",
        );
      }
      expect(vncDevice.id).not.toBe(sshDevice.id);
      expect(vncDevice).toMatchObject({ accessAllowed: false });
      expect(sshDevice).toMatchObject({ accessAllowed: false });
      expect(vncDevice.channels).toContainEqual(
        expect.objectContaining({
          id: vncId,
          kind: "vnc",
          sshDependencyIds: [sshId],
        }),
      );

      const running = await startVncRun(context, owner);
      const runDirectory = await accept(
        remoteDevicesClient(context).listForRun({
          headers: { authorization: `Bearer ${running.agentToken}` },
        }),
        [200],
      );
      expect(runDirectory.body.devices).toContainEqual(
        expect.objectContaining({
          id: vncDevice.id,
          channels: expect.arrayContaining([
            expect.objectContaining({
              id: vncId,
              kind: "vnc",
              sshDependencyIds: [sshId],
            }),
          ]),
        }),
      );

      const kms = useSecretKmsProbe();
      const setAccess = async (deviceId: string, body: RemoteDeviceAccess) => {
        runtime.authenticate(owner);
        await accept(
          remoteDevicesClient(context).setAccess({
            headers: vncSessionHeaders,
            params: { deviceId },
            body,
          }),
          [200],
        );
      };
      const resolveWithPolicy = (withPolicyHeader: boolean) => {
        return accept(
          runtime.runner().resolve({
            headers: vncRunnerHeaders,
            ...(withPolicyHeader
              ? { extraHeaders: DEVICE_POLICY_HEADERS }
              : {}),
            params: { runId: running.runId },
            body: {
              connectionId: vncId,
              runnerIdentity: running.runnerIdentity,
              supportedProfiles: [...vncProfiles],
            },
          }),
          [200],
        );
      };
      const checkWithPolicy = () => {
        return accept(
          runtime.runner().check({
            headers: vncRunnerHeaders,
            extraHeaders: DEVICE_POLICY_HEADERS,
            params: { runId: running.runId },
            body: {
              connectionId: vncId,
              runnerIdentity: running.runnerIdentity,
              expectedGeneration: 1,
              expectedTransport: {
                type: "ssh",
                connectionId: sshId,
                generation: 1,
              },
            },
          }),
          [200],
        );
      };

      expect((await resolveWithPolicy(true)).body).toStrictEqual({
        outcome: "unavailable",
      });
      expect(kms.decryptCalls).toBe(0);

      await setAccess(vncDevice.id, { mode: "always" });
      expect((await resolveWithPolicy(true)).body).toStrictEqual({
        outcome: "unavailable",
      });
      expect((await checkWithPolicy()).body).toStrictEqual({
        outcome: "unavailable",
      });
      expect(kms.decryptCalls).toBe(0);

      await setAccess(sshDevice.id, { mode: "always" });
      expect((await resolveWithPolicy(false)).body).toStrictEqual({
        outcome: "unavailable",
      });
      expect(kms.decryptCalls).toBe(0);

      const resolved = await resolveWithPolicy(true);
      expect(resolved.headers.get("x-okou-remote-device-policy")).toBe("1");
      expect(resolved.body).toStrictEqual({
        outcome: "resolved_transport",
        host: "127.0.0.1",
        port: 5900,
        generation: 1,
        serverName: "127.0.0.1",
        transport: { type: "ssh", connectionId: sshId, generation: 1 },
        authentication: { method: "vnc_password", password: vncPassword },
        security: vncSecurity,
      });
      expect(kms.decryptCalls).toBe(1);
      expect((await checkWithPolicy()).body).toStrictEqual({
        outcome: "valid",
      });
      expect(kms.decryptCalls).toBe(1);

      await setAccess(sshDevice.id, { mode: "denied" });
      expect((await checkWithPolicy()).body).toStrictEqual({
        outcome: "unavailable",
      });
      expect((await resolveWithPolicy(true)).body).toStrictEqual({
        outcome: "unavailable",
      });
      expect(kms.decryptCalls).toBe(1);

      await setAccess(sshDevice.id, { mode: "for", hours: 1 });
      expect((await checkWithPolicy()).body).toStrictEqual({
        outcome: "valid",
      });
    },
  );

  it(
    "runner-vnc-038 (1/4) rejects a pending Run before decrypting VNC credentials",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const runtime = createVncRuntimeApi(context);
      const runs = createRunsApi(context);
      const chat = createChatFilesBddApi(context);
      const owner = createVncOwner(context);
      const connection = await accept(
        runtime.connections().create({
          headers: vncSessionHeaders,
          body: vncConnectionBody(),
        }),
        [201],
      );
      await runtime.enableDefault(owner, "vnc", connection.body.id);

      const candidateIdentity = {
        runnerId: randomUUID(),
        heartbeatGeneration: 5_000_000_000,
      };
      await Promise.all([
        deliverOrganizationCreated(context, owner.actor),
        runs.configureRunnerGroup({
          runnerIdentity: candidateIdentity,
          heartbeatAuthorization: vncRunnerHeaders.authorization,
        }),
      ]);
      await createWorkflowsBddApi(context).createWorkflow(owner.actor, {
        name: `pending-vnc-${randomUUID().slice(0, 8)}`,
        visibility: "private",
        instruction: "Use VNC desktop",
      });
      const held = holdDownloadSigning(context);
      const clientEventId = randomUUID();
      const sent = await chat.requestSendEvent(
        owner.actor,
        {
          prompt: "Wait for an available Runner",
          model: null,
          clientEventId,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected an accepted pending chat send");
      }
      await held.waitForPending();
      runtime.authenticate(owner);
      const observed = await accept(
        setupApp({ context, routes: chatInputStatusRoutes })(
          chatInputStatusContract,
        ).get({
          headers: vncSessionHeaders,
          params: { threadId: sent.body.threadId, eventId: clientEventId },
        }),
        [200],
      );
      if (observed.body.status !== "consumed") {
        throw new Error("Expected a pending Run");
      }
      const pendingRunId = observed.body.runId;
      await expect(
        runs.readRun(owner.actor, pendingRunId),
      ).resolves.toMatchObject({ status: "pending" });

      const kms = useSecretKmsProbe();
      await expect(
        runtime.resolve({
          runId: pendingRunId,
          connectionId: connection.body.id,
          runnerIdentity: candidateIdentity,
        }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      const checked = await accept(
        runtime.runner().check({
          headers: vncRunnerHeaders,
          params: { runId: pendingRunId },
          body: {
            connectionId: connection.body.id,
            runnerIdentity: candidateIdentity,
            expectedGeneration: 1,
            expectedTransport: { type: "direct" },
          },
        }),
        [200],
      );
      expect(checked.body).toStrictEqual({ outcome: "unavailable" });
      expect(kms.decryptCalls).toBe(0);

      await runs.requestCancelRun(owner.actor, pendingRunId, [200]);
      held.release();
      await flushWaitUntilForTest();
    },
  );

  it(
    "runner-vnc-038 (2/4) rejects a completed Run before decrypting VNC credentials",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const runtime = createVncRuntimeApi(context);
      const fixture = await createDefaultVncFixture(context);
      const kms = useSecretKmsProbe();

      await expect(runtime.resolve(fixture)).resolves.toMatchObject({
        outcome: "resolved_transport",
        generation: 1,
      });
      expect(kms.decryptCalls).toBe(1);

      await finishRun(context, fixture, "completed");

      await expect(runtime.resolve(fixture)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      const checked = await accept(
        runtime.runner().check({
          headers: vncRunnerHeaders,
          params: { runId: fixture.runId },
          body: {
            connectionId: fixture.connectionId,
            runnerIdentity: fixture.runnerIdentity,
            expectedGeneration: 1,
            expectedTransport: { type: "direct" },
          },
        }),
        [200],
      );
      expect(checked.body).toStrictEqual({ outcome: "unavailable" });
      expect(kms.decryptCalls).toBe(1);
    },
  );

  it(
    "runner-vnc-038 (3/4) rejects a cancelled Run before decrypting VNC credentials",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const runtime = createVncRuntimeApi(context);
      const fixture = await createDefaultVncFixture(context);
      const kms = useSecretKmsProbe();

      await expect(runtime.resolve(fixture)).resolves.toMatchObject({
        outcome: "resolved_transport",
        generation: 1,
      });
      expect(kms.decryptCalls).toBe(1);

      await finishRun(context, fixture, "cancelled");

      await expect(runtime.resolve(fixture)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      const checked = await accept(
        runtime.runner().check({
          headers: vncRunnerHeaders,
          params: { runId: fixture.runId },
          body: {
            connectionId: fixture.connectionId,
            runnerIdentity: fixture.runnerIdentity,
            expectedGeneration: 1,
            expectedTransport: { type: "direct" },
          },
        }),
        [200],
      );
      expect(checked.body).toStrictEqual({ outcome: "unavailable" });
      expect(kms.decryptCalls).toBe(1);
    },
  );

  it(
    "runner-vnc-038 (4/4) rejects a failed Run before decrypting VNC credentials",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const runtime = createVncRuntimeApi(context);
      const fixture = await createDefaultVncFixture(context);
      const kms = useSecretKmsProbe();

      await expect(runtime.resolve(fixture)).resolves.toMatchObject({
        outcome: "resolved_transport",
        generation: 1,
      });
      expect(kms.decryptCalls).toBe(1);

      await finishRun(context, fixture, "failed");

      await expect(runtime.resolve(fixture)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      const checked = await accept(
        runtime.runner().check({
          headers: vncRunnerHeaders,
          params: { runId: fixture.runId },
          body: {
            connectionId: fixture.connectionId,
            runnerIdentity: fixture.runnerIdentity,
            expectedGeneration: 1,
            expectedTransport: { type: "direct" },
          },
        }),
        [200],
      );
      expect(checked.body).toStrictEqual({ outcome: "unavailable" });
      expect(kms.decryptCalls).toBe(1);
    },
  );
});
