import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { setupApp } from "../../../__tests__/test-helpers";
import { randomUUID } from "node:crypto";
import { createRouteMocks } from "./helpers/route-test";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { expect, test } from "vitest";

import { testContext, accept } from "../../../__tests__/test-context";
import { tailscaleRoutes } from "../tailscale";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function tailscale(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
}

function createBody(id: string, name: string, clientSecret: string) {
  return {
    id,
    name,
    credentials: { clientId: `client-${randomUUID()}`, clientSecret },
    tags: ["tag:okou"],
  };
}

test("tailscale-creation-001 arbitrates concurrent explicit-ID creation without overwriting the winner or leaking it to another member", async () => {
  const owner = bdd.user();
  const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
  const id = randomUUID();
  const names = [`Tailnet A ${id.slice(0, 8)}`, `Tailnet B ${id.slice(0, 8)}`];
  const ownerApi = tailscale(owner);
  const concurrent = await Promise.all(
    names.map((name) => {
      return accept(
        ownerApi.create({
          headers,
          body: createBody(id, name, `secret-${randomUUID()}`),
        }),
        [201, 204],
      );
    }),
  );
  expect(
    concurrent
      .map((response) => {
        return response.status;
      })
      .sort(),
  ).toStrictEqual([201, 204]);
  const created = concurrent.find((response) => {
    return response.status === 201;
  });
  if (created?.status !== 201) {
    throw new Error("Expected one winning creation");
  }
  const winner = created.body;
  expect(names).toContain(winner.name);

  const replaySecret = `secret-${randomUUID()}`;
  await accept(
    ownerApi.create({
      headers,
      body: createBody(id, `Renamed ${id.slice(0, 8)}`, replaySecret),
    }),
    [204],
  );
  await expect(
    accept(ownerApi.list({ headers }), [200]),
  ).resolves.toMatchObject({ body: { configs: [winner] } });

  const peerSecret = `secret-${randomUUID()}`;
  const peerName = `Peer ${id.slice(0, 8)}`;
  const peerApi = tailscale(peer);
  const conflict = await accept(
    peerApi.create({ headers, body: createBody(id, peerName, peerSecret) }),
    [409],
  );
  const disclosed = JSON.stringify(conflict.body);
  for (const hidden of [winner.name, peerName, peerSecret, replaySecret]) {
    expect(disclosed).not.toContain(hidden);
  }
  const peerList = await accept(peerApi.list({ headers }), [200]);
  expect(peerList.body.configs).toStrictEqual([]);

  const ownerAgain = tailscale(owner);
  const ownerList = await accept(ownerAgain.list({ headers }), [200]);
  expect(ownerList.body.configs).toStrictEqual([winner]);
  await accept(
    ownerAgain.delete({
      headers,
      params: { configId: id },
      body: { expectedRevision: winner.revision },
    }),
    [204],
  );
});
