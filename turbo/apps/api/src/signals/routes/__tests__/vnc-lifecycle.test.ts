import { randomUUID } from "node:crypto";

import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { Webhook } from "svix";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { vncConnectionsRoutes } from "../vnc-connections";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { ClerkTransportTestError } from "./helpers/clerk-transport-error";
import { requireVncCredentialId } from "./helpers/vnc-response";

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
      security: { type: "x509_vnc", trust: { mode: "system" } },
      credential: {
        create: {
          name: "Desktop login",
          authentication: { method: "vnc_password", password: "pass123" },
        },
      },
    },
  });
}

async function webhook(event: {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}) {
  const secret = `whsec_${Buffer.from("vnc-lifecycle-signing-key").toString("base64")}`;
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
  context.mocks.clerk.verifyWebhook.mockImplementation(async (request) => {
    if (!(request instanceof Request)) {
      throw new Error("Expected the Clerk webhook request");
    }
    const payload = await request.text();
    new Webhook(secret).verify(payload, Object.fromEntries(request.headers));
    const verified: unknown = JSON.parse(payload);
    return verified;
  });
  const body = JSON.stringify(event);
  const id = `msg_${randomUUID()}`;
  const timestamp = nowDate();
  const response = await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body,
      extraHeaders: {
        "svix-id": id,
        "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
        "svix-signature": new Webhook(secret).sign(id, timestamp, body),
      },
    }),
    [200],
  );
  expect(response.body).toBe("OK");
  await flushWaitUntilForTest();
}

async function createUnusedCredential() {
  return await accept(
    credentials().create({
      headers,
      body: {
        id: randomUUID(),
        name: "Unused login",
        authentication: { method: "vnc_password", password: "unused" },
      },
    }),
    [201],
  );
}

test.each(["mixed", "unused credentials", "credential-free hosts", "empty"])(
  "signed membership departure erases %s resources before the living user rejoins",
  async (scenario) => {
    useSecretKmsProbe();
    const current = await owner();
    const connectionIds: string[] = [];
    const credentialIds: string[] = [];
    if (scenario === "mixed") {
      const first = await accept(createConnection(), [201]);
      const credentialId = requireVncCredentialId(first.body);
      connectionIds.push(first.body.id);
      credentialIds.push(credentialId);
      const shared = await accept(
        connections().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "Shared login",
            host: "shared.example.com",
            security: { type: "x509_vnc", trust: { mode: "system" } },
            credential: { id: credentialId },
          },
        }),
        [201],
      );
      connectionIds.push(shared.body.id);
    }
    if (scenario === "mixed" || scenario === "unused credentials") {
      credentialIds.push((await createUnusedCredential()).body.id);
    }
    if (scenario === "mixed" || scenario === "credential-free hosts") {
      const withoutCredential = await accept(
        connections().create({
          headers,
          body: {
            id: randomUUID(),
            displayName: "Certificate-only desktop",
            host: "certificate.example.com",
            security: { type: "x509_none", trust: { mode: "system" } },
            credential: { type: "none" },
          },
        }),
        [201],
      );
      connectionIds.push(withoutCredential.body.id);
    }
    const peer = await owner({ orgId: current.orgId });
    const peerConnection = await accept(createConnection(), [201]);
    const otherOrg = await owner({ userId: current.userId });
    const otherOrgConnection = await accept(createConnection(), [201]);
    await store.set(deleteOrgMembership$, current, context.signal);
    const departure = {
      type: "organizationMembership.deleted",
      data: {
        id: current.membershipId,
        organization_id: current.orgId,
        user_id: current.userId,
      },
    };
    await webhook(departure);
    await webhook(departure);
    mocks.clerk.session(current.userId, current.orgId);
    await accept(connections().list({ headers }), [404]);
    await accept(credentials().list({ headers }), [404]);

    const rejoined = { ...current, membershipId: `orgmem_${randomUUID()}` };
    await store.set(seedOrgMembership$, rejoined, context.signal);
    await webhook({
      type: "organizationMembership.created",
      data: {
        id: rejoined.membershipId,
        organization_id: rejoined.orgId,
        user_id: rejoined.userId,
        role: "org:member",
      },
    });
    expect(
      (await accept(connections().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
    expect(
      (await accept(credentials().list({ headers }), [200])).body.credentials,
    ).toStrictEqual([]);
    for (const connectionId of connectionIds) {
      await accept(
        connections().update({
          headers,
          params: { connectionId },
          body: { expectedGeneration: 1, displayName: "Rejoined desktop" },
        }),
        [404],
      );
    }
    for (const credentialId of credentialIds) {
      await accept(
        credentials().update({
          headers,
          params: { credentialId },
          body: { expectedRevision: 1, name: "Rejoined login" },
        }),
        [404],
      );
    }
    for (const [survivor, preserved] of [
      [peer, peerConnection],
      [otherOrg, otherOrgConnection],
    ] as const) {
      mocks.clerk.session(survivor.userId, survivor.orgId);
      expect(
        (await accept(connections().list({ headers }), [200])).body.connections,
      ).toStrictEqual([preserved.body]);
      expect(
        (
          await accept(credentials().list({ headers }), [200])
        ).body.credentials.map((entry) => {
          return entry.id;
        }),
      ).toStrictEqual([requireVncCredentialId(preserved.body)]);
    }
  },
);

test.each(["user", "organization"] as const)(
  "signed %s deletion with referenced VNC credentials preserves a surviving owner's configuration",
  async (scope) => {
    useSecretKmsProbe();
    const current = await owner();
    await accept(createConnection(), [201]);
    await createUnusedCredential();
    const alsoRemoved = await owner(
      scope === "user" ? { userId: current.userId } : { orgId: current.orgId },
    );
    await accept(createConnection(), [201]);
    const survivor = await owner(
      scope === "organization"
        ? { userId: current.userId }
        : { orgId: current.orgId },
    );
    const preserved = await accept(createConnection(), [201]);
    await store.set(deleteOrgMembership$, current, context.signal);
    await store.set(deleteOrgMembership$, alsoRemoved, context.signal);
    const event = {
      type: `${scope}.deleted`,
      data: { id: scope === "user" ? current.userId : current.orgId },
    };
    await webhook(event);
    await webhook(event);
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
    ).toStrictEqual([requireVncCredentialId(preserved.body)]);
  },
);

test("requires current membership while retaining the same owner's configuration after rejoining", async () => {
  useSecretKmsProbe();
  const current = await owner();
  const previous = await accept(createConnection(), [201]);
  await store.set(deleteOrgMembership$, current, context.signal);
  await accept(connections().list({ headers }), [404]);
  await accept(credentials().list({ headers }), [404]);
  await accept(createConnection(), [404]);
  const rejoined = { ...current, membershipId: `orgmem_${randomUUID()}` };
  await store.set(seedOrgMembership$, rejoined, context.signal);
  expect(
    (await accept(connections().list({ headers }), [200])).body.connections,
  ).toStrictEqual([previous.body]);
  expect(
    (await accept(credentials().list({ headers }), [200])).body.credentials.map(
      (entry) => {
        return entry.id;
      },
    ),
  ).toStrictEqual([requireVncCredentialId(previous.body)]);
  const additional = await accept(createConnection(), [201]);
  expect(additional.body.id).not.toBe(previous.body.id);
  expect(additional.body.host).toBe(previous.body.host);
  expect(additional.body.port).toBe(previous.body.port);
  const renamed = await accept(
    credentials().update({
      headers,
      params: { credentialId: requireVncCredentialId(previous.body) },
      body: { expectedRevision: 1, name: "Rejoined" },
    }),
    [200],
  );
  expect(renamed.body.name).toBe("Rejoined");
  await accept(
    connections().create({
      headers,
      body: {
        id: randomUUID(),
        displayName: "Shared credential",
        host: "other-desktop.example.com",
        security: { type: "x509_vnc", trust: { mode: "system" } },
        credential: { id: requireVncCredentialId(previous.body) },
      },
    }),
    [201],
  );
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
