import { randomUUID } from "node:crypto";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { sshCredentialsContract } from "@okouai/api-contracts/contracts/ssh-credentials";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { sshConnectionsRoutes } from "../ssh-connections";
import { tailscaleRoutes } from "../tailscale";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const clerkDirectory = createStore();

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

async function member(orgId = `org_${randomUUID()}`): Promise<Actor> {
  const actor = { userId: `user_${randomUUID()}`, orgId };
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
const tailscale = () => {
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
};

function inlineLogin() {
  return {
    create: {
      name: `Login ${randomUUID().slice(0, 8)}`,
      username: "deploy",
      authentication: {
        method: "password" as const,
        password: `pw-${randomUUID()}`,
      },
    },
  };
}

async function createTailscaleConfig(id = randomUUID()) {
  return (
    await accept(
      tailscale().create({
        headers,
        body: {
          id,
          name: `Tailnet ${id.slice(0, 8)}`,
          credentials: {
            clientId: `client-${randomUUID()}`,
            clientSecret: `secret-${randomUUID()}`,
          },
          tags: ["tag:okou"],
        },
      }),
      [201],
    )
  ).body;
}

/** Everything the member can see about hosts, logins and Tailscale configs. */
async function inventory() {
  const [hostList, loginList, configList] = await Promise.all([
    accept(hosts().list({ headers }), [200]),
    accept(logins().list({ headers }), [200]),
    accept(tailscale().list({ headers }), [200]),
  ]);
  return {
    hosts: hostList.body.connections,
    logins: loginList.body.credentials,
    configs: configList.body.configs,
  };
}

describe("SSH Tailscale binding atomicity", () => {
  it("ssh-tailscale-binding-atomicity-003 does not let a Tailscale config grant another member's SSH login", async () => {
    const owner = await member();
    const colleague = await member(owner.orgId);
    signIn(colleague);
    const foreignLogin = await accept(
      logins().create({
        headers,
        body: {
          id: randomUUID(),
          name: "Colleague login",
          username: "colleague",
          authentication: {
            method: "password",
            password: `pw-${randomUUID()}`,
          },
        },
      }),
      [201],
    );
    signIn(owner);
    const config = await createTailscaleConfig();

    const response = await accept(
      hosts().create({
        headers,
        body: {
          id: randomUUID(),
          displayName: "Borrowed login",
          host: "peer.example.com",
          credential: { id: foreignLogin.body.id },
          transport: { type: "tailscale", configId: config.id },
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("SSH_CREDENTIAL_NOT_FOUND");
    const after = await inventory();
    expect(after.hosts).toStrictEqual([]);
    expect(after.logins).toStrictEqual([]);
    expect(
      after.configs.map((item) => {
        return item.id;
      }),
    ).toStrictEqual([config.id]);
  });

  it("ssh-tailscale-binding-atomicity-004 rejects a missing Tailscale config on create, then binds once it exists", async () => {
    signIn(await member());
    const configId = randomUUID();
    const hostId = randomUUID();
    const body = {
      id: hostId,
      displayName: "Tailnet host",
      host: "peer.example.com",
      credential: inlineLogin(),
      transport: { type: "tailscale" as const, configId },
    };
    const before = await inventory();

    const missing = await accept(hosts().create({ headers, body }), [404]);

    expect(missing.body.error.code).toBe("TAILSCALE_NOT_FOUND");
    await expect(inventory()).resolves.toStrictEqual(before);

    await createTailscaleConfig(configId);
    const created = await accept(hosts().create({ headers, body }), [201]);
    expect(created.body).toMatchObject({
      id: hostId,
      generation: 1,
      transport: { type: "tailscale", configId },
    });
  });

  it("ssh-tailscale-binding-atomicity-005 rejects a missing Tailscale config on update, then moves the host once it exists", async () => {
    signIn(await member());
    const configId = randomUUID();
    const hostId = randomUUID();
    await accept(
      hosts().create({
        headers,
        body: {
          id: hostId,
          displayName: "Direct host",
          host: "ssh.example.com",
          credential: inlineLogin(),
          transport: { type: "direct" },
        },
      }),
      [201],
    );
    const before = await inventory();
    const update = {
      expectedGeneration: 1,
      host: "100.64.0.21",
      credential: inlineLogin(),
      transport: { type: "tailscale" as const, configId },
    };

    const missing = await accept(
      hosts().update({
        headers,
        params: { connectionId: hostId },
        body: update,
      }),
      [404],
    );

    expect(missing.body.error.code).toBe("TAILSCALE_NOT_FOUND");
    const after = await inventory();
    expect(after).toStrictEqual(before);
    expect(after.hosts[0]).toMatchObject({
      host: "ssh.example.com",
      generation: 1,
    });

    await createTailscaleConfig(configId);
    const moved = await accept(
      hosts().update({
        headers,
        params: { connectionId: hostId },
        body: update,
      }),
      [200],
    );
    expect(moved.body).toMatchObject({
      generation: 2,
      transport: { type: "tailscale", configId },
    });
  });
});
