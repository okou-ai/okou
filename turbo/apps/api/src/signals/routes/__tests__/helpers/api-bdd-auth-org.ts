import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import type {
  OrgResponse,
  UpdateOrgRequest,
} from "@okouai/api-contracts/contracts/orgs";
import type {
  InviteOrgMemberRequest,
  MembershipRequestAction,
  OrgMembersResponse,
  OrgMessageResponse,
  RemoveOrgMemberRequest,
  UpdateOrgMemberRoleRequest,
} from "@okouai/api-contracts/contracts/org-members";
import {
  onboardingCompleteContract,
  onboardingStatusContract,
  type OnboardingStatusResponse,
} from "@okouai/api-contracts/contracts/onboarding";
import { authContract } from "@okouai/api-contracts/contracts/auth";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrants,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  agentsByIdContract,
  agentsMainContract,
  type AgentMetadataRequest,
  type AgentRequest,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  customConnectorByIdContract,
  customConnectorValuesContract,
  customConnectorsContract,
  type CreateCustomConnectorBody,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  orgContract,
  orgDeleteContract,
  orgLeaveContract,
} from "@okouai/api-contracts/contracts/org-routes";
import { orgLogoContract } from "@okouai/api-contracts/contracts/org-logo";
import {
  orgInviteContract,
  orgMembersContract,
  orgMembershipRequestsContract,
} from "@okouai/api-contracts/contracts/org-member-routes";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import {
  userPreferencesContract,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { HttpResponse, http } from "msw";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { mockEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { authMeRoutes } from "../../auth-me";
import { cliAuthRoutes } from "../../cli-auth";
import { agentsRoutes } from "../../agents";
import { connectorAccountRoutes } from "../../connector-accounts";
import { customConnectorsRoutes } from "../../custom-connectors";
import { customConnectorsCreateRoutes } from "../../custom-connectors-create";
import { customConnectorsDeleteRoutes } from "../../custom-connectors-delete";
import { customConnectorsGetRoutes } from "../../custom-connectors-get";
import { customConnectorsValuesSetRoutes } from "../../custom-connectors-values-set";
import { onboardingCompleteRoutes } from "../../onboarding-complete";
import { onboardingStatusRoutes } from "../../onboarding-status";
import { orgDeleteRoutes } from "../../org-delete";
import { orgInviteRoutes } from "../../org-invite";
import { orgLogoRoutes } from "../../org-logo";
import { orgMembersRoutes } from "../../org-members";
import { orgMembershipRequestsRoutes } from "../../org-membership-requests";
import { orgReadRoutes } from "../../org-read";
import { userPreferencesRoutes } from "../../user-preferences";
import { createBddApi, type OnboardingBootstrapOptions } from "./api-bdd";
import { createRouteMocks } from "./route-test";

type ClerkOrgRole = "org:admin" | "org:member";
type ApiOrgRole = "admin" | "member";

interface AuthHeaders {
  readonly authorization?: string;
}

interface ClerkEmailAddress {
  readonly id: string;
  readonly emailAddress: string;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly ClerkEmailAddress[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly imageUrl: string;
}

export interface ApiTestUser {
  readonly userId: string;
  readonly orgId: string | null;
  readonly orgRole: ClerkOrgRole | undefined;
  readonly email: string;
}

interface ApiTestUserOptions {
  readonly userId?: string;
  readonly orgId?: string | null;
  readonly orgRole?: ClerkOrgRole;
  readonly email?: string;
}

interface BddOrgMember {
  readonly actor: ApiTestUser;
  readonly role?: ClerkOrgRole;
  readonly joinedAt?: number;
}

interface BddPendingInvitation {
  readonly id: string;
  readonly email: string;
  readonly role?: ClerkOrgRole;
  readonly createdAt?: number;
}

interface BddMembershipRequest {
  readonly id: string;
  readonly actor: ApiTestUser;
  readonly createdAt?: number;
}

interface BddOrgState {
  readonly slug?: string | null;
  readonly name?: string;
  readonly createdBy?: string;
  readonly createdAt?: number;
  readonly members?: readonly BddOrgMember[];
  readonly pendingInvitations?: readonly BddPendingInvitation[];
  readonly membershipRequests?: readonly BddMembershipRequest[];
}

interface BearerActor {
  readonly bearerToken: string;
}

type LogoUploadActor = ApiTestUser | BearerActor;

type ClerkLogoOperation = "get" | "upload";
type ClerkLogoErrorName =
  | "NotFoundError"
  | "BadRequestError"
  | "ForbiddenError";

interface ClerkLogoState {
  readonly imageUrl: string;
  readonly hasImage: boolean;
}

interface MembershipRequestHandlerOptions {
  readonly requests?: readonly BddMembershipRequest[];
  readonly listStatus?: 200 | 404 | 429;
  readonly retryAfterSeconds?: number;
  readonly acceptStatus?: 200 | 404;
  readonly rejectStatus?: 200 | 404;
}

interface MembershipRequestCallCounters {
  readonly listCalls: () => number;
  readonly acceptCalls: () => number;
  readonly rejectCalls: () => number;
}

interface RawJsonResponse {
  readonly status: number;
  readonly body: unknown;
}

const authOrgRoutes = [
  ...authMeRoutes,
  ...cliAuthRoutes,
  ...onboardingStatusRoutes,
  ...onboardingCompleteRoutes,
  ...userPreferencesRoutes,
  ...orgReadRoutes,
  ...orgDeleteRoutes,
  ...orgMembersRoutes,
  ...orgInviteRoutes,
  ...orgMembershipRequestsRoutes,
  ...orgLogoRoutes,
  ...agentsRoutes,
  ...connectorAccountRoutes,
  ...customConnectorsRoutes,
  ...customConnectorsCreateRoutes,
  ...customConnectorsGetRoutes,
  ...customConnectorsDeleteRoutes,
  ...customConnectorsValuesSetRoutes,
] as const;

function isBearerActor(actor: LogoUploadActor): actor is BearerActor {
  return "bearerToken" in actor;
}

function installClerkMembershipRequestHandlers(
  orgId: string,
  options: MembershipRequestHandlerOptions,
): MembershipRequestCallCounters {
  mockEnv("CLERK_SECRET_KEY", "clerk-test-secret");
  const requests = options.requests ?? [];
  const listStatus = options.listStatus ?? 200;
  const acceptStatus = options.acceptStatus ?? 200;
  const rejectStatus = options.rejectStatus ?? 200;
  let listCalls = 0;
  let acceptCalls = 0;
  let rejectCalls = 0;

  server.use(
    http.get(
      "https://api.clerk.com/v1/organizations/:orgId/membership_requests",
      ({ params }) => {
        if (params.orgId !== orgId) {
          return HttpResponse.json({ data: [] });
        }
        listCalls += 1;
        if (listStatus === 429) {
          return HttpResponse.json(
            { error: "Membership requests rate limited" },
            {
              status: 429,
              headers: {
                "Retry-After": String(options.retryAfterSeconds ?? 1),
              },
            },
          );
        }
        if (listStatus !== 200) {
          return HttpResponse.json(
            { error: "Membership requests unavailable" },
            { status: listStatus },
          );
        }
        return HttpResponse.json({
          data: requests.map((request) => {
            return {
              id: request.id,
              public_user_data: { user_id: request.actor.userId },
              created_at: requestDate(request),
            };
          }),
        });
      },
    ),
    http.post(
      "https://api.clerk.com/v1/organizations/:orgId/membership_requests/:requestId/accept",
      ({ params }) => {
        if (params.orgId !== orgId) {
          return HttpResponse.json({ ok: true });
        }
        acceptCalls += 1;
        if (acceptStatus !== 200) {
          return HttpResponse.json(
            { error: "Membership request not found" },
            { status: acceptStatus },
          );
        }
        return HttpResponse.json({ ok: true });
      },
    ),
    http.post(
      "https://api.clerk.com/v1/organizations/:orgId/membership_requests/:requestId/reject",
      ({ params }) => {
        if (params.orgId !== orgId) {
          return HttpResponse.json({ ok: true });
        }
        rejectCalls += 1;
        if (rejectStatus !== 200) {
          return HttpResponse.json(
            { error: "Membership request not found" },
            { status: rejectStatus },
          );
        }
        return HttpResponse.json({ ok: true });
      },
    ),
  );

  return {
    listCalls: () => {
      return listCalls;
    },
    acceptCalls: () => {
      return acceptCalls;
    },
    rejectCalls: () => {
      return rejectCalls;
    },
  };
}

function roleFromClerk(role: ClerkOrgRole | undefined): ApiOrgRole {
  return role === "org:admin" ? "admin" : "member";
}

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function bearerHeaders(token: string): AuthHeaders {
  return { authorization: `Bearer ${token}` };
}

function userFrom(options: ApiTestUserOptions = {}): ApiTestUser {
  const userId = options.userId ?? `user_${randomUUID()}`;
  return {
    userId,
    orgId: options.orgId === undefined ? `org_${randomUUID()}` : options.orgId,
    orgRole:
      options.orgRole ?? (options.orgId === null ? undefined : "org:admin"),
    email: options.email ?? `${userId}@example.test`,
  };
}

function clerkProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Actor",
    imageUrl: `https://example.test/${actor.userId}.png`,
  };
}

function recordValue(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  return Reflect.get(source, key);
}

function stringArrayValue(source: unknown, key: string): readonly string[] {
  const value = recordValue(source, key);
  return Array.isArray(value)
    ? value.filter((item): item is string => {
        return typeof item === "string";
      })
    : [];
}

function membershipDate(member: BddOrgMember): number {
  return member.joinedAt ?? Date.parse("2026-01-01T00:00:00.000Z");
}

function invitationDate(invitation: BddPendingInvitation): number {
  return invitation.createdAt ?? Date.parse("2026-01-02T00:00:00.000Z");
}

function requestDate(request: BddMembershipRequest): number {
  return request.createdAt ?? Date.parse("2026-01-03T00:00:00.000Z");
}

function defaultOrgMember(actor: ApiTestUser): BddOrgMember {
  return actor.orgRole ? { actor, role: actor.orgRole } : { actor };
}

export function createAuthOrgAgentsBddApi(context: TestContext) {
  const routeMocks = createRouteMocks(context);

  function testApp() {
    return createAppWithRoutes({
      signal: context.signal,
      routes: authOrgRoutes,
    });
  }

  function authenticate(actor: ApiTestUser | null): AuthHeaders {
    if (!actor) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return authHeaders(actor);
  }

  function mockClerkUsers(actors: readonly ApiTestUser[]): void {
    const profiles = new Map(
      actors.map((actor) => {
        return [actor.userId, clerkProfile(actor)] as const;
      }),
    );
    const profilesByEmail = new Map(
      actors.map((actor) => {
        return [actor.email, clerkProfile(actor)] as const;
      }),
    );

    context.mocks.clerk.users.getUserList.mockImplementation(
      (input: unknown) => {
        const ids = stringArrayValue(input, "userId");
        if (ids.length > 0) {
          return Promise.resolve({
            data: ids
              .map((id) => {
                return profiles.get(id);
              })
              .filter((profile): profile is ClerkUserProfile => {
                return Boolean(profile);
              }),
          });
        }

        const emails = stringArrayValue(input, "emailAddress");
        if (emails.length > 0) {
          return Promise.resolve({
            data: emails
              .map((email) => {
                return profilesByEmail.get(email);
              })
              .filter((profile): profile is ClerkUserProfile => {
                return Boolean(profile);
              }),
          });
        }

        return Promise.resolve({ data: [...profiles.values()] });
      },
    );
  }

  function clerkLogoMock(operation: ClerkLogoOperation) {
    if (operation === "get") {
      return context.mocks.clerk.organizations.getOrganization;
    }
    return context.mocks.clerk.organizations.updateOrganizationLogo;
  }

  async function rawJsonRequest(
    actor: ApiTestUser | null,
    path: string,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    body: Record<string, unknown>,
    statuses: readonly number[],
  ): Promise<RawJsonResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const auth = authenticate(actor);
    if (auth.authorization) {
      headers.authorization = auth.authorization;
    }
    const response = await testApp().request(path, {
      method,
      headers,
      body: JSON.stringify(body),
    });
    const responseBody: unknown = await response.json();
    if (!statuses.includes(response.status)) {
      throw new Error(
        `Expected raw ${method} ${path} status to be one of ${statuses.join(
          ", ",
        )}, received ${response.status}. Body: ${JSON.stringify(responseBody)}`,
      );
    }
    return { status: response.status, body: responseBody };
  }

  return {
    user: userFrom,

    authenticate,

    acceptAgentStorageWrites(): void {
      context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    },

    mockClerkUsers,

    mockClerkOrg(actor: ApiTestUser, state: BddOrgState = {}): void {
      if (!actor.orgId) {
        throw new Error("Cannot mock an organization for a no-org actor");
      }

      const slug =
        state.slug === undefined
          ? `bdd-${actor.orgId.slice(-8).toLowerCase()}`
          : state.slug;
      const name = state.name ?? "BDD Workspace";
      const createdBy = state.createdBy ?? actor.userId;
      const createdAt =
        state.createdAt ?? Date.parse("2026-01-01T00:00:00.000Z");
      const members = state.members ?? [defaultOrgMember(actor)];
      const pendingInvitations = state.pendingInvitations ?? [];
      const membershipRequests = state.membershipRequests ?? [];
      const orgActors = [
        actor,
        ...members.map((member) => {
          return member.actor;
        }),
        ...membershipRequests.map((request) => {
          return request.actor;
        }),
      ];

      mockClerkUsers(orgActors);
      installClerkMembershipRequestHandlers(actor.orgId, {
        requests: membershipRequests,
      });

      context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
        id: actor.orgId,
        slug,
        name,
        createdBy,
        createdAt,
      });
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        {
          data: members.map((member) => {
            return {
              role: member.role ?? member.actor.orgRole ?? "org:member",
              organization: { id: actor.orgId, slug, name },
            };
          }),
        },
      );
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        {
          data: members.map((member) => {
            return {
              role: member.role ?? member.actor.orgRole ?? "org:member",
              publicUserData: { userId: member.actor.userId },
              createdAt: membershipDate(member),
            };
          }),
        },
      );
      context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
        {
          data: pendingInvitations.map((invitation) => {
            return {
              id: invitation.id,
              emailAddress: invitation.email,
              role: invitation.role ?? "org:member",
              createdAt: invitationDate(invitation),
            };
          }),
        },
      );
      context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
        {},
      );
      context.mocks.clerk.organizations.revokeOrganizationInvitation.mockResolvedValue(
        {},
      );
      context.mocks.clerk.organizations.updateOrganization.mockResolvedValue({
        id: actor.orgId,
        slug,
        name,
        createdBy,
        createdAt,
      });
      context.mocks.clerk.organizations.updateOrganizationMembership.mockResolvedValue(
        {},
      );
      context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValue(
        {},
      );
      context.mocks.clerk.organizations.deleteOrganization.mockResolvedValue(
        {},
      );
    },

    mockClerkMembershipRequestHandlers(
      orgId: string,
      options: MembershipRequestHandlerOptions = {},
    ): MembershipRequestCallCounters {
      return installClerkMembershipRequestHandlers(orgId, options);
    },

    mockClerkOrgLogo(operation: ClerkLogoOperation, state: ClerkLogoState) {
      clerkLogoMock(operation).mockResolvedValue({
        imageUrl: state.imageUrl,
        hasImage: state.hasImage,
      });
    },

    mockClerkLogoError(
      operation: ClerkLogoOperation,
      name: ClerkLogoErrorName,
    ): void {
      const error = new Error(`Clerk organization logo ${operation} failed`);
      error.name = name;
      clerkLogoMock(operation).mockRejectedValue(error);
    },

    async requestReadOrgLogo(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgLogoContract,
      );
      return await accept(
        client.get({ headers: authenticate(actor) }),
        statuses,
      );
    },

    // Contract clients cannot send multipart bodies, so the logo upload goes
    // through the raw Hono app (requestRawSlackIngress precedent).
    async requestUploadOrgLogo(
      actor: LogoUploadActor | null,
      form: FormData,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ): Promise<RawJsonResponse> {
      const headers: Record<string, string> = {};
      if (actor && isBearerActor(actor)) {
        headers.authorization = `Bearer ${actor.bearerToken}`;
      } else {
        const auth = authenticate(actor);
        if (auth.authorization) {
          headers.authorization = auth.authorization;
        }
      }
      const response = await testApp().request("/api/org/logo", {
        method: "POST",
        headers,
        body: form,
      });
      const body: unknown = await response.json();
      if (!(statuses as readonly number[]).includes(response.status)) {
        throw new Error(
          `Expected POST /api/org/logo status to be one of ${statuses.join(
            ", ",
          )}, received ${response.status}. Body: ${JSON.stringify(body)}`,
        );
      }
      return { status: response.status, body };
    },

    async requestRawJson(
      actor: ApiTestUser | null,
      path: string,
      method: "POST" | "PATCH" | "PUT" | "DELETE",
      body: Record<string, unknown>,
      statuses: readonly number[],
    ): Promise<RawJsonResponse> {
      return await rawJsonRequest(actor, path, method, body, statuses);
    },

    async readMe(actor: ApiTestUser): Promise<{
      readonly userId: string;
      readonly email: string;
      readonly orgId: string | null;
    }> {
      mockClerkUsers([actor]);
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        authContract,
      );
      const response = await accept(
        client.me({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async requestReadMe(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404 | 500)[],
    ) {
      if (actor) {
        mockClerkUsers([actor]);
      }
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        authContract,
      );
      return await accept(
        client.me({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async requestReadMeWithBearer(
      token: string,
      profileActor: ApiTestUser,
      statuses: readonly (200 | 401 | 403 | 404 | 500)[],
    ) {
      mockClerkUsers([profileActor]);
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        authContract,
      );
      return await accept(
        client.me({ headers: bearerHeaders(token) }),
        statuses,
      );
    },

    async createCliToken(actor: ApiTestUser): Promise<{ token: string }> {
      const deviceClient = setupAppWithRoutes({
        context,
        routes: authOrgRoutes,
      })(cliAuthDeviceContract);
      const device = await accept(deviceClient.create({ body: {} }), [200]);

      const approvalClient = setupAppWithRoutes({
        context,
        routes: authOrgRoutes,
      })(cliAuthApproveContract);
      await accept(
        approvalClient.approve({
          headers: authenticate(actor),
          body: { device_code: device.body.device_code },
        }),
        [200],
      );

      const tokenClient = setupAppWithRoutes({
        context,
        routes: authOrgRoutes,
      })(cliAuthTokenContract);
      const token = await accept(
        tokenClient.exchange({
          body: { device_code: device.body.device_code },
        }),
        [200],
      );
      return { token: token.body.access_token };
    },

    async readOnboardingStatus(
      actor: ApiTestUser,
    ): Promise<OnboardingStatusResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        onboardingStatusContract,
      );
      const response = await accept(
        client.getStatus({
          headers: authenticate(actor),
        }),
        [200],
      );
      return response.body;
    },

    async bootstrapLimitedFreeOnboarding(
      actor: ApiTestUser,
      body: OnboardingBootstrapOptions,
    ) {
      const agentId = await createBddApi(
        context,
      ).bootstrapLimitedFreeOnboarding(actor, body);
      return { status: 200 as const, body: { agentId } };
    },

    async completeOnboarding(actor: ApiTestUser) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        onboardingCompleteContract,
      );
      return await accept(
        client.complete({
          headers: authenticate(actor),
          body: {},
        }),
        [200, 403],
      );
    },

    async readPreferences(
      actor: ApiTestUser,
    ): Promise<UserPreferencesResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        userPreferencesContract,
      );
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async updatePreferences(
      actor: ApiTestUser,
      body: UpdateUserPreferencesRequest,
    ): Promise<UserPreferencesResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        userPreferencesContract,
      );
      const response = await accept(
        client.update({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async readOrg(actor: ApiTestUser): Promise<OrgResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgContract,
      );
      const response = await accept(
        client.get({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async readCreatedOrganizationsCount(actor: ApiTestUser): Promise<number> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgContract,
      );
      const response = await accept(
        client.createdCount({ headers: authenticate(actor) }),
        [200],
      );
      return response.body.createdOrganizationsCount;
    },

    async requestReadOrg(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 404)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgContract,
      );
      return await accept(
        client.get({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async updateOrg(
      actor: ApiTestUser,
      body: UpdateOrgRequest,
    ): Promise<OrgResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgContract,
      );
      const response = await accept(
        client.update({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async requestUpdateOrg(
      actor: ApiTestUser | null,
      body: UpdateOrgRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgContract,
      );
      return await accept(
        client.update({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async listMembers(actor: ApiTestUser): Promise<OrgMembersResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgMembersContract,
      );
      const response = await accept(
        client.members({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async requestListMembers<S extends 200 | 400 | 401 | 403 | 404 | 500 | 503>(
      actor: ApiTestUser,
      statuses: readonly S[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgMembersContract,
      );
      return await accept(
        client.members({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async requestReadOrgWithBearer(
      token: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgContract,
      );
      return await accept(
        client.get({ headers: bearerHeaders(token) }),
        statuses,
      );
    },

    async requestUpdateOrgWithBearer(
      token: string,
      body: UpdateOrgRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgContract,
      );
      return await accept(
        client.update({ headers: bearerHeaders(token), body }),
        statuses,
      );
    },

    async requestListMembersWithBearer<
      S extends 200 | 400 | 401 | 403 | 404 | 500 | 503,
    >(token: string, statuses: readonly S[]) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgMembersContract,
      );
      return await accept(
        client.members({ headers: bearerHeaders(token) }),
        statuses,
      );
    },

    async inviteMember(
      actor: ApiTestUser,
      body: InviteOrgMemberRequest,
    ): Promise<OrgMessageResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgInviteContract,
      );
      const response = await accept(
        client.invite({
          headers: authenticate(actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestInviteMember(
      actor: ApiTestUser | null,
      body: InviteOrgMemberRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgInviteContract,
      );
      return await accept(
        client.invite({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async revokeInvitation(
      actor: ApiTestUser,
      invitationId: string,
    ): Promise<OrgMessageResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgInviteContract,
      );
      const response = await accept(
        client.revoke({
          headers: authenticate(actor),
          body: { invitationId },
        }),
        [200],
      );
      return response.body;
    },

    async requestRevokeInvitation(
      actor: ApiTestUser | null,
      invitationId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgInviteContract,
      );
      return await accept(
        client.revoke({
          headers: authenticate(actor),
          body: { invitationId },
        }),
        statuses,
      );
    },

    async updateMemberRole(
      actor: ApiTestUser,
      body: UpdateOrgMemberRoleRequest,
    ): Promise<OrgMessageResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgMembersContract,
      );
      const response = await accept(
        client.updateRole({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async requestUpdateMemberRole(
      actor: ApiTestUser | null,
      body: UpdateOrgMemberRoleRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgMembersContract,
      );
      return await accept(
        client.updateRole({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async removeMember(
      actor: ApiTestUser,
      body: RemoveOrgMemberRequest,
    ): Promise<OrgMessageResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgMembersContract,
      );
      const response = await accept(
        client.removeMember({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async requestRemoveMember(
      actor: ApiTestUser | null,
      body: RemoveOrgMemberRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgMembersContract,
      );
      return await accept(
        client.removeMember({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async acceptMembershipRequest(
      actor: ApiTestUser,
      body: MembershipRequestAction,
    ): Promise<OrgMessageResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgMembershipRequestsContract,
      );
      const response = await accept(
        client.accept({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async rejectMembershipRequest(
      actor: ApiTestUser,
      body: MembershipRequestAction,
    ): Promise<OrgMessageResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgMembershipRequestsContract,
      );
      const response = await accept(
        client.reject({ headers: authenticate(actor), body }),
        [200],
      );
      return response.body;
    },

    async requestAcceptMembershipRequest(
      actor: ApiTestUser | null,
      body: MembershipRequestAction,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgMembershipRequestsContract,
      );
      return await accept(
        client.accept({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async requestRejectMembershipRequest(
      actor: ApiTestUser | null,
      body: MembershipRequestAction,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgMembershipRequestsContract,
      );
      return await accept(
        client.reject({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async leaveOrg(actor: ApiTestUser): Promise<OrgMessageResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgLeaveContract,
      );
      const response = await accept(
        client.leave({ headers: authenticate(actor), body: {} }),
        [200],
      );
      return response.body;
    },

    async requestLeaveOrg(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgLeaveContract,
      );
      return await accept(
        client.leave({ headers: authenticate(actor), body: {} }),
        statuses,
      );
    },

    async deleteOrg(actor: ApiTestUser): Promise<OrgMessageResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgDeleteContract,
      );
      const response = await accept(
        client.delete({
          headers: authenticate(actor),
          body: { confirm: "confirm" },
        }),
        [200],
      );
      return response.body;
    },

    async requestDeleteOrg(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        orgDeleteContract,
      );
      return await accept(
        client.delete({
          headers: authenticate(actor),
          body: { confirm: "confirm" },
        }),
        statuses,
      );
    },

    async requestDeleteOrgWithBearer(
      bearer: string,
      statuses: readonly number[],
    ): Promise<RawJsonResponse> {
      const response = await testApp().request("/api/org/delete", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ confirm: "confirm" }),
      });
      const responseBody: unknown = await response.json();
      if (!statuses.includes(response.status)) {
        throw new Error(
          `Expected POST /api/org/delete status to be one of ${statuses.join(
            ", ",
          )}, received ${response.status}. Body: ${JSON.stringify(
            responseBody,
          )}`,
        );
      }
      return { status: response.status, body: responseBody };
    },

    async readEnabledConnectorSlugs(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<readonly string[]> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        userConnectorsContract,
      );
      const response = await accept(
        client.get({
          headers: authenticate(actor),
          params: { id: agentId },
        }),
        [200],
      );
      return response.body.enabledConnectorSlugs;
    },

    async createAgent(
      actor: ApiTestUser,
      body: AgentRequest = {},
    ): Promise<AgentResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentsMainContract,
      );
      const response = await accept(
        client.create({
          headers: authenticate(actor),
          body,
        }),
        [201],
      );
      return response.body;
    },

    async requestCreateAgent(
      actor: ApiTestUser | null,
      body: AgentRequest,
      statuses: readonly (201 | 400 | 401 | 403 | 409 | 422)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentsMainContract,
      );
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async listAgents(actor: ApiTestUser): Promise<readonly AgentResponse[]> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentsMainContract,
      );
      const response = await accept(
        client.list({
          headers: authenticate(actor),
        }),
        [200],
      );
      return response.body;
    },

    async requestListAgents(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentsMainContract,
      );
      return await accept(
        client.list({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async readAgent(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<AgentResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentsByIdContract,
      );
      const response = await accept(
        client.get({
          params: { id: agentId },
          headers: authenticate(actor),
        }),
        [200],
      );
      return response.body;
    },

    async requestReadAgent(
      actor: ApiTestUser | null,
      agentId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentsByIdContract,
      );
      return await accept(
        client.get({ params: { id: agentId }, headers: authenticate(actor) }),
        statuses,
      );
    },

    async updateAgentMetadata(
      actor: ApiTestUser,
      agentId: string,
      body: AgentMetadataRequest,
    ): Promise<AgentResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentsByIdContract,
      );
      const response = await accept(
        client.updateMetadata({
          params: { id: agentId },
          headers: authenticate(actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async updateAgent(
      actor: ApiTestUser,
      agentId: string,
      body: AgentRequest,
    ): Promise<AgentResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentsByIdContract,
      );
      const response = await accept(
        client.update({
          params: { id: agentId },
          headers: authenticate(actor),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async requestUpdateAgent(
      actor: ApiTestUser | null,
      agentId: string,
      body: AgentRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentsByIdContract,
      );
      return await accept(
        client.update({
          params: { id: agentId },
          headers: authenticate(actor),
          body,
        }),
        statuses,
      );
    },

    async requestUpdateAgentMetadata(
      actor: ApiTestUser | null,
      agentId: string,
      body: AgentMetadataRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentsByIdContract,
      );
      return await accept(
        client.updateMetadata({
          params: { id: agentId },
          headers: authenticate(actor),
          body,
        }),
        statuses,
      );
    },

    async deleteAgent(actor: ApiTestUser, agentId: string): Promise<void> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentsByIdContract,
      );
      await accept(
        client.delete({
          params: { id: agentId },
          headers: authenticate(actor),
        }),
        [204],
      );
    },

    async requestDeleteAgent(
      actor: ApiTestUser | null,
      agentId: string,
      statuses: readonly (204 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentsByIdContract,
      );
      return await accept(
        client.delete({
          params: { id: agentId },
          headers: authenticate(actor),
        }),
        statuses,
      );
    },

    async createCustomConnector(
      actor: ApiTestUser,
      body: CreateCustomConnectorBody,
    ): Promise<CustomConnectorResponse> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        customConnectorsContract,
      );
      const response = await accept(
        client.create({ headers: authenticate(actor), body }),
        [201],
      );
      return response.body;
    },

    async requestCreateCustomConnector(
      actor: ApiTestUser | null,
      body: CreateCustomConnectorBody,
      statuses: readonly (201 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        customConnectorsContract,
      );
      return await accept(
        client.create({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async listCustomConnectors(actor: ApiTestUser): Promise<{
      readonly connectors: readonly CustomConnectorResponse[];
    }> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        customConnectorsContract,
      );
      const response = await accept(
        client.list({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async setCustomConnectorSecret(
      actor: ApiTestUser,
      connectorId: string,
      value: string,
    ): Promise<void> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        customConnectorValuesContract,
      );
      await accept(
        client.set({
          headers: authenticate(actor),
          params: { id: connectorId },
          body: {
            values: [{ key: "secret", kind: "secret", value }],
            account: { intent: "add" },
          },
        }),
        [200],
      );
    },

    async deleteDefaultCustomConnectorAccount(
      actor: ApiTestUser,
      connectorId: string,
    ): Promise<void> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        connectorAccountsContract,
      );
      const accounts = await accept(
        client.connections({
          headers: authenticate(actor),
          query: { kind: "custom", customConnectorId: connectorId },
        }),
        [200],
      );
      const account = accounts.body.connections.find((candidate) => {
        return candidate.isDefault;
      });
      if (!account) {
        return;
      }
      await accept(
        client.delete({
          params: { connectionId: account.id },
          headers: authenticate(actor),
          body: {
            target: { kind: "custom", customConnectorId: connectorId },
          },
        }),
        [200],
      );
    },

    async deleteCustomConnector(
      actor: ApiTestUser,
      connectorId: string,
    ): Promise<void> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        customConnectorByIdContract,
      );
      await accept(
        client.delete({
          headers: authenticate(actor),
          params: { id: connectorId },
        }),
        [204],
      );
    },

    async readAgentCustomConnectors(
      actor: ApiTestUser,
      agentId: string,
    ): Promise<AgentCustomConnectorGrants> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentCustomConnectorsContract,
      );
      const response = await accept(
        client.get({
          headers: authenticate(actor),
          params: { id: agentId },
        }),
        [200],
      );
      return response.body;
    },

    async updateAgentCustomConnectors(
      actor: ApiTestUser,
      agentId: string,
      connectorIds: readonly string[],
    ): Promise<AgentCustomConnectorGrants> {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentCustomConnectorsContract,
      );
      const response = await accept(
        client.update({
          headers: authenticate(actor),
          params: { id: agentId },
          body: {
            grants: connectorIds.map((customConnectorId) => {
              return { customConnectorId, permissionNames: [] };
            }),
          },
        }),
        [200],
      );
      return response.body;
    },

    async requestUpdateAgentCustomConnectors(
      actor: ApiTestUser | null,
      agentId: string,
      connectorIds: readonly string[],
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupAppWithRoutes({ context, routes: authOrgRoutes })(
        agentCustomConnectorsContract,
      );
      return await accept(
        client.update({
          headers: authenticate(actor),
          params: { id: agentId },
          body: {
            grants: connectorIds.map((customConnectorId) => {
              return { customConnectorId, permissionNames: [] };
            }),
          },
        }),
        statuses,
      );
    },

    roleFromClerk,
  };
}
