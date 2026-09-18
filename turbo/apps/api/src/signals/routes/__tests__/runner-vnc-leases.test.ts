import { randomUUID } from "node:crypto";
import type {
  RunnerVncAcquireRequest,
  RunnerVncAuthority,
} from "@okouai/api-contracts/contracts/runner-vnc";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { onRejection } from "../../utils";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncConnectionBody,
  vncRunnerHeaders,
  vncSessionHeaders,
  type VncRuntimeFixture,
} from "./helpers/vnc-runtime";

const context = testContext();
const api = createVncRuntimeApi(context);
beforeEach(initializeVncRuntimeTest);

function acquire(
  f: VncRuntimeFixture,
  authority: RunnerVncAuthority,
  holderId = randomUUID(),
) {
  const body: RunnerVncAcquireRequest = {
    connectionId: f.connectionId,
    runnerIdentity: f.runnerIdentity,
    authority,
    holderId,
  };
  return accept(
    api
      .runner()
      .acquire({ headers: vncRunnerHeaders, params: { runId: f.runId }, body }),
    [200],
  );
}

async function acquired(
  f: VncRuntimeFixture,
  authority: RunnerVncAuthority,
  holderId = randomUUID(),
) {
  const result = (await acquire(f, authority, holderId)).body;
  if (result.outcome !== "acquired") {
    throw new Error(`VNC fixture did not acquire: ${result.outcome}`);
  }
  return result;
}

function leaseRequest(
  f: VncRuntimeFixture,
  authority: RunnerVncAuthority,
  leaseToken: string,
) {
  return {
    headers: vncRunnerHeaders,
    params: { runId: f.runId },
    body: {
      connectionId: f.connectionId,
      runnerIdentity: f.runnerIdentity,
      authority,
      leaseToken,
    },
  };
}

async function expire(f: VncRuntimeFixture, leaseToken: string) {
  // Database wall time is an infrastructure state with no production mutation API.
  await accept(
    api.state().action({
      body: {
        action: "expire-lease",
        orgId: f.orgId,
        userId: f.userId,
        connectionId: f.connectionId,
        leaseToken,
      },
    }),
    [200],
  );
}

function lock(
  f: VncRuntimeFixture,
  action:
    | "hold-connection-lock"
    | "read-connection-lock"
    | "release-connection-lock",
) {
  return accept(
    api.state().action({
      body: {
        action,
        orgId: f.orgId,
        userId: f.userId,
        connectionId: f.connectionId,
      },
    }),
    [200],
  );
}

describe("fenced VNC control leases", () => {
  it("replays one acquisition without extending it, renews current authority and bounds its clock data", async () => {
    const f = await api.fixture();
    const { authority } = await api.resolved(f);
    const holderId = randomUUID();
    const first = await acquired(f, authority, holderId);
    expect(first.validForMs).toBeGreaterThan(0);
    expect(first.validForMs).toBeLessThanOrEqual(30_000);
    expect(first.renewAfterMs).toBe(10_000);
    expect(
      Math.abs(
        Date.parse(first.expiresAt) -
          Date.parse(first.serverTime) -
          first.validForMs,
      ),
    ).toBeLessThanOrEqual(1);
    const replay = await acquired(f, authority, holderId);
    expect(replay.leaseToken).toBe(first.leaseToken);
    expect(replay.expiresAt).toBe(first.expiresAt);
    expect(replay.validForMs).toBeLessThanOrEqual(first.validForMs);
    const request = leaseRequest(f, authority, first.leaseToken);
    const checked = await accept(api.runner().check(request), [200]);
    expect(checked.body).toMatchObject({
      outcome: "valid",
      leaseToken: first.leaseToken,
      expiresAt: first.expiresAt,
    });
    const renewed = await accept(api.runner().renew(request), [200]);
    expect(renewed.body).toMatchObject({
      outcome: "valid",
      leaseToken: first.leaseToken,
      renewAfterMs: 10_000,
    });
    if (renewed.body.outcome !== "valid") {
      throw new Error("Expected renewed VNC lease");
    }
    expect(Date.parse(renewed.body.expiresAt)).toBeGreaterThanOrEqual(
      Date.parse(first.expiresAt),
    );
    expect((await acquire(f, authority)).body).toStrictEqual({
      outcome: "busy",
    });
    expect(
      (await accept(api.runner().release(request), [200])).body,
    ).toStrictEqual({ outcome: "released" });
    expect(
      (await accept(api.runner().renew(request), [200])).body,
    ).toStrictEqual({ outcome: "expired" });
    expect((await acquire(f, authority, holderId)).body).toStrictEqual({
      outcome: "expired",
    });
  });

  it("admits exactly one concurrent contender and lets exact concurrent replay converge", async () => {
    const f = await api.fixture();
    const { authority } = await api.resolved(f);
    const results = await Promise.all([
      acquire(f, authority),
      acquire(f, authority),
    ]);
    expect(
      results
        .map((result) => {
          return result.body.outcome;
        })
        .sort(),
    ).toStrictEqual(["acquired", "busy"]);
    const winner = results.find((result) => {
      return result.body.outcome === "acquired";
    });
    if (!winner || winner.body.outcome !== "acquired") {
      throw new Error("Expected one VNC winner");
    }
    await accept(
      api.runner().release(leaseRequest(f, authority, winner.body.leaseToken)),
      [200],
    );
    const holderId = randomUUID();
    const replay = await Promise.all([
      acquired(f, authority, holderId),
      acquired(f, authority, holderId),
    ]);
    expect(replay[0].leaseToken).toBe(replay[1].leaseToken);
    expect(replay[0].expiresAt).toBe(replay[1].expiresAt);
  });

  it("never lets expired or superseded tokens renew or release their replacement", async () => {
    const f = await api.fixture();
    const { authority } = await api.resolved(f);
    const holderId = randomUUID();
    const first = await acquired(f, authority, holderId);
    const stale = leaseRequest(f, authority, first.leaseToken);
    await expire(f, first.leaseToken);
    const rejected = await Promise.all([
      accept(api.runner().check(stale), [200]),
      accept(api.runner().renew(stale), [200]),
      accept(api.runner().release(stale), [200]),
    ]);
    for (const result of rejected) {
      expect(result.body).toStrictEqual({
        outcome: "expired",
      });
    }
    expect((await acquire(f, authority, holderId)).body).toStrictEqual({
      outcome: "expired",
    });
    const replacement = await acquired(f, authority);
    expect(replacement.leaseToken).not.toBe(first.leaseToken);
    expect((await accept(api.runner().renew(stale), [200])).body).toStrictEqual(
      { outcome: "expired" },
    );
    expect(
      (await accept(api.runner().release(stale), [200])).body,
    ).toStrictEqual({ outcome: "expired" });
    expect(
      (
        await accept(
          api
            .runner()
            .check(leaseRequest(f, authority, replacement.leaseToken)),
          [200],
        )
      ).body.outcome,
    ).toBe("valid");
  });

  it("retains a revoked holder until expiry and rejects revoke/regrant authority reuse", async () => {
    const f = await api.fixture();
    const original = await api.resolved(f);
    const first = await acquired(f, original.authority);
    const stale = leaseRequest(f, original.authority, first.leaseToken);
    await api.grant(f, false);
    expect((await accept(api.runner().renew(stale), [200])).body).toStrictEqual(
      { outcome: "unavailable" },
    );
    await api.grant(f, true);
    const replacement = await api.resolved(f);
    expect(replacement.authority.grantId).not.toBe(original.authority.grantId);
    expect((await acquire(f, original.authority)).body.outcome).toBe(
      "configuration_changed",
    );
    expect((await acquire(f, replacement.authority)).body).toStrictEqual({
      outcome: "busy",
    });
    await expire(f, first.leaseToken);
    const next = await acquired(f, replacement.authority);
    expect(next.leaseToken).not.toBe(first.leaseToken);
    expect(
      (await accept(api.runner().release(stale), [200])).body.outcome,
    ).not.toBe("released");
    expect(
      (
        await accept(
          api
            .runner()
            .check(leaseRequest(f, replacement.authority, next.leaseToken)),
          [200],
        )
      ).body.outcome,
    ).toBe("valid");
  });

  it("fences credential rotation while preserving the old reservation's accepted lifetime", async () => {
    const f = await api.fixture();
    const original = await api.resolved(f);
    const first = await acquired(f, original.authority);
    await accept(
      api.credentials().update({
        headers: vncSessionHeaders,
        params: { credentialId: f.credentialId },
        body: {
          expectedRevision: 1,
          authentication: { method: "vnc_password", password: "rotated" },
        },
      }),
      [200],
    );
    const replacement = await api.resolved(f);
    expect(replacement.authority.generation).toBe(
      original.authority.generation + 1,
    );
    expect(
      (
        await accept(
          api
            .runner()
            .renew(leaseRequest(f, original.authority, first.leaseToken)),
          [200],
        )
      ).body.outcome,
    ).toBe("configuration_changed");
    expect((await acquire(f, replacement.authority)).body).toStrictEqual({
      outcome: "busy",
    });
    await expire(f, first.leaseToken);
    expect((await acquire(f, replacement.authority)).body.outcome).toBe(
      "acquired",
    );
  });

  it("fences physical UUID reuse even when the public generation restarts at one", async () => {
    const f = await api.fixture();
    const original = await api.resolved(f);
    const first = await acquired(f, original.authority);
    await accept(
      api.connections().delete({
        headers: vncSessionHeaders,
        params: { connectionId: f.connectionId },
        body: { expectedGeneration: 1 },
      }),
      [204],
    );
    expect(
      (
        await accept(
          api
            .runner()
            .check(leaseRequest(f, original.authority, first.leaseToken)),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "unavailable" });
    await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: vncConnectionBody(f.connectionId),
      }),
      [201],
    );
    const replacement = await api.resolved(f);
    expect(replacement.authority.generation).toBe(1);
    expect(replacement.authority.instanceId).not.toBe(
      original.authority.instanceId,
    );
    expect((await acquire(f, original.authority)).body.outcome).toBe(
      "configuration_changed",
    );
    const next = await acquired(f, replacement.authority);
    expect(
      (
        await accept(
          api
            .runner()
            .release(leaseRequest(f, original.authority, first.leaseToken)),
          [200],
        )
      ).body.outcome,
    ).not.toBe("released");
    expect(
      (
        await accept(
          api
            .runner()
            .check(leaseRequest(f, replacement.authority, next.leaseToken)),
          [200],
        )
      ).body.outcome,
    ).toBe("valid");
  });

  it("binds tokens to the exact Run and winning process rather than the owner or Agent", async () => {
    const f = await api.fixture();
    const { authority } = await api.resolved(f);
    const first = await acquired(f, authority);
    const other = { ...f, ...(await api.runtime(f, { agentId: f.agentId })) };
    expect((await acquire(other, authority)).body).toStrictEqual({
      outcome: "busy",
    });
    expect(
      (
        await accept(
          api.runner().renew(leaseRequest(other, authority, first.leaseToken)),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "expired" });
    const wrongProcess = {
      ...f,
      runnerIdentity: { ...f.runnerIdentity, heartbeatGeneration: 9 },
    };
    expect(
      (
        await accept(
          api
            .runner()
            .release(leaseRequest(wrongProcess, authority, first.leaseToken)),
          [200],
        )
      ).body,
    ).toStrictEqual({ outcome: "unavailable" });
    expect(
      (
        await accept(
          api.runner().check(leaseRequest(f, authority, first.leaseToken)),
          [200],
        )
      ).body.outcome,
    ).toBe("valid");
  });

  it("rechecks the feature after a connection lock wait before acquiring", async () => {
    const f = await api.fixture();
    const { authority } = await api.resolved(f);
    // An external DB lock wait is not constructible through a production route.
    const held = lock(f, "hold-connection-lock");
    await expect
      .poll(async () => {
        return (await lock(f, "read-connection-lock")).body.held;
      })
      .toBe(true);
    const pending = acquire(f, authority);
    const release = async () => {
      await lock(f, "release-connection-lock");
      await Promise.all([held, pending]);
    };
    await onRejection(
      (async () => {
        await expect
          .poll(async () => {
            return (await lock(f, "read-connection-lock")).body.waiting;
          })
          .toBe(true);
        await updateFeatureSwitchesForUser(context, f, {
          [FeatureSwitchKey.VncAccess]: false,
        });
      })(),
      release,
    );
    await release();
    expect((await pending).body).toStrictEqual({ outcome: "unavailable" });
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    expect((await acquire(f, authority)).body.outcome).toBe("acquired");
  });

  it("uses database expiry after a lock wait instead of reviving the prior snapshot", async () => {
    const f = await api.fixture();
    const { authority } = await api.resolved(f);
    const first = await acquired(f, authority);
    const held = lock(f, "hold-connection-lock");
    await expect
      .poll(async () => {
        return (await lock(f, "read-connection-lock")).body.held;
      })
      .toBe(true);
    const pending = api
      .runner()
      .renew(leaseRequest(f, authority, first.leaseToken));
    const release = async () => {
      await lock(f, "release-connection-lock");
      await Promise.all([held, pending]);
    };
    await onRejection(
      (async () => {
        await expect
          .poll(async () => {
            return (await lock(f, "read-connection-lock")).body.waiting;
          })
          .toBe(true);
        await expire(f, first.leaseToken);
      })(),
      release,
    );
    await release();
    expect((await accept(pending, [200])).body).toStrictEqual({
      outcome: "expired",
    });
  });
});
