import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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

describe("Codex expiry cache capacity", () => {
  it("evicts old identity entries at bounded capacity", async () => {
    const remote = upstream();
    const first = await fixture();
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
    // Each API-created owner occupies a connect binding and a legacy binding.
    // More than 256 bindings must evict the oldest, without time manipulation.
    // Token-scoped Clerk responses let independent owners prepare concurrently
    // without racing the shared session mock or creating unrelated organizations.
    // Keep eight owners in flight without waiting for a whole batch's slowest
    // request before starting the next owner.
    const remainingOwners = userIds.values();
    const preparations = await Promise.allSettled(
      Array.from({ length: 8 }, async () => {
        for (const userId of remainingOwners) {
          const ownerHeaders = { authorization: `Bearer ${userId}` };
          await accept(
            providers.upsert({
              headers: ownerHeaders,
              body: {
                type: "codex-oauth-token",
                authMethod: "auth_json",
                secrets: { CODEX_AUTH_JSON: credentials().raw },
              },
            }),
            [200, 201],
          );
          const listed = await accept(
            providers.list({ headers: ownerHeaders }),
            [200],
          );
          expectExpiry(listed.body.modelProviders, remote.expiry);
        }
      }),
    );
    // Join every worker before restoring the first owner's session, including
    // when another owner's request or expiry assertion fails.
    for (const preparation of preparations) {
      if (preparation.status === "rejected") {
        throw preparation.reason;
      }
    }
    const before = remote.detailsCalls;
    remote.expiry = new Date(now() + 7_200_000).toISOString();
    expectExpiry(await first.list(), remote.expiry);
    expect(remote.detailsCalls).toBe(before + 1);
  });
});
