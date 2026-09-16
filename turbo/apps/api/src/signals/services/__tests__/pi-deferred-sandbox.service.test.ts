/* eslint-disable no-restricted-imports, no-restricted-syntax -- #34243 intentionally ships no API producer. Immutable H1 publication, cross-process waiting, captured credentials, private maintenance expiry and locked-transaction races cannot be created through production endpoints until #34244. Fixtures own these infrastructure states; actual Runner poll/claim/chunk/release and legacy create/cancel endpoints verify external execution behavior. */
import { createBddApi } from "../../routes/__tests__/helpers/api-bdd";
import { createDeferredPromise } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRunsApi } from "../../routes/__tests__/helpers/api-bdd-runs";
import { modelProviderSurfaces } from "@okouai/db/schema/model-provider-gateway";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { withMockNowForTest } from "../../../lib/time";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { encryptPersistentSecretValue } from "../crypto.utils";
import { captureDeferredMaintenance } from "../../../test-fixtures/pi-deferred-maintenance";
import {
  holdDeferredRow,
  waitForDeferredBlocker,
} from "../../../test-fixtures/pi-deferred-lock";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { captureDeferredStorage } from "../../../test-fixtures/pi-deferred-storage";
import {
  captureDeferredPersonalProvider,
  captureDeferredGateway,
} from "../../../test-fixtures/pi-deferred-provider";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { projectErasureDecision } from "@okouai/db/operations/account-erasure";
import { accountErasureJobs } from "@okouai/db/schema/account-erasure";
import {
  recoverDeferredPiRuns$,
  failWaitingPiCandidate,
  publishPiSandboxDemand,
  consumeDeferredPiRun$,
} from "../pi-deferred-sandbox.service";
import { setTimeout as delay } from "node:timers/promises";
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import { runsCancelContract } from "@okouai/api-contracts/contracts/run-routes";
import { runsCancelRoutes } from "../../routes/runs-cancel";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import {
  transferPiFixtureAgentOwner,
  seedPiInferenceFixture,
  removePiInferenceFixture,
  readPiInferenceFixture,
} from "../../../test-fixtures/pi-inference-lifecycle";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createStore } from "ccstate";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";
import { createPiSessionJsonl } from "@okouai/pi-agent-runtime/api";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  agentRunInference,
  agentRunSandboxIntent,
  agentRunSandboxLease,
} from "@okouai/db/schema/agent-run-inference";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import {
  runnersPollContract,
  runnersJobClaimContract,
  PI_DEFERRED_SANDBOX_HEADER,
} from "@okouai/api-contracts/contracts/runners";
import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { db } from "../../../lib/db";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import {
  piDeferredConfigurationSchema,
  piDeferredContextSchema,
} from "../pi-deferred-sandbox-contract";
import {
  publishPiInferenceObject,
  deletePiObjectOrphansForOwner,
} from "../pi-inference-object.service";
import { runnersRoutes } from "../../routes/runners";
import { createRouteMocks } from "../../routes/__tests__/helpers/route-test";

const context = testContext();
const execute = promisify(execFile);
const commit = "a".repeat(40);
const publisher = fileURLToPath(
  new URL(
    "../../../__tests__/fixtures/pi-deferred-publisher.ts",
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
  const { hash: h1Hash } = JSON.parse(child.stdout) as { hash: string };
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
  return { ...f, capturedMount, maintenance };
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

describe("durable deferred Pi consumer through actual PostgreSQL and Runner routes", () => {
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
    const chunks: Buffer[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const chunk: { body: { chunk: string; nextOffset: number | null } } =
        await accept(
          handoffApp(runnersJobClaimContract).handoff({
            params: { id: f.runId, offset: String(offset) },
            headers: { authorization: `Bearer ${response.body.sandboxToken}` },
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
    expect(release.body.released).toBeTruthy();
    expect((await readRequiredPiFixture(f)).lease?.state).toBe("released");
  }, 150_000);

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
    await accept(claim(f.runId, true, randomUUID()), [404]);
    // Expiry is an infrastructure fixture; the original worker is still alive
    // outside the transaction, blocked at the real storage signing boundary.
    await db()
      .update(agentRunSandboxLease)
      .set({ deadlineAt: new Date(0) })
      .where(eq(agentRunSandboxLease.runId, f.runId));
    await createStore().set(recoverDeferredPiRuns$, [f.runId], context.signal);
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
    const second = await fixture({ orgId: first.orgId, userId: first.userId });
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
    expect(wrong.body.released).toBeFalsy();
    for (let attempt = 0; attempt < 2; attempt++) {
      const release = await accept(
        app(runnersJobClaimContract).release({
          params: { id: first.runId },
          headers: {
            authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
          },
          body: { runnerId, ownerEpoch: 2, generation: 1, proof: "destroyed" },
        }),
        [200],
      );
      expect(release.body.released).toBeTruthy();
    }
    await createStore().set(
      consumeDeferredPiRun$,
      second.runId,
      context.signal,
    );
    await accept(claim(second.runId, true, randomUUID()), [200]);
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
    expect(proof.body.released).toBeTruthy();
    await accept(claiming, [404]);
    expect((await readRequiredPiFixture(f)).lease?.state).toBe("released");
    expect((await readRequiredPiFixture(f)).inference.phase).toBe("terminal");
  }, 45_000);
  it.each(["before-reservation", "after-publication"] as const)(
    "fences retained demand when closure commits %s",
    async (stage) => {
      const f = await fixture();
      if (stage === "after-publication") {
        await createStore().set(consumeDeferredPiRun$, f.runId, context.signal);
      }
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
});
