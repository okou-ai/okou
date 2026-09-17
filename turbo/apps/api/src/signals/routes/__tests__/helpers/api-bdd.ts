import { mockClerkUsers } from "./clerk-users";
import { randomUUID } from "node:crypto";

import { authContract } from "@okouai/api-contracts/contracts/auth";
import {
  onboardingCompleteContract,
  onboardingStatusContract,
  type OnboardingStatusResponse,
} from "@okouai/api-contracts/contracts/onboarding";
import type { ApiErrorResponse } from "@okouai/api-contracts/contracts/errors";
import {
  agentsByIdContract,
  agentInstructionsContract,
  agentsMainContract,
  type AgentMetadataRequest,
  type AgentRequest,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import {
  userPreferencesContract,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { apiTestS3PresignedUrl } from "../../../../__tests__/mocks";
import { now } from "../../../../lib/time";
import { signSandboxJwtForTests } from "../../../auth/tokens";
import { authMeRoutes } from "../../auth-me";
import { agentsRoutes } from "../../agents";
import { agentInstructionsRoutes } from "../../agent-instructions";
import { onboardingCompleteRoutes } from "../../onboarding-complete";
import { onboardingStatusRoutes } from "../../onboarding-status";
import { orgReadRoutes } from "../../org-read";
import { userPreferencesRoutes } from "../../user-preferences";
import { createRouteMocks } from "./route-test";

type ClerkOrgRole = "org:admin" | "org:member";

interface AuthHeaders {
  readonly authorization?: string;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface ApiTestUser {
  readonly userId: string;
  readonly orgId: string | null;
  readonly orgRole: ClerkOrgRole | undefined;
  readonly email: string;
}

export interface ApiTestUserOptions {
  readonly userId?: string;
  readonly orgId?: string | null;
  readonly orgRole?: ClerkOrgRole;
  readonly email?: string;
}

export interface OnboardingBootstrapOptions {
  readonly displayName: string;
  readonly sound?: string;
  readonly avatarUrl?: string;
  readonly timezone?: string;
}

function authHeaders(user: ApiTestUser | null): AuthHeaders {
  return user ? { authorization: "Bearer clerk-session" } : {};
}

function okouAgentReadHeaders(user: ApiTestUser): AuthHeaders {
  if (!user.orgId) {
    throw new Error("Cannot bootstrap onboarding without an organization");
  }
  const seconds = Math.floor(now() / 1000);
  const token = signSandboxJwtForTests({
    scope: "okou",
    userId: user.userId,
    orgId: user.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: ["agent:read"],
    iat: seconds,
    exp: seconds + 60,
  });
  return { authorization: `Bearer ${token}` };
}

function clerkUserProfile(user: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${user.userId}`;
  return {
    id: user.userId,
    emailAddresses: [{ id: emailId, emailAddress: user.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "User",
  };
}

function createUser(options: ApiTestUserOptions = {}): ApiTestUser {
  const userId = options.userId ?? `user_${randomUUID()}`;
  return {
    userId,
    orgId: options.orgId === undefined ? `org_${randomUUID()}` : options.orgId,
    orgRole:
      options.orgRole ?? (options.orgId === null ? undefined : "org:admin"),
    email: options.email ?? `${userId}@example.test`,
  };
}

export function createBddApi(context: TestContext) {
  const mocks = createRouteMocks(context);

  function authClient() {
    return setupAppWithRoutes({ context, routes: authMeRoutes })(authContract);
  }

  function onboardingStatusClient() {
    return setupAppWithRoutes({
      context,
      routes: onboardingStatusRoutes,
    })(onboardingStatusContract);
  }

  function onboardingCompleteClient() {
    return setupAppWithRoutes({
      context,
      routes: onboardingCompleteRoutes,
    })(onboardingCompleteContract);
  }

  function orgClient() {
    return setupAppWithRoutes({
      context,
      routes: orgReadRoutes,
    })(orgContract);
  }

  function userPreferencesClient() {
    return setupAppWithRoutes({
      context,
      routes: userPreferencesRoutes,
    })(userPreferencesContract);
  }

  function agentsClient() {
    return setupAppWithRoutes({
      context,
      routes: agentsRoutes,
    })(agentsMainContract);
  }

  function agentsByIdClient() {
    return setupAppWithRoutes({
      context,
      routes: agentsRoutes,
    })(agentsByIdContract);
  }

  function agentInstructionsClient() {
    return setupAppWithRoutes({
      context,
      routes: agentInstructionsRoutes,
    })(agentInstructionsContract);
  }

  function user(options: ApiTestUserOptions = {}): ApiTestUser {
    return createUser(options);
  }

  function authenticate(nextUser: ApiTestUser | null): AuthHeaders {
    if (!nextUser) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }

    mocks.clerk.session(nextUser.userId, nextUser.orgId, nextUser.orgRole);
    mockClerkUsers(context, [clerkUserProfile(nextUser)]);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: nextUser.orgId
        ? [
            {
              role: nextUser.orgRole ?? "org:admin",
              organization: { id: nextUser.orgId },
              publicUserData: { userId: nextUser.userId },
            },
          ]
        : [],
    });
    return authHeaders(nextUser);
  }

  function acceptAgentStorageWrites(): void {
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    context.mocks.s3.getSignedUrl.mockImplementation(
      (_client: unknown, command: unknown) => {
        return Promise.resolve(apiTestS3PresignedUrl(command));
      },
    );
  }

  return {
    user,
    acceptAgentStorageWrites,

    async readMe(nextUser: ApiTestUser): Promise<{
      readonly userId: string;
      readonly email: string;
      readonly orgId: string | null;
    }> {
      const response = await accept(
        authClient().me({ headers: authenticate(nextUser) }),
        [200],
      );
      return response.body;
    },

    async requestReadMe(
      nextUser: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        authClient().me({ headers: authenticate(nextUser) }),
        statuses,
      );
    },

    async readOnboardingStatus(
      nextUser: ApiTestUser,
    ): Promise<OnboardingStatusResponse> {
      const response = await accept(
        onboardingStatusClient().getStatus({
          headers: authenticate(nextUser),
        }),
        [200],
      );
      return response.body;
    },

    async requestReadOnboardingStatus(
      nextUser: ApiTestUser | null,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        onboardingStatusClient().getStatus({
          headers: authenticate(nextUser),
        }),
        statuses,
      );
    },

    async completeOnboarding(
      nextUser: ApiTestUser,
      body: { readonly timezone?: string } = {},
    ) {
      return await accept(
        onboardingCompleteClient().complete({
          headers: authenticate(nextUser),
          body,
        }),
        [200, 403],
      );
    },

    async updateUserTimezone(
      nextUser: ApiTestUser,
      timezone: string,
    ): Promise<void> {
      await accept(
        userPreferencesClient().update({
          headers: authenticate(nextUser),
          body: { timezone },
        }),
        [200],
      );
    },

    async updateUserLocale(
      nextUser: ApiTestUser,
      locale: UserLocale,
    ): Promise<void> {
      await accept(
        userPreferencesClient().update({
          headers: authenticate(nextUser),
          body: { locale },
        }),
        [200],
      );
    },

    async bootstrapLimitedFreeOnboarding(
      nextUser: ApiTestUser,
      options: OnboardingBootstrapOptions,
    ): Promise<string> {
      const headers = authenticate(nextUser);
      await accept(
        agentsClient().list({ headers: okouAgentReadHeaders(nextUser) }),
        [200],
      );
      const statusResponse = await accept(
        onboardingStatusClient().getStatus({
          headers,
        }),
        [200],
      );
      const status = statusResponse.body;
      if (!status.defaultAgentId) {
        throw new Error("Expected onboarding bootstrap to create an agent");
      }

      await accept(
        agentsByIdClient().updateMetadata({
          params: { id: status.defaultAgentId },
          headers,
          body: options.sound === undefined ? {} : { sound: options.sound },
        }),
        [200],
      );

      if (options.timezone !== undefined) {
        await accept(
          userPreferencesClient().update({
            headers,
            body: { timezone: options.timezone },
          }),
          [200],
        );
      }

      const completed = await accept(
        onboardingCompleteClient().complete({
          headers,
          body: {},
        }),
        [200, 403],
      );
      if (completed.status !== 200) {
        throw new Error(
          `Expected onboarding completion to succeed, got ${completed.status}`,
        );
      }

      return status.defaultAgentId;
    },

    async requestReadOrg(
      nextUser: ApiTestUser | null,
      statuses: readonly (200 | 401 | 404)[],
    ) {
      return await accept(
        orgClient().get({ headers: authenticate(nextUser) }),
        statuses,
      );
    },

    async createAgent(
      nextUser: ApiTestUser,
      body: AgentRequest = {},
    ): Promise<AgentResponse> {
      const response = await accept(
        agentsClient().create({
          headers: authenticate(nextUser),
          body,
        }),
        [201],
      );
      return response.body;
    },

    async requestCreateAgent(
      nextUser: ApiTestUser | null,
      body: AgentRequest,
      statuses: readonly (201 | 400 | 401 | 403 | 409 | 422)[],
    ) {
      return await accept(
        agentsClient().create({
          headers: authenticate(nextUser),
          body,
        }),
        statuses,
      );
    },

    async listAgents(nextUser: ApiTestUser): Promise<readonly AgentResponse[]> {
      const response = await accept(
        agentsClient().list({ headers: authenticate(nextUser) }),
        [200],
      );
      return response.body;
    },

    async readAgent(
      nextUser: ApiTestUser,
      agentId: string,
    ): Promise<AgentResponse> {
      const response = await accept(
        agentsByIdClient().get({
          params: { id: agentId },
          headers: authenticate(nextUser),
        }),
        [200],
      );
      return response.body;
    },

    async requestReadAgent(
      nextUser: ApiTestUser | null,
      agentId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        agentsByIdClient().get({
          params: { id: agentId },
          headers: authenticate(nextUser),
        }),
        statuses,
      );
    },

    async updateAgentMetadata(
      nextUser: ApiTestUser,
      agentId: string,
      body: AgentMetadataRequest,
    ): Promise<AgentResponse> {
      const response = await accept(
        agentsByIdClient().updateMetadata({
          params: { id: agentId },
          headers: authenticate(nextUser),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async updateAgent(
      nextUser: ApiTestUser,
      agentId: string,
      body: AgentRequest,
    ): Promise<AgentResponse> {
      const response = await accept(
        agentsByIdClient().update({
          params: { id: agentId },
          headers: authenticate(nextUser),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async updateAgentInstructions(
      nextUser: ApiTestUser,
      agentId: string,
      content: string,
    ): Promise<AgentResponse> {
      const response = await accept(
        agentInstructionsClient().update({
          params: { id: agentId },
          headers: authenticate(nextUser),
          body: { content },
        }),
        [200],
      );
      return response.body;
    },

    async deleteAgent(nextUser: ApiTestUser, agentId: string): Promise<void> {
      await accept(
        agentsByIdClient().delete({
          params: { id: agentId },
          headers: authenticate(nextUser),
        }),
        [204],
      );
    },

    async requestDeleteAgent(
      nextUser: ApiTestUser | null,
      agentId: string,
      statuses: readonly (204 | 400 | 401 | 403 | 404 | 409)[],
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      return await accept(
        agentsByIdClient().delete({
          params: { id: agentId },
          headers: authenticate(nextUser),
        }),
        statuses,
      );
    },
  };
}

export function expectApiError(
  body: unknown,
): asserts body is ApiErrorResponse {
  if (
    typeof body !== "object" ||
    body === null ||
    !("error" in body) ||
    typeof body.error !== "object" ||
    body.error === null
  ) {
    throw new Error("Expected API error response body");
  }
}
