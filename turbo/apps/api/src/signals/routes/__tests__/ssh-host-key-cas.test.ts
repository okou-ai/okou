import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { joinAll } from "../../utils";
import { sshConnectionsRoutes } from "../ssh-connections";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const api = () => {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
};

async function create(transport: "direct" | "cloudflare_access" | "tailscale") {
  useSecretKmsProbe();
  mocks.clerk.session(
    `user_trust_${randomUUID()}`,
    `org_trust_${randomUUID()}`,
  );
  const protection =
    transport === "direct"
      ? undefined
      : transport === "cloudflare_access"
        ? {
            type: "cloudflare_access" as const,
            create: {
              name: "Access",
              credentials: {
                clientId: "trust-fixture.access",
                clientSecret: "trust-fixture-token",
              },
            },
          }
        : {
            type: "tailscale" as const,
            create: {
              name: "Tailnet",
              credentials: {
                clientId: "trust-fixture-client",
                clientSecret: "trust-fixture-secret",
              },
              tags: ["tag:okou"],
            },
          };
  return await accept(
    api().create({
      headers,
      body: {
        id: randomUUID(),
        displayName: "Trust target",
        host:
          transport === "tailscale" ? "peer.tailnet.ts.net" : "ssh.example.com",
        port: transport === "cloudflare_access" ? 443 : 22,
        credential: {
          create: {
            name: "Login",
            username: "deploy",
            authentication: {
              method: "password",
              password: "fixture-password",
            },
          },
        },
        transport: protection,
      },
    }),
    [201],
  );
}

test.each(["direct", "cloudflare_access", "tailscale"] as const)(
  "competing %s trust resets accept only one expected generation",
  async (transport) => {
    const created = await create(transport);
    const reset = () => {
      return api().resetHostKey({
        headers,
        params: { connectionId: created.body.id },
        body: { expectedGeneration: created.body.generation },
      });
    };
    const outcomes = await joinAll([reset(), reset()]);
    expect(
      outcomes
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const refused = outcomes.find((result) => {
      return result.status === 409;
    });
    expect(refused?.body).toStrictEqual({
      error: {
        code: "SSH_GENERATION_CONFLICT",
        message: "SSH connection was modified by another request",
      },
    });
    const listed = await accept(api().list({ headers }), [200]);
    const [after] = listed.body.connections;
    if (!after) {
      throw new Error("Expected the trust target");
    }
    expect(listed.body.connections).toStrictEqual([
      { ...created.body, generation: 2, updatedAt: after.updatedAt },
    ]);
    await accept(reset(), [409]);
    await expect(api().list({ headers })).resolves.toMatchObject({
      status: 200,
      body: listed.body,
    });
  },
);
