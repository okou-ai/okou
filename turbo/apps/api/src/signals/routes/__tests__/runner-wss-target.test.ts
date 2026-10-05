import { randomUUID } from "node:crypto";

import { CLIENT_VERSION_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import { testRuntimeStateContract } from "@okouai/api-contracts/contracts/test-runtime-state";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow } from "../../../lib/time";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { runnerWssTicketRoutes } from "../runner-wss-tickets";
import { testRuntimeStateRoutes } from "../test-runtime-state";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const inventoryHostname = "runner-a.example.com";
const publicOrigin = `wss://${inventoryHostname}:443`;

function testClient() {
  return setupApp({ context, routes: testRuntimeStateRoutes })(
    testRuntimeStateContract,
  );
}

async function setup() {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
  const agent = await bdd.createAgent(actor, {
    displayName: "WSS target fixture",
    description: "Tests existing winning Runner attribution",
    visibility: "private",
  });
  return { api, actor, agentId: agent.agentId, runnerGroup };
}

async function createRun(f: Awaited<ReturnType<typeof setup>>) {
  const run = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "Resolve an existing Runner target",
  });
  await f.api.heartbeatRunner(f.runnerGroup);
  return run;
}

async function createOwnedRun(f: Awaited<ReturnType<typeof setup>>) {
  const run = await f.api.createThreadRun(f.actor, {
    agentId: f.agentId,
    prompt: "Resolve an existing Runner target",
  });
  let sandboxToken: string | undefined;
  onTestFinished(async () => {
    const api = createRunsApi(context);
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const current = await api.readRun(f.actor, run.runId);
    if (current.status === "pending" || current.status === "running") {
      await api.requestCancelRun(f.actor, run.runId, [200]);
    }
    if (
      sandboxToken &&
      (current.status === "pending" ||
        current.status === "running" ||
        current.status === "cancelled")
    ) {
      await createWebhookCallbackApi(context).requestAgentComplete(
        { runId: run.runId, exitCode: 1, error: "Cancelled by test cleanup" },
        { authorization: `Bearer ${sandboxToken}` },
        [200],
      );
    }
    await flushWaitUntilForTest();
    await bdd.deleteAgent(f.actor, f.agentId);
  });
  await f.api.heartbeatRunner(f.runnerGroup);
  return {
    ...run,
    recordClaim(token: string) {
      sandboxToken = token;
    },
  };
}

async function bootstrapTarget(
  f: Awaited<ReturnType<typeof setup>>,
  runId: string,
  status: 200 | 404,
) {
  createRouteMocks(context).clerk.session(
    f.actor.userId,
    f.actor.orgId,
    f.actor.orgRole,
  );
  return await accept(
    setupApp({ context, routes: runnerWssTicketRoutes })(
      runnerWssTicketsContract,
    ).bootstrap({
      params: { runId },
      headers: { authorization: "Bearer clerk-session" },
      body: undefined,
    }),
    [status],
  );
}

function unavailableTarget() {
  return {
    error: { code: "NOT_FOUND", message: "WSS connection unavailable" },
  };
}

async function readTarget(
  runId: string,
  owner: { readonly userId: string; readonly orgId: string | null },
  now?: Date,
) {
  if (!owner.orgId) {
    throw new Error("Expected an organization-scoped test actor");
  }
  return (
    await accept(
      testClient().action({
        body: {
          action: "resolve-runner-wss-target",
          run_id: runId,
          user_id: owner.userId,
          org_id: owner.orgId,
          ...(now ? { now: now.toISOString() } : {}),
        },
      }),
      [200],
    )
  ).body.wss_target;
}

async function claimRun(
  f: Awaited<ReturnType<typeof setup>>,
  runId: string,
  args: {
    readonly runnerId: string;
    readonly hostname?: string;
    readonly version?: string;
  },
) {
  return await f.api.claimRunnerJob(
    runId,
    {
      runnerIdentity: { runnerId: args.runnerId, heartbeatGeneration: 1 },
      ...(args.hostname ? { runnerHostname: args.hostname } : {}),
    },
    args.version ? { [CLIENT_VERSION_HEADER]: args.version } : undefined,
  );
}

async function heartbeat(
  f: Awaited<ReturnType<typeof setup>>,
  runnerId: string,
  mode: "running" | "draining" | "starting" | "stopping",
  sequence: number,
  options: {
    readonly group?: string;
    readonly wssIngressServiceActive?: boolean;
  } = {},
) {
  await f.api.requestHeartbeatRunner(true, [200], {
    runnerId,
    group: options.group ?? f.runnerGroup,
    mode,
    snapshotSequence: sequence,
    wssIngressServiceActive: options.wssIngressServiceActive ?? true,
  });
}

describe("internal WSS target via guarded test API route", () => {
  it("resolves only the authorized active official winner", async () => {
    const f = await setup();
    const run = await createRun(f);
    const runnerId = randomUUID();
    await claimRun(f, run.runId, {
      runnerId,
      hostname: inventoryHostname,
      version: "0.214.2",
    });
    await heartbeat(f, runnerId, "running", 1);
    await expect(readTarget(run.runId, f.actor)).resolves.toMatchObject({
      runId: run.runId,
      runnerId,
      publicOrigin,
      ingressVerification: "not-observed",
      observedMode: "running",
    });
    await expect(
      readTarget(run.runId, { ...f.actor, userId: "not-owner" }),
    ).resolves.toBeNull();
    await expect(
      readTarget(run.runId, { ...f.actor, orgId: "not-owner" }),
    ).resolves.toBeNull();
    await f.api.requestCancelRun(f.actor, run.runId, [200]);
    await expect(readTarget(run.runId, f.actor)).resolves.toBeNull();
  });

  it("refreshes an unchanged snapshot while preserving WSS ordering", async () => {
    const f = await setup();
    const run = await createRun(f);
    const runnerId = randomUUID();
    await claimRun(f, run.runId, { runnerId, hostname: inventoryHostname });
    await heartbeat(f, runnerId, "running", 1);
    const initial = await readTarget(run.runId, f.actor);
    if (!initial) {
      throw new Error("Expected an initial Runner target");
    }

    const nextHeartbeatAt = new Date(initial.observedAt).getTime() + 1000;
    mockNow(nextHeartbeatAt);
    onTestFinished(clearMockNow);
    // The JSONB arrays are unchanged, but freshness must still advance.
    await heartbeat(f, runnerId, "running", 2);
    const refreshed = await readTarget(run.runId, f.actor);
    expect(new Date(refreshed?.observedAt ?? 0).getTime()).toBe(
      nextHeartbeatAt,
    );
    await heartbeat(f, runnerId, "running", 1, {
      wssIngressServiceActive: false,
    });
    await expect(readTarget(run.runId, f.actor)).resolves.toMatchObject({
      runnerId,
    });
    await heartbeat(f, runnerId, "running", 3, {
      wssIngressServiceActive: false,
    });
    await expect(readTarget(run.runId, f.actor)).resolves.toBeNull();
    await f.api.requestCancelRun(f.actor, run.runId, [200]);
  });

  it("does not trust runner identity or hostname supplied by a PAT claimant", async () => {
    const f = await setup();
    const run = await createOwnedRun(f);
    const runnerId = randomUUID();
    const apiKey = await f.api.createCliToken(f.actor);
    const claim = await f.api.requestClaimRunnerJobAs(
      `Bearer ${apiKey.token}`,
      run.runId,
      [200],
      {
        runnerIdentity: { runnerId, heartbeatGeneration: 1 },
        runnerHostname: inventoryHostname,
      },
    );
    if (claim.status !== 200) {
      throw new Error("Expected the actual PAT Runner claim");
    }
    run.recordClaim(claim.body.sandboxToken);
    await heartbeat(f, runnerId, "running", 1);
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    await f.api.requestCancelRun(f.actor, run.runId, [200]);
  });

  it("keeps draining available for owned runs but rejects stopped, mismatched and stale snapshots", async () => {
    const f = await setup();
    const run = await createRun(f);
    await heartbeat(f, randomUUID(), "running", 1);
    await expect(readTarget(run.runId, f.actor)).resolves.toBeNull();
    const runnerId = randomUUID();
    await claimRun(f, run.runId, {
      runnerId,
      hostname: inventoryHostname,
      version: "0.214.2",
    });
    await expect(readTarget(run.runId, f.actor)).resolves.toBeNull();
    await heartbeat(f, runnerId, "starting", 1);
    await expect(readTarget(run.runId, f.actor)).resolves.toBeNull();
    await heartbeat(f, runnerId, "draining", 2);
    const draining = await readTarget(run.runId, f.actor);
    expect(draining).toMatchObject({ observedMode: "draining", runnerId });
    if (!draining) {
      throw new Error("Expected the draining Runner target");
    }
    const observed = new Date(draining.observedAt);
    await expect(
      readTarget(run.runId, f.actor, new Date(observed.getTime() + 30_000)),
    ).resolves.toBeNull();
    await expect(
      readTarget(run.runId, f.actor, new Date(observed.getTime() - 5001)),
    ).resolves.toBeNull();
    await heartbeat(f, runnerId, "draining", 3, {
      wssIngressServiceActive: false,
    });
    await expect(readTarget(run.runId, f.actor)).resolves.toBeNull();
    await heartbeat(f, runnerId, "stopping", 4);
    await expect(readTarget(run.runId, f.actor)).resolves.toBeNull();
    await heartbeat(f, runnerId, "running", 5, { group: "vm0/other" });
    await expect(readTarget(run.runId, f.actor)).resolves.toBeNull();
    await f.api.requestCancelRun(f.actor, run.runId, [200]);
  });

  it("denies a missing or inactive WSS ingress observation and rejects an older true snapshot", async () => {
    const f = await setup();
    const run = await createOwnedRun(f);
    const runnerId = randomUUID();
    const claim = await claimRun(f, run.runId, {
      runnerId,
      hostname: inventoryHostname,
    });
    run.recordClaim(claim.sandboxToken);
    await f.api.requestHeartbeatRunner(true, [200], {
      runnerId,
      group: f.runnerGroup,
      mode: "running",
      snapshotSequence: 1,
    });
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    await heartbeat(f, runnerId, "running", 2);
    expect((await bootstrapTarget(f, run.runId, 200)).body).toMatchObject({
      wssUrl: `${publicOrigin}/ws/${runnerId}`,
    });
    await heartbeat(f, runnerId, "running", 3, {
      wssIngressServiceActive: false,
    });
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    await heartbeat(f, runnerId, "running", 2);
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    await f.api.requestCancelRun(f.actor, run.runId, [200]);
  });

  it("does not infer listener support from a claim version, but needs a hostname", async () => {
    const f = await setup();
    const runnerId = randomUUID();
    await heartbeat(f, runnerId, "running", 1);
    const oldRun = await createRun(f);
    await claimRun(f, oldRun.runId, {
      runnerId,
      hostname: inventoryHostname,
      version: "0.213.99",
    });
    await expect(readTarget(oldRun.runId, f.actor)).resolves.toMatchObject({
      publicOrigin,
      ingressVerification: "not-observed",
    });
    const historical = await createRun(f);
    await claimRun(f, historical.runId, { runnerId });
    await expect(readTarget(historical.runId, f.actor)).resolves.toBeNull();
    const noVersion = await createRun(f);
    await claimRun(f, noVersion.runId, {
      runnerId,
      hostname: inventoryHostname,
    });
    await expect(readTarget(noVersion.runId, f.actor)).resolves.toMatchObject({
      publicOrigin,
      ingressVerification: "not-observed",
    });
    for (const runId of [oldRun.runId, historical.runId, noVersion.runId]) {
      await f.api.requestCancelRun(f.actor, runId, [200]);
    }
  });

  it("rejects a browser-normalized IP hostname in an otherwise eligible official claim", async () => {
    const f = await setup();
    const run = await createOwnedRun(f);
    const runnerId = randomUUID();
    const claim = await claimRun(f, run.runId, {
      runnerId,
      hostname: "127.1",
      version: "0.214.9",
    });
    run.recordClaim(claim.sandboxToken);
    await heartbeat(f, runnerId, "running", 1);
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    await f.api.requestCancelRun(f.actor, run.runId, [200]);
  });
});
