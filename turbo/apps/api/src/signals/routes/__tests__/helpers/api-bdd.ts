import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { instructionsRoutes } from "../../instructions";
import { mockClerkUsers } from "./clerk-users";
import { randomUUID } from "node:crypto";

import { authContract } from "@okouai/api-contracts/contracts/auth";
import {
  onboardingCompleteContract,
  onboardingStatusContract,
} from "@okouai/api-contracts/contracts/onboarding";
import type { ApiErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import {
  userPreferencesContract,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { apiTestS3PresignedUrl } from "../../../../__tests__/mocks";
import { authMeRoutes } from "../../auth-me";
import { onboardingCompleteRoutes } from "../../onboarding-complete";
import { onboardingStatusRoutes } from "../../onboarding-status";
import { orgReadRoutes } from "../../org-read";
import { userPreferencesRoutes } from "../../user-preferences";
import { deliverOrganizationCreated } from "./api-bdd-webhooks";
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
  readonly timezone?: string;
}

function authHeaders(user: ApiTestUser | null): AuthHeaders {
  return user ? { authorization: "Bearer clerk-session" } : {};
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

  async function provisionWorkspace(creator: ApiTestUser) {
    authenticate(creator);
    await deliverOrganizationCreated(context, creator);
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

  function acceptStorageWrites(): void {
    const objects = new Map<string, Buffer>();
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const name =
        typeof command === "object" && command !== null
          ? command.constructor.name
          : "";
      const input =
        typeof command === "object" &&
        command !== null &&
        "input" in command &&
        typeof command.input === "object" &&
        command.input !== null
          ? (command.input as { Key?: unknown; Body?: unknown })
          : undefined;
      const key = typeof input?.Key === "string" ? input.Key : undefined;
      if (name === "PutObjectCommand" && key) {
        const body = input?.Body;
        objects.set(
          key,
          typeof body === "string"
            ? Buffer.from(body)
            : body instanceof Uint8Array
              ? Buffer.from(body)
              : Buffer.alloc(0),
        );
      }
      if (name === "GetObjectCommand" && key) {
        const stored = objects.get(key);
        if (stored !== undefined) {
          return Promise.resolve({
            ContentLength: stored.length,
            ETag: '"fixture-etag"',
            Body: {
              async *[Symbol.asyncIterator]() {
                yield stored;
              },
            },
          });
        }
        return Promise.reject(
          Object.assign(new Error(`NoSuchKey: ${key}`), { name: "NoSuchKey" }),
        );
      }
      return Promise.resolve({
        ContentLength: 1024,
        UploadId: randomUUID(),
        ETag: "fixture-etag",
      });
    });
    context.mocks.s3.getSignedUrl.mockImplementation(
      (_client: unknown, command: unknown) => {
        return Promise.resolve(apiTestS3PresignedUrl(command));
      },
    );
  }

  return {
    user,
    acceptStorageWrites,

    async readMe(nextUser: ApiTestUser): Promise<{
      readonly userId: string;
      readonly email: string;
      readonly orgId: string | null;
    }> {
      const client = authClient();
      const response = await accept(
        client.me({ headers: authenticate(nextUser) }),
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
    provisionWorkspace,

    async readOnboardingStatus(nextUser: ApiTestUser) {
      const response = await accept(
        onboardingStatusClient().getStatus({
          headers: authenticate(nextUser),
        }),
        [200],
      );
      return response.body;
    },

    async completeOnboarding(
      nextUser: ApiTestUser,
      body: { readonly timezone?: string } = {},
    ) {
      const client = onboardingCompleteClient();
      return await accept(
        client.complete({
          headers: authenticate(nextUser),
          body,
        }),
        [200],
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
      options: OnboardingBootstrapOptions = {},
    ) {
      await provisionWorkspace(nextUser);
      const headers = authenticate(nextUser);

      if (options.timezone !== undefined) {
        await accept(
          userPreferencesClient().update({
            headers,
            body: { timezone: options.timezone },
          }),
          [200],
        );
      }

      return await accept(
        onboardingCompleteClient().complete({
          headers,
          body: {},
        }),
        [200],
      );
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

    async updatePersonalInstructions(
      nextUser: ApiTestUser,
      content: string,
    ): Promise<void> {
      const client = setupAppWithRoutes({
        context,
        routes: instructionsRoutes,
      })(instructionsContract);
      await accept(
        client.update({ headers: authenticate(nextUser), body: { content } }),
        [200],
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
