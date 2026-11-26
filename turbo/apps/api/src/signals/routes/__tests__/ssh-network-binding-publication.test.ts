import { randomUUID } from "node:crypto";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  sshConnectionsContract,
  type UpdateSshConnectionRequest,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { tailscaleRoutes } from "../tailscale";
import { holdSecretKms } from "./helpers/hold-secret-kms";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const clerkDirectory = createStore();

type NetworkKind = "cloudflare_access" | "tailscale";

function networkTransport(kind: NetworkKind, configId: string) {
  return kind === "tailscale"
    ? { type: "tailscale" as const, configId }
    : { type: "cloudflare_access" as const, configId };
}

async function signedInMember() {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  await clerkDirectory.set(
    seedOrgMembership$,
    { ...actor, role: "member" },
    context.signal,
  );
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:member",
  );
}

const hosts = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};
const access = () => {
  return setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
};
const tailscale = () => {
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
};

function serviceCredentials() {
  return {
    clientId: `client-${randomUUID()}`,
    clientSecret: `secret-${randomUUID()}`,
  };
}

function inlineLogin(name = "Deploy login") {
  return {
    create: {
      name,
      username: "deploy",
      authentication: {
        method: "password" as const,
        password: `pw-${randomUUID()}`,
      },
    },
  };
}

async function createConfig(kind: NetworkKind) {
  const id = randomUUID();
  const name = `Network ${id.slice(0, 8)}`;
  if (kind === "cloudflare_access") {
    return (
      await accept(
        access().create({
          headers,
          query: { view: "scoped" },
          body: { id, name, credentials: serviceCredentials() },
        }),
        [201],
      )
    ).body;
  }
  return (
    await accept(
      tailscale().create({
        headers,
        body: {
          id,
          name,
          credentials: serviceCredentials(),
          tags: ["tag:okou"],
        },
      }),
      [201],
    )
  ).body;
}

/** The SSH hosts each configuration publishes, keyed by configuration id. */
async function publishedHosts(kind: NetworkKind) {
  const configs =
    kind === "cloudflare_access"
      ? (
          await accept(
            access().list({ headers, query: { view: "scoped" } }),
            [200],
          )
        ).body.configs
      : (await accept(tailscale().list({ headers }), [200])).body.configs;
  return Object.fromEntries(
    configs.map((config) => {
      return [config.id, config.sshHosts];
    }),
  );
}

async function listHosts() {
  return (await accept(hosts().list({ headers }), [200])).body.connections;
}

async function createBoundHost(kind: NetworkKind, configId: string) {
  const id = randomUUID();
  const displayName = `Host ${id.slice(0, 8)}`;
  const created = await accept(
    hosts().create({
      headers,
      body: {
        id,
        displayName,
        host: "peer.example.com",
        port: 443,
        credential: inlineLogin(),
        transport: networkTransport(kind, configId),
      },
    }),
    [201],
  );
  return { id, displayName, generation: created.body.generation };
}

async function editBinding(
  connectionId: string,
  body: UpdateSshConnectionRequest,
) {
  return (
    await accept(
      hosts().update({ headers, params: { connectionId }, body }),
      [200],
    )
  ).body;
}

/** Create, two retained edits, then a rebind; returns what each step published. */
async function retainAndRebind(kind: NetworkKind) {
  await signedInMember();
  const [first, second] = await Promise.all([
    createConfig(kind),
    createConfig(kind),
  ]);
  const host = await createBoundHost(kind, first.id);
  const unrelated = await createBoundHost(kind, second.id);
  const unrelatedBefore = (await listHosts()).find((item) => {
    return item.id === unrelated.id;
  });
  const afterCreate = await publishedHosts(kind);

  await editBinding(host.id, {
    expectedGeneration: host.generation,
    displayName: "Renamed host",
    credential: inlineLogin("Replacement login"),
  });
  const retained = await editBinding(host.id, {
    expectedGeneration: host.generation + 1,
    displayName: "Renamed host",
    transport: networkTransport(kind, first.id),
  });
  const afterRetain = await publishedHosts(kind);

  const rebound = await editBinding(host.id, {
    expectedGeneration: host.generation + 2,
    transport: networkTransport(kind, second.id),
  });
  const afterRebind = await publishedHosts(kind);
  const unrelatedAfter = (await listHosts()).find((item) => {
    return item.id === unrelated.id;
  });

  expect(afterCreate[first.id]).toStrictEqual([
    { id: host.id, displayName: host.displayName },
  ]);
  expect(retained).toMatchObject({
    generation: host.generation + 2,
    transport: networkTransport(kind, first.id),
  });
  expect(afterRetain[first.id]).toStrictEqual([
    { id: host.id, displayName: "Renamed host" },
  ]);
  expect(afterRetain[second.id]).toStrictEqual([
    { id: unrelated.id, displayName: unrelated.displayName },
  ]);
  expect(rebound).toMatchObject({
    generation: host.generation + 3,
    transport: networkTransport(kind, second.id),
  });
  expect(afterRebind[first.id]).toStrictEqual([]);
  expect(
    [...(afterRebind[second.id] ?? [])].sort((a, b) => {
      return a.id.localeCompare(b.id);
    }),
  ).toStrictEqual(
    [
      { id: host.id, displayName: "Renamed host" },
      { id: unrelated.id, displayName: unrelated.displayName },
    ].sort((a, b) => {
      return a.id.localeCompare(b.id);
    }),
  );
  return { unrelatedBefore, unrelatedAfter };
}

describe("SSH network binding publication", () => {
  it("ssh-network-binding-publication-005 includes a rename made while an Access rotation prepares its secret", async () => {
    await signedInMember();
    const config = await createConfig("cloudflare_access");
    const host = await createBoundHost("cloudflare_access", config.id);
    const kms = holdSecretKms(1, context.signal);

    const rotation = accept(
      access().update({
        headers,
        query: { view: "scoped" },
        params: { configId: config.id },
        body: {
          expectedRevision: config.revision,
          credentials: serviceCredentials(),
        },
      }),
      [200],
    );
    await kms.entered;
    const renamed = await editBinding(host.id, {
      expectedGeneration: host.generation,
      displayName: "Retained during rotation",
    });
    kms.release();
    const rotated = await rotation;

    expect(renamed).toMatchObject({
      generation: host.generation + 1,
      transport: { type: "cloudflare_access", configId: config.id },
    });
    expect(rotated.body).toMatchObject({
      revision: config.revision + 1,
      generation: config.generation + 1,
      sshHosts: [{ id: host.id, displayName: "Retained during rotation" }],
    });
    const listed = (await listHosts()).find((item) => {
      return item.id === host.id;
    });
    expect(listed).toMatchObject({
      displayName: "Retained during rotation",
      generation: host.generation + 2,
    });
  });

  it("ssh-network-binding-publication-001 keeps Cloudflare Access bindings published through retained edits and a rebind", async () => {
    const { unrelatedBefore, unrelatedAfter } =
      await retainAndRebind("cloudflare_access");

    expect(unrelatedAfter).toStrictEqual(unrelatedBefore);
  });

  it("ssh-network-binding-publication-002 keeps Tailscale bindings published through retained edits and a rebind", async () => {
    const { unrelatedBefore, unrelatedAfter } =
      await retainAndRebind("tailscale");

    expect(unrelatedAfter).toStrictEqual(unrelatedBefore);
  });
});
