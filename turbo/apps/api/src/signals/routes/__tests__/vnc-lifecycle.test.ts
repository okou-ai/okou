import { randomUUID } from "node:crypto";

import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { vncConnectionsRoutes } from "../vnc-connections";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { holdSecretKms } from "./helpers/hold-secret-kms";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { ClerkTransportTestError } from "./helpers/clerk-transport-error";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const connections = () => {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncConnectionsContract,
  );
};
const credentials = () => {
  return setupApp({ context, routes: vncConnectionsRoutes })(
    vncCredentialsContract,
  );
};

async function owner(overrides: { orgId?: string; userId?: string } = {}) {
  const value = {
    orgId: overrides.orgId ?? `org_vnc_lifecycle_${randomUUID()}`,
    userId: overrides.userId ?? `user_vnc_lifecycle_${randomUUID()}`,
    membershipId: `orgmem_${randomUUID()}`,
  };
  await store.set(seedOrgMembership$, value, context.signal);
  await updateFeatureSwitchesForUser(context, value, {
    [FeatureSwitchKey.VncAccess]: true,
  });
  mocks.clerk.session(value.userId, value.orgId);
  mocks.s3.listObjects([]);
  return value;
}

function createConnection() {
  return connections().create({
    headers,
    body: {
      id: randomUUID(),
      displayName: "Desktop",
      host: "desktop.example.com",
      port: 5900,
      trust: { mode: "system" },
      credential: { create: { name: "Desktop login", password: "pass123" } },
    },
  });
}

async function webhook(event: {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}) {
  mockOptionalEnv(
    "CLERK_WEBHOOK_SIGNING_SECRET",
    "synthetic-vnc-signing-secret",
  );
  context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({ body: JSON.stringify(event) }),
    [200],
  );
  await flushWaitUntilForTest();
}

test.each(["user", "organization", "membership"] as const)(
  "%s cleanup fences a first VNC save paused at KMS before any configuration exists",
  async (scope) => {
    const current = await owner();
    const held = holdSecretKms(1, context.signal);
    const pending = createConnection();
    await held.entered;
    const event =
      scope === "membership"
        ? {
            type: "organizationMembership.deleted",
            data: {
              id: current.membershipId,
              organization_id: current.orgId,
              user_id: current.userId,
            },
          }
        : {
            type: `${scope}.deleted`,
            data: { id: scope === "user" ? current.userId : current.orgId },
          };
    await webhook(event);
    held.release();
    const rejected = await accept(pending, [409]);
    expect(rejected.body.error.code).toBe("VNC_OWNER_CHANGED");
  },
);

test("cleanup fences a first save whose positive Clerk membership lookup has not returned", async () => {
  useSecretKmsProbe();
  const current = await owner();
  const entered = createDeferredPromise<void>(context.signal);
  const released = createDeferredPromise<void>(context.signal);
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementationOnce(
    async () => {
      entered.resolve();
      await released.promise;
      return {
        data: [
          {
            id: current.membershipId,
            role: "org:member",
            createdAt: 1,
            organization: {
              id: current.orgId,
              name: "VNC lifecycle test",
              slug: null,
              imageUrl: "",
              hasImage: false,
              createdAt: 1,
            },
            publicUserData: { userId: current.userId },
          },
        ],
        totalCount: 1,
      };
    },
  );
  const pending = createConnection();
  await entered.promise;
  await webhook({
    type: "organizationMembership.deleted",
    data: {
      id: current.membershipId,
      organization_id: current.orgId,
      user_id: current.userId,
    },
  });
  released.resolve();
  const rejected = await accept(pending, [409]);
  expect(rejected.body.error.code).toBe("VNC_OWNER_CHANGED");
  const hosts = await accept(connections().list({ headers }), [200]);
  const logins = await accept(credentials().list({ headers }), [200]);
  expect(hosts.body.connections).toStrictEqual([]);
  expect(logins.body.credentials).toStrictEqual([]);
});

test.each(["user", "organization", "membership"] as const)(
  "%s cleanup erases saved VNC hosts and credentials while preserving another owner",
  async (scope) => {
    useSecretKmsProbe();
    const current = await owner();
    await accept(createConnection(), [201]);
    const survivor = await owner(
      scope === "organization"
        ? { userId: current.userId }
        : { orgId: current.orgId },
    );
    const preserved = await accept(createConnection(), [201]);
    const event =
      scope === "membership"
        ? {
            type: "organizationMembership.deleted",
            data: {
              id: current.membershipId,
              organization_id: current.orgId,
              user_id: current.userId,
            },
          }
        : {
            type: `${scope}.deleted`,
            data: { id: scope === "user" ? current.userId : current.orgId },
          };
    await webhook(event);

    // Retain the external test identity to inspect the public configuration
    // boundary after cleanup. Re-enabling its cleared rollout override restores
    // only visibility; it cannot recreate a removed host or encrypted password.
    await updateFeatureSwitchesForUser(context, current, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    mocks.clerk.session(current.userId, current.orgId);
    const removedHosts = await accept(connections().list({ headers }), [200]);
    const removedCredentials = await accept(
      credentials().list({ headers }),
      [200],
    );
    expect(removedHosts.body.connections).toStrictEqual([]);
    expect(removedCredentials.body.credentials).toStrictEqual([]);

    mocks.clerk.session(survivor.userId, survivor.orgId);
    const survivingHosts = await accept(connections().list({ headers }), [200]);
    const survivingCredentials = await accept(
      credentials().list({ headers }),
      [200],
    );
    expect(survivingHosts.body.connections).toStrictEqual([preserved.body]);
    expect(
      survivingCredentials.body.credentials.map((entry) => {
        return entry.id;
      }),
    ).toStrictEqual([preserved.body.credentialId]);
  },
);

test("a delayed save from the old membership cannot purge a rejoined owner's new configuration before cleanup arrives", async () => {
  const current = await owner();
  const held = holdSecretKms(1, context.signal);
  const stale = createConnection();
  await held.entered;
  await store.set(
    seedOrgMembership$,
    { ...current, membershipId: `orgmem_${randomUUID()}` },
    context.signal,
  );
  const replacement = await accept(createConnection(), [201]);
  held.release();
  const rejected = await accept(stale, [409]);
  expect(rejected.body.error.code).toBe("VNC_OWNER_CHANGED");
  const listed = await accept(connections().list({ headers }), [200]);
  expect(listed.body.connections).toStrictEqual([replacement.body]);
});

test("a delayed deletion of an earlier membership preserves the rejoined owner's VNC configuration", async () => {
  useSecretKmsProbe();
  const current = await owner();
  await accept(createConnection(), [201]);
  const rejoined = { ...current, membershipId: `orgmem_${randomUUID()}` };
  await store.set(seedOrgMembership$, rejoined, context.signal);
  // The same endpoint is reusable, while the prior generation is discarded.
  const saved = await accept(createConnection(), [201]);
  await webhook({
    type: "organizationMembership.deleted",
    data: {
      id: current.membershipId,
      organization_id: current.orgId,
      user_id: current.userId,
    },
  });
  const listed = await accept(connections().list({ headers }), [200]);
  expect(listed.body.connections).toStrictEqual([saved.body]);
  const logins = await accept(credentials().list({ headers }), [200]);
  expect(
    logins.body.credentials.map((entry) => {
      return entry.id;
    }),
  ).toStrictEqual([saved.body.credentialId]);
});

test("a malformed membership deletion without its required ID cannot erase configuration", async () => {
  useSecretKmsProbe();
  const current = await owner();
  const saved = await accept(createConnection(), [201]);
  await webhook({
    type: "organizationMembership.deleted",
    data: { organization_id: current.orgId, user_id: current.userId },
  });
  const listed = await accept(connections().list({ headers }), [200]);
  expect(listed.body.connections).toStrictEqual([saved.body]);
});

test("a missing Clerk identity denies owner reads while provider failures remain server errors", async () => {
  await owner();
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValueOnce(
    new ClerkTransportTestError(404),
  );
  const missing = await accept(connections().list({ headers }), [404]);
  expect(missing.body.error.code).toBe("VNC_UNAVAILABLE");
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValueOnce(
    new Error("Synthetic membership provider outage"),
  );
  await accept(connections().list({ headers }), [500]);
});
