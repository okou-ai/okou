import { publicChatActor } from "./helpers/public-chat-actor";
import { randomUUID } from "node:crypto";

import { CLIENT_VERSION_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { setupApp } from "../../../__tests__/test-helpers";
import { runnerWssTicketRoutes } from "../runner-wss-tickets";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const inventoryHostname = "runner-a.example.com";
const publicOrigin = `wss://${inventoryHostname}:443`;

async function setup() {
  const owned = await publicChatActor(context, {
    restoreEnvironment: clearMockNow,
  });
  return { ...owned, api: createRunsApi(context) };
}

async function createOwnedRun(f: Awaited<ReturnType<typeof setup>>) {
  return await f.run(async () => {
    const run = await f.api.createThreadRun(f.actor, {
      agentId: f.agentId,
      prompt: "Resolve an existing Runner target",
    });
    await f.api.heartbeatRunner(f.runnerGroup);
    return run;
  });
}

async function bootstrapTarget(
  f: Awaited<ReturnType<typeof setup>>,
  runId: string,
  status: 200 | 404,
  actor = f.actor,
) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
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

async function claimRun(
  f: Awaited<ReturnType<typeof setup>>,
  runId: string,
  args: {
    readonly runnerId: string;
    readonly hostname?: string;
    readonly version?: string;
  },
) {
  return await f.claimRunnerRun(
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
  await f.run(async () => {
    await f.api.requestHeartbeatRunner(true, [200], {
      runnerId,
      group: options.group ?? f.runnerGroup,
      mode,
      snapshotSequence: sequence,
      wssIngressServiceActive: options.wssIngressServiceActive ?? true,
    });
  });
}

describe("WSS bootstrap target eligibility", () => {
  it("resolves only the authorized active official winner", async () => {
    const f = await setup();
    const run = await createOwnedRun(f);
    const runnerId = randomUUID();
    await claimRun(f, run.runId, {
      runnerId,
      hostname: inventoryHostname,
      version: "0.214.2",
    });

    await heartbeat(f, runnerId, "running", 1);
    expect((await bootstrapTarget(f, run.runId, 200)).body).toMatchObject({
      wssUrl: `${publicOrigin}/ws/${runnerId}`,
    });
    expect(
      (
        await bootstrapTarget(f, run.runId, 404, {
          ...f.actor,
          userId: "not-owner",
        })
      ).body,
    ).toStrictEqual(unavailableTarget());
    expect(
      (
        await bootstrapTarget(f, run.runId, 404, {
          ...f.actor,
          orgId: "not-owner",
        })
      ).body,
    ).toStrictEqual(unavailableTarget());
    await f.api.requestCancelRun(f.actor, run.runId, [200]);
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
  });

  it("refreshes an unchanged snapshot while preserving WSS ordering", async () => {
    const f = await setup();
    const run = await createOwnedRun(f);
    const runnerId = randomUUID();
    await claimRun(f, run.runId, {
      runnerId,
      hostname: inventoryHostname,
    });

    const initialAt = now();
    mockNow(initialAt);
    await heartbeat(f, runnerId, "running", 1);
    expect((await bootstrapTarget(f, run.runId, 200)).body).toMatchObject({
      wssUrl: `${publicOrigin}/ws/${runnerId}`,
    });
    mockNow(initialAt + 1000);
    await heartbeat(f, runnerId, "running", 2);
    // At the original snapshot's expiry, the identical newer snapshot is fresh.
    mockNow(initialAt + 30_000);
    expect((await bootstrapTarget(f, run.runId, 200)).body).toMatchObject({
      wssUrl: `${publicOrigin}/ws/${runnerId}`,
    });
    mockNow(initialAt + 1000);
    await heartbeat(f, runnerId, "running", 1, {
      wssIngressServiceActive: false,
    });
    expect((await bootstrapTarget(f, run.runId, 200)).body).toMatchObject({
      wssUrl: `${publicOrigin}/ws/${runnerId}`,
    });
    await heartbeat(f, runnerId, "running", 3, {
      wssIngressServiceActive: false,
    });
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
  });

  it("does not trust runner identity or hostname supplied by a PAT claimant", async () => {
    const f = await setup();
    const run = await createOwnedRun(f);
    const runnerId = randomUUID();
    const apiKey = await f.api.createCliToken(f.actor);
    const claim = await f.claimPatRun(
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

    await heartbeat(f, runnerId, "running", 1);
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    await f.api.requestCancelRun(f.actor, run.runId, [200]);
  });

  it("keeps draining available for owned runs but rejects stopped, mismatched and stale snapshots", async () => {
    const f = await setup();
    const run = await createOwnedRun(f);
    await heartbeat(f, randomUUID(), "running", 1);
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    const runnerId = randomUUID();
    await claimRun(f, run.runId, {
      runnerId,
      hostname: inventoryHostname,
      version: "0.214.2",
    });

    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    await heartbeat(f, runnerId, "starting", 1);
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    const observedAt = now();
    mockNow(observedAt);
    await heartbeat(f, runnerId, "draining", 2);
    expect((await bootstrapTarget(f, run.runId, 200)).body).toMatchObject({
      wssUrl: `${publicOrigin}/ws/${runnerId}`,
    });
    mockNow(observedAt + 30_000);
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    mockNow(observedAt - 5001);
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    mockNow(observedAt);
    await heartbeat(f, runnerId, "draining", 3, {
      wssIngressServiceActive: false,
    });
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    await heartbeat(f, runnerId, "stopping", 4);
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    await heartbeat(f, runnerId, "running", 5, { group: "vm0/other" });
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
  });

  it("denies a missing or inactive WSS ingress observation and rejects an older true snapshot", async () => {
    const f = await setup();
    const run = await createOwnedRun(f);
    const runnerId = randomUUID();
    await claimRun(f, run.runId, {
      runnerId,
      hostname: inventoryHostname,
    });

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
    const oldRun = await createOwnedRun(f);
    await claimRun(f, oldRun.runId, {
      runnerId,
      hostname: inventoryHostname,
      version: "0.213.99",
    });

    expect((await bootstrapTarget(f, oldRun.runId, 200)).body).toMatchObject({
      wssUrl: `${publicOrigin}/ws/${runnerId}`,
    });
    const historical = await createOwnedRun(f);
    await claimRun(f, historical.runId, { runnerId });

    expect(
      (await bootstrapTarget(f, historical.runId, 404)).body,
    ).toStrictEqual(unavailableTarget());
    const noVersion = await createOwnedRun(f);
    await claimRun(f, noVersion.runId, {
      runnerId,
      hostname: inventoryHostname,
    });

    expect((await bootstrapTarget(f, noVersion.runId, 200)).body).toMatchObject(
      { wssUrl: `${publicOrigin}/ws/${runnerId}` },
    );
  });

  it("rejects a browser-normalized IP hostname in an otherwise eligible official claim", async () => {
    const f = await setup();
    const run = await createOwnedRun(f);
    const runnerId = randomUUID();
    await claimRun(f, run.runId, {
      runnerId,
      hostname: "127.1",
      version: "0.214.9",
    });

    await heartbeat(f, runnerId, "running", 1);
    expect((await bootstrapTarget(f, run.runId, 404)).body).toStrictEqual(
      unavailableTarget(),
    );
    await f.api.requestCancelRun(f.actor, run.runId, [200]);
  });
});
