import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { joinAll } from "../../utils";
import { sshConnectionsRoutes } from "../ssh-connections";
import { tailscaleRoutes } from "../tailscale";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([...sshConnectionsRoutes, ...tailscaleRoutes]);
const connections = () => {
  return setupApp({ context, routes })(sshConnectionsContract);
};
const credentials = () => {
  return setupApp({ context, routes })(sshCredentialsContract);
};
const tailscale = () => {
  return setupApp({ context, routes })(tailscaleContract);
};
const login = Object.freeze({
  name: "Atomic login",
  username: "deploy",
  authentication: {
    method: "password" as const,
    password: "binding-password-canary",
  },
});
const network = Object.freeze({
  name: "Atomic network",
  credentials: {
    clientId: "binding-client-canary",
    clientSecret: "binding-secret-canary",
  },
  tags: ["tag:okou"],
});
function owner(orgId = `org_atomic_binding_${randomUUID()}`) {
  const userId = `user_atomic_binding_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  return { orgId, userId };
}
async function inventory() {
  return {
    hosts: (await accept(connections().list({ headers }), [200])).body
      .connections,
    credentials: (await accept(credentials().list({ headers }), [200])).body
      .credentials,
    configs: (await accept(tailscale().list({ headers }), [200])).body.configs,
  };
}
function inlineHost(id: string) {
  return {
    id,
    displayName: "Atomic host",
    host: "100.64.0.21",
    port: 22,
    credential: { create: login },
    transport: { type: "tailscale" as const, create: network },
  };
}
async function directHost(id: string = randomUUID()) {
  return await accept(
    connections().create({
      headers,
      body: {
        id,
        displayName: "Direct host",
        host: "ssh.example.com",
        port: 22,
        credential: { create: login },
      },
    }),
    [201],
  );
}

test("concurrent inline Tailscale Host creation commits only the winner's network and login", async () => {
  useSecretKmsProbe();
  const creator = owner();
  const id = randomUUID();
  const body = inlineHost(id);
  const outcomes = await joinAll(
    [body, { ...body, displayName: "Competing host" }].map(async (input) => {
      return await accept(
        connections().create({ headers, body: input }),
        [201, 204],
      );
    }),
  );
  expect(
    outcomes
      .map((result) => {
        return result.status;
      })
      .sort(),
  ).toStrictEqual([201, 204]);
  const winner = outcomes.find((result) => {
    return result.status === 201;
  });
  if (winner?.status !== 201) {
    throw new Error("Expected exactly one winning Host");
  }
  const before = await inventory();
  expect(before.hosts).toStrictEqual([winner.body]);
  expect(before.credentials).toHaveLength(1);
  expect(before.configs).toHaveLength(1);
  expect(winner.body).toMatchObject({
    id,
    generation: 1,
    credentialId: before.credentials[0]?.id,
    transport: { type: "tailscale", configId: before.configs[0]?.id },
  });
  await accept(
    connections().create({
      headers,
      body: { ...body, displayName: "Replay cannot replace" },
    }),
    [204],
  );
  await expect(inventory()).resolves.toStrictEqual(before);
  owner(creator.orgId);
  const refused = await accept(connections().create({ headers, body }), [409]);
  expect(refused.body.error.code).toBe("SSH_RESOURCE_ID_CONFLICT");
  await expect(inventory()).resolves.toStrictEqual({
    hosts: [],
    credentials: [],
    configs: [],
  });
  mocks.clerk.session(creator.userId, creator.orgId);
  await expect(inventory()).resolves.toStrictEqual(before);
});

test("competing inline Tailscale rebinds leave one winner and no losing network or login", async () => {
  useSecretKmsProbe();
  owner();
  const initial = await directHost();
  const params = { connectionId: initial.body.id };
  const body = {
    expectedGeneration: 1,
    host: "100.64.0.21",
    port: 22,
    credential: { create: { ...login, name: "Replacement login" } },
    transport: { type: "tailscale" as const, create: network },
  };
  const outcomes = await joinAll(
    [body, { ...body, displayName: "Competing edit" }].map(async (input) => {
      return await accept(
        connections().update({ headers, params, body: input }),
        [200, 409],
      );
    }),
  );
  expect(
    outcomes
      .map((result) => {
        return result.status;
      })
      .sort(),
  ).toStrictEqual([200, 409]);
  const rejected = outcomes.find((result) => {
    return result.status === 409;
  });
  expect(rejected?.body).toMatchObject({
    error: { code: "SSH_GENERATION_CONFLICT" },
  });
  const current = await inventory();
  expect(current.hosts).toHaveLength(1);
  expect(current.credentials).toHaveLength(2);
  expect(current.configs).toHaveLength(1);
  expect(current.hosts[0]).toMatchObject({
    id: initial.body.id,
    generation: 2,
    credentialName: "Replacement login",
    transport: { type: "tailscale", configId: current.configs[0]?.id },
  });
  expect(
    current.credentials.filter((credential) => {
      return credential.name === "Replacement login";
    }),
  ).toHaveLength(1);
});

test("a visible selected Tailscale configuration does not grant a foreign SSH login", async () => {
  useSecretKmsProbe();
  const creator = owner();
  const config = await accept(
    tailscale().create({ headers, body: { id: randomUUID(), ...network } }),
    [201],
  );
  owner(creator.orgId);
  const foreign = await accept(
    credentials().create({ headers, body: { id: randomUUID(), ...login } }),
    [201],
  );
  mocks.clerk.session(creator.userId, creator.orgId);
  const refused = await accept(
    connections().create({
      headers,
      body: {
        ...inlineHost(randomUUID()),
        credential: { id: foreign.body.id },
        transport: { type: "tailscale", configId: config.body.id },
      },
    }),
    [404],
  );
  expect(refused.body.error.code).toBe("SSH_CREDENTIAL_NOT_FOUND");
  await expect(inventory()).resolves.toStrictEqual({
    hosts: [],
    credentials: [],
    configs: [config.body],
  });
});

test.each(["create", "update"] as const)(
  "missing selected Tailscale configuration rejects %s without leaving an inline login",
  async (operation) => {
    useSecretKmsProbe();
    owner();
    const id = randomUUID();
    const initial = operation === "update" ? await directHost(id) : undefined;
    const before = await inventory();
    const transport = { type: "tailscale" as const, configId: randomUUID() };
    const rejected =
      operation === "create"
        ? await accept(
            connections().create({
              headers,
              body: { ...inlineHost(id), transport },
            }),
            [404],
          )
        : await accept(
            connections().update({
              headers,
              params: { connectionId: id },
              body: {
                expectedGeneration: 1,
                host: "100.64.0.21",
                credential: { create: login },
                transport,
              },
            }),
            [404],
          );
    expect(rejected.body.error.code).toBe("TAILSCALE_NOT_FOUND");
    await expect(inventory()).resolves.toStrictEqual(before);
    if (initial) {
      expect(before.hosts).toStrictEqual([initial.body]);
    }
    const config = await accept(
      tailscale().create({
        headers,
        body: { id: transport.configId, ...network },
      }),
      [201],
    );
    if (operation === "create") {
      const created = await accept(
        connections().create({
          headers,
          body: { ...inlineHost(id), transport },
        }),
        [201],
      );
      expect(created.body).toMatchObject({
        id,
        generation: 1,
        transport: { type: "tailscale", configId: config.body.id },
      });
    } else {
      const updated = await accept(
        connections().update({
          headers,
          params: { connectionId: id },
          body: {
            expectedGeneration: 1,
            host: "100.64.0.21",
            credential: { create: login },
            transport,
          },
        }),
        [200],
      );
      expect(updated.body).toMatchObject({
        id,
        generation: 2,
        transport: { type: "tailscale", configId: config.body.id },
      });
    }
  },
);
