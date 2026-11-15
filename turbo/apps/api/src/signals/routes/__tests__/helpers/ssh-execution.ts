import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import type { TestContext } from "../../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../../lib/env";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createBddApi } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { useSecretKmsProbe } from "./secret-kms-probe";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

interface RuntimeOptions {
  readonly agentId?: string;
  readonly group?: string;
  readonly runnerIdentity?: {
    readonly runnerId: string;
    readonly heartbeatGeneration: number;
  };
}

/** Ordinary chat Runs only; historical and intentionally invalid fixtures stay separate. */
export function createSshExecutionApi(
  context: TestContext,
  options: {
    readonly runnerHeaders: { readonly authorization: string };
    readonly authenticate: (owner: Owner) => void;
  },
) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const paidOrganizations = new Set<string>();
  const active = new Map<
    string,
    { readonly owner: Owner; readonly sandboxToken: string | null }
  >();

  async function runtime(owner: Owner, runtimeOptions: RuntimeOptions = {}) {
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    if (!paidOrganizations.has(owner.orgId)) {
      const bootstrapActor = bdd.user({ ...owner, orgRole: "org:admin" });
      await runs.grantProEntitlement(bootstrapActor);
      await bdd.readOnboardingStatus(bootstrapActor);
      paidOrganizations.add(owner.orgId);
    }
    const actor = bdd.user({ ...owner, orgRole: "org:member" });
    await runs.ensurePersonalSubscriptionModel(actor, {
      model: "claude-sonnet-5-5",
    });
    // The paid organization is shared, but each Run owner needs their own memory.
    await bdd.completeOnboarding(actor);
    // Each omitted Agent is a distinct public Agent, matching the ordinary fixture.
    const agentId =
      runtimeOptions.agentId ??
      (
        await bdd.createAgent(actor, {
          displayName: "SSH execution Agent",
          visibility: "public",
        })
      ).agentId;
    const group =
      runtimeOptions.group ??
      (await runs.configureRunnerGroup({ registerRunner: false }));
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
    const candidate = runtimeOptions.runnerIdentity ?? {
      runnerId: randomUUID(),
      heartbeatGeneration: 5_000_000_000,
    };
    await runs.registerDirectRunner(group, {
      runnerIdentity: candidate,
      heartbeatAuthorization: options.runnerHeaders.authorization,
    });
    const { runId, threadId } = await runs.createThreadRun(actor, {
      agentId,
      prompt: "Use my configured SSH hosts",
      model: "claude-sonnet-5-5",
    });
    active.set(runId, { owner, sandboxToken: null });
    const input = await runs.executionInput(runId);
    active.set(runId, { owner, sandboxToken: input.sandboxToken });
    const selected = runs.dispatchedRun(runId);
    const runnerIdentity = {
      runnerId: selected.runnerId,
      heartbeatGeneration: selected.heartbeatGeneration,
    };
    const sandboxToken = input.sandboxToken;
    const agentToken = input.platformEnvironment.OKOU_TOKEN;
    if (!sandboxToken || !agentToken) {
      throw new Error("Expected the execution's sandbox and Agent credentials");
    }
    await expect(runs.readRun(actor, runId)).resolves.toMatchObject({
      status: "running",
    });
    await flushWaitUntilForTest();
    options.authenticate(owner);
    const guestHeaders = { authorization: `Bearer ${agentToken}` };
    return {
      ...owner,
      agentId,
      runId,
      threadId,
      runnerIdentity,
      sandboxToken,
      agentToken,
      guestHeaders,
      token: () => {
        return guestHeaders;
      },
    };
  }

  async function complete(value: Awaited<ReturnType<typeof runtime>>) {
    const webhooks = createWebhookCallbackApi(context);
    const headers = { authorization: `Bearer ${value.sandboxToken}` };
    await webhooks.requestAgentEvents(
      {
        runId: value.runId,
        events: [{ type: "system", sequenceNumber: 0 }],
      },
      headers,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: value.runId,
        exitCode: 0,
        lastEventSequence: 0,
        completion: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-cli-${value.runId}`,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      headers,
      [200],
    );
    const completed = await runs.readRun(
      bdd.user({ ...value, orgRole: "org:member" }),
      value.runId,
    );
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeDefined();
    expect(completed.result?.frameworkSessionId).toBeDefined();
    active.delete(value.runId);
    await flushWaitUntilForTest();
    options.authenticate(value);
  }

  // Register in the owning describe so cancellation finishes before context teardown.
  async function cleanup() {
    for (const [runId, { owner, sandboxToken }] of active) {
      options.authenticate(owner);
      useSecretKmsProbe();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      const actor = bdd.user({ ...owner, orgRole: "org:member" });
      const current = await runs.readRun(actor, runId);
      if (!["completed", "failed", "timeout"].includes(current.status)) {
        await runs.requestCancelRun(actor, runId, [200]);
        if (sandboxToken === null) {
          await expect(runs.readRun(actor, runId)).resolves.toMatchObject({
            status: "cancelled",
            startedAt: null,
          });
        } else {
          await createWebhookCallbackApi(context).requestAgentComplete(
            { runId, exitCode: 137 },
            { authorization: `Bearer ${sandboxToken}` },
            [200],
          );
        }
      }
      await flushWaitUntilForTest();
      active.delete(runId);
    }
    paidOrganizations.clear();
  }

  return { runtime, complete, cleanup };
}
