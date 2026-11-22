import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createVncExecutionApi } from "./helpers/vnc-execution";
import { channelsPublishedTo } from "./helpers/realtime-publications";
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
const executionApi = createVncExecutionApi(context);
const bdd = createBddApi(context);
const runs = createRunsApi(context);
beforeEach(initializeVncRuntimeTest);
afterEach(executionApi.cleanup);

function check(
  f: Pick<
    VncRuntimeFixture,
    "runId" | "connectionId" | "runnerIdentity" | "orgId" | "userId"
  >,
  generation = 1,
) {
  api.authenticate(f);
  return accept(
    api.runner().check({
      headers: vncRunnerHeaders,
      params: { runId: f.runId },
      body: {
        connectionId: f.connectionId,
        runnerIdentity: f.runnerIdentity,
        expectedGeneration: generation,
        expectedTransport: { type: "direct" },
      },
    }),
    [200],
  );
}

function notifications() {
  return context.mocks.ably.publish.mock.calls.filter((call) => {
    return call[0] === "vnc-authority-invalidated";
  });
}

describe("VNC authority and revocation", () => {
  it("requires exact current Run/Runner/configuration", async () => {
    const f = await executionApi.fixture();
    expect((await check(f)).body).toStrictEqual({
      outcome: "valid",
    });
    expect((await check(f, 2)).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    for (const runnerIdentity of [
      { ...f.runnerIdentity, runnerId: randomUUID() },
      {
        ...f.runnerIdentity,
        heartbeatGeneration: f.runnerIdentity.heartbeatGeneration + 1,
      },
    ]) {
      expect((await check({ ...f, runnerIdentity })).body).toStrictEqual({
        outcome: "unavailable",
      });
    }
    expect((await check({ ...f, runId: randomUUID() })).body).toStrictEqual({
      outcome: "unavailable",
    });
    const another = await executionApi.fixture();
    expect(
      (await check({ ...another, connectionId: f.connectionId })).body,
    ).toStrictEqual({ outcome: "unavailable" });
  });

  it("delivers host changes only to the exact owner/connection and refuses stale generations", async () => {
    const f = await executionApi.fixture();
    const another = await executionApi.fixture();
    api.authenticate(f);
    context.mocks.ably.publish.mockClear();
    await accept(
      api.connections().update({
        headers: vncSessionHeaders,
        params: { connectionId: f.connectionId },
        body: { expectedGeneration: 1, displayName: "Changed desktop" },
      }),
      [200],
    );
    expect(notifications()).toStrictEqual([
      [
        "vnc-authority-invalidated",
        { runId: f.runId, connectionId: f.connectionId },
      ],
    ]);
    expect(
      channelsPublishedTo(context.mocks, "ssh-authority-invalidated"),
    ).toStrictEqual([]);
    expect((await check(f)).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    context.mocks.ably.publish.mockClear();
    await accept(
      api.connections().update({
        headers: vncSessionHeaders,
        params: { connectionId: f.connectionId },
        body: { expectedGeneration: 1, displayName: "Stale write" },
      }),
      [409],
    );
    expect(notifications()).toStrictEqual([]);
    await accept(
      api.connections().delete({
        headers: vncSessionHeaders,
        params: { connectionId: f.connectionId },
        body: { expectedGeneration: 2 },
      }),
      [204],
    );
    expect(notifications()).toStrictEqual([
      [
        "vnc-authority-invalidated",
        { runId: f.runId, connectionId: f.connectionId },
      ],
    ]);
    expect((await check(f, 2)).body).toStrictEqual({
      outcome: "unavailable",
    });
    for (const value of [f, another]) {
      await expect(
        runs.readRun(bdd.user(value), value.runId),
      ).resolves.toMatchObject({ status: "running" });
    }
  });

  it("revokes current credential references and preserves unrelated connections", async () => {
    const f = await executionApi.fixture();
    api.authenticate(f);
    const linked = await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: { ...vncConnectionBody(), credential: { id: f.credentialId } },
      }),
      [201],
    );
    await accept(
      api
        .connections()
        .create({ headers: vncSessionHeaders, body: vncConnectionBody() }),
      [201],
    );
    context.mocks.ably.publish.mockClear();
    await accept(
      api.credentials().update({
        headers: vncSessionHeaders,
        params: { credentialId: f.credentialId },
        body: {
          expectedRevision: 1,
          authentication: {
            method: "vnc_password",
            password: "rotated",
          },
        },
      }),
      [200],
    );
    expect(notifications()).toHaveLength(2);
    expect(notifications()).toStrictEqual(
      expect.arrayContaining([
        [
          "vnc-authority-invalidated",
          { runId: f.runId, connectionId: f.connectionId },
        ],
        [
          "vnc-authority-invalidated",
          { runId: f.runId, connectionId: linked.body.id },
        ],
      ]),
    );
    expect((await check(f)).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    expect((await check(f, 2)).body).toStrictEqual({
      outcome: "valid",
    });
  });

  it("a publication failure preserves the committed host change and current admission refusal", async () => {
    const f = await executionApi.fixture();
    api.authenticate(f);
    context.mocks.ably.publish.mockRejectedValue(
      new Error("notification unavailable"),
    );
    await accept(
      api.connections().update({
        headers: vncSessionHeaders,
        params: { connectionId: f.connectionId },
        body: {
          expectedGeneration: 1,
          displayName: "Committed during outage",
        },
      }),
      [200],
    );
    expect((await check(f)).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    expect((await check(f, 2)).body).toStrictEqual({
      outcome: "valid",
    });
    context.mocks.ably.publish.mockResolvedValue(undefined);
  });
});
