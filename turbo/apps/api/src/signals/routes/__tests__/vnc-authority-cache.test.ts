import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createClaimedVncApi } from "./helpers/claimed-vnc-runtime";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import {
  updateFeatureSwitchesForUser,
  deleteFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { requireVncCredentialId } from "./helpers/vnc-response";
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
const claimed = createClaimedVncApi(context);
const bdd = createBddApi(context);
const runs = createRunsApi(context);
beforeEach(initializeVncRuntimeTest);
afterEach(claimed.cleanup);

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
  it.each(["configuration", "metadata"] as const)(
    "agent %s privacy changes revoke member Runs and preserve the owner's authority",
    async (entry) => {
      const owner = await claimed.paidOwner();
      const actor = bdd.user(owner);
      const agent = await bdd.createAgent(actor, {
        displayName: "Shared VNC Agent",
        visibility: "public",
      });
      const ownRun = await claimed.runtime({
        ...owner,
        agentId: agent.agentId,
      });
      const member = { orgId: owner.orgId, userId: `user-${randomUUID()}` };
      await updateFeatureSwitchesForUser(context, member, {
        [FeatureSwitchKey.VncAccess]: true,
      });
      await runs.ensurePersonalSubscriptionModel(bdd.user(member), {
        model: "claude-fable-5-1",
      });
      await bdd.readOnboardingStatus(bdd.user(member));
      await bdd.completeOnboarding(bdd.user(member));
      const memberRun = await claimed.runtime({
        ...member,
        agentId: agent.agentId,
      });
      api.authenticate(member);
      const desktop = await accept(
        api
          .connections()
          .create({ headers: vncSessionHeaders, body: vncConnectionBody() }),
        [201],
      );
      await api.enableDefault(member, "vnc", desktop.body.id);
      expect(
        (await check({ ...memberRun, connectionId: desktop.body.id })).body,
      ).toStrictEqual({ outcome: "valid" });
      context.mocks.ably.publish.mockClear();
      if (entry === "configuration") {
        await bdd.updateAgent(actor, agent.agentId, { visibility: "private" });
      } else {
        await bdd.updateAgentMetadata(actor, agent.agentId, {
          visibility: "private",
        });
      }
      expect(notifications()).toStrictEqual([
        [
          "vnc-authority-invalidated",
          { runId: memberRun.runId, connectionId: null },
        ],
      ]);
      expect(
        (await check({ ...memberRun, connectionId: desktop.body.id })).body,
      ).toStrictEqual({ outcome: "unavailable" });
      await expect(bdd.readAgent(actor, agent.agentId)).resolves.toMatchObject({
        visibility: "private",
      });
      for (const value of [ownRun, memberRun]) {
        await expect(
          runs.readRun(bdd.user(value), value.runId),
        ).resolves.toMatchObject({ status: "running" });
      }
      expect(
        channelsPublishedTo(context.mocks, "ssh-authority-invalidated"),
      ).toStrictEqual([]);
    },
  );

  it("requires exact current Run/Runner/configuration", async () => {
    const f = await claimed.fixture();
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
    const another = await claimed.fixture();
    expect(
      (await check({ ...another, connectionId: f.connectionId })).body,
    ).toStrictEqual({ outcome: "unavailable" });
  });

  it("delivers host changes only to the exact owner/connection and refuses stale generations", async () => {
    const f = await claimed.fixture();
    const another = await claimed.fixture();
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
    const f = await claimed.fixture();
    api.authenticate(f);
    const linked = await accept(
      api.connections().create({
        headers: vncSessionHeaders,
        body: { ...vncConnectionBody(), credential: { id: f.credentialId } },
      }),
      [201],
    );
    const unrelated = await accept(
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
    expect(requireVncCredentialId(unrelated.body)).not.toBe(f.credentialId);
    expect((await check(f)).body).toStrictEqual({
      outcome: "configuration_changed",
    });
    expect((await check(f, 2)).body).toStrictEqual({
      outcome: "valid",
    });
  });

  it.each([
    FeatureSwitchKey.VncAccess,
    FeatureSwitchKey.RemoteControlGuidedSetup,
  ])(
    "%s changes and reset revoke only that owner's VNC snapshots without cancelling Runs",
    async (feature) => {
      const f = await claimed.fixture();
      const another = await claimed.fixture();
      await updateFeatureSwitchesForUser(context, f, {
        [FeatureSwitchKey.VncAccess]: false,
        [FeatureSwitchKey.RemoteControlGuidedSetup]: false,
        [feature]: true,
      });
      expect((await check(f)).body).toStrictEqual({ outcome: "valid" });
      for (const change of [
        () => {
          return updateFeatureSwitchesForUser(context, f, {
            [feature]: false,
          });
        },
        () => {
          return deleteFeatureSwitchesForUser(context, f);
        },
      ]) {
        context.mocks.ably.publish.mockClear();
        await change();
        expect(notifications()).toStrictEqual([
          ["vnc-authority-invalidated", { runId: f.runId, connectionId: null }],
        ]);
        expect((await check(f)).body).toStrictEqual({
          outcome: "unavailable",
        });
        expect((await check(another)).body).toStrictEqual({
          outcome: "valid",
        });
        expect(
          channelsPublishedTo(context.mocks, "ssh-authority-invalidated"),
        ).toStrictEqual([]);
        await expect(runs.readRun(bdd.user(f), f.runId)).resolves.toMatchObject(
          {
            status: "running",
          },
        );
      }
    },
  );

  it("a publication failure preserves the committed host change and current admission refusal", async () => {
    const f = await claimed.fixture();
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
