/* eslint-disable no-restricted-imports, no-restricted-syntax -- #34243 intentionally ships no API producer. Immutable H1 publication, cross-process waiting, captured credentials, private maintenance expiry and locked-transaction races cannot be created through production endpoints until #34244. Fixtures own these infrastructure states; actual Runner poll/claim/chunk/release and legacy create/cancel endpoints verify external execution behavior. */
import { createBddApi } from "../../../routes/__tests__/helpers/api-bdd";
import { createDeferredPromise } from "../../../utils";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createRunsApi } from "../../../routes/__tests__/helpers/api-bdd-runs";
import { createRunReadsApi } from "../../../routes/__tests__/helpers/api-bdd-run-reads";
import { modelProviderSurfaces } from "@okouai/db/schema/model-provider-gateway";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { withMockNowForTest } from "../../../../lib/time";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { encryptPersistentSecretValue } from "../../crypto.utils";
import {
  captureDeferredMaintenance,
  captureDeferredMaintenanceCheckpoint,
} from "../../../../test-fixtures/pi-deferred-maintenance";
import {
  holdDeferredRow,
  waitForDeferredBlocker,
} from "../../../../test-fixtures/pi-deferred-lock";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { apiTestS3PresignedUrl } from "../../../../__tests__/mocks";
import { captureDeferredStorage } from "../../../../test-fixtures/pi-deferred-storage";
import {
  captureDeferredPersonalProvider,
  captureDeferredGateway,
} from "../../../../test-fixtures/pi-deferred-provider";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { projectErasureDecision } from "@okouai/db/operations/account-erasure";
import { accountErasureJobs } from "@okouai/db/schema/account-erasure";
import {
  recoverDeferredPiRuns$,
  failWaitingPiCandidate,
  publishPiSandboxDemand,
  consumeDeferredPiRun$,
} from "../../pi-deferred-sandbox.service";
import { promoteNextQueuedRun$ } from "../../run-queue.service";
import { drainOrgQueueToCapacity$ } from "../../agent-run-lifecycle.service";
import { setTimeout as delay } from "node:timers/promises";
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import { runsCancelContract } from "@okouai/api-contracts/contracts/run-routes";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { runsCancelRoutes } from "../../../routes/runs-cancel";
import { testCronCleanupSandboxesStateRoutes } from "../../../routes/test-cron-cleanup-sandboxes-state";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import {
  transferPiFixtureAgentOwner,
  seedPiInferenceFixture,
  removePiInferenceFixture,
  readPiInferenceFixture,
} from "../../../../test-fixtures/pi-inference-lifecycle";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createStore } from "ccstate";
import { eq, inArray, sql } from "drizzle-orm";
import { expect, onTestFinished } from "vitest";
import { createPiSessionJsonl } from "@okouai/pi-agent-runtime/api";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  agentRunInference,
  agentRunSandboxIntent,
  agentRunSandboxLease,
} from "@okouai/db/schema/agent-run-inference";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import {
  agentRunInferenceObjects,
  piInferenceObjects,
} from "@okouai/db/schema/pi-inference-object";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import {
  runnersPollContract,
  runnersJobClaimContract,
  PI_DEFERRED_SANDBOX_HEADER,
} from "@okouai/api-contracts/contracts/runners";
import { testContext, accept } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { db } from "../../../../lib/db";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import {
  piDeferredConfigurationSchema,
  piDeferredContextSchema,
  piDeferredH1Schema,
  piDeferredSecretsSchema,
} from "../../pi-deferred-sandbox-contract";
import {
  publishPiInferenceObject,
  deletePiObjectOrphansForOwner,
  readPiInferenceObject,
  reclaimPiInferenceObjects,
  retainPiInferenceObject,
  retainPiInferenceObjects,
} from "../../pi-inference-object.service";
import { runnersRoutes } from "../../../routes/runners";
import { generateSandboxToken } from "../../../auth/tokens";
import { createRouteMocks } from "../../../routes/__tests__/helpers/route-test";
import { recordPiMemoryPhase2Checkpoint } from "../../pi-memory-phase2-checkpoint.service";
import {
  handlePiMemoryPhase2MaintenanceCallback,
  settlePiMemoryPhase2Checkpoint,
} from "../../pi-memory-phase2-maintenance.service";

type DefineTest = (typeof import("vitest"))["test"];

const context = testContext();
const execute = promisify(execFile);
const commit = "a".repeat(40);
const publisher = fileURLToPath(
  new URL(
    "../../../../__tests__/fixtures/pi-deferred-publisher.ts",
    import.meta.url,
  ),
);

async function readRequiredPiFixture(
  f: Parameters<typeof readPiInferenceFixture>[0],
) {
  const state = await readPiInferenceFixture(f);
  if (!state) {
    throw new Error("Missing durable Pi fixture");
  }
  return state;
}

async function fixture(
  options: {
    readonly large?: boolean;
    readonly resourceUserId?: string;
    readonly personal?: boolean;
    readonly gateway?: boolean;
    readonly storage?: boolean;
    readonly maintenance?: boolean;
    readonly publish?: boolean;
    readonly orgId?: string;
    readonly userId?: string;
    readonly publishInProcess?: boolean;
  } = {},
) {
  const f = await seedPiInferenceFixture({
    phase: "publishing",
    orgId: options.orgId,
    userId: options.userId,
  });
  onTestFinished(async () => {
    await removePiInferenceFixture(f);
    await deletePiObjectOrphansForOwner(db(), { userId: f.userId });
    await db()
      .delete(builtInModelKeys)
      .where(eq(builtInModelKeys.vendor, f.runId));
  });
  createRouteMocks(context).clerk.session(f.userId, f.orgId);
  mockEnv("GIT_COMMIT_SHA", commit);
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", `vm0/consumer-${f.runId}`);
  mockEnv(
    "CLI_PKG_URL",
    `https://static.okou.io/okou-cli/${commit}/package.tgz`,
  );
  const [key] = await db()
    .insert(builtInModelKeys)
    .values({ vendor: f.runId, apiKey: "synthetic-deepseek-key" })
    .returning({ id: builtInModelKeys.id });
  if (!key) {
    throw new Error("Missing fixture key");
  }
  await db()
    .update(agentRuns)
    .set({
      builtInModelKeyId: key.id,
      modelProvider: "built-in",
      triggerSource: "web",
    })
    .where(eq(agentRuns.id, f.runId));
  const maintenance = options.maintenance
    ? await captureDeferredMaintenance(f)
    : undefined;
  const piSessionId = maintenance ? f.runId : f.threadId;
  if (options.resourceUserId) {
    await transferPiFixtureAgentOwner(f, options.resourceUserId);
  }
  const configuration = piDeferredConfigurationSchema.parse({
    schemaVersion: 1,
    resourceOwner: {
      userId: options.resourceUserId ?? f.userId,
      orgId: f.orgId,
    },
    body: {
      agentId: maintenance ? undefined : f.agentId,
      prompt: "Synthetic foundation fixture",
      triggerSource: "web",
    },
    productAgentExecutionPlan: {
      identity: maintenance ? "pi-memory-phase2-maintenance" : "agent",
      content: {
        version: "1",
        agent: { framework: options.gateway ? "codex" : "claude-code" },
      },
    },
    connectorScope: {
      allowedConnectorSlugs: [],
      allowedCustomConnectorIds: [],
    },
    modelProviderId: null,
    modelProviderCredentialScope: null,
    modelProviderType: "built-in",
    selectedModel: "deepseek-v4-flash",
    runtimeProvider: "deepseek",
    runtimeModel: "deepseek-v4-flash",
    modelConfig: {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-v4-flash",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialSecretName: "DEEPSEEK_API_KEY",
    },
    builtInModelRuntimeRoute: {
      selectedModel: "deepseek-v4-flash",
      providerType: "deepseek",
      upstreamModel: "deepseek-v4-flash",
      modelKeyId: key.id,
    },
    includeOkouTokenSecret: false,
    piMemoryPhase2Maintenance: maintenance,
    ...(options.personal ? await captureDeferredPersonalProvider(f) : {}),
    ...(options.gateway ? await captureDeferredGateway(f) : {}),
  });
  const configurationHash = await publishPiInferenceObject(
    db(),
    f,
    "configuration",
    piDeferredConfigurationSchema,
    configuration,
  );
  const capturedMount = options.storage
    ? await captureDeferredStorage(f)
    : undefined;
  const contextHash = await publishPiInferenceObject(
    db(),
    f,
    "context",
    piDeferredContextSchema,
    {
      schemaVersion: 1,
      baseSession: { sessionId: piSessionId, sha256: null },
      resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
      storageMounts: capturedMount ? [capturedMount] : [],
      h0SessionHistory: createPiSessionJsonl({
        cwd: "/home/user/workspace",
        sessionId: piSessionId,
        timestamp: new Date().toISOString(),
      }),
    },
  );
  let h1Hash: string;
  if (options.publishInProcess) {
    const session = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: piSessionId,
    });
    session.appendMessage({
      role: "user",
      content: "Synthetic foundation fixture",
      timestamp: 1,
    });
    session.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tool-1",
          name: "read",
          arguments: { path: "/home/user/workspace/README.md" },
        },
      ],
      api: "openai-completions",
      provider: configuration.runtimeProvider,
      model: configuration.runtimeModel,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: 2,
    });
    const sessionHistory = session.toJsonl();
    h1Hash = await publishPiInferenceObject(db(), f, "h1", piDeferredH1Schema, {
      schemaVersion: 1,
      manifestGeneration: 3,
      lastEventSequence: 4,
      sessionHistory,
      historyHash: createHash("sha256").update(sessionHistory).digest("hex"),
    });
  } else {
    const child = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        publisher,
        f.orgId,
        f.userId,
        piSessionId,
        options.large ? "large" : "small",
        configuration.runtimeProvider,
        configuration.runtimeModel,
      ],
      { timeout: 30_000 },
    );
    ({ hash: h1Hash } = JSON.parse(child.stdout) as { hash: string });
  }
  await db()
    .update(agentRunInference)
    .set({
      input: {
        schemaVersion: 1,
        inputEventId: null,
        inputGeneration: 0,
        configurationHash,
        contextHash,
        h0: { kind: "empty" },
        deferredSecrets: { kind: "none" },
      },
      publication: { h1Hash, manifestGeneration: 3, lastEventSequence: 4 },
    })
    .where(eq(agentRunInference.runId, f.runId));
  if (options.publish !== false) {
    await expect(
      publishPiSandboxDemand(
        db(),
        { runId: f.runId, ownerEpoch: 1, generation: 1 },
        {
          mode: "pending-tools",
          h1Hash,
          manifestGeneration: 3,
          pendingToolIds: ["tool-1"],
          lastEventSequence: 4,
        },
      ),
    ).resolves.toBeTruthy();
  }
  if (options.publish !== false) {
    await expect(
      publishPiSandboxDemand(
        db(),
        { runId: f.runId, ownerEpoch: 1, generation: 1 },
        {
          mode: "pending-tools",
          h1Hash,
          manifestGeneration: 3,
          pendingToolIds: ["tool-1"],
          lastEventSequence: 4,
        },
      ),
    ).resolves.toBeTruthy();
  }
  return { ...f, capturedMount, maintenance, h1Hash };
}

function claim(runId: string, capable: boolean, runnerId: string) {
  const app = setupApp({ context, routes: runnersRoutes });
  return app(runnersJobClaimContract).claim({
    params: { id: runId },
    headers: {
      authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
    },
    extraHeaders: capable ? { [PI_DEFERRED_SANDBOX_HEADER]: "1" } : {},
    body: {
      runnerIdentity: { runnerId, heartbeatGeneration: 1 },
      capabilities: { piModelConfigGenerations: [1, 2, 3, 4] },
    },
  });
}

function release(
  runId: string,
  body: {
    readonly runnerId: string;
    readonly ownerEpoch: number;
    readonly generation: number;
    readonly proof: "destroyed";
  },
) {
  return setupApp({ context, routes: runnersRoutes })(
    runnersJobClaimContract,
  ).release({
    params: { id: runId },
    headers: {
      authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
    },
    body,
  });
}

async function createLegacyAdmissionFixture(
  displayName: string,
  baseConcurrencyLimit = 1,
) {
  const api = createRunsApi(context);
  const bdd = createBddApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Missing fixture org");
  }
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName,
    visibility: "public",
  });
  await db()
    .update(orgPlanEntitlements)
    .set({ baseConcurrencyLimit })
    .where(eq(orgPlanEntitlements.orgId, actor.orgId));
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  return { actor: { ...actor, orgId: actor.orgId }, agent, api };
}

async function grantPaidConcurrency(orgId: string, slots = 1): Promise<void> {
  const stripeSubscriptionId = `sub_${randomUUID()}`;
  await db()
    .insert(orgConcurrencySubscriptions)
    .values({
      stripeSubscriptionId,
      orgId,
      stripePriceId: `price_${randomUUID()}`,
      slots,
      subscriptionStatus: "active",
      currentPeriodEnd: new Date("2099-01-01T00:00:00Z"),
    });
  onTestFinished(async () => {
    await db()
      .delete(orgConcurrencySubscriptions)
      .where(
        eq(
          orgConcurrencySubscriptions.stripeSubscriptionId,
          stripeSubscriptionId,
        ),
      );
  });
}

export const registerDurabilityTests = (it: DefineTest): void => {
  it("restores a large H1 after its publisher exits and more than 55 seconds of waiting", async () => {
    const f = await fixture({ large: true });
    const blocker = await seedPiInferenceFixture({
      legacy: true,
      phase: "sandbox_running",
      orgId: f.orgId,
      userId: f.userId,
    });
    onTestFinished(async () => {
      await removePiInferenceFixture(blocker);
    });
    await db()
      .update(orgPlanEntitlements)
      .set({ baseConcurrencyLimit: 1 })
      .where(eq(orgPlanEntitlements.orgId, f.orgId));
    await expect(
      createStore().set(consumeDeferredPiRun$, f.runId, context.signal),
    ).resolves.toBeFalsy();
    const beforeWait = Date.now();
    await deletePiObjectOrphansForOwner(db(), { userId: f.userId });
    await delay(56_000);
    expect(Date.now() - beforeWait).toBeGreaterThan(55_000);
    await expect(
      db()
        .select()
        .from(agentRunSandboxLease)
        .where(eq(agentRunSandboxLease.runId, f.runId)),
    ).resolves.toStrictEqual([]);
    await expect(
      db()
        .select()
        .from(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, f.runId)),
    ).resolves.toStrictEqual([]);
    await db()
      .update(agentRuns)
      .set({ status: "completed" })
      .where(eq(agentRuns.id, blocker.runId));
    await expect(
      createStore().set(consumeDeferredPiRun$, f.runId, context.signal),
    ).resolves.toBeTruthy();
    const runnerId = randomUUID();
    const pollClient = setupApp({ context, routes: runnersRoutes })(
      runnersPollContract,
    );
    const headers = {
      authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
    };
    const pollBody = {
      group: `vm0/consumer-${f.runId}`,
      supportedProfiles: ["vm0/default"],
      runnerId,
    };
    const oldPoll = await accept(
      pollClient.poll({ headers, body: pollBody }),
      [200],
    );
    expect(oldPoll.body.job).toBeNull();
    const newPoll = await accept(
      pollClient.poll({
        headers,
        body: pollBody,
        extraHeaders: { [PI_DEFERRED_SANDBOX_HEADER]: "1" },
      }),
      [200],
    );
    expect(newPoll.body.job?.runId).toBe(f.runId);
    expect(newPoll.headers.get(PI_DEFERRED_SANDBOX_HEADER)).toBe("1");
    await accept(claim(f.runId, false, runnerId), [404]);
    const response = await accept(claim(f.runId, true, runnerId), [200]);
    expect(response.body.apiStartTime).toBe(f.apiStartedAt.getTime());
    expect(response.body.piSessionId).toBe(f.threadId);
    expect(response.body.piLaunchConfig?.apiFirstTurn).toMatchObject({
      schemaVersion: 2,
      ownerEpoch: 2,
      generation: 1,
      continuation: { mode: "pending-tools", pendingToolIds: ["tool-1"] },
      sandboxEventSequenceStart: 5,
    });
    expect(Buffer.byteLength(JSON.stringify(response.body))).toBeLessThan(
      1_500_000,
    );
    const handoffApp = setupApp({ context, routes: runnersRoutes });
    const readHandoff = (token: string) => {
      return handoffApp(runnersJobClaimContract).handoff({
        params: { id: f.runId, offset: "0" },
        headers: { authorization: `Bearer ${token}` },
      });
    };
    await accept(
      readHandoff(
        generateSandboxToken(f.userId, randomUUID(), f.orgId, {
          ownerEpoch: 2,
          generation: 1,
        }),
      ),
      [401],
    );
    await accept(
      readHandoff(generateSandboxToken(f.userId, f.runId, f.orgId)),
      [404],
    );
    await accept(
      readHandoff(
        generateSandboxToken(f.userId, f.runId, `other-${f.orgId}`, {
          ownerEpoch: 2,
          generation: 1,
        }),
      ),
      [404],
    );
    await accept(
      readHandoff(
        generateSandboxToken(`other-${f.userId}`, f.runId, f.orgId, {
          ownerEpoch: 2,
          generation: 1,
        }),
      ),
      [404],
    );
    await accept(
      readHandoff(
        generateSandboxToken(f.userId, f.runId, f.orgId, {
          ownerEpoch: 1,
          generation: 1,
        }),
      ),
      [404],
    );
    await accept(
      readHandoff(
        generateSandboxToken(f.userId, f.runId, f.orgId, {
          ownerEpoch: 2,
          generation: 2,
        }),
      ),
      [404],
    );
    const chunks: Buffer[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const chunk: { body: { chunk: string; nextOffset: number | null } } =
        await accept(
          handoffApp(runnersJobClaimContract).handoff({
            params: { id: f.runId, offset: String(offset) },
            headers: {
              authorization: `Bearer ${response.body.sandboxToken}`,
            },
          }),
          [200],
        );
      expect(Buffer.byteLength(JSON.stringify(chunk.body))).toBeLessThan(
        1_500_000,
      );
      chunks.push(Buffer.from(chunk.body.chunk, "base64"));
      offset = chunk.body.nextOffset;
    }
    const restored = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    expect(restored.sessionHistory.length).toBeGreaterThan(6 * 1024 * 1024);
    expect(restored.sessionHistory).toContain('"id":"tool-1"');
    expect((await readRequiredPiFixture(f)).lease).toMatchObject({
      state: "claimed",
      runnerId,
    });
    await accept(claim(f.runId, true, runnerId), [404]);
    const app = setupApp({ context, routes: runnersRoutes });
    const release = await accept(
      app(runnersJobClaimContract).release({
        params: { id: f.runId },
        headers: {
          authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        body: { runnerId, ownerEpoch: 2, generation: 1, proof: "destroyed" },
      }),
      [200],
    );
    expect(release.body.outcome).toBe("released");
    expect((await readRequiredPiFixture(f)).lease?.state).toBe("released");
  }, 150_000);
};

export const registerAdmissionTests = (it: DefineTest): void => {
  it("revalidates captured ownership at actual claim and preserves the unclaimed lease", async () => {
    const f = await fixture();
    await expect(
      createStore().set(consumeDeferredPiRun$, f.runId, context.signal),
    ).resolves.toBeTruthy();
    await transferPiFixtureAgentOwner(f, `transferred-${randomUUID()}`);
    const poll = await accept(
      setupApp({ context, routes: runnersRoutes })(runnersPollContract).poll({
        headers: {
          authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        extraHeaders: { [PI_DEFERRED_SANDBOX_HEADER]: "1" },
        body: {
          group: `vm0/consumer-${f.runId}`,
          supportedProfiles: ["vm0/default"],
          runnerId: randomUUID(),
        },
      }),
      [200],
    );
    expect(poll.body.job).toBeNull();
    await accept(claim(f.runId, true, randomUUID()), [404]);
    expect((await readRequiredPiFixture(f)).lease).toMatchObject({
      state: "ready",
      runnerId: null,
    });
  }, 45_000);

  it("rejects unadmitted untouched-H0 demand without preparing an environment", async () => {
    const f = await fixture({ publish: false });
    await db()
      .update(agentRunInference)
      .set({
        phase: "admitted",
        activationReady: false,
        providerAttemptState: "not-started",
        publication: null,
      })
      .where(eq(agentRunInference.runId, f.runId));
    await expect(
      publishPiSandboxDemand(
        db(),
        { runId: f.runId, ownerEpoch: 1, generation: 1 },
        { mode: "untouched-h0" },
      ),
    ).resolves.toBeFalsy();
    await expect(
      db()
        .select()
        .from(agentRunSandboxIntent)
        .where(eq(agentRunSandboxIntent.runId, f.runId)),
    ).resolves.toStrictEqual([]);
    await expect(
      db()
        .select()
        .from(agentRunSandboxLease)
        .where(eq(agentRunSandboxLease.runId, f.runId)),
    ).resolves.toStrictEqual([]);
    await expect(
      db()
        .select()
        .from(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, f.runId)),
    ).resolves.toStrictEqual([]);
  }, 45_000);

  it("fences a blocked materializer after durable recovery publishes a newer generation", async () => {
    const f = await fixture({ storage: true });
    const mount = f.capturedMount;
    if (!mount) {
      throw new Error("Missing captured Storage");
    }
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let blocked = false;
    context.mocks.s3.getSignedUrl.mockImplementation(
      async (_client: unknown, command: unknown) => {
        if (
          !blocked &&
          command instanceof GetObjectCommand &&
          command.input.Key?.includes(mount.storageId)
        ) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        return apiTestS3PresignedUrl(command);
      },
    );
    const previous = createStore().set(
      consumeDeferredPiRun$,
      f.runId,
      context.signal,
    );
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve();
      }
      await previous;
    });
    await entered.promise;
    await flushWaitUntilForTest();
    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();
    await accept(claim(f.runId, true, randomUUID()), [404]);
    // Expiry is an infrastructure fixture; the original worker is still alive
    // outside the transaction, blocked at the real storage signing boundary.
    await db()
      .update(agentRunSandboxLease)
      .set({ deadlineAt: new Date(0) })
      .where(eq(agentRunSandboxLease.runId, f.runId));
    await createStore().set(recoverDeferredPiRuns$, [f.runId], context.signal);
    await flushWaitUntilForTest();
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `org:${f.orgId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "runQueueChanged",
      null,
    );
    await expect(
      createStore().set(consumeDeferredPiRun$, f.runId, context.signal),
    ).resolves.toBeTruthy();
    release.resolve();
    await expect(previous).resolves.toBeFalsy();
    await expect(
      createStore().set(consumeDeferredPiRun$, f.runId, context.signal),
    ).resolves.toBeFalsy();
    const runnerId = randomUUID();
    const result = await accept(claim(f.runId, true, runnerId), [200]);
    expect(result.body.apiStartTime).toBe(f.apiStartedAt.getTime());
    expect(result.body.piSessionId).toBe(f.threadId);
    expect(result.body.piLaunchConfig?.apiFirstTurn).toMatchObject({
      schemaVersion: 2,
      ownerEpoch: 4,
      generation: 2,
      continuation: { mode: "pending-tools", pendingToolIds: ["tool-1"] },
    });
    await accept(claim(f.runId, true, runnerId), [404]);
  }, 45_000);

  it("serializes demand fairly, holds expired claimed capacity and releases only with the exact proof", async () => {
    const first = await fixture();
    const second = await fixture({
      orgId: first.orgId,
      userId: first.userId,
    });
    await db()
      .update(orgPlanEntitlements)
      .set({ baseConcurrencyLimit: 1 })
      .where(eq(orgPlanEntitlements.orgId, first.orgId));
    await expect(
      createStore().set(consumeDeferredPiRun$, second.runId, context.signal),
    ).resolves.toBeFalsy();
    await expect(
      createStore().set(consumeDeferredPiRun$, first.runId, context.signal),
    ).resolves.toBeTruthy();
    const runnerId = randomUUID();
    await expect(
      db()
        .select({
          runId: runnerJobQueue.runId,
          context: runnerJobQueue.executionContext,
        })
        .from(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, first.runId)),
    ).resolves.toMatchObject([
      {
        runId: first.runId,
        context: { piLaunchConfig: { apiFirstTurn: { schemaVersion: 2 } } },
      },
    ]);
    expect((await readRequiredPiFixture(first)).inference.phase).toBe(
      "sandbox_ready",
    );
    await accept(claim(first.runId, true, runnerId), [200]);
    await db()
      .update(agentRunSandboxLease)
      .set({ deadlineAt: new Date(0) })
      .where(eq(agentRunSandboxLease.runId, first.runId));
    createRouteMocks(context).clerk.session(first.userId, first.orgId);
    const app = setupApp({
      context,
      routes: [...runnersRoutes, ...runsCancelRoutes],
    });
    await accept(
      app(runsCancelContract).cancel({
        params: { id: first.runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    // Finish the cancel-triggered queue drain while the claimed lease still
    // holds capacity, so it cannot race the explicit consumer after release.
    await flushWaitUntilForTest();
    await expect(
      createStore().set(consumeDeferredPiRun$, second.runId, context.signal),
    ).resolves.toBeFalsy();
    const wrong = await accept(
      app(runnersJobClaimContract).release({
        params: { id: first.runId },
        headers: {
          authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        body: { runnerId, ownerEpoch: 2, generation: 2, proof: "destroyed" },
      }),
      [200],
    );
    expect(wrong.body.outcome).toBe("stale");
    for (let attempt = 0; attempt < 2; attempt++) {
      const release = await accept(
        app(runnersJobClaimContract).release({
          params: { id: first.runId },
          headers: {
            authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
          },
          body: {
            runnerId,
            ownerEpoch: 2,
            generation: 1,
            proof: "destroyed",
          },
        }),
        [200],
      );
      expect(release.body.outcome).toBe("released");
    }
    await expect(
      createStore().set(consumeDeferredPiRun$, second.runId, context.signal),
    ).resolves.toBeTruthy();
    await accept(claim(second.runId, true, randomUUID()), [200]);
  }, 60_000);

  it("reserves paid capacity for multiple equal-time deferred demands without overselling", async () => {
    const { actor, api } = await createLegacyAdmissionFixture(
      "Paid deferred numerical reservation",
      2,
    );
    await grantPaidConcurrency(actor.orgId);

    const sameEnqueuedAt = Date.now();
    const demands = await withMockNowForTest(sameEnqueuedAt, async () => {
      const first = await fixture({
        orgId: actor.orgId,
        userId: actor.userId,
        publishInProcess: true,
      });
      const second = await fixture({
        orgId: actor.orgId,
        userId: actor.userId,
        publishInProcess: true,
      });
      const third = await fixture({
        orgId: actor.orgId,
        userId: actor.userId,
        publishInProcess: true,
      });
      const fourth = await fixture({
        orgId: actor.orgId,
        userId: actor.userId,
        publishInProcess: true,
      });
      return [first, second, third, fourth] as const;
    });
    const intentOrder = await db()
      .select({
        runId: agentRunSandboxIntent.runId,
        enqueuedAt: agentRunSandboxIntent.enqueuedAt,
      })
      .from(agentRunSandboxIntent)
      .where(
        inArray(
          agentRunSandboxIntent.runId,
          demands.map((demand) => {
            return demand.runId;
          }),
        ),
      )
      .orderBy(agentRunSandboxIntent.enqueuedAt, agentRunSandboxIntent.runId);
    expect(intentOrder).toHaveLength(4);
    expect(
      intentOrder.map((intent) => {
        return intent.enqueuedAt.getTime();
      }),
    ).toStrictEqual([
      sameEnqueuedAt,
      sameEnqueuedAt,
      sameEnqueuedAt,
      sameEnqueuedAt,
    ]);
    const [first, second, third, fourth] = intentOrder;
    if (!first || !second || !third || !fourth) {
      throw new Error("Missing equal-time deferred demand order");
    }

    const waiting = await api.readRunQueue(actor);
    expect(waiting.body.concurrency).toMatchObject({
      limit: 3,
      active: 0,
      waiting: 4,
      available: 0,
    });
    await expect(
      createStore().set(consumeDeferredPiRun$, fourth.runId, context.signal),
    ).resolves.toBeFalsy();
    await expect(
      createStore().set(consumeDeferredPiRun$, third.runId, context.signal),
    ).resolves.toBeTruthy();
    await expect(
      createStore().set(consumeDeferredPiRun$, third.runId, context.signal),
    ).resolves.toBeFalsy();
    const reservedEarlierSlots = await api.readRunQueue(actor);
    expect(reservedEarlierSlots.body.concurrency).toMatchObject({
      limit: 3,
      active: 1,
      waiting: 3,
      available: 0,
    });
    await expect(
      createStore().set(consumeDeferredPiRun$, second.runId, context.signal),
    ).resolves.toBeTruthy();
    await expect(
      createStore().set(consumeDeferredPiRun$, first.runId, context.signal),
    ).resolves.toBeTruthy();
    await expect(
      createStore().set(consumeDeferredPiRun$, fourth.runId, context.signal),
    ).resolves.toBeFalsy();

    const saturated = await api.readRunQueue(actor);
    expect(saturated.body.concurrency).toMatchObject({
      limit: 3,
      active: 3,
      waiting: 1,
      available: 0,
    });
    const expectedLeases = [first.runId, second.runId, third.runId].sort();
    const leases = await db()
      .select({ runId: agentRunSandboxLease.runId })
      .from(agentRunSandboxLease)
      .innerJoin(agentRuns, eq(agentRuns.id, agentRunSandboxLease.runId))
      .where(eq(agentRuns.orgId, actor.orgId))
      .orderBy(agentRunSandboxLease.runId);
    expect(
      leases.map((lease) => {
        return lease.runId;
      }),
    ).toStrictEqual(expectedLeases);
    const jobs = await db()
      .select({ runId: runnerJobQueue.runId })
      .from(runnerJobQueue)
      .innerJoin(agentRuns, eq(agentRuns.id, runnerJobQueue.runId))
      .where(eq(agentRuns.orgId, actor.orgId))
      .orderBy(runnerJobQueue.runId);
    expect(
      jobs.map((job) => {
        return job.runId;
      }),
    ).toStrictEqual(expectedLeases);
  }, 120_000);

  it.each(["cancelled", "expired"] as const)(
    "invalidates the queue projection when waiting demand is %s",
    async (transition) => {
      const { actor, api } = await createLegacyAdmissionFixture(
        `Waiting projection ${transition}`,
        2,
      );
      const deferred = await fixture({
        orgId: actor.orgId,
        userId: actor.userId,
        publishInProcess: true,
      });
      const before = await api.readRunQueue(actor);
      expect(before.body.concurrency).toMatchObject({
        active: 0,
        waiting: 1,
        available: 1,
      });
      await flushWaitUntilForTest();
      context.mocks.ably.channelGet.mockClear();
      context.mocks.ably.publish.mockClear();

      if (transition === "cancelled") {
        const cancel = setupApp({ context, routes: runsCancelRoutes })(
          runsCancelContract,
        );
        await accept(
          cancel.cancel({
            params: { id: deferred.runId },
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200],
        );
      } else {
        const expiresAt = new Date(Date.now() + 1000);
        await db()
          .update(agentRunSandboxIntent)
          .set({ expiresAt })
          .where(eq(agentRunSandboxIntent.runId, deferred.runId));
        await expect(
          withMockNowForTest(expiresAt.getTime() + 1, async () => {
            return await createStore().set(
              consumeDeferredPiRun$,
              deferred.runId,
              context.signal,
            );
          }),
        ).resolves.toBeFalsy();
      }
      await flushWaitUntilForTest();

      const after = await api.readRunQueue(actor);
      expect(after.body.concurrency).toMatchObject({
        active: 0,
        waiting: 0,
        available: 2,
      });
      expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
        `org:${actor.orgId}`,
      );
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        "runQueueChanged",
        null,
      );
    },
    60_000,
  );

  it("publishes the final capacity after cancellation promotes an ordinary Run", async () => {
    const { actor, agent, api } = await createLegacyAdmissionFixture(
      "Cancellation promotion projection",
    );
    const deferred = await fixture({
      orgId: actor.orgId,
      userId: actor.userId,
      publishInProcess: true,
    });
    const queued = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "ordinary Run after cancelled demand",
      modelProvider: "anthropic-api-key",
    });
    expect(queued.status).toBe("queued");
    const before = await api.readRunQueue(actor);
    expect(before.body.concurrency).toMatchObject({
      limit: 1,
      active: 0,
      waiting: 1,
      available: 0,
    });

    const held = await holdDeferredRow(context.signal, (tx) => {
      return tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${actor.orgId}))`,
      );
    });
    await flushWaitUntilForTest();
    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();
    const queueChangeCount = () => {
      return context.mocks.ably.publish.mock.calls.filter(([topic]) => {
        return topic === "runQueueChanged";
      }).length;
    };

    const cancel = setupApp({ context, routes: runsCancelRoutes })(
      runsCancelContract,
    );
    await accept(
      cancel.cancel({
        params: { id: deferred.runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await expect.poll(queueChangeCount).toBe(1);
    await held.waitForBlocked();
    const afterCancellationHint = await api.readRunQueue(actor);
    expect(afterCancellationHint.body.concurrency).toMatchObject({
      active: 0,
      waiting: 0,
      available: 1,
    });

    await held.release();
    await flushWaitUntilForTest();
    expect(queueChangeCount()).toBe(2);
    const finalCapacity = await api.readRunQueue(actor);
    expect(finalCapacity.body.concurrency).toMatchObject({
      active: 1,
      waiting: 0,
      available: 0,
    });
    await expect(
      db()
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, queued.runId)),
    ).resolves.toStrictEqual([{ status: "pending" }]);
  }, 60_000);

  it("invalidates waiting demand expired by maintenance while capacity stays full", async () => {
    const { actor, agent, api } = await createLegacyAdmissionFixture(
      "Maintenance waiting projection",
    );
    const active = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "physical occupancy during deferred expiry",
      modelProvider: "anthropic-api-key",
    });
    expect(active.status).toBe("pending");
    const deferred = await fixture({
      orgId: actor.orgId,
      userId: actor.userId,
      publishInProcess: true,
    });
    const visibleWaiting = await api.readRunQueue(actor);
    expect(visibleWaiting.body.concurrency).toMatchObject({
      limit: 1,
      active: 1,
      waiting: 1,
      available: 0,
    });
    await db()
      .update(agentRunSandboxIntent)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(agentRunSandboxIntent.runId, deferred.runId));

    await flushWaitUntilForTest();
    context.mocks.ably.channelGet.mockClear();
    context.mocks.ably.publish.mockClear();
    const cleanup = await accept(
      setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
        testCronCleanupSandboxesStateContract,
      ).cleanup({
        body: {
          runIds: [deferred.runId],
          orgIds: [actor.orgId],
          chatThreadIds: [deferred.threadId],
          exportJobIds: [],
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(cleanup.body.cleaned).toBe(1);
    const after = await api.readRunQueue(actor);
    expect(after.body.concurrency).toMatchObject({
      active: 1,
      waiting: 0,
      available: 0,
    });
    await expect(
      db()
        .select({
          status: agentRuns.status,
          state: agentRunSandboxIntent.state,
        })
        .from(agentRuns)
        .innerJoin(
          agentRunSandboxIntent,
          eq(agentRunSandboxIntent.runId, agentRuns.id),
        )
        .where(eq(agentRuns.id, deferred.runId)),
    ).resolves.toStrictEqual([{ status: "timeout", state: "expired" }]);
    expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
      `org:${actor.orgId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "runQueueChanged",
      null,
    );
  }, 60_000);

  it("fences a delayed claim before acknowledging not-started and forbids later dispatch", async () => {
    const f = await fixture();
    await expect(
      createStore().set(consumeDeferredPiRun$, f.runId, context.signal),
    ).resolves.toBeTruthy();
    const runnerId = randomUUID();
    const app = setupApp({ context, routes: runnersRoutes });
    const held = await holdDeferredRow(context.signal, (tx) => {
      return tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${f.orgId}))`,
      );
    });
    const release = app(runnersJobClaimContract).release({
      params: { id: f.runId },
      headers: {
        authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
      },
      body: { runnerId, heartbeatGeneration: 1, proof: "not-started" },
    });
    const releasePid = await held.waitForBlocked();
    const claiming = claim(f.runId, true, runnerId);
    await waitForDeferredBlocker(releasePid);
    await held.release();
    const proof = await accept(release, [200]);
    expect(proof.body.outcome).toBe("released");
    await accept(claiming, [404]);
    expect((await readRequiredPiFixture(f)).lease?.state).toBe("released");
    expect((await readRequiredPiFixture(f)).inference.phase).toBe("terminal");
  }, 45_000);
};

export const registerAuthorizationTests = (it: DefineTest): void => {
  it.each(["before-reservation", "after-publication"] as const)(
    "fences retained demand when closure commits %s",
    async (stage) => {
      const f = await fixture();
      if (stage === "after-publication") {
        await createStore().set(consumeDeferredPiRun$, f.runId, context.signal);
      }
      await flushWaitUntilForTest();
      context.mocks.ably.channelGet.mockClear();
      context.mocks.ably.publish.mockClear();
      const job = await projectErasureDecision(db(), {
        subjectId: f.userId,
        subjectKind: "user",
        generation: 1,
        authorityId: randomUUID(),
        decisionRef: randomUUID(),
        decisionSequence: 1n,
        confirmationRef: randomUUID(),
        previousDecisionRef: null,
        dispositionVersion: 1,
        requestedAt: new Date(),
        deadlineAt: new Date("2099-01-01T00:00:00Z"),
      });
      onTestFinished(async () => {
        await db()
          .delete(accountErasureJobs)
          .where(eq(accountErasureJobs.id, job.id));
      });
      if (stage === "before-reservation") {
        await expect(
          createStore().set(consumeDeferredPiRun$, f.runId, context.signal),
        ).resolves.toBeFalsy();
        await flushWaitUntilForTest();
        expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
          `org:${f.orgId}`,
        );
        expect(context.mocks.ably.publish).toHaveBeenCalledWith(
          "runQueueChanged",
          null,
        );
      }
      await accept(claim(f.runId, true, randomUUID()), [404]);
      const state = await readRequiredPiFixture(f);
      await expect(
        db()
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, f.runId)),
      ).resolves.toStrictEqual([{ status: "cancelled" }]);
      expect(state.inference).toMatchObject({
        phase: "terminal",
        usageSettled: false,
        providerAttemptState: "settled",
      });
      expect(state.inference.input.configurationHash).toMatch(
        /^[a-f0-9]{64}$/u,
      );
    },
    45_000,
  );

  it("recovers terminal delivery work after the process stops with no lease", async () => {
    const f = await fixture();
    // The durable commit is complete, then its original process does no effects.
    await failWaitingPiCandidate(db(), f.runId);
    expect((await readRequiredPiFixture(f)).lease).toBeNull();
    await expect(
      db()
        .select({ pending: agentRunSandboxIntent.terminalEffectsPendingAt })
        .from(agentRunSandboxIntent)
        .where(eq(agentRunSandboxIntent.runId, f.runId)),
    ).resolves.toMatchObject([{ pending: expect.any(Date) }]);
    await createStore().set(recoverDeferredPiRuns$, [f.runId], context.signal);
    await accept(claim(f.runId, true, randomUUID()), [404]);
    await expect(
      db()
        .select({ pending: agentRunSandboxIntent.terminalEffectsPendingAt })
        .from(agentRunSandboxIntent)
        .where(eq(agentRunSandboxIntent.runId, f.runId)),
    ).resolves.toStrictEqual([{ pending: null }]);
    expect((await readRequiredPiFixture(f)).inference.usageSettled).toBeFalsy();
  }, 45_000);
  it("retains the captured personal account after it is disconnected", async () => {
    const f = await fixture({ personal: true });
    await createStore().set(consumeDeferredPiRun$, f.runId, context.signal);
    const [run] = await db()
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, f.runId));
    if (!run?.modelProviderId) {
      throw new Error("Missing synthetic account binding");
    }
    await db()
      .update(modelProviderAccounts)
      .set({ isActive: false, disconnectedAt: new Date() })
      .where(eq(modelProviderAccounts.id, run.modelProviderId));
    await db()
      .update(agentRuns)
      .set({ modelProviderId: null })
      .where(eq(agentRuns.id, f.runId));
    await accept(claim(f.runId, true, randomUUID()), [404]);
    await db()
      .update(agentRuns)
      .set({ modelProviderId: run.modelProviderId })
      .where(eq(agentRuns.id, f.runId));
    // Retention authorizes this existing run's exact account, never a reselection.
    const result = await accept(claim(f.runId, true, randomUUID()), [200]);
    expect(result.body.piModelConfig).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.6-terra",
    });
    expect(result.body.apiStartTime).toBe(f.apiStartedAt.getTime());
    await expect(
      db()
        .select({ source: agentRuns.modelProviderId })
        .from(agentRuns)
        .where(eq(agentRuns.id, f.runId)),
    ).resolves.toStrictEqual([{ source: run.modelProviderId }]);
  }, 45_000);

  it("signs the captured readonly version after reservation outside the run lock", async () => {
    const f = await fixture({ storage: true });
    const mount = f.capturedMount;
    if (!mount) {
      throw new Error("Missing captured Storage");
    }
    const signedKeys: string[] = [];
    context.mocks.s3.getSignedUrl.mockImplementation(
      async (_client: unknown, command: unknown) => {
        if (
          command instanceof GetObjectCommand &&
          command.input.Key?.includes(mount.storageId)
        ) {
          const [lease] = await db()
            .select()
            .from(agentRunSandboxLease)
            .where(eq(agentRunSandboxLease.runId, f.runId));
          expect(lease).toBeDefined();
          await db().transaction(async (tx) => {
            await tx
              .select({ id: agentRuns.id })
              .from(agentRuns)
              .where(eq(agentRuns.id, f.runId))
              .for("update", { noWait: true });
          });
          signedKeys.push(command.input.Key);
        }
        return apiTestS3PresignedUrl(command);
      },
    );
    await createStore().set(consumeDeferredPiRun$, f.runId, context.signal);
    const response = await accept(claim(f.runId, true, randomUUID()), [200]);
    expect(response.body.storageManifest?.storageMounts).toContainEqual(
      expect.objectContaining({ mountPath: mount.mountPath }),
    );
    expect(signedKeys.length).toBeGreaterThan(0);
    expect(
      signedKeys.every((key) => {
        return key.includes(mount.version);
      }),
    ).toBeTruthy();
    const wireMount = response.body.storageManifest?.storageMounts.find(
      (entry) => {
        return entry.mountPath === mount.mountPath;
      },
    );
    expect(wireMount?.writeback ?? false).toBeFalsy();
    expect(wireMount?.archiveUrl).toContain(mount.version);
  }, 45_000);

  it("rejects a missing captured Storage mount snapshot without consuming the ready job", async () => {
    const f = await fixture({ storage: true });
    const mount = f.capturedMount;
    if (!mount) {
      throw new Error("Missing captured Storage");
    }
    context.mocks.s3.getSignedUrl.mockImplementation(
      (_client: unknown, command: unknown) => {
        return Promise.resolve(apiTestS3PresignedUrl(command));
      },
    );
    await createStore().set(consumeDeferredPiRun$, f.runId, context.signal);
    const [published] = await db()
      .select({ mounts: agentRuns.storageMounts })
      .from(agentRuns)
      .where(eq(agentRuns.id, f.runId));
    if (!published?.mounts) {
      throw new Error("Missing published Storage mount snapshot");
    }
    // A ready v4 writer always stores an array. Only an infrastructure fixture
    // can represent loss of this required captured authorization metadata.
    await db()
      .update(agentRuns)
      .set({ storageMounts: null })
      .where(eq(agentRuns.id, f.runId));
    const runnerId = randomUUID();
    await accept(claim(f.runId, true, runnerId), [500]);
    await db()
      .update(agentRuns)
      .set({ storageMounts: published.mounts })
      .where(eq(agentRuns.id, f.runId));
    const result = await accept(claim(f.runId, true, runnerId), [200]);
    expect(result.body.storageManifest?.storageMounts).toContainEqual(
      expect.objectContaining({ mountPath: mount.mountPath }),
    );
    expect(result.body.apiStartTime).toBe(f.apiStartedAt.getTime());
  }, 45_000);

  it("rechecks the real private maintenance lease after the claim waits on its row", async () => {
    const f = await fixture({ maintenance: true });
    const maintenance = f.maintenance;
    if (!maintenance) {
      throw new Error("Missing private lease");
    }
    await createStore().set(consumeDeferredPiRun$, f.runId, context.signal);
    const held = await holdDeferredRow(
      context.signal,
      (tx) => {
        return tx
          .select()
          .from(piMemoryPhase2Jobs)
          .where(
            eq(piMemoryPhase2Jobs.memoryStorageId, maintenance.memoryStorageId),
          )
          .for("update");
      },
      (tx) => {
        return tx
          .update(piMemoryPhase2Jobs)
          .set({ leaseExpiresAt: new Date(0) })
          .where(
            eq(piMemoryPhase2Jobs.memoryStorageId, maintenance.memoryStorageId),
          );
      },
    );
    const claiming = claim(f.runId, true, randomUUID());
    await held.waitForBlocked();
    await held.release();
    await accept(claiming, [404]);
    expect((await readRequiredPiFixture(f)).lease?.runnerId).toBeNull();
  }, 45_000);

  it("retains terminal recovery after a callback fails and clears it after a later delivery", async () => {
    const f = await fixture();
    const url = `https://callback.example/${f.runId}`;
    const delivered: unknown[] = [];
    let available = false;
    server.use(
      http.post(url, async ({ request }) => {
        const body: unknown = await request.json();
        if (available) {
          delivered.push(body);
        }
        return HttpResponse.json({}, { status: available ? 200 : 503 });
      }),
    );
    await db()
      .insert(agentRunCallbacks)
      .values({
        runId: f.runId,
        url,
        encryptedSecret: await encryptPersistentSecretValue(
          "synthetic-callback-secret",
          f,
        ),
      });
    await failWaitingPiCandidate(db(), f.runId);
    await createStore().set(recoverDeferredPiRuns$, [f.runId], context.signal);
    expect(delivered).toStrictEqual([]);
    await expect(
      db()
        .select({ pending: agentRunSandboxIntent.terminalEffectsPendingAt })
        .from(agentRunSandboxIntent)
        .where(eq(agentRunSandboxIntent.runId, f.runId)),
    ).resolves.toMatchObject([{ pending: expect.any(Date) }]);
    available = true;
    await withMockNowForTest(Date.now() + 120_000, async () => {
      await createStore().set(
        recoverDeferredPiRuns$,
        [f.runId],
        context.signal,
      );
    });
    expect(delivered).toStrictEqual([
      expect.objectContaining({ runId: f.runId, status: "failed" }),
    ]);
    await expect(
      db()
        .select({ pending: agentRunSandboxIntent.terminalEffectsPendingAt })
        .from(agentRunSandboxIntent)
        .where(eq(agentRunSandboxIntent.runId, f.runId)),
    ).resolves.toStrictEqual([{ pending: null }]);
  }, 45_000);

  it.each([false, true])(
    "rechecks the captured custom gateway at actual claim, changed=%s",
    async (changed) => {
      const f = await fixture({ gateway: true });
      await createStore().set(consumeDeferredPiRun$, f.runId, context.signal);
      const [run] = await db()
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, f.runId));
      if (!run?.modelProviderId) {
        throw new Error("Missing gateway source");
      }
      if (changed) {
        await db()
          .update(modelProviderSurfaces)
          .set({ apiBaseUrl: "https://changed-gateway.example/v1" })
          .where(eq(modelProviderSurfaces.id, run.modelProviderId));
        await accept(claim(f.runId, true, randomUUID()), [404]);
      } else {
        const response = await accept(
          claim(f.runId, true, randomUUID()),
          [200],
        );
        expect(response.body.piModelConfig).toMatchObject({
          model: "captured-upstream-model",
          baseUrl: "https://gateway.example/v1",
        });
      }
    },
    45_000,
  );
};

export const registerCompatibilityTests = (it: DefineTest): void => {
  it("lets the older real legacy queue job run before later v4 demand under one slot", async () => {
    const api = createRunsApi(context);
    const bdd = createBddApi(context);
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Missing fixture org");
    }
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    api.configureRunnerGroup();
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Mixed queue fixture",
      visibility: "public",
    });
    await db()
      .update(orgPlanEntitlements)
      .set({ baseConcurrencyLimit: 1 })
      .where(eq(orgPlanEntitlements.orgId, actor.orgId));
    const active = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "legacy active",
      modelProvider: "anthropic-api-key",
    });
    const legacy = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "legacy queued",
      modelProvider: "anthropic-api-key",
    });
    const deferred = await fixture({
      orgId: actor.orgId,
      userId: actor.userId,
    });
    await expect(
      createStore().set(consumeDeferredPiRun$, deferred.runId, context.signal),
    ).resolves.toBeFalsy();
    const cancel = setupApp({ context, routes: runsCancelRoutes })(
      runsCancelContract,
    );
    await accept(
      cancel.cancel({
        params: { id: active.runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    await accept(claim(legacy.runId, false, randomUUID()), [200]);
    await accept(claim(deferred.runId, true, randomUUID()), [404]);
    await accept(
      cancel.cancel({
        params: { id: legacy.runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const result = await accept(
      claim(deferred.runId, true, randomUUID()),
      [200],
    );
    expect(result.body.apiStartTime).toBe(deferred.apiStartedAt.getTime());
  }, 60_000);
  it.each(["checkpoint", "completion"] as const)(
    "releases owned capacity after real maintenance %s retirement",
    async (transition) => {
      const f = await fixture({ maintenance: true });
      const maintenance = f.maintenance;
      if (!maintenance) {
        throw new Error("Missing private lease");
      }
      await expect(
        createStore().set(consumeDeferredPiRun$, f.runId, context.signal),
      ).resolves.toBeTruthy();
      const runnerId = randomUUID();
      await accept(claim(f.runId, true, runnerId), [200]);
      const checkpoint = await captureDeferredMaintenanceCheckpoint(
        f,
        maintenance,
      );
      if (transition === "checkpoint") {
        await db().transaction(async (tx) => {
          await recordPiMemoryPhase2Checkpoint(tx, {
            ...maintenance,
            runId: f.runId,
            orgId: f.orgId,
            userId: f.userId,
            versionId: checkpoint.versionId,
          });
          await settlePiMemoryPhase2Checkpoint(
            tx,
            f.runId,
            checkpoint.versionId,
          );
        });
      }
      await db()
        .update(agentRuns)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(agentRuns.id, f.runId));
      const observed = await handlePiMemoryPhase2MaintenanceCallback(db(), {
        runId: f.runId,
        payload: { ...maintenance, orgId: f.orgId, userId: f.userId },
        status: "completed",
      });
      expect(observed).toStrictEqual(
        transition === "checkpoint"
          ? { success: true, skipped: true }
          : { success: true },
      );
      await expect(
        db()
          .select({
            status: piMemoryPhase2Jobs.status,
            maintenanceRunId: piMemoryPhase2Jobs.maintenanceRunId,
            completedRevision: piMemoryPhase2Jobs.completedRevision,
            checkpointId: piMemoryPhase2Jobs.lastMaintenanceCheckpointId,
            checkpointVersion:
              piMemoryPhase2Jobs.lastMaintenanceCheckpointVersionId,
            outcome: piMemoryPhase2Jobs.lastMaintenanceOutcome,
          })
          .from(piMemoryPhase2Jobs)
          .where(
            eq(piMemoryPhase2Jobs.memoryStorageId, maintenance.memoryStorageId),
          ),
      ).resolves.toStrictEqual([
        {
          status: "idle",
          maintenanceRunId: null,
          completedRevision: 1,
          checkpointId: checkpoint.id,
          checkpointVersion: checkpoint.versionId,
          outcome: "published",
        },
      ]);
      const mismatched = await accept(
        release(f.runId, {
          runnerId,
          ownerEpoch: 2,
          generation: 2,
          proof: "destroyed",
        }),
        [200],
      );
      expect(mismatched.body).toStrictEqual({ outcome: "stale" });
      await expect(
        db()
          .select({
            state: agentRunSandboxLease.state,
            runnerId: agentRunSandboxLease.runnerId,
          })
          .from(agentRunSandboxLease)
          .where(eq(agentRunSandboxLease.runId, f.runId)),
      ).resolves.toStrictEqual([{ state: "claimed", runnerId }]);
      for (let attempt = 0; attempt < 2; attempt++) {
        const released = await accept(
          release(f.runId, {
            runnerId,
            ownerEpoch: 2,
            generation: 1,
            proof: "destroyed",
          }),
          [200],
        );
        expect(released.body).toStrictEqual({ outcome: "released" });
      }
      await expect(
        db()
          .select({ state: agentRunSandboxLease.state })
          .from(agentRunSandboxLease)
          .where(eq(agentRunSandboxLease.runId, f.runId)),
      ).resolves.toStrictEqual([{ state: "released" }]);
      await expect(
        db()
          .select({ usageSettled: agentRunInference.usageSettled })
          .from(agentRunInference)
          .where(eq(agentRunInference.runId, f.runId)),
      ).resolves.toStrictEqual([{ usageSettled: false }]);
    },
    60_000,
  );

  it("rejects an oversized durable continuation before it can be claimed", async () => {
    const f = await fixture({ publish: false });
    const oversized = "a".repeat(17 * 1024 * 1024);
    await expect(
      publishPiInferenceObject(db(), f, "h1", piDeferredH1Schema, {
        schemaVersion: 1,
        manifestGeneration: 3,
        lastEventSequence: 4,
        sessionHistory: oversized,
        historyHash: "0".repeat(64),
      }),
    ).rejects.toThrow(/shared UTF-8 limit/u);
    // Multibyte content stays inside a UTF-16 length limit while overflowing
    // the reader's UTF-8 ceiling.
    await expect(
      publishPiInferenceObject(db(), f, "h1", piDeferredH1Schema, {
        schemaVersion: 1,
        manifestGeneration: 3,
        lastEventSequence: 4,
        sessionHistory: "\u20ac".repeat(9 * 1024 * 1024),
        historyHash: "0".repeat(64),
      }),
    ).rejects.toThrow(/shared UTF-8 limit/u);
  }, 60_000);

  it("finalizes individually valid objects that exceed the combined limit", async () => {
    const f = await fixture({ publish: false });
    const piSessionId = f.threadId;
    const history = createPiSessionJsonl({
      cwd: "/home/user/workspace",
      sessionId: piSessionId,
      timestamp: new Date().toISOString(),
    });
    const contextHash = await publishPiInferenceObject(
      db(),
      f,
      "context",
      piDeferredContextSchema,
      {
        schemaVersion: 1,
        baseSession: { sessionId: piSessionId, sha256: null },
        resourceSnapshot: {
          schemaVersion: 1,
          // 25 MiB of resource content fits the per-object envelope on its own.
          agentsFiles: [
            { path: "/AGENTS.md", content: "b".repeat(25 * 1024 * 1024) },
          ],
          skills: [],
        },
        storageMounts: [],
        h0SessionHistory: history,
      },
    );
    // 10 MiB of history is inside the supported history ceiling on its own, but
    // the two together exceed the serialized handoff the chunk API can carry.
    const largeHistory = `${history}${"c".repeat(10 * 1024 * 1024)}`;
    const h1Hash = await publishPiInferenceObject(
      db(),
      f,
      "h1",
      piDeferredH1Schema,
      {
        schemaVersion: 1,
        manifestGeneration: 3,
        lastEventSequence: 4,
        sessionHistory: largeHistory,
        historyHash: createHash("sha256").update(largeHistory).digest("hex"),
      },
    );
    const existing = await readRequiredPiFixture(f);
    await db()
      .update(agentRunInference)
      .set({
        input: { ...existing.inference.input, contextHash },
        publication: { h1Hash, manifestGeneration: 3, lastEventSequence: 4 },
      })
      .where(eq(agentRunInference.runId, f.runId));
    await expect(
      publishPiSandboxDemand(
        db(),
        { runId: f.runId, ownerEpoch: 1, generation: 1 },
        {
          mode: "pending-tools",
          h1Hash,
          manifestGeneration: 3,
          pendingToolIds: ["tool-1"],
          lastEventSequence: 4,
        },
      ),
    ).resolves.toBeFalsy();
    await expect(
      db()
        .select({ runId: agentRunSandboxIntent.runId })
        .from(agentRunSandboxIntent)
        .where(eq(agentRunSandboxIntent.runId, f.runId)),
    ).resolves.toStrictEqual([]);
    await expect(
      db()
        .select({ runId: runnerJobQueue.runId })
        .from(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, f.runId)),
    ).resolves.toStrictEqual([]);
    const [run] = await db()
      .select({ status: agentRuns.status, error: agentRuns.error })
      .from(agentRuns)
      .where(eq(agentRuns.id, f.runId));
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("serialized bytes");
    expect((await readRequiredPiFixture(f)).inference.usageSettled).toBeFalsy();
    await accept(claim(f.runId, true, randomUUID()), [404]);
  }, 60_000);
};

export const registerCapacityTests = (it: DefineTest): void => {
  it.each(["deferred-first", "legacy-first"] as const)(
    "bounds fresh legacy admission and duplicate consumers with %s lock order",
    async (order) => {
      const { actor, agent, api } = await createLegacyAdmissionFixture(
        `Mixed admission ${order}`,
      );
      const deferred = await fixture({
        orgId: actor.orgId,
        userId: actor.userId,
      });
      const held = await holdDeferredRow(context.signal, (tx) => {
        return tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${actor.orgId}))`,
        );
      });
      const startConsumer = () => {
        return createStore().set(
          consumeDeferredPiRun$,
          deferred.runId,
          context.signal,
        );
      };
      const startLegacy = () => {
        return api.requestCreateRun(
          actor,
          {
            agentId: agent.agentId,
            prompt: `fresh legacy ${order}`,
            modelProvider: "anthropic-api-key",
          },
          [201],
        );
      };
      const raced =
        order === "deferred-first"
          ? await (async () => {
              const consumer = startConsumer();
              const consumerPid = await held.waitForBlocked();
              const legacy = startLegacy();
              const legacyPid = await waitForDeferredBlocker(consumerPid);
              const duplicate = startConsumer();
              await waitForDeferredBlocker(legacyPid);
              await held.release();
              return {
                legacy: await legacy,
                consumers: await Promise.all([consumer, duplicate]),
              };
            })()
          : await (async () => {
              const legacy = startLegacy();
              const legacyPid = await held.waitForBlocked();
              const consumer = startConsumer();
              const consumerPid = await waitForDeferredBlocker(legacyPid);
              const duplicate = startConsumer();
              await waitForDeferredBlocker(consumerPid);
              await held.release();
              return {
                legacy: await legacy,
                consumers: await Promise.all([consumer, duplicate]),
              };
            })();
      expect(raced.legacy.body).toMatchObject({ status: "queued" });
      if (!("runId" in raced.legacy.body)) {
        throw new Error("Missing queued legacy Run");
      }
      const legacyRunId = raced.legacy.body.runId;
      expect(
        [...raced.consumers].sort((left, right) => {
          return Number(left) - Number(right);
        }),
      ).toStrictEqual([false, true]);
      await expect(
        db()
          .select({
            runId: agentRunSandboxLease.runId,
            state: agentRunSandboxLease.state,
          })
          .from(agentRunSandboxLease)
          .innerJoin(agentRuns, eq(agentRuns.id, agentRunSandboxLease.runId))
          .where(eq(agentRuns.orgId, actor.orgId)),
      ).resolves.toStrictEqual([{ runId: deferred.runId, state: "ready" }]);
      await expect(
        db()
          .select({ runId: runnerJobQueue.runId })
          .from(runnerJobQueue)
          .innerJoin(agentRuns, eq(agentRuns.id, runnerJobQueue.runId))
          .where(eq(agentRuns.orgId, actor.orgId)),
      ).resolves.toStrictEqual([{ runId: deferred.runId }]);
      await expect(
        db()
          .select({ runId: agentRunQueue.runId })
          .from(agentRunQueue)
          .innerJoin(agentRuns, eq(agentRuns.id, agentRunQueue.runId))
          .where(eq(agentRuns.orgId, actor.orgId)),
      ).resolves.toStrictEqual([{ runId: legacyRunId }]);
      const runnerId = randomUUID();
      const claimed = await accept(
        claim(deferred.runId, true, runnerId),
        [200],
      );
      expect(claimed.body.apiStartTime).toBe(deferred.apiStartedAt.getTime());
      await accept(claim(deferred.runId, true, randomUUID()), [404]);
      await expect(
        db()
          .select({
            runId: agentRunSandboxLease.runId,
            state: agentRunSandboxLease.state,
          })
          .from(agentRunSandboxLease)
          .innerJoin(agentRuns, eq(agentRuns.id, agentRunSandboxLease.runId))
          .where(eq(agentRuns.orgId, actor.orgId)),
      ).resolves.toStrictEqual([{ runId: deferred.runId, state: "claimed" }]);
    },
    90_000,
  );

  it.each(["deferred-first", "legacy-first"] as const)(
    "uses spare capacity and holds the last slot with %s lock order",
    async (order) => {
      const { actor, agent, api } = await createLegacyAdmissionFixture(
        `Spare admission ${order}`,
        2,
      );
      const deferred = await fixture({
        orgId: actor.orgId,
        userId: actor.userId,
        publishInProcess: true,
      });
      const waiting = await api.readRunQueue(actor);
      expect(waiting.body.concurrency).toMatchObject({
        active: 0,
        waiting: 1,
        available: 1,
      });
      expect(JSON.stringify(waiting.body)).not.toContain(deferred.runId);

      const held = await holdDeferredRow(context.signal, (tx) => {
        return tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${actor.orgId}))`,
        );
      });
      const startConsumer = () => {
        return createStore().set(
          consumeDeferredPiRun$,
          deferred.runId,
          context.signal,
        );
      };
      const startLegacy = () => {
        return api.requestCreateRun(
          actor,
          {
            agentId: agent.agentId,
            prompt: `spare legacy ${order}`,
            modelProvider: "anthropic-api-key",
          },
          [201],
        );
      };
      const raced =
        order === "deferred-first"
          ? await (async () => {
              const consumer = startConsumer();
              const consumerPid = await held.waitForBlocked();
              const legacy = startLegacy();
              const legacyPid = await waitForDeferredBlocker(consumerPid);
              const duplicate = startConsumer();
              await waitForDeferredBlocker(legacyPid);
              await held.release();
              return {
                legacy: await legacy,
                consumers: await Promise.all([consumer, duplicate]),
              };
            })()
          : await (async () => {
              const legacy = startLegacy();
              const legacyPid = await held.waitForBlocked();
              const consumer = startConsumer();
              const consumerPid = await waitForDeferredBlocker(legacyPid);
              const duplicate = startConsumer();
              await waitForDeferredBlocker(consumerPid);
              await held.release();
              return {
                legacy: await legacy,
                consumers: await Promise.all([consumer, duplicate]),
              };
            })();
      expect(raced.legacy.body).toMatchObject({ status: "pending" });
      expect(
        [...raced.consumers].sort((left, right) => {
          return Number(left) - Number(right);
        }),
      ).toStrictEqual([false, true]);
      await expect(
        db()
          .select({
            runId: agentRunSandboxLease.runId,
            state: agentRunSandboxLease.state,
          })
          .from(agentRunSandboxLease)
          .innerJoin(agentRuns, eq(agentRuns.id, agentRunSandboxLease.runId))
          .where(eq(agentRuns.orgId, actor.orgId)),
      ).resolves.toStrictEqual([{ runId: deferred.runId, state: "ready" }]);
      const saturated = await api.readRunQueue(actor);
      expect(saturated.body.concurrency).toMatchObject({
        active: 2,
        waiting: 0,
        available: 0,
      });
      const overflow = await api.requestCreateRun(
        actor,
        {
          agentId: agent.agentId,
          prompt: `last-slot overflow ${order}`,
          modelProvider: "anthropic-api-key",
        },
        [201],
      );
      expect(overflow.body).toMatchObject({ status: "queued" });
    },
    120_000,
  );

  it.each(["consumer-first", "drain-first"] as const)(
    "preserves equal-time mixed ordering at the paid last slot with %s lock order",
    async (order) => {
      const { actor, agent, api } = await createLegacyAdmissionFixture(
        `Mixed equal-time ${order}`,
      );
      const active = await api.createRun(actor, {
        agentId: agent.agentId,
        prompt: `active before mixed race ${order}`,
        modelProvider: "anthropic-api-key",
      });
      expect(active.status).toBe("pending");
      const queued = await api.createRun(actor, {
        agentId: agent.agentId,
        prompt: `queued before mixed race ${order}`,
        modelProvider: "anthropic-api-key",
      });
      expect(queued.status).toBe("queued");
      const [queuedRow] = await db()
        .select({ createdAt: agentRunQueue.createdAt })
        .from(agentRunQueue)
        .where(eq(agentRunQueue.runId, queued.runId));
      if (!queuedRow) {
        throw new Error("Missing equal-time queued admission row");
      }
      const deferred = await fixture({
        orgId: actor.orgId,
        userId: actor.userId,
        publish: false,
        publishInProcess: true,
      });
      await grantPaidConcurrency(actor.orgId);
      await expect(
        withMockNowForTest(queuedRow.createdAt.getTime(), async () => {
          return await publishPiSandboxDemand(
            db(),
            { runId: deferred.runId, ownerEpoch: 1, generation: 1 },
            {
              mode: "pending-tools",
              h1Hash: deferred.h1Hash,
              manifestGeneration: 3,
              pendingToolIds: ["tool-1"],
              lastEventSequence: 4,
            },
          );
        }),
      ).resolves.toBeTruthy();
      const [deferredIntent] = await db()
        .select({ enqueuedAt: agentRunSandboxIntent.enqueuedAt })
        .from(agentRunSandboxIntent)
        .where(eq(agentRunSandboxIntent.runId, deferred.runId));
      if (!deferredIntent) {
        throw new Error("Missing equal-time deferred admission row");
      }
      expect(deferredIntent.enqueuedAt).toStrictEqual(queuedRow.createdAt);

      const before = await api.readRunQueue(actor);
      expect(before.body.concurrency).toMatchObject({
        limit: 2,
        active: 1,
        waiting: 1,
        available: 0,
      });
      const held = await holdDeferredRow(context.signal, (tx) => {
        return tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${actor.orgId}))`,
        );
      });
      const startConsumer = () => {
        return createStore().set(
          consumeDeferredPiRun$,
          deferred.runId,
          context.signal,
        );
      };
      const startDrain = () => {
        return createStore().set(
          drainOrgQueueToCapacity$,
          { orgId: actor.orgId },
          context.signal,
        );
      };
      const raced =
        order === "consumer-first"
          ? await (async () => {
              const consumer = startConsumer();
              const consumerPid = await held.waitForBlocked();
              const drain = startDrain();
              await waitForDeferredBlocker(consumerPid);
              await held.release();
              return { consumer: await consumer, drain: await drain };
            })()
          : await (async () => {
              const drain = startDrain();
              const drainPid = await held.waitForBlocked();
              const consumer = startConsumer();
              await waitForDeferredBlocker(drainPid);
              await held.release();
              return { consumer: await consumer, drain: await drain };
            })();
      expect(raced.drain + Number(raced.consumer)).toBe(1);

      const deferredEarlier = deferred.runId.localeCompare(queued.runId) < 0;
      const [queuedAfterRace] = await db()
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, queued.runId));
      if (!queuedAfterRace) {
        throw new Error("Missing equal-time queued Run after race");
      }
      const leaseAfterRace = await db()
        .select({ state: agentRunSandboxLease.state })
        .from(agentRunSandboxLease)
        .where(eq(agentRunSandboxLease.runId, deferred.runId));
      expect(queuedAfterRace.status).toBe(
        deferredEarlier ? "queued" : "pending",
      );
      expect(leaseAfterRace).toStrictEqual(
        deferredEarlier ? [{ state: "ready" }] : [],
      );
      const lastSlot = await api.readRunQueue(actor);
      expect(lastSlot.body.concurrency).toMatchObject({
        limit: 2,
        active: 2,
        waiting: deferredEarlier ? 0 : 1,
        available: 0,
      });

      await db()
        .update(orgPlanEntitlements)
        .set({ baseConcurrencyLimit: 2 })
        .where(eq(orgPlanEntitlements.orgId, actor.orgId));
      await expect(
        createStore().set(
          drainOrgQueueToCapacity$,
          { orgId: actor.orgId },
          context.signal,
        ),
      ).resolves.toBe(1);
      const saturated = await api.readRunQueue(actor);
      expect(saturated.body.concurrency).toMatchObject({
        limit: 3,
        active: 3,
        waiting: 0,
        available: 0,
      });
      await expect(
        db()
          .select({ runId: agentRunQueue.runId })
          .from(agentRunQueue)
          .where(eq(agentRunQueue.runId, queued.runId)),
      ).resolves.toStrictEqual([]);
      await expect(
        db()
          .select({ state: agentRunSandboxLease.state })
          .from(agentRunSandboxLease)
          .where(eq(agentRunSandboxLease.runId, deferred.runId)),
      ).resolves.toStrictEqual([{ state: "ready" }]);
    },
    120_000,
  );

  it("promotes a queued Run when newly earlier demand leaves spare capacity", async () => {
    const { actor, agent, api } = await createLegacyAdmissionFixture(
      "Queued spare-capacity admission",
    );
    await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "active before queue promotion",
      modelProvider: "anthropic-api-key",
    });
    const queued = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "queued before capacity expansion",
      modelProvider: "anthropic-api-key",
    });
    expect(queued.status).toBe("queued");
    const [queuedRow] = await db()
      .select({ createdAt: agentRunQueue.createdAt })
      .from(agentRunQueue)
      .where(eq(agentRunQueue.runId, queued.runId));
    if (!queuedRow) {
      throw new Error("Missing queued admission row");
    }
    const deferred = await fixture({
      orgId: actor.orgId,
      userId: actor.userId,
      publish: false,
      publishInProcess: true,
    });
    await db()
      .update(orgPlanEntitlements)
      .set({ baseConcurrencyLimit: 3 })
      .where(eq(orgPlanEntitlements.orgId, actor.orgId));

    const beforeDemand = await api.readRunQueue(actor);
    expect(beforeDemand.body.concurrency).toMatchObject({
      active: 1,
      waiting: 0,
      available: 2,
    });
    expect(JSON.stringify(beforeDemand.body)).not.toContain(deferred.runId);

    const held = await holdDeferredRow(context.signal, (tx) => {
      return tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${actor.orgId}))`,
      );
    });
    const publication = withMockNowForTest(
      queuedRow.createdAt.getTime() - 1,
      async () => {
        return await publishPiSandboxDemand(
          db(),
          { runId: deferred.runId, ownerEpoch: 1, generation: 1 },
          {
            mode: "pending-tools",
            h1Hash: deferred.h1Hash,
            manifestGeneration: 3,
            pendingToolIds: ["tool-1"],
            lastEventSequence: 4,
          },
        );
      },
    );
    const publisherPid = await held.waitForBlocked();
    const promotion = createStore().set(
      promoteNextQueuedRun$,
      { orgId: actor.orgId },
      context.signal,
    );
    await waitForDeferredBlocker(publisherPid);
    await held.release();
    await expect(publication).resolves.toBeTruthy();
    await expect(promotion).resolves.toMatchObject({
      kind: "activation",
      activation: { runnerNotification: { runId: queued.runId } },
    });
    await expect(
      createStore().set(consumeDeferredPiRun$, deferred.runId, context.signal),
    ).resolves.toBeTruthy();
    const saturated = await api.readRunQueue(actor);
    expect(saturated.body.concurrency).toMatchObject({
      active: 3,
      waiting: 0,
      available: 0,
    });
    const overflow = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "queued after last reserved slot",
      modelProvider: "anthropic-api-key",
    });
    expect(overflow.status).toBe("queued");
  }, 120_000);

  it("preserves nonqueue capacity errors and ordinary admission without older demand", async () => {
    const { actor, agent, api } = await createLegacyAdmissionFixture(
      "Nonqueue admission boundary",
    );
    const reads = createRunReadsApi(context);
    const directRun = {
      agentId: agent.agentId,
      modelProviderType: "anthropic-api-key" as const,
      vars: { OKOU_AGENT_ID: agent.agentId },
      secrets: { OKOU_TOKEN: "direct-admission-boundary-token" },
    };
    const ordinary = await reads.requestCreateDirectRun(
      actor,
      { ...directRun, prompt: "ordinary direct legacy" },
      [201],
    );
    expect(ordinary.body).toMatchObject({ status: "pending" });
    const ordinaryCapacity = await api.readRunQueue(actor);
    expect(ordinaryCapacity.body.concurrency).toMatchObject({
      active: 1,
      waiting: 0,
      available: 0,
    });
    const cancel = setupApp({ context, routes: runsCancelRoutes })(
      runsCancelContract,
    );
    await accept(
      cancel.cancel({
        params: { id: ordinary.body.runId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const deferred = await fixture({
      orgId: actor.orgId,
      userId: actor.userId,
    });
    const limited = await reads.requestCreateDirectRun(
      actor,
      { ...directRun, prompt: "nonqueue behind deferred demand" },
      [429],
    );
    expect(limited.body).toMatchObject({
      error: { code: "CONCURRENT_RUN_LIMIT" },
    });
    await expect(
      createStore().set(consumeDeferredPiRun$, deferred.runId, context.signal),
    ).resolves.toBeTruthy();
  }, 90_000);

  it.each(["closed", "expired"] as const)(
    "advances later eligible demand after an older %s head",
    async (headState) => {
      const orgId = `org_${randomUUID()}`;
      const baseTime = Date.now() - 10_000;
      const head = await withMockNowForTest(baseTime, async () => {
        return await fixture({ orgId, userId: `user_${randomUUID()}` });
      });
      const later = await withMockNowForTest(baseTime + 1000, async () => {
        return await fixture({ orgId, userId: `user_${randomUUID()}` });
      });
      await db()
        .update(orgPlanEntitlements)
        .set({ baseConcurrencyLimit: 1 })
        .where(eq(orgPlanEntitlements.orgId, orgId));
      if (headState === "closed") {
        const job = await projectErasureDecision(db(), {
          subjectId: head.userId,
          subjectKind: "user",
          generation: 1,
          authorityId: randomUUID(),
          decisionRef: randomUUID(),
          decisionSequence: 1n,
          confirmationRef: randomUUID(),
          previousDecisionRef: null,
          dispositionVersion: 1,
          requestedAt: new Date(),
          deadlineAt: new Date("2099-01-01T00:00:00Z"),
        });
        onTestFinished(async () => {
          await db()
            .delete(accountErasureJobs)
            .where(eq(accountErasureJobs.id, job.id));
        });
        await expect(
          createStore().set(consumeDeferredPiRun$, head.runId, context.signal),
        ).resolves.toBeFalsy();
      } else {
        await db()
          .update(agentRunSandboxIntent)
          .set({ enqueuedAt: new Date(0), expiresAt: new Date(1000) })
          .where(eq(agentRunSandboxIntent.runId, head.runId));
      }
      await expect(
        createStore().set(consumeDeferredPiRun$, later.runId, context.signal),
      ).resolves.toBeTruthy();
      if (headState === "expired") {
        await expect(
          createStore().set(consumeDeferredPiRun$, head.runId, context.signal),
        ).resolves.toBeFalsy();
      }
      await expect(
        db()
          .select({
            runId: runnerJobQueue.runId,
            phase: agentRunInference.phase,
            leaseState: agentRunSandboxLease.state,
          })
          .from(runnerJobQueue)
          .innerJoin(
            agentRunInference,
            eq(agentRunInference.runId, runnerJobQueue.runId),
          )
          .innerJoin(
            agentRunSandboxLease,
            eq(agentRunSandboxLease.runId, runnerJobQueue.runId),
          )
          .where(eq(runnerJobQueue.runId, later.runId)),
      ).resolves.toStrictEqual([
        {
          runId: later.runId,
          phase: "sandbox_ready",
          leaseState: "ready",
        },
      ]);
      await expect(
        db()
          .select({ runId: runnerJobQueue.runId })
          .from(runnerJobQueue)
          .where(eq(runnerJobQueue.runId, head.runId)),
      ).resolves.toStrictEqual([]);
      await accept(claim(later.runId, true, randomUUID()), [200]);
    },
    60_000,
  );
};

export const registerLifecycleTests = (it: DefineTest): void => {
  it("recovers pending terminal delivery after real maintenance failure retirement", async () => {
    const f = await fixture({ maintenance: true });
    const maintenance = f.maintenance;
    if (!maintenance) {
      throw new Error("Missing private lease");
    }
    await expect(
      createStore().set(consumeDeferredPiRun$, f.runId, context.signal),
    ).resolves.toBeTruthy();
    const runnerId = randomUUID();
    await accept(claim(f.runId, true, runnerId), [200]);
    const url = `https://callback.example/maintenance-${f.runId}`;
    const delivered: unknown[] = [];
    let available = false;
    server.use(
      http.post(url, async ({ request }) => {
        const body: unknown = await request.json();
        if (available) {
          delivered.push(body);
        }
        return HttpResponse.json({}, { status: available ? 200 : 503 });
      }),
    );
    await db()
      .insert(agentRunCallbacks)
      .values({
        runId: f.runId,
        url,
        encryptedSecret: await encryptPersistentSecretValue(
          "synthetic-maintenance-callback-secret",
          f,
        ),
      });
    await expect(
      handlePiMemoryPhase2MaintenanceCallback(db(), {
        runId: f.runId,
        payload: { ...maintenance, orgId: f.orgId, userId: f.userId },
        status: "failed",
        error: "synthetic maintenance failure",
      }),
    ).resolves.toStrictEqual({ success: true });
    await expect(
      db()
        .select({
          status: piMemoryPhase2Jobs.status,
          maintenanceRunId: piMemoryPhase2Jobs.maintenanceRunId,
          retryCount: piMemoryPhase2Jobs.retryCount,
          outcome: piMemoryPhase2Jobs.lastMaintenanceOutcome,
        })
        .from(piMemoryPhase2Jobs)
        .where(
          eq(piMemoryPhase2Jobs.memoryStorageId, maintenance.memoryStorageId),
        ),
    ).resolves.toStrictEqual([
      {
        status: "retryable_failure",
        maintenanceRunId: null,
        retryCount: 1,
        outcome: "failed",
      },
    ]);
    const mismatched = await accept(
      release(f.runId, {
        runnerId,
        ownerEpoch: 2,
        generation: 2,
        proof: "destroyed",
      }),
      [200],
    );
    expect(mismatched.body).toStrictEqual({ outcome: "stale" });
    expect((await readRequiredPiFixture(f)).lease?.state).toBe("claimed");
    const released = await accept(
      release(f.runId, {
        runnerId,
        ownerEpoch: 2,
        generation: 1,
        proof: "destroyed",
      }),
      [200],
    );
    expect(released.body).toStrictEqual({ outcome: "released" });
    await expect(
      db()
        .select({ pending: agentRunSandboxIntent.terminalEffectsPendingAt })
        .from(agentRunSandboxIntent)
        .where(eq(agentRunSandboxIntent.runId, f.runId)),
    ).resolves.toMatchObject([{ pending: expect.any(Date) }]);
    await createStore().set(recoverDeferredPiRuns$, [f.runId], context.signal);
    expect(delivered).toStrictEqual([]);
    await expect(
      db()
        .select({ pending: agentRunSandboxIntent.terminalEffectsPendingAt })
        .from(agentRunSandboxIntent)
        .where(eq(agentRunSandboxIntent.runId, f.runId)),
    ).resolves.toMatchObject([{ pending: expect.any(Date) }]);
    expect((await readRequiredPiFixture(f)).lease?.state).toBe("released");
    available = true;
    await withMockNowForTest(Date.now() + 120_000, async () => {
      await createStore().set(
        recoverDeferredPiRuns$,
        [f.runId],
        context.signal,
      );
    });
    expect(delivered).toStrictEqual([
      expect.objectContaining({ runId: f.runId, status: "failed" }),
    ]);
    await expect(
      db()
        .select({ pending: agentRunSandboxIntent.terminalEffectsPendingAt })
        .from(agentRunSandboxIntent)
        .where(eq(agentRunSandboxIntent.runId, f.runId)),
    ).resolves.toStrictEqual([{ pending: null }]);
    const state = await readRequiredPiFixture(f);
    expect(state.lease?.state).toBe("released");
    expect(state.inference.usageSettled).toBeFalsy();
    const duplicate = await accept(
      release(f.runId, {
        runnerId,
        ownerEpoch: 2,
        generation: 1,
        proof: "destroyed",
      }),
      [200],
    );
    expect(duplicate.body).toStrictEqual({ outcome: "released" });
  }, 60_000);

  it("retains the exact immutable input batch and deduplicates references", async () => {
    const f = await fixture();
    const state = await readRequiredPiFixture(f);
    const references = [
      {
        kind: "configuration" as const,
        hash: state.inference.input.configurationHash,
      },
      { kind: "context" as const, hash: state.inference.input.contextHash },
    ] as const;
    await db()
      .delete(agentRunInferenceObjects)
      .where(eq(agentRunInferenceObjects.runId, f.runId));

    await db().transaction(async (tx) => {
      await retainPiInferenceObjects(tx, {
        runId: f.runId,
        orgId: f.orgId,
        userId: f.userId,
        references: [...references, references[0]],
      });
    });

    await expect(
      db()
        .select({
          kind: agentRunInferenceObjects.kind,
          hash: agentRunInferenceObjects.hash,
        })
        .from(agentRunInferenceObjects)
        .where(eq(agentRunInferenceObjects.runId, f.runId))
        .orderBy(agentRunInferenceObjects.kind),
    ).resolves.toStrictEqual(references);
  }, 45_000);

  it("rejects wrong-kind, missing and wrong-owner object batches atomically", async () => {
    const f = await fixture();
    const foreign = await fixture();
    const state = await readRequiredPiFixture(f);
    const foreignState = await readRequiredPiFixture(foreign);
    await db()
      .delete(agentRunInferenceObjects)
      .where(eq(agentRunInferenceObjects.runId, f.runId));
    const invalidBatches = [
      [
        {
          kind: "configuration" as const,
          hash: state.inference.input.contextHash,
        },
        {
          kind: "context" as const,
          hash: state.inference.input.configurationHash,
        },
      ],
      [
        {
          kind: "configuration" as const,
          hash: state.inference.input.configurationHash,
        },
        { kind: "h1" as const, hash: "f".repeat(64) },
      ],
      [
        {
          kind: "configuration" as const,
          hash: state.inference.input.configurationHash,
        },
        {
          kind: "configuration" as const,
          hash: foreignState.inference.input.configurationHash,
        },
      ],
    ] as const;

    for (const references of invalidBatches) {
      await expect(
        db().transaction(async (tx) => {
          await retainPiInferenceObjects(tx, {
            runId: f.runId,
            orgId: f.orgId,
            userId: f.userId,
            references,
          });
        }),
      ).rejects.toThrow("Pi inference object is unavailable for this owner");
      await expect(
        db()
          .select()
          .from(agentRunInferenceObjects)
          .where(eq(agentRunInferenceObjects.runId, f.runId)),
      ).resolves.toStrictEqual([]);
    }
  }, 45_000);

  it("keeps an object a concurrent retain is still committing out of the sweep", async () => {
    const f = await fixture();
    const shared = await publishPiInferenceObject(
      db(),
      f,
      "h1",
      piDeferredH1Schema,
      {
        schemaVersion: 1,
        manifestGeneration: 8,
        lastEventSequence: 8,
        sessionHistory: `shared-${f.runId}`,
        historyHash: createHash("sha256")
          .update(`shared-${f.runId}`)
          .digest("hex"),
      },
    );
    await db()
      .update(piInferenceObjects)
      .set({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
      .where(eq(piInferenceObjects.hash, shared));
    // Hold an in-flight retain, then run the real sweep against it.
    const held = await holdDeferredRow(context.signal, (tx) => {
      return retainPiInferenceObject(tx, {
        runId: f.runId,
        orgId: f.orgId,
        userId: f.userId,
        kind: "h1",
        hash: shared,
      });
    });
    await reclaimPiInferenceObjects(db());
    await expect(
      db()
        .select({ hash: piInferenceObjects.hash })
        .from(piInferenceObjects)
        .where(eq(piInferenceObjects.hash, shared)),
    ).resolves.toStrictEqual([{ hash: shared }]);
    await held.release();
    // The committed reference keeps protecting it on the next sweep.
    await reclaimPiInferenceObjects(db());
    await expect(
      db()
        .select({ hash: piInferenceObjects.hash })
        .from(piInferenceObjects)
        .where(eq(piInferenceObjects.hash, shared)),
    ).resolves.toStrictEqual([{ hash: shared }]);
    await expect(
      readPiInferenceObject(
        db(),
        {
          runId: f.runId,
          orgId: f.orgId,
          userId: f.userId,
          kind: "h1",
          hash: shared,
        },
        piDeferredH1Schema,
      ),
    ).resolves.toMatchObject({ manifestGeneration: 8 });
  }, 60_000);

  it("rejects a foreign namespace and an unretained hash through the object seam", async () => {
    const f = await fixture();
    const state = await readRequiredPiFixture(f);
    const hash = state.inference.input.configurationHash;
    await expect(
      readPiInferenceObject(
        db(),
        {
          runId: f.runId,
          orgId: f.orgId,
          userId: `user_${randomUUID()}`,
          kind: "configuration",
          hash,
        },
        piDeferredConfigurationSchema,
      ),
    ).rejects.toThrow(/missing or fails integrity/u);
    // The same bytes under another kind are not this Run's retained reference.
    await expect(
      readPiInferenceObject(
        db(),
        {
          runId: f.runId,
          orgId: f.orgId,
          userId: f.userId,
          kind: "context",
          hash,
        },
        piDeferredContextSchema,
      ),
    ).rejects.toThrow(/not retained by this Run/u);
  }, 45_000);

  it("reclaims an unreferenced publication and keeps every retained object", async () => {
    const f = await fixture();
    const state = await readRequiredPiFixture(f);
    const retained = state.inference.input.configurationHash;
    const orphan = await publishPiInferenceObject(
      db(),
      f,
      "h1",
      piDeferredH1Schema,
      {
        schemaVersion: 1,
        manifestGeneration: 9,
        lastEventSequence: 9,
        sessionHistory: `orphan-${f.runId}`,
        historyHash: createHash("sha256").update(f.runId).digest("hex"),
      },
    );
    // A publication whose reference or intent commit never landed has no Run
    // edge; age it past the reclaim window without touching live references.
    await db()
      .update(piInferenceObjects)
      .set({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
      .where(eq(piInferenceObjects.hash, orphan));
    await expect(reclaimPiInferenceObjects(db())).resolves.toBeGreaterThan(0);
    await expect(
      db()
        .select({ hash: piInferenceObjects.hash })
        .from(piInferenceObjects)
        .where(eq(piInferenceObjects.hash, orphan)),
    ).resolves.toStrictEqual([]);
    await expect(
      db()
        .select({ hash: piInferenceObjects.hash })
        .from(piInferenceObjects)
        .where(eq(piInferenceObjects.hash, retained)),
    ).resolves.toStrictEqual([{ hash: retained }]);
  }, 45_000);

  it("fails an expired encrypted deferred secret without settling usage", async () => {
    const f = await fixture();
    const secretsHash = await publishPiInferenceObject(
      db(),
      f,
      "secrets",
      piDeferredSecretsSchema,
      {
        schemaVersion: 1,
        ciphertext: await encryptPersistentSecretValue("synthetic-secret", f),
      },
    );
    const state = await readRequiredPiFixture(f);
    await db()
      .update(agentRunInference)
      .set({
        input: {
          ...state.inference.input,
          deferredSecrets: {
            kind: "encrypted",
            objectHash: secretsHash,
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          },
        },
      })
      .where(eq(agentRunInference.runId, f.runId));
    await expect(
      createStore().set(consumeDeferredPiRun$, f.runId, context.signal),
    ).rejects.toThrow(/secret envelope expired/u);
    await expect(
      db()
        .select({ runId: runnerJobQueue.runId })
        .from(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, f.runId)),
    ).resolves.toStrictEqual([]);
    expect((await readRequiredPiFixture(f)).inference.usageSettled).toBeFalsy();
    await accept(claim(f.runId, true, randomUUID()), [404]);
  }, 45_000);

  it("suppresses terminal effects when the captured resource owner closes after transfer", async () => {
    const original = `user_${randomUUID()}`;
    const f = await fixture({ resourceUserId: original });
    const delivered: unknown[] = [];
    const url = `https://callback.example/${f.runId}`;
    server.use(
      http.post(url, async ({ request }) => {
        delivered.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );
    await db()
      .insert(agentRunCallbacks)
      .values({
        runId: f.runId,
        url,
        encryptedSecret: await encryptPersistentSecretValue(
          "synthetic-secret",
          f,
        ),
      });
    await transferPiFixtureAgentOwner(f, `user_${randomUUID()}`);
    const closure = await projectErasureDecision(db(), {
      subjectId: original,
      subjectKind: "user",
      generation: 1,
      authorityId: randomUUID(),
      decisionRef: randomUUID(),
      decisionSequence: 1n,
      confirmationRef: randomUUID(),
      previousDecisionRef: null,
      dispositionVersion: 1,
      requestedAt: new Date(),
      deadlineAt: new Date("2099-01-01T00:00:00Z"),
    });
    onTestFinished(async () => {
      await db()
        .delete(accountErasureJobs)
        .where(eq(accountErasureJobs.id, closure.id));
    });
    await failWaitingPiCandidate(db(), f.runId);
    await createStore().set(recoverDeferredPiRuns$, [f.runId], context.signal);
    expect(delivered).toStrictEqual([]);
    await expect(
      db()
        .select({ error: agentRuns.error })
        .from(agentRuns)
        .where(eq(agentRuns.id, f.runId)),
    ).resolves.toStrictEqual([{ error: "account_erasure:subject_closed" }]);
    expect((await readRequiredPiFixture(f)).inference.usageSettled).toBeFalsy();
    await expect(
      db()
        .select({ status: agentRunCallbacks.status })
        .from(agentRunCallbacks)
        .where(eq(agentRunCallbacks.runId, f.runId)),
    ).resolves.toStrictEqual([{ status: "pending" }]);
  }, 45_000);
};
