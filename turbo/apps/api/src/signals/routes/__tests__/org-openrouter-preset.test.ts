import { randomUUID } from "node:crypto";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  ORG_OPENROUTER_PRESETS,
  orgOpenrouterPresetContract,
} from "@okouai/api-contracts/contracts/org-openrouter-preset";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { featureSwitchesRoutes } from "../feature-switches";
import { orgOpenrouterPresetRoutes } from "../org-openrouter-preset";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...orgOpenrouterPresetRoutes,
  ...featureSwitchesRoutes,
]);

function client() {
  return setupApp({ context, routes })(orgOpenrouterPresetContract);
}

function session(
  role: "org:admin" | "org:member" = "org:admin",
  orgId = `org_${randomUUID()}`,
) {
  mocks.clerk.session(`user_${randomUUID()}`, orgId, role);
  return orgId;
}

async function debug(enabled: boolean) {
  await accept(
    setupApp({ context, routes })(featureSwitchesContract).update({
      headers,
      body: { switches: { [FeatureSwitchKey.OkouDebug]: enabled } },
    }),
    [200],
  );
}

test("lets a Debug administrator persist each allowed preset for the organization", async () => {
  const orgId = session();
  await debug(true);
  const initial = await accept(client().get({ headers }), [200]);
  expect(initial.body.openrouterPreset).toBeNull();
  for (const openrouterPreset of ORG_OPENROUTER_PRESETS) {
    await accept(
      client().update({ headers, body: { openrouterPreset } }),
      [200],
    );
    const saved = await accept(client().get({ headers }), [200]);
    expect(saved.body.openrouterPreset).toBe(openrouterPreset);
  }
  session("org:admin", orgId);
  await debug(true);
  const peer = await accept(client().get({ headers }), [200]);
  expect(peer.body.openrouterPreset).toBe("@preset/memory");
  session();
  await debug(true);
  const elsewhere = await accept(client().get({ headers }), [200]);
  expect(elsewhere.body.openrouterPreset).toBeNull();
});

test.each([
  ["org:member", true],
  ["org:admin", false],
] as const)(
  "denies reads and writes for role %s with Debug %s",
  async (role, enabled) => {
    const orgId = session();
    await debug(true);
    await accept(
      client().update({
        headers,
        body: { openrouterPreset: "@preset/okou-1-0" },
      }),
      [200],
    );
    session(role, orgId);
    await debug(enabled);
    await accept(client().get({ headers }), [403]);
    await accept(
      client().update({
        headers,
        body: { openrouterPreset: "@preset/memory" },
      }),
      [403],
    );
    session("org:admin", orgId);
    await debug(true);
    const saved = await accept(client().get({ headers }), [200]);
    expect(saved.body.openrouterPreset).toBe("@preset/okou-1-0");
  },
);

test("rejects unlisted presets and caller-selected organizations without changing the saved value", async () => {
  session();
  await debug(true);
  await accept(
    client().update({
      headers,
      body: { openrouterPreset: "@preset/okou-1-0" },
    }),
    [200],
  );
  const request = setupRawAppRequest({ context, routes });
  for (const body of [
    { openrouterPreset: "@preset/not-allowed" },
    { openrouterPreset: "openai/gpt-5" },
    { openrouterPreset: null },
    {},
    { openrouterPreset: "@preset/memory", orgId: "org_another" },
  ]) {
    const response = await request("/api/org/openrouter-preset", {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  }
  const saved = await accept(client().get({ headers }), [200]);
  expect(saved.body.openrouterPreset).toBe("@preset/okou-1-0");
});

test("requires authentication for both reads and writes", async () => {
  const read = await accept(client().get(), [401]);
  const write = await accept(
    client().update({ body: { openrouterPreset: "@preset/memory" } }),
    [401],
  );
  expect([read.status, write.status]).toStrictEqual([401, 401]);
  mocks.clerk.session(`user_${randomUUID()}`, null);
  const withoutOrg = await accept(client().get({ headers }), [401]);
  const writeWithoutOrg = await accept(
    client().update({ headers, body: { openrouterPreset: "@preset/memory" } }),
    [401],
  );
  expect([withoutOrg.status, writeWithoutOrg.status]).toStrictEqual([401, 401]);
});
