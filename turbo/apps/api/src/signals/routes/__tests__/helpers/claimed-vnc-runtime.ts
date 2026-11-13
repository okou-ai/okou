import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createBddApi } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";
import { useSecretKmsProbe } from "./secret-kms-probe";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { requireVncCredentialId } from "./vnc-response";
import {
  createVncRuntimeApi,
  vncConnectionBody,
  vncRunnerHeaders,
  vncSessionHeaders,
} from "./vnc-runtime";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

/** Ordinary claimed Runs only. Historical and intentionally invalid runtimes keep their own fixtures. */
export function createClaimedVncApi(context: TestContext) {
  const api = createVncRuntimeApi(context);
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const cleanups: (() => Promise<void>)[] = [];

  function owner(): Owner {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected a VNC owner organization");
    }
    const value = { orgId: actor.orgId, userId: actor.userId };
    api.authenticate(value);
    return value;
  }

  /** Paid onboarding creates an Agent but no VNC host or Run. */
  async function paidOwner() {
    const value = owner();
    const actor = bdd.user(value);
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });
    const { defaultAgentId: agentId } = await bdd.readOnboardingStatus(actor);
    if (!agentId) {
      throw new Error("Expected onboarding to provide the default Agent");
    }
    api.authenticate(value);
    return { ...value, agentId };
  }

  async function runtime(value: Owner & { readonly agentId: string }) {
    const actor = bdd.user(value);
    const runnerIdentity = {
      runnerId: randomUUID(),
      heartbeatGeneration: 5_000_000_000,
    };
    await runs.configureRunnerGroup({
      runnerIdentity,
      heartbeatAuthorization: vncRunnerHeaders.authorization,
    });
    const { runId, threadId } = await runs.createThreadRun(actor, {
      agentId: value.agentId,
      prompt: "Use my configured VNC desktop",
    });
    const input = await runs.executionInput(runId);
    cleanups.push(async () => {
      // Negative membership/KMS assertions finish before restoring cleanup prerequisites.
      api.authenticate(value);
      useSecretKmsProbe();
      await runs.requestCancelRun(actor, runId, [200, 404]);
      await createWebhookCallbackApi(context).requestAgentComplete(
        { runId, exitCode: 137 },
        { authorization: `Bearer ${input.sandboxToken}` },
        [200, 404],
      );
    });
    const sandboxToken = input.sandboxToken;
    const agentToken = input.platformEnvironment.OKOU_TOKEN;
    if (!sandboxToken || !agentToken) {
      throw new Error(
        "Expected the Runner claim to issue distinct sandbox and Agent credentials",
      );
    }
    await expect(runs.readRun(actor, runId)).resolves.toMatchObject({
      status: "running",
    });
    api.authenticate(value);
    return {
      ...value,
      runId,
      threadId,
      runnerIdentity,
      sandboxToken,
      agentToken,
    };
  }

  async function fixture(options: { readonly defaultEnabled?: boolean } = {}) {
    const value = await paidOwner();
    const connection = await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: vncConnectionBody(),
      }),
      [201],
    );
    if (options.defaultEnabled !== false) {
      await api.enableDefault(value, "vnc", connection.body.id);
    }
    const running = await runtime(value);
    return {
      ...running,
      connectionId: connection.body.id,
      credentialId: requireVncCredentialId(connection.body),
    };
  }

  function agentHeaders(value: { readonly agentToken: string }) {
    return { authorization: `Bearer ${value.agentToken}` };
  }

  // Call from a describe-owned afterEach before the parent testContext tears down.
  async function cleanup() {
    for (const finish of cleanups.splice(0)) {
      await finish();
      await flushWaitUntilForTest();
    }
  }

  return { owner, paidOwner, runtime, fixture, agentHeaders, cleanup };
}
