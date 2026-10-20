import { mockClerkUsers } from "./clerk-users";

import { authContract } from "@okouai/api-contracts/contracts/auth";
import { pushSubscriptionsContract } from "@okouai/api-contracts/contracts/push-subscriptions";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import {
  userModelPreferenceContract,
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
} from "@okouai/api-contracts/contracts/user-model-preference";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { authMeRoutes } from "../../auth-me";
import { agentsRoutes } from "../../agents";
import { pushSubscriptionsRoutes } from "../../push-subscriptions";
import { userModelPreferenceRoutes } from "../../user-model-preference";
import { userPreferencesRoutes } from "../../user-preferences";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";

type ClerkOrgRole = "org:admin" | "org:member";

interface AuthHeaders {
  readonly authorization?: string;
}

interface BearerCredential {
  readonly bearer: string;
}

/**
 * Session actor (Clerk mocks set on use) or a raw bearer token minted through
 * the CLI device flow (PAT) or a real Runner claim.
 */
type Credential = ApiTestUser | BearerCredential;

interface ProbeHeaders {
  readonly authorization?: string;
  readonly cookie?: string;
}

interface RegisterPushBody {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

const userConfigRoutes = [
  ...authMeRoutes,
  ...agentsRoutes,
  ...userModelPreferenceRoutes,
  ...pushSubscriptionsRoutes,
  ...userPreferencesRoutes,
] as const;

function isBearerCredential(
  credential: Credential,
): credential is BearerCredential {
  return "bearer" in credential;
}

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Cannot use a no-org actor here");
  }
  return actor.orgId;
}

export function createUserConfigBddApi(context: TestContext) {
  const routeMocks = createRouteMocks(context);

  function authenticate(credential: Credential | null): AuthHeaders {
    if (credential === null) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }
    if (isBearerCredential(credential)) {
      return { authorization: `Bearer ${credential.bearer}` };
    }
    routeMocks.clerk.session(
      credential.userId,
      credential.orgId,
      credential.orgRole,
    );
    return { authorization: "Bearer clerk-session" };
  }

  return {
    mockSession(actor: ApiTestUser | null): void {
      if (!actor) {
        context.mocks.clerk.authenticateRequest.mockResolvedValue({
          isAuthenticated: false,
        });
        return;
      }
      routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    },

    mockClerkUsers(actors: readonly ApiTestUser[]): void {
      mockClerkUsers(
        context,
        actors.map((actor) => {
          const emailId = `email_${actor.userId}`;
          return {
            id: actor.userId,
            emailAddresses: [{ id: emailId, emailAddress: actor.email }],
            primaryEmailAddressId: emailId,
            firstName: "BDD",
            lastName: "Actor",
          };
        }),
      );
    },

    mockMembership(actor: ApiTestUser, role: ClerkOrgRole | null): void {
      const orgId = requireOrgId(actor);
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: role === null ? [] : [{ role, organization: { id: orgId } }],
        },
      );
    },

    async requestMe(
      headers: ProbeHeaders,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      const client = setupAppWithRoutes({
        context,
        routes: userConfigRoutes,
      })(authContract);
      return await accept(client.me({ headers }), statuses);
    },

    async readMe(credential: Credential): Promise<{
      readonly userId: string;
      readonly email: string;
      readonly orgId: string | null;
    }> {
      const client = setupAppWithRoutes({ context, routes: userConfigRoutes })(
        authContract,
      );
      const response = await accept(
        client.me({ headers: authenticate(credential) }),
        [200],
      );
      return response.body;
    },

    async readUserConnectors(
      credential: Credential,
      agentId: string,
    ): Promise<{ readonly enabledConnectorSlugs: string[] }> {
      const client = setupAppWithRoutes({ context, routes: userConfigRoutes })(
        userBuiltinConnectorsContract,
      );
      const response = await accept(
        client.get({
          headers: authenticate(credential),
          params: { id: agentId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadUserConnectors(
      credential: Credential | null,
      agentId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: userConfigRoutes })(
        userBuiltinConnectorsContract,
      );
      return await accept(
        client.get({
          headers: authenticate(credential),
          params: { id: agentId },
        }),
        statuses,
      );
    },

    async updateUserBuiltinConnectors(
      credential: Credential,
      agentId: string,
      enabledConnectorSlugs: readonly string[],
      operation?: "replace" | "add" | "remove",
    ): Promise<{ readonly enabledConnectorSlugs: string[] }> {
      const client = setupAppWithRoutes({ context, routes: userConfigRoutes })(
        userBuiltinConnectorsContract,
      );
      const body =
        operation === undefined
          ? { enabledConnectorSlugs: [...enabledConnectorSlugs] }
          : { enabledConnectorSlugs: [...enabledConnectorSlugs], operation };
      const response = await accept(
        client.update({
          headers: authenticate(credential),
          params: { id: agentId },
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestUpdateUserConnectors(
      credential: Credential | null,
      agentId: string,
      enabledConnectorSlugs: readonly string[],
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
      operation?: "replace" | "add" | "remove",
    ) {
      const client = setupAppWithRoutes({ context, routes: userConfigRoutes })(
        userBuiltinConnectorsContract,
      );
      const body =
        operation === undefined
          ? { enabledConnectorSlugs: [...enabledConnectorSlugs] }
          : { enabledConnectorSlugs: [...enabledConnectorSlugs], operation };
      return await accept(
        client.update({
          headers: authenticate(credential),
          params: { id: agentId },
          body,
        }),
        statuses,
      );
    },

    async readModelPreference(
      actor: ApiTestUser,
    ): Promise<UserModelPreferenceResponse> {
      const client = setupAppWithRoutes({ context, routes: userConfigRoutes })(
        userModelPreferenceContract,
      );
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async requestReadModelPreference(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: userConfigRoutes })(
        userModelPreferenceContract,
      );
      return await accept(
        client.get({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async updateModelPreference(
      actor: ApiTestUser,
      body: UpdateUserModelPreferenceRequest,
    ): Promise<UserModelPreferenceResponse> {
      const client = setupAppWithRoutes({ context, routes: userConfigRoutes })(
        userModelPreferenceContract,
      );
      const response = await accept(
        client.update({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async requestUpdateModelPreference(
      actor: ApiTestUser | null,
      body: UpdateUserModelPreferenceRequest,
      statuses: readonly (200 | 400 | 401)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: userConfigRoutes })(
        userModelPreferenceContract,
      );
      return await accept(
        client.update({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestRegisterPush(
      credential: Credential | null,
      body: RegisterPushBody,
      statuses: readonly (201 | 400 | 401 | 403)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: userConfigRoutes })(
        pushSubscriptionsContract,
      );
      return await accept(
        client.register({ headers: authenticate(credential), body }),
        statuses,
      );
    },
  };
}
