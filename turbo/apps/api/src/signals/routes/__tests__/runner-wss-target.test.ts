import { randomUUID } from "node:crypto";

import { CLIENT_VERSION_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import { testRuntimeStateContract } from "@okouai/api-contracts/contracts/test-runtime-state";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { testRuntimeStateRoutes } from "../test-runtime-state";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const inventoryHostname = "runner-a.example.com";
const publicOrigin = "wss://runner-a-wss.example.com:443";

function testClient() {
  return setupApp({ context, routes: testRuntimeStateRoutes })(
    testRuntimeStateContract,
  );
}

function provision() {
  mockEnv(
    "OKOU_WSS_HOST_ORIGINS",
    JSON.stringify([{ inventoryHostname, publicOrigin }]),
  );
  // Synthetic future floor. A real floor is configured only after #37027.
  mockEnv("OKOU_WSS_MIN_RUNNER_VERSION", "0.214.0");
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
  const run = await f.api.createDirectRun(f.actor, {
    agentId: f.agentId,
    prompt: "Resolve an existing Runner target",
    modelProviderType: "anthropic-api-key",
    vars: { OKOU_AGENT_ID: f.agentId },
    secrets: { OKOU_TOKEN: "bdd-wss-target-test-token" },
  });
  await f.api.heartbeatRunner(f.runnerGroup);
  return run;
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
  await f.api.claimRunnerJob(
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
  group = f.runnerGroup,
) {
  await f.api.requestHeartbeatRunner(true, [200], {
    runnerId,
    group,
    mode,
    snapshotSequence: sequence,
  });
}

describe("internal WSS target via guarded test API route", () => {
  it("defaults off, then resolves only the authorized active winner after both settings", async () => {
    const f = await setup();
    const run = await createRun(f);
    const runnerId = randomUUID();
    await claimRun(f, run.runId, {
      runnerId,
      hostname: inventoryHostname,
      version: "0.214.2",
    });
    await heartbeat(f, runnerId, "running", 1);
    await expect(readTarget(run.runId, f.actor)).resolves.toBeNull();
    mockEnv(
      "OKOU_WSS_HOST_ORIGINS",
      JSON.stringify([{ inventoryHostname, publicOrigin }]),
    );
    await expect(readTarget(run.runId, f.actor)).resolves.toBeNull();
    mockEnv("OKOU_WSS_MIN_RUNNER_VERSION", "0.214.0");
    await expect(readTarget(run.runId, f.actor)).resolves.toMatchObject({
      runId: run.runId,
      runnerId,
      publicOrigin,
      ingressVerification: "not-observed",
      claimedVersion: "0.214.2",
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

  it("keeps draining available for owned runs but rejects stopped, mismatched and stale snapshots", async () => {
    provision();
    const f = await setup();
    const run = await createRun(f);
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
    await heartbeat(f, runnerId, "stopping", 3);
    await expect(readTarget(run.runId, f.actor)).resolves.toBeNull();
    await heartbeat(f, runnerId, "running", 4, "vm0/other");
    await expect(readTarget(run.runId, f.actor)).resolves.toBeNull();
    await f.api.requestCancelRun(f.actor, run.runId, [200]);
  });

  it("rejects unsupported and missing claim metadata and unlisted or malformed host mapping", async () => {
    provision();
    const f = await setup();
    const runnerId = randomUUID();
    await heartbeat(f, runnerId, "running", 1);
    const oldRun = await createRun(f);
    await claimRun(f, oldRun.runId, {
      runnerId,
      hostname: inventoryHostname,
      version: "0.213.99",
    });
    await expect(readTarget(oldRun.runId, f.actor)).resolves.toBeNull();
    const historical = await createRun(f);
    await claimRun(f, historical.runId, { runnerId });
    await expect(readTarget(historical.runId, f.actor)).resolves.toBeNull();
    const current = await createRun(f);
    await claimRun(f, current.runId, {
      runnerId,
      hostname: inventoryHostname,
      version: "0.214.9",
    });
    await expect(readTarget(current.runId, f.actor)).resolves.toMatchObject({
      publicOrigin,
    });
    expect(() => {
      mockEnv("OKOU_WSS_HOST_ORIGINS", "{");
    }).toThrow("Expected property name");
    mockEnv(
      "OKOU_WSS_HOST_ORIGINS",
      JSON.stringify([
        { inventoryHostname: "other.example.com", publicOrigin },
      ]),
    );
    await expect(readTarget(current.runId, f.actor)).resolves.toBeNull();
    for (const runId of [oldRun.runId, historical.runId, current.runId]) {
      await f.api.requestCancelRun(f.actor, runId, [200]);
    }
  });
});
