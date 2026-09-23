import { randomUUID } from "node:crypto";

import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const query = Object.freeze({ view: "scoped" as const });
const configs = () => {
  return setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
};
const hosts = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};

async function owner(orgId = `org_shared_access_${randomUUID()}`) {
  const value = {
    orgId,
    userId: `user_shared_access_${randomUUID()}`,
    membershipId: `orgmem_${randomUUID()}`,
  };
  await store.set(seedOrgMembership$, value, context.signal);
  mocks.clerk.session(value.userId, value.orgId, "org:admin");
  mocks.s3.listObjects([]);
  return value;
}

async function createShared() {
  return (
    await accept(
      configs().create({
        headers,
        query,
        body: {
          id: randomUUID(),
          scope: "organization",
          name: "Shared gateway",
          credentials: { clientId: "client-id", clientSecret: "client-secret" },
        },
      }),
      [201],
    )
  ).body;
}

async function createHost(configId: string) {
  return (
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Shared protected host",
          host: "ssh.example.com",
          port: 443,
          credential: {
            create: {
              name: "Login",
              username: "deploy",
              authentication: { method: "password", password: "password" },
            },
          },
          transport: { type: "cloudflare_access", configId },
        },
      }),
      [201],
    )
  ).body;
}

async function webhook(
  type: "user.deleted" | "organization.deleted",
  id: string,
) {
  mockOptionalEnv(
    "CLERK_WEBHOOK_SIGNING_SECRET",
    "synthetic-access-signing-secret",
  );
  const event = { type, data: { id } };
  context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({
      body: JSON.stringify(event),
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

test("creator erasure preserves shared Access and another member's SSH host", async () => {
  useSecretKmsProbe();
  const creator = await owner();
  const shared = await createShared();
  const member = await owner(creator.orgId);
  mocks.clerk.session(member.userId, member.orgId, "org:member");
  const host = await createHost(shared.id);

  await webhook("user.deleted", creator.userId);

  mocks.clerk.session(member.userId, member.orgId, "org:member");
  expect(
    (await accept(configs().list({ headers, query }), [200])).body.configs,
  ).toMatchObject([{ id: shared.id, scope: "organization" }]);
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(expect.objectContaining({ id: host.id }));
});

test("organization erasure removes shared Access after its member SSH references", async () => {
  useSecretKmsProbe();
  const creator = await owner();
  const shared = await createShared();
  const member = await owner(creator.orgId);
  mocks.clerk.session(member.userId, member.orgId, "org:member");
  await createHost(shared.id);

  await webhook("organization.deleted", creator.orgId);

  mocks.clerk.session(member.userId, member.orgId, "org:member");
  expect(
    (await accept(configs().list({ headers, query }), [200])).body.configs,
  ).toStrictEqual([]);
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toStrictEqual([]);
});
