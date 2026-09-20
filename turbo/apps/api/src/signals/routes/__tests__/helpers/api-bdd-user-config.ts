import { mockClerkUsers } from "./clerk-users";
import { randomUUID } from "node:crypto";

import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { pushSubscriptionsContract } from "@okouai/api-contracts/contracts/push-subscriptions";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import {
  userModelPreferenceContract,
  type UpdateUserModelPreferenceRequest,
  type UserModelPreferenceResponse,
} from "@okouai/api-contracts/contracts/user-model-preference";
import {
  userPreferencesContract,
  type UpdateUserPreferencesRequest,
} from "@okouai/api-contracts/contracts/user-preferences";
import { z } from "zod";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { now } from "../../../../lib/time";
import {
  signPatJwtForTests,
  signSandboxJwtForTests,
} from "../../../auth/tokens";
import { authMeRoutes } from "../../auth-me";
import { agentsRoutes } from "../../agents";
import { pushSubscriptionsRoutes } from "../../push-subscriptions";
import { userModelPreferenceRoutes } from "../../user-model-preference";
import { userPreferencesRoutes } from "../../user-preferences";
import type { ApiTestUser } from "./api-bdd";
import { testAuthProbeContract, testAuthProbeRoutes } from "./auth-probe";
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
 * the CLI device flow (PAT) or the sandbox and Okou run-token test signers.
 */
type Credential = ApiTestUser | BearerCredential;

interface MintedBearer {
  readonly token: string;
  readonly runId: string;
}

interface ProbeHeaders {
  readonly authorization?: string;
  readonly cookie?: string;
}

interface ProbeQuery {
  readonly acceptAnySandboxCapability?: string;
}

interface RegisterPushBody {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

const c = initContract();

/**
 * Permissive mirror of the user-model-preference update route used to send
 * contract-invalid bodies through the app (the real contract types reject
 * them at compile time).
 *
 * The path is the one the real contract declares. This client runs against an
 * app built from `userConfigRoutes`, so it reaches the real handler instead of
 * registering a route of its own.
 */
const rawModelPreferenceContract = c.router({
  update: {
    method: "PUT" as const,
    path: "/api/user-model-preference",
    headers: z.object({ authorization: z.string().optional() }),
    body: z.unknown(),
    responses: {
      200: z.unknown(),
      400: z.object({
        error: z.object({ message: z.string(), code: z.string() }),
      }),
      401: z.object({
        error: z.object({ message: z.string(), code: z.string() }),
      }),
    },
  },
});

const userConfigRoutes = [
  ...testAuthProbeRoutes,
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

    sandboxBearer(actor: ApiTestUser): MintedBearer {
      const seconds = Math.floor(now() / 1000);
      const runId = `run_${randomUUID()}`;
      const token = signSandboxJwtForTests({
        scope: "sandbox",
        userId: actor.userId,
        orgId: requireOrgId(actor),
        runId,
        iat: seconds,
        exp: seconds + 3600,
      });
      return { token, runId };
    },

    okouBearer(
      actor: ApiTestUser,
      capabilities: readonly Capability[],
    ): MintedBearer {
      const seconds = Math.floor(now() / 1000);
      const runId = `run_${randomUUID()}`;
      const token = signSandboxJwtForTests({
        scope: "okou",
        userId: actor.userId,
        orgId: requireOrgId(actor),
        runId,
        capabilities: [...capabilities],
        iat: seconds,
        exp: seconds + 3600,
      });
      return { token, runId };
    },

    forgedPatBearer(userId: string): string {
      const seconds = Math.floor(now() / 1000);
      return signPatJwtForTests({
        scope: "cli",
        userId,
        orgId: `org_${randomUUID()}`,
        tokenId: randomUUID(),
        iat: seconds,
        exp: seconds + 3600,
      });
    },

    async probeAuth(
      headers: ProbeHeaders,
      query: ProbeQuery,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      const client = setupAppWithRoutes({
        context,
        routes: userConfigRoutes,
      })(testAuthProbeContract);
      return await accept(client.check({ headers, query }), statuses);
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

    async rawUpdateModelPreference(
      actor: ApiTestUser,
      body: unknown,
      statuses: readonly (200 | 400 | 401)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: userConfigRoutes })(
        rawModelPreferenceContract,
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

    async requestUpdatePreferences(
      actor: ApiTestUser | null,
      body: UpdateUserPreferencesRequest,
      statuses: readonly (200 | 400 | 401)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: userConfigRoutes })(
        userPreferencesContract,
      );
      return await accept(
        client.update({ headers: authenticate(actor), body }),
        statuses,
      );
    },
  };
}
