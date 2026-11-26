import { randomUUID } from "node:crypto";

import {
  sshConnectionsContract,
  type SshConnectionResponse,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { createStore } from "ccstate";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { sshConnectionsRoutes } from "../ssh-connections";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { inlineSshKey } from "./helpers/ssh-credential";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

const clerkDirectory = createStore();

async function newActor(ids: Partial<Actor> = {}): Promise<Actor> {
  const actor = {
    userId: ids.userId ?? `user_${randomUUID()}`,
    orgId: ids.orgId ?? `org_${randomUUID()}`,
  };
  await clerkDirectory.set(
    seedOrgMembership$,
    { ...actor, role: "member" },
    context.signal,
  );
  return actor;
}

function signIn(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:member",
  );
}

function hosts() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}

function createHost(
  host: string,
  username = "deploy",
  options: { readonly port?: number } = {},
) {
  return hosts().create({
    headers,
    body: {
      id: randomUUID(),
      displayName: `Host ${host}`,
      host,
      ...(options.port === undefined ? {} : { port: options.port }),
      credential: inlineSshKey(username, `key-${randomUUID()}\n`),
    },
  });
}

async function listHosts() {
  return (await accept(hosts().list({ headers }), [200])).body.connections;
}

function byId(items: readonly SshConnectionResponse[]) {
  return [...items].sort((a, b) => {
    return a.id.localeCompare(b.id);
  });
}

describe("SSH connection routes", () => {
  it("ssh-connections-002 an ordinary member lists no hosts without feature overrides", async () => {
    signIn(await newActor({ orgId: "org_ordinary_ssh" }));

    const response = await accept(hosts().list({ headers }), [200]);

    expect(response.body).toStrictEqual({ connections: [] });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("ssh-connections-006 invalid hosts and extra password fields are rejected before KMS work", async () => {
    const kms = useSecretKmsProbe();
    signIn(await newActor());

    for (const host of ["[::1]", "example.com:22", "https://example.com"]) {
      const invalid = await accept(createHost(host), [400]);
      expect(invalid.body.error.code).toBe("SSH_INVALID_HOST");
    }
    expect(kms.generateDataKeyCalls).toBe(0);

    const valid = await accept(createHost("EXAMPLE.com."), [201]);
    expect(valid.body.host).toBe("example.com");
    expect(kms.generateDataKeyCalls).toBe(1);

    const canary = `canary-${randomUUID()}`;
    const authentication = {
      method: "private_key",
      privateKey: `key-${randomUUID()}`,
      passphrase: null,
      password: canary,
    };
    const raw = setupRawAppRequest({ context, routes: sshConnectionsRoutes });
    const create = await raw("/api/ssh/connections", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        id: randomUUID(),
        displayName: "Broken",
        host: "broken.example.com",
        credential: {
          create: { name: "Broken login", username: "deploy", authentication },
        },
      }),
    });
    const update = await raw(`/api/ssh/connections/${valid.body.id}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        expectedGeneration: valid.body.generation,
        credential: {
          create: { name: "Broken login", username: "deploy", authentication },
        },
      }),
    });

    for (const response of [create, update]) {
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain(canary);
    }
    expect(kms.generateDataKeyCalls).toBe(1);
  });

  it("ssh-connections-007 independent logins share a normalized endpoint on create and update", async () => {
    useSecretKmsProbe();
    signIn(await newActor());

    const first = await accept(createHost("EXAMPLE.com.", "ubuntu"), [201]);
    const second = await accept(createHost("example.COM", "deploy"), [201]);
    const third = await accept(
      createHost("other.example.com", "deploy", { port: 2222 }),
      [201],
    );
    expect(second.body).toMatchObject({
      host: "example.com",
      port: 22,
      username: "deploy",
    });

    const moved = await accept(
      hosts().update({
        headers,
        params: { connectionId: third.body.id },
        body: {
          expectedGeneration: third.body.generation,
          host: "EXAMPLE.com.",
          port: 22,
        },
      }),
      [200],
    );
    expect(moved.body).toMatchObject({
      id: third.body.id,
      host: "example.com",
      port: 22,
      username: "deploy",
      generation: 2,
    });

    expect(byId(await listHosts())).toStrictEqual(
      byId([first.body, second.body, moved.body]),
    );
  });

  it("ssh-connections-008 another member cannot update the owner's host and KMS is not called", async () => {
    const kms = useSecretKmsProbe();
    const owner = await newActor();
    signIn(owner);
    const created = await accept(createHost("owner.example.com"), [201]);
    expect(kms.generateDataKeyCalls).toBe(1);

    signIn(await newActor({ orgId: owner.orgId }));
    const update = await accept(
      hosts().update({
        headers,
        params: { connectionId: created.body.id },
        body: {
          expectedGeneration: created.body.generation,
          credential: inlineSshKey("intruder", `key-${randomUUID()}`),
        },
      }),
      [404],
    );

    expect(update.body.error.message).toBe("SSH connection not found");
    expect(kms.generateDataKeyCalls).toBe(1);
    await expect(listHosts()).resolves.toStrictEqual([]);
  });

  it("ssh-connections-009 a peer sharing the organization cannot reset the owner's host key", async () => {
    useSecretKmsProbe();
    const owner = await newActor();
    signIn(owner);
    const ownerHost = await accept(createHost("owner.example.com"), [201]);
    const peer = await newActor({ orgId: owner.orgId });
    signIn(peer);
    const peerHost = await accept(createHost("peer.example.com"), [201]);

    const foreign = await accept(
      hosts().resetHostKey({
        headers,
        params: { connectionId: ownerHost.body.id },
        body: { expectedGeneration: ownerHost.body.generation },
      }),
      [404],
    );
    const unknown = await accept(
      hosts().resetHostKey({
        headers,
        params: { connectionId: randomUUID() },
        body: { expectedGeneration: 1 },
      }),
      [404],
    );
    expect(foreign.body.error.code).toBe("SSH_CONNECTION_NOT_FOUND");
    expect(foreign.body).toStrictEqual(unknown.body);

    await expect(listHosts()).resolves.toStrictEqual([peerHost.body]);
    signIn(owner);
    await expect(listHosts()).resolves.toStrictEqual([ownerHost.body]);

    const reset = await accept(
      hosts().resetHostKey({
        headers,
        params: { connectionId: ownerHost.body.id },
        body: { expectedGeneration: ownerHost.body.generation },
      }),
      [200],
    );
    expect(reset.body).toMatchObject({
      id: ownerHost.body.id,
      host: "owner.example.com",
      generation: 2,
    });
    await expect(listHosts()).resolves.toStrictEqual([reset.body]);
  });

  it("ssh-connections-010 a peer sharing the user ID in another organization cannot reset the owner's host key", async () => {
    useSecretKmsProbe();
    const owner = await newActor();
    signIn(owner);
    const ownerHost = await accept(createHost("owner.example.com"), [201]);
    const peer = await newActor({ userId: owner.userId });
    signIn(peer);
    const peerHost = await accept(createHost("peer.example.com"), [201]);

    const foreign = await accept(
      hosts().resetHostKey({
        headers,
        params: { connectionId: ownerHost.body.id },
        body: { expectedGeneration: ownerHost.body.generation },
      }),
      [404],
    );
    const unknown = await accept(
      hosts().resetHostKey({
        headers,
        params: { connectionId: randomUUID() },
        body: { expectedGeneration: 1 },
      }),
      [404],
    );
    expect(foreign.body.error.code).toBe("SSH_CONNECTION_NOT_FOUND");
    expect(foreign.body).toStrictEqual(unknown.body);

    await expect(listHosts()).resolves.toStrictEqual([peerHost.body]);
    signIn(owner);
    await expect(listHosts()).resolves.toStrictEqual([ownerHost.body]);

    const reset = await accept(
      hosts().resetHostKey({
        headers,
        params: { connectionId: ownerHost.body.id },
        body: { expectedGeneration: ownerHost.body.generation },
      }),
      [200],
    );
    expect(reset.body).toMatchObject({
      id: ownerHost.body.id,
      host: "owner.example.com",
      generation: 2,
    });
    await expect(listHosts()).resolves.toStrictEqual([reset.body]);
  });
});
