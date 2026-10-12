import { randomUUID } from "node:crypto";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
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
async function config(
  scope: "personal" | "organization",
  id: string = randomUUID(),
) {
  return (
    await accept(
      configs().create({
        headers,
        body: {
          id,
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
async function host(configId: string, id: string = randomUUID()) {
  return (
    await accept(
      hosts().create({
        headers,
        body: {
          id,
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
async function deletionWebhook(
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

test("user deletion preserves the creator's shared Tailscale configuration and other members' hosts", async () => {
  useSecretKmsProbe();
  const creator = await owner();
  const shared = await config("organization");
  const personal = await config("personal");
  await host(personal.id);
  const member = await owner(creator.orgId, "member");
  const retained = await host(shared.id);
  await deletionWebhook("user.deleted", creator.userId);
  mocks.clerk.session(member.userId, member.orgId, "org:member");
  expect(
    (await accept(configs().list({ headers }), [200])).body.configs,
  ).toStrictEqual([
    {
      ...shared,
      sshHosts: [{ id: retained.id, displayName: retained.displayName }],
    },
  ]);
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toStrictEqual([retained]);
});

test("organization deletion releases its configuration and Host identities while preserving another organization", async () => {
  useSecretKmsProbe();
  const creator = await owner();
  const personal = await config("personal");
  const personalHost = await host(personal.id);
  const shared = await config("organization");
  await owner(creator.orgId, "member");
  const sharedHost = await host(shared.id);
  const survivor = await owner();
  const survivingConfig = await config("organization");
  const survivingHost = await host(survivingConfig.id);

  await deletionWebhook("organization.deleted", creator.orgId);

  // This observer's organization still exists. Never authenticate through the
  // deleted organization to inspect its private rows or fabricate authority.
  mocks.clerk.session(survivor.userId, survivor.orgId, "org:admin");
  expect(
    (await accept(configs().list({ headers }), [200])).body.configs,
  ).toStrictEqual([
    {
      ...survivingConfig,
      sshHosts: [
        { id: survivingHost.id, displayName: survivingHost.displayName },
      ],
    },
  ]);
  expect(
    (await accept(hosts().list({ headers }), [200])).body.connections,
  ).toStrictEqual([survivingHost]);
  // Public caller-known UUID reuse proves deletion, not just owner invisibility:
  // a retained foreign identity would reject these creations with 409/204.
  const recreatedPersonal = await config("personal", personal.id);
  const recreatedShared = await config("organization", shared.id);
  expect(recreatedPersonal).toMatchObject({ id: personal.id, revision: 1 });
  expect(recreatedShared).toMatchObject({ id: shared.id, revision: 1 });
  await expect(
    host(recreatedPersonal.id, personalHost.id),
  ).resolves.toMatchObject({
    id: personalHost.id,
    generation: 1,
  });
  await expect(host(recreatedShared.id, sharedHost.id)).resolves.toMatchObject({
    id: sharedHost.id,
    generation: 1,
  });
});
