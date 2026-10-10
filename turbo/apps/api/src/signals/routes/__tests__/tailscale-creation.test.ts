import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { joinAll } from "../../utils";
import { tailscaleRoutes } from "../tailscale";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const api = () => {
  return setupApp({ context, routes: tailscaleRoutes })(tailscaleContract);
};

test("arbitrates concurrent explicit-ID creation without overwriting the winner or granting foreign reconciliation", async () => {
  const orgId = `org_tailscale_create_${randomUUID()}`;
  const userId = `user_tailscale_create_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  const body = {
    id: randomUUID(),
    name: "First network",
    credentials: {
      clientId: "creation-client-canary",
      clientSecret: "creation-secret-canary",
    },
    tags: ["tag:okou"],
  };
  const outcomes = await joinAll(
    [body, { ...body, name: "Competing network" }].map(async (input) => {
      return await accept(api().create({ headers, body: input }), [201, 204]);
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
    throw new Error(
      "Concurrent creation must return exactly one created configuration",
    );
  }
  expect(
    (await accept(api().list({ headers }), [200])).body.configs,
  ).toStrictEqual([winner.body]);
  await accept(
    api().create({
      headers,
      body: {
        ...body,
        name: "Replay must not rename",
        credentials: {
          ...body.credentials,
          clientSecret: "replay-secret-canary",
        },
      },
    }),
    [204],
  );
  expect(
    (await accept(api().list({ headers }), [200])).body.configs,
  ).toStrictEqual([winner.body]);

  mocks.clerk.session(`user_foreign_${randomUUID()}`, orgId);
  const refused = await accept(api().create({ headers, body }), [409]);
  expect(JSON.stringify(refused.body)).not.toMatch(
    /creation-secret-canary|creation-client-canary|First network|Competing network/u,
  );
  expect(
    (await accept(api().list({ headers }), [200])).body.configs,
  ).toStrictEqual([]);

  mocks.clerk.session(userId, orgId);
  expect(
    (await accept(api().list({ headers }), [200])).body.configs,
  ).toStrictEqual([winner.body]);
  await accept(
    api().delete({
      headers,
      params: { configId: body.id },
      body: { expectedRevision: 1 },
    }),
    [204],
  );
});
