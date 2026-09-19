import { randomUUID } from "node:crypto";

import { runnerApiUsageContract } from "@okouai/api-contracts/contracts/runner-api-usage";
import { testApiUsageStateContract } from "@okouai/api-contracts/contracts/test-api-usage-state";
import {
  testSshConnectionStateContract,
  type TestSshConnectionStateActionBody,
} from "@okouai/api-contracts/contracts/test-ssh-connection-state";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { runnerApiUsageRoutes } from "../runner-api-usage";
import { testApiUsageStateRoutes } from "../test-api-usage-state";
import { testSshConnectionStateRoutes } from "../test-ssh-connection-state";

const context = testContext();
const runnerSecret = "a".repeat(64);
const runnerHeaders = Object.freeze({
  authorization: `Bearer vm0_official_${runnerSecret}`,
});
type RuntimeBody = Extract<
  TestSshConnectionStateActionBody,
  { action: "create-runtime" }
>;

function client() {
  return setupApp({ context, routes: runnerApiUsageRoutes })(
    runnerApiUsageContract,
  );
}

function stateClient() {
  return setupApp({ context, routes: testSshConnectionStateRoutes })(
    testSshConnectionStateContract,
  );
}

function usageStateClient() {
  return setupApp({ context, routes: testApiUsageStateRoutes })(
    testApiUsageStateContract,
  );
}

async function initialize(runId: string, phase: "no-inference" | "pending") {
  await accept(
    usageStateClient().action({
      body: { action: "initialize", runId, phase },
    }),
    [200],
  );
}

async function register(runId: string, attemptId: string) {
  await accept(
    usageStateClient().action({
      body: { action: "register", runId, attemptId },
    }),
    [200],
  );
}

async function corrupt(runId: string) {
  await accept(
    usageStateClient().action({
      body: { action: "corrupt-projection", runId },
    }),
    [200],
  );
}

async function observe(
  runId: string,
  attemptId: string,
  input: {
    readonly coverage: "complete" | "partial" | "unavailable";
    readonly tokens: {
      readonly input: number | null;
      readonly cacheRead: number | null;
      readonly cacheCreation: number | null;
      readonly output: number | null;
    };
  } | null,
) {
  await accept(
    usageStateClient().action({
      body: { action: "observe", runId, attemptId, observation: input },
    }),
    [200],
  );
}

async function runtime(overrides: Partial<RuntimeBody> = {}) {
  const runnerIdentity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 5_000_000_000,
  };
  const result = await accept(
    stateClient().action({
      body: {
        action: "create-runtime",
        orgId: `org_api_usage_${randomUUID()}`,
        userId: `user_api_usage_${randomUUID()}`,
        ...runnerIdentity,
        triggerSource: "web",
        status: "running",
        chat: true,
        access: false,
        ...overrides,
      },
    }),
    [200],
  );
  if (!result.body.runId) {
    throw new Error("Missing runtime Run identity");
  }
  return { runId: result.body.runId, runnerIdentity };
}

async function read(input: Awaited<ReturnType<typeof runtime>>) {
  return await accept(
    client().read({
      headers: runnerHeaders,
      params: { runId: input.runId },
      body: { runnerIdentity: input.runnerIdentity },
    }),
    [200],
  );
}

beforeEach(() => {
  mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
});

describe("Runner API usage", () => {
  it("keeps old writers and stale claims opaque without an SSH grant", async () => {
    const f = await runtime();
    const absent = await read(f);
    expect(absent.headers.get("cache-control")).toBe("no-store");
    expect(absent.body).toStrictEqual({ state: "unavailable", runId: f.runId });

    await initialize(f.runId, "no-inference");
    expect((await read(f)).body).toMatchObject({
      state: "available",
      inferenceState: "no_inference",
      complete: true,
      observedAttempts: 0,
      outstandingAttempts: 0,
      totals: { total: 0 },
    });
    for (const runnerIdentity of [
      { ...f.runnerIdentity, runnerId: randomUUID() },
      {
        ...f.runnerIdentity,
        heartbeatGeneration: f.runnerIdentity.heartbeatGeneration - 1,
      },
    ]) {
      expect((await read({ ...f, runnerIdentity })).body).toStrictEqual({
        state: "unavailable",
        runId: f.runId,
      });
    }

    for (const unavailable of [
      await runtime({ status: "pending" }),
      await runtime({ runnerId: null, heartbeatGeneration: null }),
    ]) {
      await initialize(unavailable.runId, "no-inference");
      expect((await read(unavailable)).body).toStrictEqual({
        state: "unavailable",
        runId: unavailable.runId,
      });
    }
  });

  it("serves monotonic cumulative evidence and preserves duplicate revisions", async () => {
    const f = await runtime();
    await initialize(f.runId, "pending");
    const pending = await read(f);
    expect(pending.body).toMatchObject({
      state: "available",
      revision: 1,
      inferenceState: "pending",
      complete: false,
      reasons: ["pending_inference"],
    });

    const attemptId = randomUUID();
    await register(f.runId, attemptId);
    await observe(f.runId, attemptId, {
      coverage: "complete",
      tokens: { input: 1, cacheRead: 2, cacheCreation: 3, output: 4 },
    });
    const observed = await read(f);
    expect(observed.body).toMatchObject({
      state: "available",
      revision: 3,
      inferenceState: "attempted",
      complete: true,
      observedAttempts: 1,
      outstandingAttempts: 0,
      totals: {
        input: 1,
        cacheRead: 2,
        cacheCreation: 3,
        output: 4,
        total: 10,
      },
    });
    await observe(f.runId, attemptId, {
      coverage: "complete",
      tokens: { input: 1, cacheRead: 2, cacheCreation: 3, output: 4 },
    });
    expect((await read(f)).body).toMatchObject({ revision: 3 });
    await observe(f.runId, attemptId, null);
    expect((await read(f)).body).toMatchObject({
      revision: 3,
      complete: true,
      totals: { total: 10 },
    });

    await observe(f.runId, attemptId, {
      coverage: "complete",
      tokens: { input: 9, cacheRead: 2, cacheCreation: 3, output: 4 },
    });
    expect((await read(f)).body).toMatchObject({
      revision: 4,
      complete: false,
      reasons: ["ambiguous_attempt"],
      totals: { input: 0, cacheRead: 2, cacheCreation: 3, output: 4, total: 9 },
    });

    for (let index = 0; index < 8; index += 1) {
      await register(f.runId, randomUUID());
    }
    expect((await read(f)).body).toMatchObject({
      observedAttempts: 1,
      outstandingAttempts: 7,
      complete: false,
      reasons: ["in_flight", "ambiguous_attempt", "overflow"],
    });
  });

  it("keeps first-terminal evidence loss sticky while retaining later totals", async () => {
    const f = await runtime();
    await initialize(f.runId, "pending");
    const attemptId = randomUUID();
    await register(f.runId, attemptId);
    await observe(f.runId, attemptId, null);
    expect((await read(f)).body).toMatchObject({
      revision: 3,
      complete: false,
      reasons: ["missing_usage"],
      totals: { total: 0 },
    });

    await observe(f.runId, attemptId, {
      coverage: "complete",
      tokens: { input: 1, cacheRead: 2, cacheCreation: 3, output: 4 },
    });
    expect((await read(f)).body).toMatchObject({
      revision: 4,
      complete: false,
      reasons: ["missing_usage"],
      totals: { total: 10 },
    });
  });

  it("keeps aggregate overflow sticky and omits only the unsafe contribution", async () => {
    const f = await runtime();
    await initialize(f.runId, "pending");
    const firstAttemptId = randomUUID();
    const secondAttemptId = randomUUID();
    await observe(f.runId, firstAttemptId, {
      coverage: "complete",
      tokens: {
        input: Number.MAX_SAFE_INTEGER,
        cacheRead: 0,
        cacheCreation: 0,
        output: 0,
      },
    });
    await observe(f.runId, secondAttemptId, {
      coverage: "complete",
      tokens: { input: 0, cacheRead: 0, cacheCreation: 0, output: 1 },
    });
    expect((await read(f)).body).toMatchObject({
      complete: false,
      reasons: ["overflow"],
      totals: {
        input: Number.MAX_SAFE_INTEGER,
        cacheRead: 0,
        cacheCreation: 0,
        output: 0,
        total: Number.MAX_SAFE_INTEGER,
      },
    });

    await observe(f.runId, firstAttemptId, {
      coverage: "complete",
      tokens: {
        input: Number.MAX_SAFE_INTEGER - 1,
        cacheRead: 0,
        cacheCreation: 0,
        output: 0,
      },
    });
    expect((await read(f)).body).toMatchObject({
      complete: false,
      reasons: ["ambiguous_attempt", "overflow"],
      totals: { input: 0, output: 1, total: 1 },
    });
  });

  it("distinguishes provider zero from partial category coverage", async () => {
    const zero = await runtime();
    await initialize(zero.runId, "pending");
    const zeroAttemptId = randomUUID();
    await register(zero.runId, zeroAttemptId);
    await observe(zero.runId, zeroAttemptId, {
      coverage: "complete",
      tokens: { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 },
    });
    expect((await read(zero)).body).toMatchObject({
      inferenceState: "attempted",
      observedAttempts: 1,
      complete: true,
      reasons: [],
      totals: { total: 0 },
    });

    const partial = await runtime();
    await initialize(partial.runId, "pending");
    const partialAttemptId = randomUUID();
    await register(partial.runId, partialAttemptId);
    await observe(partial.runId, partialAttemptId, {
      coverage: "partial",
      tokens: { input: 7, cacheRead: null, cacheCreation: null, output: 3 },
    });
    expect((await read(partial)).body).toMatchObject({
      inferenceState: "attempted",
      observedAttempts: 1,
      complete: false,
      reasons: ["missing_categories"],
      totals: { input: 7, output: 3, total: 10 },
    });
  });

  it("sets no-store before rejecting non-official credentials", async () => {
    const f = await runtime();
    const result = await client().read({
      headers: { authorization: "Bearer wrong" },
      params: { runId: f.runId },
      body: { runnerIdentity: f.runnerIdentity },
    });
    expect(result.status).toBe(401);
    expect(result.headers.get("cache-control")).toBe("no-store");
  });

  it("surfaces corrupt source state instead of returning unavailable", async () => {
    const f = await runtime();
    await initialize(f.runId, "pending");
    await corrupt(f.runId);

    const result = await client().read({
      headers: runnerHeaders,
      params: { runId: f.runId },
      body: { runnerIdentity: f.runnerIdentity },
    });
    expect(result.status).toBe(500);
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
});
