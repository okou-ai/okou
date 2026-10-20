import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { tailscaleRoutes } from "../tailscale";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const query = Object.freeze({ view: "scoped" as const });
const routes = Object.freeze([
  ...cloudflareAccessRoutes,
  ...tailscaleRoutes,
  ...sshConnectionsRoutes,
]);
type Provider = "cloudflare_access" | "tailscale";
const login = Object.freeze({
  name: "Publication login",
  username: "deploy",
  authentication: { method: "password" as const, password: "synthetic-login" },
});
const oauth = Object.freeze({
  clientId: "synthetic-id",
  clientSecret: "synthetic-secret",
});
const hosts = () => {
  return setupApp({ context, routes })(sshConnectionsContract);
};
const credentials = () => {
  return setupApp({ context, routes })(sshCredentialsContract);
};
const cloudflare = () => {
  return setupApp({ context, routes })(cloudflareAccessContract);
};
const tailscale = () => {
  return setupApp({ context, routes })(tailscaleContract);
};

beforeEach(() => {
  mocks.clerk.session(
    `user_network_publication_${randomUUID()}`,
    `org_network_publication_${randomUUID()}`,
  );
  useSecretKmsProbe();
});
async function createConfig(provider: Provider) {
  const app = await setupApp({ context, routes });
  const body = {
    id: randomUUID(),
    name: "Private network",
    credentials: oauth,
  };
  return provider === "cloudflare_access"
    ? (
        await accept(
          app(cloudflareAccessContract).create({ headers, query, body }),
          [201],
        )
      ).body
    : (
        await accept(
          app(tailscaleContract).create({
            headers,
            body: { ...body, tags: ["tag:okou"] },
          }),
          [201],
        )
      ).body;
}
async function configList(provider: Provider) {
  return provider === "cloudflare_access"
    ? (await accept(cloudflare().list({ headers, query }), [200])).body.configs
    : (await accept(tailscale().list({ headers }), [200])).body.configs;
}
async function rotate(
  provider: Provider,
  config: { id: string; revision: number },
) {
  const body = {
    expectedRevision: config.revision,
    credentials: {
      clientId: "replacement-id",
      clientSecret: "replacement-secret",
    },
  };
  const params = { configId: config.id };
  return provider === "cloudflare_access"
    ? (
        await accept(
          cloudflare().update({ headers, query, params, body }),
          [200],
        )
      ).body
    : (await accept(tailscale().update({ headers, params, body }), [200])).body;
}
function selectedTransport(provider: Provider, configId: string) {
  return provider === "cloudflare_access"
    ? { type: "cloudflare_access" as const, configId }
    : { type: "tailscale" as const, configId };
}
async function createHost(provider: Provider, configId: string) {
  return (
    await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Bound host",
          host: "peer.example.com",
          port: 443,
          credential: { create: login },
          transport: selectedTransport(provider, configId),
        },
      }),
      [201],
    )
  ).body;
}
async function latestHost(id: string) {
  const current = (
    await accept(hosts().list({ headers }), [200])
  ).body.connections.find((host) => {
    return host.id === id;
  });
  if (!current) {
    throw new Error("Expected owned publication host");
  }
  return current;
}

test.each(["cloudflare_access", "tailscale"] as const)(
  "%s creation, retained edits and rebind preserve logical configuration metadata",
  async (provider) => {
    const config = await createConfig(provider);
    const first = await createHost(provider, config.id);
    await expect(configList(provider)).resolves.toStrictEqual([
      {
        ...config,
        sshHosts: [{ id: first.id, displayName: first.displayName }],
      },
    ]);
    const unrelatedConfig = await createConfig(provider);
    const unrelated = await createHost(provider, unrelatedConfig.id);
    const changed = (
      await accept(
        hosts().update({
          headers,
          params: { connectionId: first.id },
          body: {
            expectedGeneration: first.generation,
            displayName: "Retained implicitly",
            credential: { create: { ...login, name: "Replacement login" } },
          },
        }),
        [200],
      )
    ).body;
    const retained = (
      await accept(
        hosts().update({
          headers,
          params: { connectionId: first.id },
          body: {
            expectedGeneration: changed.generation,
            displayName: "Retained explicitly",
            transport: selectedTransport(provider, config.id),
          },
        }),
        [200],
      )
    ).body;
    expect(retained).toMatchObject({
      id: first.id,
      generation: first.generation + 2,
      transport: selectedTransport(provider, config.id),
    });
    await expect(configList(provider)).resolves.toStrictEqual([
      {
        ...config,
        sshHosts: [{ id: first.id, displayName: retained.displayName }],
      },
      {
        ...unrelatedConfig,
        sshHosts: [{ id: unrelated.id, displayName: unrelated.displayName }],
      },
    ]);
    await expect(latestHost(unrelated.id)).resolves.toStrictEqual(unrelated);
    const rebound = (
      await accept(
        hosts().update({
          headers,
          params: { connectionId: first.id },
          body: {
            expectedGeneration: retained.generation,
            transport: selectedTransport(provider, unrelatedConfig.id),
          },
        }),
        [200],
      )
    ).body;
    expect(rebound).toMatchObject({
      id: first.id,
      generation: first.generation + 3,
      transport: selectedTransport(provider, unrelatedConfig.id),
    });
    const migratedConfig = (await configList(provider)).find((item) => {
      return item.id === unrelatedConfig.id;
    });
    expect(migratedConfig).toStrictEqual({
      ...unrelatedConfig,
      sshHosts: expect.arrayContaining([
        { id: first.id, displayName: retained.displayName },
        { id: unrelated.id, displayName: unrelated.displayName },
      ]),
    });
    expect(migratedConfig?.sshHosts).toHaveLength(2);
    await expect(configList(provider)).resolves.toContainEqual({
      ...config,
      sshHosts: [],
    });
    await expect(latestHost(unrelated.id)).resolves.toStrictEqual(unrelated);
  },
);

test.each(["cloudflare_access", "tailscale"] as const)(
  "%s rotation during retained inline-login preparation rejects the stale edit without an orphan login",
  async (provider) => {
    const config = await createConfig(provider);
    const host = await createHost(provider, config.id);
    const unrelatedConfig = await createConfig(provider);
    const unrelated = await createHost(provider, unrelatedConfig.id);
    const before = (await accept(credentials().list({ headers }), [200])).body;
    useSecretKmsProbe(async (request, callNumber) => {
      if (callNumber === 1) {
        await rotate(provider, config);
      }
      return {
        keyId: request.keyId,
        plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
        encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
      };
    });
    const rejected = await accept(
      hosts().update({
        headers,
        params: { connectionId: host.id },
        body: {
          expectedGeneration: host.generation,
          displayName: "Stale retained edit",
          credential: { create: { ...login, name: "Losing login" } },
        },
      }),
      [409],
    );
    expect(rejected.body.error.code).toBe("SSH_GENERATION_CONFLICT");
    expect(
      (await accept(credentials().list({ headers }), [200])).body,
    ).toStrictEqual(before);
    await expect(latestHost(host.id)).resolves.toMatchObject({
      ...host,
      generation: host.generation + 1,
      updatedAt: expect.any(String),
    });
    await expect(latestHost(unrelated.id)).resolves.toStrictEqual(unrelated);
    await expect(configList(provider)).resolves.toContainEqual({
      ...config,
      revision: config.revision + 1,
      generation: config.generation + 1,
      updatedAt: expect.any(String),
      sshHosts: [{ id: host.id, displayName: host.displayName }],
    });
  },
);

test.each(["cloudflare_access", "tailscale"] as const)(
  "%s rotation includes a retained binding edit completed during external secret preparation",
  async (provider) => {
    const config = await createConfig(provider);
    const host = await createHost(provider, config.id);
    useSecretKmsProbe(async (request, callNumber) => {
      if (callNumber === 1) {
        const changed = await accept(
          hosts().update({
            headers,
            params: { connectionId: host.id },
            body: {
              expectedGeneration: host.generation,
              displayName: "Retained during rotation",
            },
          }),
          [200],
        );
        expect(changed.body).toMatchObject({
          generation: host.generation + 1,
          transport: selectedTransport(provider, config.id),
        });
      }
      return {
        keyId: request.keyId,
        plaintext: Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
        encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
      };
    });
    const rotated = await rotate(provider, config);
    expect(rotated).toStrictEqual({
      ...config,
      revision: config.revision + 1,
      generation: config.generation + 1,
      updatedAt: expect.any(String),
      sshHosts: [{ id: host.id, displayName: "Retained during rotation" }],
    });
    await expect(latestHost(host.id)).resolves.toMatchObject({
      ...host,
      displayName: "Retained during rotation",
      generation: host.generation + 2,
      updatedAt: expect.any(String),
    });
  },
);
