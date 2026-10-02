import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { runnersJobClaimContract } from "@okouai/api-contracts/contracts/runners";
import { expect } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../../lib/env";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { runnersRoutes } from "../../runners";
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
    readonly runnerId: ReturnType<typeof randomUUID>;
    readonly heartbeatGeneration: number;
  };
}

/** Ordinary chat Runs only; historical and intentionally invalid fixtures stay separate. */
export function createClaimedSshRuntimeApi(
  context: TestContext,
  options: {
    readonly runnerHeaders: { readonly authorization: string };
    readonly authenticate: (owner: Owner) => void;
  },
) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const paidOrganizations = new Set<string>();
  const active = new Map<string, Owner>();

  async function runtime(owner: Owner, runtimeOptions: RuntimeOptions = {}) {
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    if (!paidOrganizations.has(owner.orgId)) {
      const bootstrapActor = bdd.user({ ...owner, orgRole: "org:admin" });
      await runs.grantProEntitlement(bootstrapActor);
      await runs.ensureOrgModelProvider(bootstrapActor, {
        model: "claude-fable-5-1",
      });
      await bdd.readOnboardingStatus(bootstrapActor);
      paidOrganizations.add(owner.orgId);
    }
    const actor = bdd.user({ ...owner, orgRole: "org:member" });
    // Each omitted Agent is a distinct public Agent, matching the ordinary fixture.
    const agentId =
      runtimeOptions.agentId ??
      (
        await bdd.createAgent(actor, {
          displayName: "Claimed SSH Agent",
          visibility: "public",
        })
      ).agentId;
    const group = runtimeOptions.group ?? runs.configureRunnerGroup();
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
    const { runId, threadId } = await runs.createThreadRun(actor, {
      agentId,
      prompt: "Use my configured SSH hosts",
      model: "claude-fable-5-1",
    });
    active.set(runId, owner);
    const runnerIdentity = runtimeOptions.runnerIdentity ?? {
      runnerId: randomUUID(),
      heartbeatGeneration: 5_000_000_000,
    };
    await runs.requestHeartbeatRunnerAs(
      options.runnerHeaders.authorization,
      [200],
      {
        group,
        runnerId: runnerIdentity.runnerId,
        snapshotGeneration: runnerIdentity.heartbeatGeneration,
      },
    );
    const claim = await accept(
      setupApp({ context, routes: runnersRoutes })(
        runnersJobClaimContract,
      ).claim({
        headers: options.runnerHeaders,
        params: { id: runId },
        body: {
          runnerIdentity,
          capabilities: { piModelConfigGenerations: [1, 2, 3, 4] },
        },
      }),
      [200],
    );
    const sandboxToken = claim.body.sandboxToken;
    const agentToken = claim.body.platformEnvironment.OKOU_TOKEN;
    if (!sandboxToken || !agentToken) {
      throw new Error("Expected the claim's sandbox and Agent credentials");
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
    const history = `bdd session history ${value.runId}`;
    const historyHash = createHash("sha256").update(history).digest("hex");
    const historyKey = `blobs/${historyHash}.blob`;
    // The external object has the exact bytes whose hash is committed below.
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (
        command instanceof HeadObjectCommand &&
        command.input.Key === historyKey
      ) {
        return Promise.resolve({
          ContentLength: Buffer.byteLength(history, "utf8"),
        });
      }
      if (
        command instanceof GetObjectCommand &&
        command.input.Key === historyKey
      ) {
        return Promise.resolve({
          Body: {
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(history, "utf8");
            },
          },
        });
      }
      return Promise.resolve({ ContentLength: 1024 });
    });
    await webhooks.requestAgentComplete(
      {
        runId: value.runId,
        exitCode: 0,
        lastEventSequence: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `bdd-cli-${value.runId}`,
          cliAgentSessionHistoryHash: historyHash,
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
    expect(completed.result?.checkpointId).toBeDefined();
    active.delete(value.runId);
    await flushWaitUntilForTest();
    options.authenticate(value);
  }

  // Register in the owning describe so cancellation finishes before context teardown.
  async function cleanup() {
    for (const [runId, owner] of active) {
      options.authenticate(owner);
      useSecretKmsProbe();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      await runs.requestCancelRun(
        bdd.user({ ...owner, orgRole: "org:member" }),
        runId,
        [200],
      );
      active.delete(runId);
      await flushWaitUntilForTest();
    }
    paidOrganizations.clear();
  }

  return { runtime, complete, cleanup };
}
