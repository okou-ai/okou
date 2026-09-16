import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshSaveAttemptsContract } from "@okouai/api-contracts/contracts/ssh-save-attempts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createDeferredPromise } from "../../utils";
import { sshConnectionsRoutes } from "../ssh-connections";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { createRouteMocks } from "./helpers/route-test";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...sshConnectionsRoutes,
  ...cloudflareAccessRoutes,
]);
const connections = () => {
  return setupApp({ context, routes })(sshConnectionsContract);
};
const credentials = () => {
  return setupApp({ context, routes })(sshCredentialsContract);
};
const access = () => {
  return setupApp({ context, routes })(cloudflareAccessContract);
};
const attempts = () => {
  return setupApp({ context, routes })(sshSaveAttemptsContract);
};
const login = Object.freeze({
  name: "Deploy",
  username: "deploy",
  authentication: { method: "password" as const, password: "secret-password" },
});
const protection = Object.freeze({
  name: "Access",
  credentials: { clientId: "test.access", clientSecret: "secret-token" },
});
type Kind = "host" | "credential" | "access";

async function owner(existing?: { orgId?: string; userId?: string }) {
  const value = {
    orgId: existing?.orgId ?? `org_save_${randomUUID()}`,
    userId: existing?.userId ?? `user_save_${randomUUID()}`,
  };
  await updateFeatureSwitchesForUser(context, value, {
    [FeatureSwitchKey.SshAccess]: true,
  });
  mocks.clerk.session(value.userId, value.orgId);
  return value;
}
async function create(kind: Kind, saveAttemptId: string, name = "Original") {
  if (kind === "credential") {
    return await credentials().create({
      headers,
      body: { ...login, name, saveAttemptId },
    });
  }
  if (kind === "access") {
    return await access().create({
      headers,
      body: { ...protection, name, saveAttemptId },
    });
  }
  return await connections().create({
    headers,
    body: {
      saveAttemptId,
      displayName: name,
      host: "ssh.example.com",
      port: 443,
      credential: { create: login },
      transport: { type: "cloudflare_access", create: protection },
    },
  });
}
async function resolve(attemptId: string) {
  return (
    await accept(
      attempts().resolve({ headers, params: { attemptId }, body: {} }),
      [200],
    )
  ).body;
}
async function resources() {
  return {
    hosts: (await accept(connections().list({ headers }), [200])).body
      .connections,
    credentials: (await accept(credentials().list({ headers }), [200])).body
      .credentials,
    access: (await accept(access().list({ headers }), [200])).body.configs,
  };
}

test.each<Kind>(["host", "credential", "access"])(
  "deduplicates concurrent %s saves and confirms a committed result without exposing secrets",
  async (kind) => {
    useSecretKmsProbe();
    await owner();
    const id = randomUUID();
    const results = await Promise.all([create(kind, id), create(kind, id)]);
    expect(
      results
        .map((r) => {
          return r.status;
        })
        .sort(),
    ).toStrictEqual([201, 409]);
    const receipt = await resolve(id);
    expect(receipt).toStrictEqual({ saved: true });
    const repeated = await accept(create(kind, id, "Changed payload"), [409]);
    expect(repeated.body.error.code).toBe("SSH_SAVE_ATTEMPT_RESOLVED");
    await expect(resolve(id)).resolves.toStrictEqual(receipt);
    const current = await resources();
    expect(current.hosts).toHaveLength(kind === "host" ? 1 : 0);
    expect(current.credentials).toHaveLength(kind === "access" ? 0 : 1);
    expect(current.access).toHaveLength(kind === "credential" ? 0 : 1);
  },
);

test.each<Kind>(["host", "credential", "access"])(
  "a confirmed unsaved %s attempt cannot execute later or with changed input",
  async (kind) => {
    useSecretKmsProbe();
    await owner();
    const id = randomUUID();
    await expect(resolve(id)).resolves.toStrictEqual({ saved: false });
    await accept(create(kind, id), [409]);
    await accept(create(kind, id, "Edited"), [409]);
    await expect(resources()).resolves.toStrictEqual({
      hosts: [],
      credentials: [],
      access: [],
    });
    await accept(create(kind, randomUUID(), "Edited"), [201]);
  },
);

test("confirmation fences a request still encrypting its inline resources", async () => {
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  useSecretKmsProbe(async (request, call) => {
    if (call === 1) {
      entered.resolve();
      await release.promise;
    }
    return {
      keyId: request.keyId,
      plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
      encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
    };
  });
  await owner();
  const id = randomUUID();
  const pending = create("host", id);
  await entered.promise;
  const outcome = await resolve(id);
  release.resolve();
  expect(outcome).toStrictEqual({ saved: false });
  await accept(pending, [409]);
  await expect(resources()).resolves.toStrictEqual({
    hosts: [],
    credentials: [],
    access: [],
  });
});

test("retains the outcome after resource deletion and does not recreate deleted resources", async () => {
  useSecretKmsProbe();
  await owner();
  const id = randomUUID();
  const created = await accept(create("host", id), [201]);
  await accept(
    connections().delete({
      headers,
      params: { connectionId: created.body.id },
    }),
    [204],
  );
  await expect(resolve(id)).resolves.toStrictEqual({ saved: true });
  await accept(create("host", id), [409]);
  expect((await resources()).hosts).toStrictEqual([]);
});

test.each(["orgId", "userId"] as const)(
  "isolates identical attempt IDs with the same %s and across operation kinds",
  async (shared) => {
    useSecretKmsProbe();
    const first = await owner();
    const id = randomUUID();
    await accept(create("credential", id), [201]);
    await accept(create("access", id), [409]);
    await owner({ [shared]: first[shared] });
    await expect(resolve(id)).resolves.toStrictEqual({ saved: false });
    await expect(resources()).resolves.toStrictEqual({
      hosts: [],
      credentials: [],
      access: [],
    });
    mocks.clerk.session(first.userId, first.orgId);
    await expect(resolve(id)).resolves.toStrictEqual({ saved: true });
  },
);

test.each(["user", "organization"] as const)(
  "erases receipts only for the deleted %s",
  async (kind) => {
    useSecretKmsProbe();
    const deleted = await owner();
    const id = randomUUID();
    await accept(create("credential", id), [201]);
    const survivor = await owner();
    await accept(create("credential", id), [201]);
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: kind === "user" ? "user.deleted" : "organization.deleted",
      data: { id: kind === "user" ? deleted.userId : deleted.orgId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    mocks.clerk.session(survivor.userId, survivor.orgId);
    await expect(resolve(id)).resolves.toStrictEqual({ saved: true });
    // Reauthorize the synthetic deleted identity only to observe its terminal
    // receipt through the production API; real Clerk cannot restore a deleted ID.
    await owner(deleted);
    await expect(resolve(id)).resolves.toStrictEqual({ saved: false });
  },
);

test("confirms or fences host edits without duplicating their inline resources", async () => {
  useSecretKmsProbe();
  await owner();
  const created = await accept(create("host", randomUUID()), [201]);
  const id = randomUUID();
  const edit = {
    saveAttemptId: id,
    expectedGeneration: 1,
    credential: { create: { ...login, name: "Replacement" } },
    transport: {
      type: "cloudflare_access" as const,
      create: { ...protection, name: "Replacement Access" },
    },
  };
  const params = { connectionId: created.body.id };
  await accept(connections().update({ headers, params, body: edit }), [200]);
  await expect(resolve(id)).resolves.toStrictEqual({ saved: true });
  await accept(
    connections().update({
      headers,
      params,
      body: { ...edit, expectedGeneration: 2 },
    }),
    [409],
  );
  const fenced = randomUUID();
  await expect(resolve(fenced)).resolves.toStrictEqual({ saved: false });
  await accept(
    connections().update({
      headers,
      params,
      body: { ...edit, saveAttemptId: fenced, expectedGeneration: 2 },
    }),
    [409],
  );
  const current = await resources();
  expect(current.hosts[0]).toMatchObject({
    generation: 2,
    credentialName: "Replacement",
  });
  expect(current.credentials).toHaveLength(2);
  expect(current.access).toHaveLength(2);
});

test("a rejected input has no saved outcome, and confirmation requires authorization", async () => {
  await owner();
  const id = randomUUID();
  await accept(
    connections().create({
      headers,
      body: {
        saveAttemptId: id,
        displayName: "Invalid",
        host: "https://ssh.example.com",
        credential: { create: login },
      },
    }),
    [400],
  );
  await expect(resolve(id)).resolves.toStrictEqual({ saved: false });
  await accept(
    attempts().resolve({ headers: {}, params: { attemptId: id }, body: {} }),
    [401],
  );
  await expect(resources()).resolves.toStrictEqual({
    hosts: [],
    credentials: [],
    access: [],
  });
  mocks.clerk.session(
    `user_disabled_${randomUUID()}`,
    `org_disabled_${randomUUID()}`,
  );
  const unavailable = await accept(
    attempts().resolve({ headers, params: { attemptId: id }, body: {} }),
    [404],
  );
  expect(unavailable.body.error.code).toBe("SSH_UNAVAILABLE");
});
