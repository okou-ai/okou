import { randomUUID } from "node:crypto";
import {
  sshConnectionsContract,
  type CreateSshConnectionRequest,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { sshConnectionsRoutes } from "../ssh-connections";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const clerkDirectory = createStore();

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
  return actor;
}

function hosts() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}

const passwordLogin = () => {
  return {
    create: {
      name: "Deploy login",
      username: "deploy",
      authentication: {
        method: "password" as const,
        password: `pw-${randomUUID()}`,
      },
    },
  };
};

async function listHosts() {
  return (await accept(hosts().list({ headers }), [200])).body.connections;
}

function resetHostKey(connectionId: string, expectedGeneration: number) {
  return accept(
    hosts().resetHostKey({
      headers,
      params: { connectionId },
      body: { expectedGeneration },
    }),
    [200, 409],
  );
}

/** Two concurrent resets at generation 1, then a stale third reset. */
async function raceHostKeyResets(body: CreateSshConnectionRequest) {
  await signedInMember();
  const created = await accept(hosts().create({ headers, body }), [201]);
  expect(created.body.generation).toBe(1);

  const concurrent = await Promise.all([
    resetHostKey(body.id, 1),
    resetHostKey(body.id, 1),
  ]);

  expect(
    concurrent
      .map((response) => {
        return response.status;
      })
      .sort(),
  ).toStrictEqual([200, 409]);
  const conflict = concurrent.find((response) => {
    return response.status === 409;
  });
  expect(conflict?.body).toMatchObject({
    error: {
      code: "SSH_GENERATION_CONFLICT",
      message: "SSH connection was modified by another request",
    },
  });
  const afterReset = await listHosts();
  expect(afterReset).toHaveLength(1);
  expect(afterReset[0]).toMatchObject({
    id: body.id,
    host: body.host,
    port: 22,
    generation: 2,
  });

  const stale = await resetHostKey(body.id, 1);
  expect(stale.status).toBe(409);
  const final = await listHosts();
  expect(final).toStrictEqual(afterReset);
  return final;
}

describe("SSH host key reset compare-and-swap", () => {
  it("ssh-host-key-cas-001 accepts only one concurrent direct host key reset", async () => {
    const final = await raceHostKeyResets({
      id: randomUUID(),
      displayName: "Direct host",
      host: "ssh.example.com",
      port: 22,
      credential: passwordLogin(),
      transport: { type: "direct" },
    });

    expect(final[0] && "transport" in final[0]).toBeFalsy();
  });

  it("ssh-host-key-cas-003 accepts only one concurrent Tailscale host key reset", async () => {
    const final = await raceHostKeyResets({
      id: randomUUID(),
      displayName: "Tailnet host",
      host: "peer.tailnet.ts.net",
      port: 22,
      credential: passwordLogin(),
      transport: {
        type: "tailscale",
        create: {
          name: `Tailnet ${randomUUID().slice(0, 8)}`,
          credentials: {
            clientId: `client-${randomUUID()}`,
            clientSecret: `secret-${randomUUID()}`,
          },
          tags: ["tag:okou"],
        },
      },
    });

    expect(final[0]).toMatchObject({ transport: { type: "tailscale" } });
  });
});
