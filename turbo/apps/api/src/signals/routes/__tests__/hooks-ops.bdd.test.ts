import { randomUUID } from "node:crypto";

import { buildInfoContract } from "@okouai/api-contracts/contracts/build-info";
import { healthContract } from "@okouai/api-contracts/contracts/health";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import apiPackage from "../../../../package.json";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  testAuthProbeContract,
  testAuthProbeRoutes,
} from "./helpers/auth-probe";
import { createRouteMocks } from "./helpers/route-test";
import { buildInfoRoutes } from "../build-info";
import { healthRoutes } from "../health";
import { featureSwitchesRoutes } from "../feature-switches";

/*
helper gap: HOOK-01 signed callbacks still need API-visible builders for
run/chat/schedule/integration source state before they can avoid DB fixtures.
helper gap: HOOK-02 external provider webhooks still need visible source-state
builders for Stripe, Clerk, GitHub, storage, checkpoints, and generation runs.
*/

const context = testContext();
const api = createBddApi(context);
const routeMocks = createRouteMocks(context);

function healthClient() {
  return setupApp({ context, routes: healthRoutes })(healthContract);
}

function buildInfoClient() {
  return setupApp({ context, routes: buildInfoRoutes })(buildInfoContract);
}

function authProbeClient() {
  return setupApp({ context, routes: testAuthProbeRoutes })(
    testAuthProbeContract,
  );
}

function featureSwitchesClient() {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
}

function headersFor(actor: ApiTestUser | null): {
  readonly authorization?: string;
} {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer clerk-session" };
}

function expectRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object response body");
  }
}

describe("OPS-02: API health and auth boundary", () => {
  it("returns public build info with a configured commit SHA", async () => {
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    mockEnv("GIT_COMMIT_SHA", commitSha);

    const response = await accept(buildInfoClient().get(), [200]);

    expect(response.body).toStrictEqual({
      commitSha,
      version: apiPackage.version,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns null build info for local commit placeholders", async () => {
    mockEnv("GIT_COMMIT_SHA", "local-dev");

    const response = await accept(buildInfoClient().get(), [200]);

    expect(response.body).toStrictEqual({
      commitSha: null,
      version: apiPackage.version,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("checks public health and the auth boundary through HTTP routes", async () => {
    const admin = api.user();

    const health = await accept(healthClient().check(), [200]);
    expect(health.body).toStrictEqual({ status: "ok" });

    const unauthorized = await accept(
      authProbeClient().check({
        headers: headersFor(null),
        query: {},
      }),
      [401],
    );
    expectApiError(unauthorized.body);
    expect(unauthorized.body.error.code).toBe("UNAUTHORIZED");

    const authenticated = await accept(
      authProbeClient().check({
        headers: headersFor(admin),
        query: {},
      }),
      [200],
    );
    expectRecord(authenticated.body);
    expect(authenticated.body.userId).toBe(admin.userId);
    expect(authenticated.body.orgId).toBe(admin.orgId);
    expect(authenticated.body.tokenType).toBe("session");
  });
});

describe("OPS-01: feature switch routes", () => {
  it("updates, reads, merges, and deletes feature switch overrides through API", async () => {
    const admin = api.user();

    const initial = await accept(
      featureSwitchesClient().get({ headers: headersFor(admin) }),
      [200],
    );
    expect(initial.body.switches[FeatureSwitchKey.Dummy]).toBeUndefined();

    const enabled = await accept(
      featureSwitchesClient().update({
        headers: headersFor(admin),
        body: {
          switches: {
            [FeatureSwitchKey.Dummy]: false,
          },
        },
      }),
      [200],
    );
    expect(enabled.body.switches[FeatureSwitchKey.Dummy]).toBeFalsy();

    const merged = await accept(
      featureSwitchesClient().update({
        headers: headersFor(admin),
        body: {
          switches: {
            [FeatureSwitchKey.Dummy]: true,
          },
        },
      }),
      [200],
    );
    expect(merged.body.switches[FeatureSwitchKey.Dummy]).toBeTruthy();

    const read = await accept(
      featureSwitchesClient().get({ headers: headersFor(admin) }),
      [200],
    );
    expect(read.body.switches).toStrictEqual(merged.body.switches);

    const deleted = await accept(
      featureSwitchesClient().delete({ headers: headersFor(admin) }),
      [200],
    );
    expect(deleted.body).toStrictEqual({ deleted: true });

    const readAfterDelete = await accept(
      featureSwitchesClient().get({ headers: headersFor(admin) }),
      [200],
    );
    expect(
      readAfterDelete.body.switches[FeatureSwitchKey.Dummy],
    ).toBeUndefined();
  });

  it("stores org-scoped feature switch overrides separately from personal overrides", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = api.user({ orgId });
    const peer = api.user({ orgId });
    const outsider = api.user();

    const ownerUpdate = await accept(
      featureSwitchesClient().update({
        headers: headersFor(owner),
        body: {
          switches: {
            [FeatureSwitchKey.PiLoop]: true,
            [FeatureSwitchKey.Dummy]: false,
          },
        },
      }),
      [200],
    );
    expect(ownerUpdate.body.switches[FeatureSwitchKey.PiLoop]).toBeTruthy();
    expect(ownerUpdate.body.switches[FeatureSwitchKey.Dummy]).toBeFalsy();

    const peerRead = await accept(
      featureSwitchesClient().get({ headers: headersFor(peer) }),
      [200],
    );
    expect(peerRead.body.switches[FeatureSwitchKey.PiLoop]).toBeTruthy();
    expect(peerRead.body.switches[FeatureSwitchKey.Dummy]).toBeUndefined();

    const outsiderRead = await accept(
      featureSwitchesClient().get({ headers: headersFor(outsider) }),
      [200],
    );
    expect(outsiderRead.body.switches[FeatureSwitchKey.PiLoop]).toBeUndefined();
    const peerUpdate = await accept(
      featureSwitchesClient().update({
        headers: headersFor(peer),
        body: {
          switches: {
            [FeatureSwitchKey.PiLoop]: false,
          },
        },
      }),
      [200],
    );
    expect(peerUpdate.body.switches[FeatureSwitchKey.PiLoop]).toBeFalsy();
    expect(peerUpdate.body.switches[FeatureSwitchKey.Dummy]).toBeUndefined();

    const ownerReadAfterPeerUpdate = await accept(
      featureSwitchesClient().get({ headers: headersFor(owner) }),
      [200],
    );
    expect(
      ownerReadAfterPeerUpdate.body.switches[FeatureSwitchKey.PiLoop],
    ).toBeFalsy();
    expect(
      ownerReadAfterPeerUpdate.body.switches[FeatureSwitchKey.Dummy],
    ).toBeFalsy();

    const deleted = await accept(
      featureSwitchesClient().delete({ headers: headersFor(owner) }),
      [200],
    );
    expect(deleted.body).toStrictEqual({ deleted: true });

    const peerReadAfterDelete = await accept(
      featureSwitchesClient().get({ headers: headersFor(peer) }),
      [200],
    );
    expect(
      peerReadAfterDelete.body.switches[FeatureSwitchKey.PiLoop],
    ).toBeUndefined();
    expect(
      peerReadAfterDelete.body.switches[FeatureSwitchKey.Dummy],
    ).toBeUndefined();
  });
});
