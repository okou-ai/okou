import { randomUUID } from "node:crypto";

import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { vncHostsContract } from "@okouai/api-contracts/contracts/vnc-access";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { agentsRoutes } from "../agents";
import { vncAccessRoutes } from "../vnc-access";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncConnectionBody,
  vncSessionHeaders as headers,
} from "./helpers/vnc-runtime";

const context = testContext();
const api = createVncRuntimeApi(context);
const mocks = createRouteMocks(context);
const store = createStore();

beforeEach(initializeVncRuntimeTest);

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}

async function owner(overrides: Partial<Owner> = {}) {
  const value = {
    orgId: `org_vnc_access_${randomUUID()}`,
    userId: `user_vnc_access_${randomUUID()}`,
    ...overrides,
  };
  await updateFeatureSwitchesForUser(context, value, {
    [FeatureSwitchKey.VncAccess]: true,
  });
  api.authenticate(value);
  return value;
}

function token(
  runtime: Owner & { readonly runId: string },
  capabilities = ["vnc:read"],
  expiresInSeconds = 3600,
) {
  const seconds = Math.floor(now() / 1000);
  return {
    authorization: `Bearer ${signSandboxJwtForTests({
      scope: "okou",
      orgId: runtime.orgId,
      userId: runtime.userId,
      runId: runtime.runId,
      capabilities,
      iat: seconds,
      exp: seconds + expiresInSeconds,
    })}`,
  };
}

function inventory() {
  return setupApp({ context, routes: vncAccessRoutes })(vncHostsContract);
}

async function visibility(agentId: string, value: "public" | "private") {
  await accept(
    setupApp({ context, routes: agentsRoutes })(agentsByIdContract).update({
      headers,
      params: { id: agentId },
      body: { visibility: value },
    }),
    [200],
  );
}

describe("explicit VNC grants and current Agent inventory", () => {
  async function createHost(host = "vnc.example.com") {
    return await accept(
      api.connections().create({
        headers,
        body: { ...vncConnectionBody(), host },
      }),
      [201],
    );
  }

  it("automatically grants all visible Agents only on a zero-to-one host transition", async () => {
    const current = await owner();
    const ownPrivate = await api.runtime(current);
    await visibility(ownPrivate.agentId, "private");
    const teammate = await owner({ orgId: current.orgId });
    const shared = await api.runtime(teammate);
    const teammatePrivate = await api.runtime(teammate);
    await visibility(teammatePrivate.agentId, "private");
    const foreign = await owner();
    const foreignAgent = await api.runtime(foreign);

    api.authenticate(current);
    const first = await createHost();
    for (const agentId of [ownPrivate.agentId, shared.agentId]) {
      expect(
        (
          await accept(
            api.access().get({ headers, params: { agentId } }),
            [200],
          )
        ).body,
      ).toStrictEqual({ enabled: true });
    }
    for (const agentId of [teammatePrivate.agentId, foreignAgent.agentId]) {
      await accept(api.access().get({ headers, params: { agentId } }), [404]);
    }

    await api.grant({ ...current, agentId: ownPrivate.agentId }, false);
    const laterAgent = await api.runtime(current);
    const second = await createHost("second.example.com");
    for (const agentId of [ownPrivate.agentId, laterAgent.agentId]) {
      expect(
        (
          await accept(
            api.access().get({ headers, params: { agentId } }),
            [200],
          )
        ).body,
      ).toStrictEqual({ enabled: false });
    }

    for (const connection of [first.body, second.body]) {
      await accept(
        api.connections().delete({
          headers,
          params: { connectionId: connection.id },
          body: { expectedGeneration: connection.generation },
        }),
        [204],
      );
    }
    await createHost("replacement.example.com");
    for (const agentId of [ownPrivate.agentId, laterAgent.agentId]) {
      expect(
        (
          await accept(
            api.access().get({ headers, params: { agentId } }),
            [200],
          )
        ).body,
      ).toStrictEqual({ enabled: true });
    }
  });

  it("serializes concurrent first hosts while granting visible Agents", async () => {
    const current = await owner();
    const runtime = await api.runtime(current);
    await Promise.all([
      createHost("one.example.com"),
      createHost("two.example.com"),
    ]);
    expect(
      (
        await accept(
          api.access().get({ headers, params: { agentId: runtime.agentId } }),
          [200],
        )
      ).body,
    ).toStrictEqual({ enabled: true });
    expect(
      (await accept(api.connections().list({ headers }), [200])).body
        .connections,
    ).toHaveLength(2);
  });

  it("does not auto-grant an Agent created after the first connection", async () => {
    const f = await api.fixture({ grant: false });
    const params = { agentId: f.agentId };
    expect(
      (await accept(api.access().get({ headers, params }), [200])).body,
    ).toStrictEqual({ enabled: false });
    await accept(inventory().list({ headers: token(f) }), [404]);
    await api.grant(f, true);
    const listed = await accept(inventory().list({ headers: token(f) }), [200]);
    expect(listed.body).toStrictEqual({
      hosts: [
        {
          id: f.connectionId,
          displayName: "VNC desktop",
          host: "vnc.example.com",
          port: 5900,
          authMethod: "vnc_password",
          securityType: "x509_vnc",
        },
      ],
    });
    const kms = useSecretKmsProbe();
    await accept(inventory().list({ headers: token(f) }), [200]);
    expect(kms.decryptCalls).toBe(0);
    await api.grant(f, false);
    await accept(inventory().list({ headers: token(f) }), [404]);
    await accept(
      api.connections().create({ headers, body: vncConnectionBody() }),
      [201],
    );
    expect(
      (await accept(api.access().get({ headers, params }), [200])).body,
    ).toStrictEqual({ enabled: false });
  });

  it("returns an authorized empty inventory and never auto-grants a later Agent", async () => {
    const current = await owner();
    const runtime = { ...current, ...(await api.runtime(current)) };
    await api.grant(runtime, true);
    expect(
      (await accept(inventory().list({ headers: token(runtime) }), [200])).body,
    ).toStrictEqual({ hosts: [] });
    const other = await api.runtime(current);
    expect(
      (
        await accept(
          api.access().get({ headers, params: { agentId: other.agentId } }),
          [200],
        )
      ).body,
    ).toStrictEqual({ enabled: false });
    await accept(
      inventory().list({ headers: token({ ...current, ...other }) }),
      [404],
    );
  });

  it("isolates a shared Agent's grants and inventory by the Run owner", async () => {
    const creator = await api.fixture();
    const consumer = await owner({ orgId: creator.orgId });
    const runtime = {
      ...consumer,
      ...(await api.runtime(consumer, { agentId: creator.agentId })),
    };
    await accept(inventory().list({ headers: token(runtime) }), [404]);
    const host = await accept(
      api.connections().create({
        headers,
        body: { ...vncConnectionBody(), host: "consumer.example.com" },
      }),
      [201],
    );
    await api.grant(runtime, true);
    expect(
      (
        await accept(inventory().list({ headers: token(runtime) }), [200])
      ).body.hosts.map((entry) => {
        return entry.id;
      }),
    ).toStrictEqual([host.body.id]);
    api.authenticate(creator);
    expect(
      (
        await accept(inventory().list({ headers: token(creator) }), [200])
      ).body.hosts.map((entry) => {
        return entry.id;
      }),
    ).toStrictEqual([creator.connectionId]);
    await visibility(creator.agentId, "private");
    api.authenticate(consumer);
    await accept(inventory().list({ headers: token(runtime) }), [404]);
    for (const agentId of [creator.agentId, randomUUID()]) {
      await accept(api.access().get({ headers, params: { agentId } }), [404]);
      await accept(
        api
          .access()
          .update({ headers, params: { agentId }, body: { enabled: true } }),
        [404],
      );
    }
  });

  it("does not accept another organization or Run owner from a valid token", async () => {
    const f = await api.fixture();
    const foreign = await owner({ userId: f.userId });
    const unavailableAgent = await accept(
      api.access().get({ headers, params: { agentId: f.agentId } }),
      [404],
    );
    expect(unavailableAgent.body.error.code).toBe("VNC_UNAVAILABLE");
    await accept(
      api.access().update({
        headers,
        params: { agentId: f.agentId },
        body: { enabled: true },
      }),
      [404],
    );
    await accept(
      inventory().list({ headers: token({ ...foreign, runId: f.runId }) }),
      [404],
    );
    const other = await owner({ orgId: f.orgId });
    await accept(
      inventory().list({ headers: token({ ...other, runId: f.runId }) }),
      [404],
    );
    api.authenticate(f);
    await accept(
      inventory().list({ headers: token({ ...f, runId: randomUUID() }) }),
      [404],
    );
  });

  it("rechecks the feature and membership for already issued tokens and owner writes", async () => {
    const f = await api.fixture();
    const stale = token(f);
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.VncAccess]: false,
    });
    const disabledInventory = await accept(
      inventory().list({ headers: stale }),
      [404],
    );
    expect(disabledInventory.body.error.code).toBe("VNC_UNAVAILABLE");
    await accept(
      api.access().get({ headers, params: { agentId: f.agentId } }),
      [404],
    );
    await accept(
      api.access().update({
        headers,
        params: { agentId: f.agentId },
        body: { enabled: true },
      }),
      [404],
    );
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [], totalCount: 0 },
    );
    await accept(inventory().list({ headers: stale }), [404]);
    await accept(
      api.access().get({ headers, params: { agentId: f.agentId } }),
      [404],
    );
    await accept(
      api.access().update({
        headers,
        params: { agentId: f.agentId },
        body: { enabled: false },
      }),
      [404],
    );
  });

  it.each(["pending", "completed", "cancelled", "failed"] as const)(
    "rejects inventory for a %s Run despite a current grant",
    async (status) => {
      const f = await api.fixture({ runtime: { status } });
      const unavailableInventory = await accept(
        inventory().list({ headers: token(f) }),
        [404],
      );
      expect(unavailableInventory.body.error.code).toBe("VNC_UNAVAILABLE");
    },
  );

  it("keeps owner grant APIs session-only and VNC inventory capability-specific", async () => {
    const f = await api.fixture({ grant: false, runtime: { access: true } });
    const params = { agentId: f.agentId };
    for (const denied of [
      token(f, ["vnc:read", "vnc:write"]),
      { authorization: `Bearer ${f.sandboxToken}` },
    ]) {
      await accept(api.access().get({ headers: denied, params }), [403]);
      await accept(
        api
          .access()
          .update({ headers: denied, params, body: { enabled: true } }),
        [403],
      );
    }
    await accept(inventory().list({ headers }), [403]);
    for (const capabilities of [
      [],
      ["ssh:read", "ssh:write"],
      ["computer-use:write"],
      ["vnc:write"],
    ]) {
      await accept(
        inventory().list({ headers: token(f, capabilities) }),
        [403],
      );
    }
    await accept(inventory().list({ headers: token(f) }), [404]);
    await accept(
      inventory().list({ headers: token(f, ["vnc:read"], -1) }),
      [401],
    );
    await accept(api.access().get({ headers: {}, params }), [401]);
    expect(
      (await accept(api.access().get({ headers, params }), [200])).body,
    ).toStrictEqual({ enabled: false });
  });

  it("rejects unknown grant fields without echoing request contents", async () => {
    const f = await api.fixture({ grant: false });
    const raw = setupRawAppRequest({ context, routes: vncAccessRoutes });
    const response = await raw(`/api/agents/${f.agentId}/vnc-access`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        password: "untrusted-secret-canary",
      }),
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(
      "untrusted-secret-canary",
    );
    expect(
      (
        await accept(
          api.access().get({ headers, params: { agentId: f.agentId } }),
          [200],
        )
      ).body,
    ).toStrictEqual({ enabled: false });
  });

  it.each(["membership", "user"] as const)(
    "%s cleanup removes grants even when the shared Agent has no VNC connections",
    async (scope) => {
      const creator = await owner();
      const shared = await api.runtime(creator);
      const consumer = await owner({ orgId: creator.orgId });
      const runtime = {
        ...consumer,
        ...(await api.runtime(consumer, { agentId: shared.agentId })),
      };
      await api.grant(runtime, true);
      const membershipId = `orgmem_${randomUUID()}`;
      await store.set(seedOrgMembership$, creator, context.signal);
      await store.set(
        seedOrgMembership$,
        { ...consumer, membershipId },
        context.signal,
      );
      mocks.s3.listObjects([]);
      mockOptionalEnv(
        "CLERK_WEBHOOK_SIGNING_SECRET",
        "synthetic-vnc-signing-secret",
      );
      context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(
        scope === "membership"
          ? {
              type: "organizationMembership.deleted",
              data: {
                id: membershipId,
                organization_id: consumer.orgId,
                user_id: consumer.userId,
              },
            }
          : { type: "user.deleted", data: { id: consumer.userId } },
      );
      await accept(
        setupApp({ context, routes: webhooksClerkRoutes })(
          webhookClerkContract,
        ).post({ body: "{}" }),
        [200],
      );
      await flushWaitUntilForTest();
      // Retained external identity permits reading the post-cleanup boundary.
      await updateFeatureSwitchesForUser(context, consumer, {
        [FeatureSwitchKey.VncAccess]: true,
      });
      api.authenticate(consumer);
      expect(
        (
          await accept(
            api.access().get({ headers, params: { agentId: shared.agentId } }),
            [200],
          )
        ).body,
      ).toStrictEqual({ enabled: false });
    },
  );
});
