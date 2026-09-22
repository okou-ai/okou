import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import {
  mapsContract,
  type MapsSearchRequest,
} from "@okouai/api-contracts/contracts/maps";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import type { RouteEntry } from "../../../route-entry";
import { billingStatusRoutes } from "../../billing-status";
import { mapsRoutes } from "../../maps";
import type { ApiTestUser } from "./api-bdd";
import { mockGoogleMapsGrounding } from "./google-maps-grounding";
import { createRouteMocks } from "./route-test";

type MapsStatus = 200 | 400 | 401 | 402 | 403 | 502 | 503;

interface AuthHeaders {
  readonly authorization?: string;
}

const mapsBillingRoutes: readonly RouteEntry[] = [
  ...billingStatusRoutes,
  ...mapsRoutes,
];

const CLERK_SESSION_AUTHORIZATION = "Bearer clerk-session";

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: CLERK_SESSION_AUTHORIZATION } : {};
}

function authenticate(context: TestContext, actor: ApiTestUser | null) {
  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return authHeaders(actor);
}

function mapsBillingApp(context: TestContext) {
  return setupAppWithRoutes({ context, routes: mapsBillingRoutes });
}

export function createMapsBillingApi(context: TestContext) {
  return {
    configureMapsProvider(): void {
      mockGoogleMapsGrounding();
    },

    async readBillingStatus(
      actor: ApiTestUser,
    ): Promise<BillingStatusResponse> {
      const client = mapsBillingApp(context)(billingStatusContract);
      const response = await accept(
        client.get({ headers: authenticate(context, actor) }),
        [200],
      );
      return response.body;
    },

    async requestMapsSearch(
      actor: ApiTestUser | null,
      body: MapsSearchRequest,
      statuses: readonly MapsStatus[],
    ) {
      const client = mapsBillingApp(context)(mapsContract);
      return await accept(
        client.search({ headers: authenticate(context, actor), body }),
        statuses,
      );
    },
  };
}
