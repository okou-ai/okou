import { randomUUID } from "node:crypto";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { countUserSshAccessResourcesFixture } from "../../../test-fixtures/ssh-access-owner-lifecycle";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { tailscaleRoutes } from "../tailscale";
import { sshConnectionsRoutes } from "../ssh-connections";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const configs = () => {
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
};
const hosts = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};
async function owner(
  orgId = `org_tail_lifecycle_${randomUUID()}`,
  role: "admin" | "member" = "admin",
) {
  const value = {
    orgId,
    userId: `user_tail_lifecycle_${randomUUID()}`,
    membershipId: `orgmem_${randomUUID()}`,
  };
  await store.set(seedOrgMembership$, { ...value, role }, context.signal);
  mocks.clerk.session(value.userId, value.orgId, `org:${role}`);
  mocks.s3.listObjects([]);
  return value;
}
async function config(scope: "personal" | "organization") {
  return (
    await accept(
      configs().create({
        headers,
        body: {
          id: randomUUID(),
          scope,
          name: "Owned private network",
          credentials: {
            clientId: "synthetic-oauth-id",
            clientSecret: "synthetic-oauth-secret",
          },
          tags: ["tag:okou"],
        },
      }),
      [201],
    )
  ).body;
}
async function host(configId: string) {
  return (
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Owned private host",
          host: "peer",
          port: 2222,
          credential: {
            create: {
              name: "Login",
              username: "deploy",
              authentication: {
                method: "password",
                password: "synthetic-password",
              },
            },
          },
          transport: { type: "tailscale", configId },
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
    "synthetic-tail-signing-secret",
  );
  const event = { type, data: { id } };
  context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({ body: JSON.stringify(event) }),
    [200],
  );
  await flushWaitUntilForTest();
}

test("user deletion erases encrypted Personal Tailscale state but preserves the creator's shared configuration and other members' hosts", async () => {
  useSecretKmsProbe();
  const creator = await owner();
  const shared = await config("organization");
  const personal = await config("personal");
  await host(personal.id);
  const member = await owner(creator.orgId, "member");
  const retained = await host(shared.id);
  await expect(
    countUserSshAccessResourcesFixture(creator.userId, "tailscale"),
  ).resolves.toStrictEqual({ configs: 1, hosts: 1, credentials: 1 });
  await webhook("user.deleted", creator.userId);
  // This narrow owned fixture proves erasure even though the deleted identity
  // cannot authenticate to inspect its encrypted Personal resources.
  await expect(
    countUserSshAccessResourcesFixture(creator.userId, "tailscale"),
  ).resolves.toStrictEqual({ configs: 0, hosts: 0, credentials: 0 });
  mocks.clerk.session(member.userId, member.orgId, "org:member");
  expect(
    (await accept(configs().list({ headers }), [200])).body.configs,
  ).toMatchObject([{ id: shared.id, scope: "organization" }]);
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toContainEqual(expect.objectContaining({ id: retained.id }));
});

test("organization deletion erases Personal and shared Tailscale configurations after dependent member hosts", async () => {
  useSecretKmsProbe();
  const creator = await owner();
  const shared = await config("organization");
  const personal = await config("personal");
  await host(personal.id);
  const member = await owner(creator.orgId, "member");
  await host(shared.id);
  await webhook("organization.deleted", creator.orgId);
  await expect(
    countUserSshAccessResourcesFixture(creator.userId, "tailscale"),
  ).resolves.toStrictEqual({ configs: 0, hosts: 0, credentials: 0 });
  for (const identity of [creator, member]) {
    mocks.clerk.session(identity.userId, identity.orgId, "org:member");
    expect(
      (await accept(configs().list({ headers }), [200])).body.configs,
    ).toStrictEqual([]);
    expect(
      (await accept(hosts().list({ headers }), [200])).body.connections,
    ).toStrictEqual([]);
  }
});
