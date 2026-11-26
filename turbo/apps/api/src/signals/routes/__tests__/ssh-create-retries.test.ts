import { randomUUID } from "node:crypto";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { cloudflareAccessRoutes } from "../cloudflare-access";
import { sshConnectionsRoutes } from "../ssh-connections";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const clerkDirectory = createStore();

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

async function member(ids: Partial<Actor> = {}): Promise<Actor> {
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

const hosts = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};
const logins = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshCredentialsContract,
  );
};
const access = () => {
  return setupApp({ context, routes: cloudflareAccessRoutes })(
    cloudflareAccessContract,
  );
};

function passwordLogin(name = "Deploy login") {
  return {
    name,
    username: "deploy",
    authentication: {
      method: "password" as const,
      password: `pw-${randomUUID()}`,
    },
  };
}

function accessToken(name = "Access token") {
  return {
    name,
    credentials: {
      clientId: `client-${randomUUID()}`,
      clientSecret: `secret-${randomUUID()}`,
    },
  };
}

function protectedHost(id: string, displayName = "Protected host") {
  return {
    id,
    displayName,
    host: "ssh.example.com",
    port: 443,
    credential: { create: passwordLogin() },
    transport: { type: "cloudflare_access" as const, create: accessToken() },
  };
}

function directHost(id: string) {
  return {
    id,
    displayName: "Direct host",
    host: "ssh.example.com",
    credential: { create: passwordLogin() },
    transport: { type: "direct" as const },
  };
}

/** Everything the signed-in caller can see about hosts, logins and Access configs. */
async function inventory() {
  const [hostList, loginList, accessList] = await Promise.all([
    accept(hosts().list({ headers }), [200]),
    accept(logins().list({ headers }), [200]),
    accept(access().list({ headers, query: {} }), [200]),
  ]);
  return {
    hosts: hostList.body.connections,
    logins: loginList.body.credentials,
    configs: accessList.body.configs,
  };
}

/** The member owns a host, a login and an Access config that share one resource ID. */
async function sameIdResources(owner: Actor, id: string) {
  signIn(owner);
  await accept(hosts().create({ headers, body: directHost(id) }), [201]);
  await accept(
    logins().create({ headers, body: { id, ...passwordLogin() } }),
    [201],
  );
  await accept(
    access().create({ headers, query: {}, body: { id, ...accessToken() } }),
    [201],
  );
}

async function expectForeignIdConflicts(stranger: Actor, id: string) {
  signIn(stranger);
  const [host, login, config] = await Promise.all([
    accept(hosts().create({ headers, body: directHost(id) }), [409]),
    accept(
      logins().create({ headers, body: { id, ...passwordLogin() } }),
      [409],
    ),
    accept(
      access().create({ headers, query: {}, body: { id, ...accessToken() } }),
      [409],
    ),
  ]);
  const sshConflict = {
    code: "SSH_RESOURCE_ID_CONFLICT",
    message: "This resource ID cannot be used for this SSH configuration.",
  };
  expect(host.body.error).toMatchObject(sshConflict);
  expect(login.body.error).toMatchObject(sshConflict);
  expect(config.body.error).toMatchObject({
    code: "CLOUDFLARE_ACCESS_RESOURCE_ID_CONFLICT",
    message:
      "This resource ID cannot be used for this Cloudflare Access configuration.",
  });
  await expect(inventory()).resolves.toStrictEqual({
    hosts: [],
    logins: [],
    configs: [],
  });
}

/** The original member repeats the host create; returns their hosts afterwards. */
async function ownerRetry(owner: Actor, id: string) {
  signIn(owner);
  const retry = await accept(
    hosts().create({ headers, body: directHost(id) }),
    [204],
  );
  if (retry.body) {
    throw new Error("Expected an empty retry acknowledgement");
  }
  return (await inventory()).hosts;
}

describe("SSH create retries", () => {
  it("ssh-create-retries-010 corrects an invalid host create without consuming its ID", async () => {
    signIn(await member());
    const id = randomUUID();

    await accept(
      hosts().create({
        headers,
        body: { ...directHost(id), host: "https://ssh.example.com" },
      }),
      [400],
    );
    await expect(inventory()).resolves.toStrictEqual({
      hosts: [],
      logins: [],
      configs: [],
    });

    await accept(hosts().create({ headers, body: directHost(id) }), [201]);
  });

  it("ssh-create-retries-001 acknowledges concurrent host create retries without duplicates", async () => {
    signIn(await member());
    const id = randomUUID();

    const statuses = await Promise.all([
      accept(hosts().create({ headers, body: protectedHost(id) }), [201, 204]),
      accept(
        hosts().create({ headers, body: protectedHost(id.toUpperCase()) }),
        [201, 204],
      ),
    ]);

    expect(
      statuses
        .map((response) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([201, 204]);
    const created = await inventory();
    expect(created.hosts).toHaveLength(1);
    expect(created.logins).toHaveLength(1);
    expect(created.configs).toHaveLength(1);

    const renamed = await accept(
      hosts().create({ headers, body: protectedHost(id, "Renamed host") }),
      [204],
    );
    expect(renamed.body).toBeFalsy();
    await expect(inventory()).resolves.toStrictEqual(created);
  });

  it("ssh-create-retries-003 acknowledges concurrent Access create retries without duplicates", async () => {
    signIn(await member());
    const id = randomUUID();

    const statuses = await Promise.all([
      accept(
        access().create({ headers, query: {}, body: { id, ...accessToken() } }),
        [201, 204],
      ),
      accept(
        access().create({
          headers,
          query: {},
          body: { id: id.toUpperCase(), ...accessToken() },
        }),
        [201, 204],
      ),
    ]);

    expect(
      statuses
        .map((response) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([201, 204]);
    const created = await inventory();
    expect(created.hosts).toStrictEqual([]);
    expect(created.logins).toStrictEqual([]);
    expect(created.configs).toHaveLength(1);

    const renamed = await accept(
      access().create({
        headers,
        query: {},
        body: { id, ...accessToken("Renamed token") },
      }),
      [204],
    );
    expect(renamed.body).toBeFalsy();
    await expect(inventory()).resolves.toStrictEqual(created);
  });

  it("ssh-create-retries-007 refuses another user in the same organization the same resource ID", async () => {
    const owner = await member();
    const id = randomUUID();
    await sameIdResources(owner, id);
    const stranger = await member({ orgId: owner.orgId });

    await expectForeignIdConflicts(stranger, id);
    await expect(ownerRetry(owner, id)).resolves.toHaveLength(1);
  });

  it("ssh-create-retries-008 refuses the same user in another organization the same resource ID", async () => {
    const owner = await member();
    const id = randomUUID();
    await sameIdResources(owner, id);
    const stranger = await member({ userId: owner.userId });

    await expectForeignIdConflicts(stranger, id);
    await expect(ownerRetry(owner, id)).resolves.toHaveLength(1);
  });

  it("ssh-create-retries-011 saves a host again after overlapping edits", async () => {
    signIn(await member());
    const id = randomUUID();
    await accept(hosts().create({ headers, body: directHost(id) }), [201]);
    const edit = () => {
      return accept(
        hosts().update({
          headers,
          params: { connectionId: id },
          body: {
            expectedGeneration: 1,
            port: 443,
            credential: { create: passwordLogin("Replacement") },
            transport: { type: "cloudflare_access", create: accessToken() },
          },
        }),
        [200, 409],
      );
    };

    await Promise.all([edit(), edit()]);
    const listed = (await inventory()).hosts.find((host) => {
      return host.id === id;
    });
    if (!listed) {
      throw new Error("Expected the host to remain listed");
    }

    const saved = await accept(
      hosts().update({
        headers,
        params: { connectionId: id },
        body: {
          expectedGeneration: listed.generation,
          displayName: "Saved again",
        },
      }),
      [200],
    );

    expect(saved.body).toMatchObject({
      displayName: "Saved again",
      generation: listed.generation + 1,
      username: "deploy",
    });
    if (!("credentialName" in saved.body)) {
      throw new Error("Expected a credential-backed host");
    }
    expect(saved.body.credentialName).toBe("Replacement");
    const credentialIds = (await inventory()).logins.map((login) => {
      return login.id;
    });
    expect(credentialIds).toContain(saved.body.credentialId);
  });
});
