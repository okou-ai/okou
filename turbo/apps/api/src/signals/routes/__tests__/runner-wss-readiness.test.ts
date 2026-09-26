import { createHash, randomBytes, randomUUID } from "node:crypto";

import { runnerWssReadinessContract } from "@okouai/api-contracts/contracts/runner-wss-readiness";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { runnerWssReadinessRoutes } from "../runner-wss-readiness";

const context = testContext();
const nowMs = Date.parse("2026-09-26T10:00:00.000Z");

function client() {
  return setupApp({ context, routes: runnerWssReadinessRoutes })(
    runnerWssReadinessContract,
  );
}

function fixture() {
  const hostA = { id: randomUUID(), hostname: "runner-a.example.test" };
  const hostB = { id: randomUUID(), hostname: "runner-b.example.test" };
  const tokenA = `okou_wss_host_${randomBytes(32).toString("base64url")}`;
  const tokenB = `okou_wss_host_${randomBytes(32).toString("base64url")}`;
  const authA = { authorization: `Bearer ${tokenA}` };
  const authB = { authorization: `Bearer ${tokenB}` };
  const digest = (token: string) => {
    return createHash("sha256").update(token).digest("hex");
  };
  function configure() {
    mockEnv(
      "OKOU_WSS_HOST_PROOFS",
      JSON.stringify([
        { ...hostA, credentialSha256: digest(tokenA) },
        { ...hostB, credentialSha256: digest(tokenB) },
      ]),
    );
  }
  function renew(
    runnerId: string,
    headers = authA,
    observedAt = new Date(nowMs).toISOString(),
  ) {
    return client().renew({
      params: { runnerId },
      headers,
      body: { proof: { nonce: randomBytes(16).toString("hex"), observedAt } },
    });
  }
  function withdraw(runnerId: string, leaseExpiresAt: string, headers = authA) {
    return client().withdraw({
      params: { runnerId },
      headers,
      body: { leaseExpiresAt },
    });
  }
  configure();
  return {
    withdraw,
    hostA,
    hostB,
    tokenA,
    tokenB,
    authA,
    authB,
    configure,
    digest,
    renew,
  };
}

beforeEach(() => {
  mockNow(new Date(nowMs));
});

describe("host-bound Runner WSS local readiness", () => {
  it("fails closed with no host configuration, PAT, fleet token or invalid host credential", async () => {
    const { configure, renew } = fixture();
    const runnerId = randomUUID();
    mockEnv("OKOU_WSS_HOST_PROOFS", undefined);
    expect((await accept(renew(runnerId), [503])).status).toBe(503);
    configure();
    await accept(renew(runnerId, { authorization: "Bearer user-pat" }), [401]);
    await accept(
      renew(runnerId, { authorization: "Bearer official-runner-secret" }),
      [401],
    );
    await accept(
      renew(runnerId, {
        authorization: `Bearer okou_wss_host_${"x".repeat(43)}`,
      }),
      [401],
    );
    mockEnv(
      "OKOU_WSS_HOST_PROOFS",
      JSON.stringify([
        {
          id: randomUUID(),
          hostname: "runner.example.test",
          credentialSha256: "bad",
        },
      ]),
    );
    await accept(renew(runnerId), [503]);
  });

  it("renews only an owned endpoint, expires, withdraws, and allows a fresh same-host probe", async () => {
    const { renew, withdraw, authA, authB } = fixture();
    const runnerId = randomUUID();
    const p = { params: { runnerId }, headers: authA };
    expect((await accept(client().status(p), [200])).body).toStrictEqual({
      localReady: false,
      publicIngressReady: false,
    });
    const initial = await accept(renew(runnerId), [200]);
    expect(initial.body.leaseExpiresAt).toBe(
      new Date(nowMs + 15_000).toISOString(),
    );
    expect((await accept(client().status(p), [200])).body).toStrictEqual({
      localReady: true,
      publicIngressReady: false,
    });
    expect(
      (await accept(client().status({ ...p, headers: authB }), [200])).body
        .localReady,
    ).toBeFalsy();
    mockNow(new Date(nowMs + 15_001));
    expect(
      (await accept(client().status(p), [200])).body.localReady,
    ).toBeFalsy();
    await accept(renew(runnerId, authA, new Date(nowMs).toISOString()), [400]);
    const renewed = await accept(
      renew(runnerId, authA, new Date(nowMs + 15_001).toISOString()),
      [200],
    );
    await accept(withdraw(runnerId, renewed.body.leaseExpiresAt), [200]);
    expect(
      (await accept(client().status(p), [200])).body.localReady,
    ).toBeFalsy();
    mockNow(new Date(nowMs + 15_002));
    await accept(
      renew(runnerId, authA, new Date(nowMs + 15_002).toISOString()),
      [200],
    );
    expect(
      (await accept(client().status(p), [200])).body.localReady,
    ).toBeTruthy();
  });

  it("bounds a delayed lease to its probe and rejects a stale proof after withdrawal", async () => {
    const { renew, withdraw, authA } = fixture();
    const runnerId = randomUUID();
    const p = { params: { runnerId }, headers: authA };
    mockNow(new Date(nowMs + 9000));
    const delayed = await accept(renew(runnerId), [200]);
    expect(delayed.body.leaseExpiresAt).toBe(
      new Date(nowMs + 15_000).toISOString(),
    );
    await accept(withdraw(runnerId, delayed.body.leaseExpiresAt), [200]);
    await accept(renew(runnerId), [400]);
    expect(
      (await accept(client().status(p), [200])).body.localReady,
    ).toBeFalsy();
    mockNow(new Date(nowMs + 9001));
    const fresh = await accept(
      renew(runnerId, authA, new Date(nowMs + 9001).toISOString()),
      [200],
    );
    expect(fresh.body.leaseExpiresAt).toBe(
      new Date(nowMs + 24_001).toISOString(),
    );
    mockNow(new Date(nowMs + 24_002));
    expect(
      (await accept(client().status(p), [200])).body.localReady,
    ).toBeFalsy();
  });

  it("does not let a delayed or foreign withdrawal erase a newer same-host lease", async () => {
    const { renew, withdraw, authA, authB } = fixture();
    const runnerId = randomUUID();
    const p = { params: { runnerId }, headers: authA };
    const oldLease = await accept(renew(runnerId), [200]);
    mockNow(new Date(nowMs + 5000));
    const freshLease = await accept(
      renew(runnerId, authA, new Date(nowMs + 5000).toISOString()),
      [200],
    );
    await accept(
      renew(runnerId, authA, new Date(nowMs + 1000).toISOString()),
      [400],
    );
    await accept(withdraw(runnerId, oldLease.body.leaseExpiresAt), [200]);
    await accept(
      withdraw(runnerId, freshLease.body.leaseExpiresAt, authB),
      [200],
    );
    expect(
      (await accept(client().status(p), [200])).body.localReady,
    ).toBeTruthy();
    await accept(withdraw(runnerId, freshLease.body.leaseExpiresAt), [200]);
    expect(
      (await accept(client().status(p), [200])).body.localReady,
    ).toBeFalsy();
  });

  it("rejects duplicate host bindings and future-dated listener proofs", async () => {
    const { renew, hostA, hostB, tokenA, tokenB, digest, authA } = fixture();
    const runnerId = randomUUID();
    await accept(
      renew(runnerId, authA, new Date(nowMs + 1000).toISOString()),
      [400],
    );
    mockEnv(
      "OKOU_WSS_HOST_PROOFS",
      JSON.stringify([
        { ...hostA, credentialSha256: digest(tokenA) },
        { ...hostB, id: hostA.id, credentialSha256: digest(tokenB) },
      ]),
    );
    expect((await accept(renew(runnerId), [503])).status).toBe(503);
  });

  it("allows only one bound host to win a simultaneous copied-ID claim", async () => {
    const { renew, authA, authB } = fixture();
    const runnerId = randomUUID();
    const responses = await Promise.all([
      renew(runnerId, authA),
      renew(runnerId, authB),
    ]);
    expect(
      responses
        .map((response) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    for (const headers of [authA, authB]) {
      expect(
        (
          await accept(
            client().status({ params: { runnerId }, headers }),
            [200],
          )
        ).body.localReady,
      ).toBeFalsy();
      await accept(renew(runnerId, headers), [409]);
    }
  });

  it("quarantines a copied ID for both hosts even after the original lease expires", async () => {
    const { renew, authA, authB } = fixture();
    const runnerId = randomUUID();
    await accept(renew(runnerId), [200]);
    await accept(renew(runnerId, authB), [409]);
    for (const headers of [authA, authB]) {
      expect(
        (
          await accept(
            client().status({ params: { runnerId }, headers }),
            [200],
          )
        ).body.localReady,
      ).toBeFalsy();
    }
    mockNow(new Date(nowMs + 30_000));
    for (const headers of [authA, authB]) {
      await accept(
        renew(runnerId, headers, new Date(nowMs + 30_000).toISOString()),
        [409],
      );
    }
  });
});
