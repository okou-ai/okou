import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { featureSwitchesRoutes } from "../feature-switches";
import {
  createCodexExpiryFixture,
  credentials,
  expectExpiry,
  routes,
  upstream,
} from "./helpers/codex-reset-credit-expiry";

const context = testContext();
const fixture = createCodexExpiryFixture(context);

async function forEachOwner(
  userIds: readonly string[],
  visit: (headers: { authorization: string }) => Promise<void>,
): Promise<void> {
  // Keep eight requests in flight and join every worker before changing auth,
  // including when another owner's request or assertion fails.
  const remainingOwners = userIds.values();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, async () => {
      for (const userId of remainingOwners) {
        await visit({ authorization: `Bearer ${userId}` });
      }
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}

async function prepareCapacity() {
  const remote = upstream();
  const first = await fixture();
  // Warm the first identity before the other owners create any bindings, so
  // it remains the oldest entry when the test fills the cache by listing them.
  expectExpiry(await first.list(), remote.expiry);
  const userIds = Array.from({ length: 129 }, () => {
    return `user_expiry_${randomUUID()}`;
  });
  const owners = new Set(userIds);
  context.mocks.clerk.authenticateRequest.mockImplementation((request) => {
    if (!(request instanceof Request)) {
      throw new Error("Expected a Clerk authentication request");
    }
    const userId = request.headers.get("authorization")?.slice(7);
    if (!userId || !owners.has(userId)) {
      throw new Error("Expected a capacity-test owner token");
    }
    return Promise.resolve({
      isAuthenticated: true,
      toAuth: () => {
        return { userId, orgId: first.orgId, orgRole: "org:admin" };
      },
    });
  });
  const app = setupApp({
    context,
    routes: [...routes, ...featureSwitchesRoutes],
  });
  const providers = app(personalModelProvidersMainContract);
  const switches = app(featureSwitchesContract);
  // Fresh users in this non-staff organization already use legacy bindings.
  // Verify that public context once instead of writing the same disabled
  // override for all 129 independent owners.
  const defaults = await accept(
    switches.get({ headers: { authorization: `Bearer ${userIds[0]}` } }),
    [200],
  );
  expect(defaults.body.effectiveSwitches).toMatchObject({
    [FeatureSwitchKey.PersonalModelProviderAccounts]: false,
  });
  // Establish the real provider records before exercising the reads. These
  // 129 connect bindings plus the first owner's two bindings fit the cache.
  await forEachOwner(userIds, async (headers) => {
    await accept(
      providers.upsert({
        headers,
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: credentials().raw },
        },
      }),
      [200, 201],
    );
  });
  return { remote, first, userIds, providers };
}

describe("Codex expiry cache capacity", () => {
  let prepared: Awaited<ReturnType<typeof prepareCapacity>>;

  beforeEach(async () => {
    // Separate API fixture creation from cache-pressure reads so both phases
    // have their own default Vitest deadline.
    prepared = await prepareCapacity();
  });

  it("evicts old identity entries at bounded capacity", async () => {
    const { remote, first, userIds, providers } = prepared;
    // Each list adds its owner's read binding. Together with the prepared
    // connect bindings, the reads exceed 256 and evict the oldest identity.
    await forEachOwner(userIds, async (headers) => {
      const listed = await accept(providers.list({ headers }), [200]);
      expectExpiry(listed.body.modelProviders, remote.expiry);
    });
    const before = remote.detailsCalls;
    remote.expiry = new Date(now() + 7_200_000).toISOString();
    expectExpiry(await first.list(), remote.expiry);
    expect(remote.detailsCalls).toBe(before + 1);
  });
});
