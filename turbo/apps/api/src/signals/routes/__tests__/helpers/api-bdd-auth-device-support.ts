import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { connectorsBySlugContract } from "@okouai/api-contracts/contracts/connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
  personalModelProviderAccountsByIdContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { modelProvidersMainContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import type { RouteEntry } from "../../../route-entry";
import { connectorsRoutes } from "../../connectors";
import { featureSwitchesRoutes } from "../../feature-switches";
import { meModelProvidersDeleteRoutes } from "../../me-model-providers-delete";
import { meModelProviderAccountRoutes } from "../../me-model-provider-accounts";
import { meModelProvidersListRoutes } from "../../me-model-providers-list";
import { modelProvidersRoutes } from "../../model-providers";
import { userPreferencesRoutes } from "../../user-preferences";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";

interface AuthHeaders {
  readonly authorization?: string;
}

const authDeviceSupportRoutes: readonly RouteEntry[] = [
  ...connectorsRoutes,
  ...featureSwitchesRoutes,
  ...meModelProviderAccountRoutes,
  ...meModelProvidersDeleteRoutes,
  ...meModelProvidersListRoutes,
  ...modelProvidersRoutes,
  ...userPreferencesRoutes,
];

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function authenticate(
  context: TestContext,
  actor: ApiTestUser | null,
): AuthHeaders {
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

function authDeviceSupportApp(context: TestContext) {
  return setupAppWithRoutes({
    context,
    routes: authDeviceSupportRoutes,
  });
}

export function createAuthDeviceSupportApi(context: TestContext) {
  return {
    async readPreferences(actor: ApiTestUser) {
      return await accept(
        authDeviceSupportApp(context)(userPreferencesContract).get({
          headers: authenticate(context, actor),
        }),
        [200],
      );
    },

    async listModelProviders(actor: ApiTestUser) {
      return await accept(
        authDeviceSupportApp(context)(modelProvidersMainContract).list({
          headers: authenticate(context, actor),
        }),
        [200],
      );
    },

    async listPersonalModelProviders(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 404 | 500)[],
    ) {
      return await accept(
        authDeviceSupportApp(context)(personalModelProvidersMainContract).list({
          headers: authenticate(context, actor),
        }),
        statuses,
      );
    },

    async deletePersonalModelProvider(
      actor: ApiTestUser | null,
      type: "claude-code-oauth-token" | "codex-oauth-token",
      statuses: readonly (204 | 401 | 404 | 500)[],
    ) {
      return await accept(
        authDeviceSupportApp(context)(
          personalModelProvidersByTypeContract,
        ).delete({
          headers: authenticate(context, actor),
          params: { type },
        }),
        statuses,
      );
    },

    async activatePersonalModelProviderAccount(actor: ApiTestUser, id: string) {
      return await accept(
        authDeviceSupportApp(context)(
          personalModelProviderAccountsByIdContract,
        ).activate({
          headers: authenticate(context, actor),
          params: { id },
          body: {},
        }),
        [200],
      );
    },

    async resetPersonalModelProviderAccount(
      actor: ApiTestUser,
      id: string,
      idempotencyKey: string,
      statuses: readonly (200 | 400 | 401 | 404 | 500)[],
      runId?: string,
    ) {
      const client = authDeviceSupportApp(context)(
        personalModelProviderAccountsByIdContract,
      );
      const headers = authenticate(context, actor);
      return await accept(
        runId
          ? client.resetFailedRunSubscriptionUsage({
              headers,
              params: { id, runId },
              body: { idempotencyKey },
            })
          : client.resetSubscriptionUsage({
              headers,
              params: { id },
              body: { idempotencyKey },
            }),
        statuses,
      );
    },

    async readPersonalModelProviderAccount(
      actor: ApiTestUser,
      id: string,
      runId: string,
      statuses: readonly (200 | 401 | 404 | 500)[],
    ) {
      return await accept(
        authDeviceSupportApp(context)(
          personalModelProviderAccountsByIdContract,
        ).getById({
          headers: authenticate(context, actor),
          params: { id },
          query: { runId },
        }),
        statuses,
      );
    },

    async deletePersonalModelProviderAccount(
      actor: ApiTestUser,
      id: string,
    ): Promise<void> {
      await accept(
        authDeviceSupportApp(context)(
          personalModelProviderAccountsByIdContract,
        ).delete({
          headers: authenticate(context, actor),
          params: { id },
        }),
        [204],
      );
    },

    async updateFeatureSwitches(
      actor: ApiTestUser,
      switches: Readonly<Record<string, boolean>>,
    ): Promise<Readonly<Record<string, boolean>>> {
      const response = await accept(
        authDeviceSupportApp(context)(featureSwitchesContract).update({
          headers: authenticate(context, actor),
          body: { switches },
        }),
        [200],
      );
      return response.body.switches;
    },

    async readConnectorBySlug(
      actor: ApiTestUser,
      connectorSlug: ConnectorSlug,
    ): Promise<ConnectorResponse> {
      const response = await accept(
        authDeviceSupportApp(context)(connectorsBySlugContract).get({
          params: { connectorSlug },
          headers: authenticate(context, actor),
        }),
        [200],
      );
      return response.body;
    },
  };
}
