import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { modelProvidersMainContract } from "@okouai/api-contracts/contracts/model-provider-routes";

import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { modelProvidersRoutes } from "../model-providers";
import {
  createCodexExpiryFixture,
  credentials,
  expectExpiry,
  expiryResponse,
  upstream,
} from "./helpers/codex-reset-credit-expiry";

const context = testContext();
const fixture = createCodexExpiryFixture(context);

describe("Codex expiry cache capacity", () => {
  it("evicts old identity entries at bounded capacity", async () => {
    const remote = upstream();
    const first = await fixture();
    expectExpiry(await first.list(), remote.expiry);
    const cached = remote.detailsCalls;
    expectExpiry(await first.list(), remote.expiry);
    expect(remote.detailsCalls).toBe(cached);
    let firstDetails = 0;
    remote.details = (request) => {
      if (request.headers.get("chatgpt-account-id") === first.auth.accountId) {
        firstDetails += 1;
      }
      return expiryResponse(remote.expiry);
    };

    // The global bound includes in-flight entries. Hold real org connections
    // at their upstream usage response, before unrelated account persistence.
    const owners = Array.from({ length: 257 }, () => {
      return { orgId: `org_expiry_${randomUUID()}`, auth: credentials() };
    });
    const orgIds = new Set(
      owners.map((owner) => {
        return owner.orgId;
      }),
    );
    const accountIds = new Set<string>(
      owners.map((owner) => {
        return owner.auth.accountId;
      }),
    );
    const startedAccounts = new Set<string>();
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const pressure = new AbortController();
    const pressureSignal = AbortSignal.any([context.signal, pressure.signal]);
    server.use(
      http.get(
        "https://chatgpt.com/backend-api/wham/usage",
        async ({ request }) => {
          const accountId = request.headers.get("chatgpt-account-id");
          if (accountId && accountIds.has(accountId)) {
            startedAccounts.add(accountId);
            if (startedAccounts.size === owners.length) {
              started.resolve();
            }
            await release.promise;
          }
          return HttpResponse.json({
            rate_limit_reset_credits: { available_count: 1 },
          });
        },
      ),
    );
    context.mocks.clerk.authenticateRequest.mockImplementation((request) => {
      if (!(request instanceof Request)) {
        throw new Error("Expected a Clerk authentication request");
      }
      const orgId = request.headers.get("authorization")?.slice(7);
      if (!orgId || !orgIds.has(orgId)) {
        throw new Error("Expected a capacity-test owner token");
      }
      return Promise.resolve({
        isAuthenticated: true,
        toAuth: () => {
          return { userId: first.userId, orgId, orgRole: "org:admin" };
        },
      });
    });
    const providers = setupApp({
      context,
      routes: modelProvidersRoutes,
      signal: pressureSignal,
      rethrowErrors: true,
    })(modelProvidersMainContract);
    const outcomes = await Promise.allSettled([
      ...owners.map(async (owner) => {
        await expect(
          providers.upsert({
            headers: { authorization: `Bearer ${owner.orgId}` },
            body: {
              type: "codex-oauth-token",
              authMethod: "auth_json",
              secrets: { CODEX_AUTH_JSON: owner.auth.raw },
            },
          }),
        ).rejects.toThrow("capacity pressure complete");
      }),
      started.promise
        .then(async () => {
          // All requests have passed auth/body parsing and allocated their
          // expiry reader before reaching this external response boundary.
          remote.expiry = new Date(now() + 7_200_000).toISOString();
          expectExpiry(await first.list(), remote.expiry);
          expect(firstDetails).toBe(1);
        })
        .finally(() => {
          pressure.abort(
            new DOMException("capacity pressure complete", "AbortError"),
          );
          release.resolve();
        }),
    ]);
    // Own every request and the observer, including assertion/cancellation errors.
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    }
  });
});
