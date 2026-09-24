import type { TestContext } from "../../../../__tests__/test-context";
import { now } from "../../../../lib/time";
import type { ApiTestUser } from "./api-bdd";

interface SignupClerkUser {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string | null;
  readonly phoneNumbers: readonly {
    readonly id: string;
    readonly phoneNumber: string;
    readonly verification: { readonly status: string } | null;
  }[];
  readonly primaryPhoneNumberId: string | null;
  readonly firstName: null;
  readonly lastName: null;
  readonly username: null;
  readonly imageUrl: string;
  readonly banned: boolean;
  readonly locked: boolean;
  readonly externalId: string | null;
  readonly privateMetadata: Record<string, unknown>;
}

interface SignupClerkOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly imageUrl: string;
  readonly hasImage: boolean;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly privateMetadata: Record<string, unknown>;
}

interface SignupClerkMembership {
  readonly id: string;
  readonly createdAt: number;
  readonly role: "org:admin" | "org:member";
  readonly organization: SignupClerkOrganization;
  readonly publicUserData: { readonly userId: string };
}

class SignupClerkError extends Error {
  static readonly kind = "ClerkAPIResponseError";

  constructor(
    readonly status: number,
    readonly errors: readonly {
      readonly code: string;
      readonly message: string;
    }[],
  ) {
    super(errors[0]?.message ?? "Clerk request failed");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected Clerk request parameters");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string") {
    throw new Error(`Expected Clerk ${name}`);
  }
  return field;
}

function matchesFilter(filter: unknown, value: string | null): boolean {
  return (
    filter === undefined || (Array.isArray(filter) && filter.includes(value))
  );
}

function page<T>(data: readonly T[], params: Record<string, unknown>) {
  const offset = typeof params.offset === "number" ? params.offset : 0;
  const limit = typeof params.limit === "number" ? params.limit : data.length;
  return { data: data.slice(offset, offset + limit), totalCount: data.length };
}

/** A per-test Clerk directory at the real SDK boundary. */
export function createSignupClerkDirectory(
  context: TestContext,
  options: {
    readonly actor: ApiTestUser;
    readonly phone: string;
    readonly registered?: boolean;
    readonly hasPhone?: boolean;
    readonly verification?: "verified" | "unverified" | null;
    readonly banned?: boolean;
    readonly locked?: boolean;
    readonly memberships?: readonly {
      readonly orgId: string;
      readonly role: "org:admin" | "org:member";
      readonly createdBy?: string;
    }[];
  },
) {
  const { actor, phone } = options;
  if (!actor.orgId) {
    throw new Error("Expected a workspace identity for the Clerk fake");
  }
  const newOrgId = actor.orgId;
  const phoneId = `phone_${actor.userId}`;
  const newUser = (params: Record<string, unknown>): SignupClerkUser => {
    return {
      id: actor.userId,
      emailAddresses: [],
      primaryEmailAddressId: null,
      phoneNumbers:
        options.hasPhone === false
          ? []
          : [
              {
                id: phoneId,
                phoneNumber: phone,
                verification:
                  options.verification === null
                    ? null
                    : { status: options.verification ?? "verified" },
              },
            ],
      primaryPhoneNumberId: options.hasPhone === false ? null : phoneId,
      firstName: null,
      lastName: null,
      username: null,
      imageUrl: "https://clerk.example.test/phone-user.png",
      banned: options.banned ?? false,
      locked: options.locked ?? false,
      externalId:
        typeof params.externalId === "string" ? params.externalId : null,
      privateMetadata:
        params.privateMetadata === undefined
          ? {}
          : record(params.privateMetadata),
    };
  };
  let user = options.registered ? newUser({}) : undefined;
  const createdUserIds: string[] = [];
  const createdOrganizationIds: string[] = [];
  const organizations: SignupClerkOrganization[] = [];
  const memberships: SignupClerkMembership[] = [];
  for (const membership of options.memberships ?? []) {
    const organization: SignupClerkOrganization = {
      id: membership.orgId,
      name: "Existing workspace",
      slug: `existing-${membership.orgId}`,
      imageUrl: "",
      hasImage: false,
      createdAt: now(),
      createdBy: membership.createdBy ?? actor.userId,
      privateMetadata: {},
    };
    organizations.push(organization);
    memberships.push({
      id: `orgmem_${actor.userId}_${organization.id}`,
      createdAt: now(),
      organization,
      role: membership.role,
      publicUserData: { userId: actor.userId },
    });
  }

  function apply(): void {
    context.mocks.clerk.users.getUser.mockImplementation((id: unknown) => {
      if (!user || id !== user.id) {
        return Promise.reject(
          new SignupClerkError(404, [
            { code: "resource_not_found", message: "User not found" },
          ]),
        );
      }
      return Promise.resolve(user);
    });
    context.mocks.clerk.users.getUserList.mockImplementation(
      (input: unknown) => {
        const params = input === undefined ? {} : record(input);
        const data =
          user &&
          matchesFilter(params.userId, user.id) &&
          (params.phoneNumber === undefined ||
            user.phoneNumbers.some((number) => {
              return matchesFilter(params.phoneNumber, number.phoneNumber);
            })) &&
          matchesFilter(params.externalId, user.externalId)
            ? [user]
            : [];
        return Promise.resolve(page(data, params));
      },
    );
    context.mocks.clerk.users.createUser.mockImplementation(
      (input: unknown) => {
        const params = record(input);
        if (
          !Array.isArray(params.phoneNumber) ||
          params.phoneNumber[0] !== phone
        ) {
          throw new Error(
            "Expected signup to create the sender's phone account",
          );
        }
        if (user) {
          return Promise.reject(
            new SignupClerkError(422, [
              {
                code: "form_identifier_exists",
                message: "Phone already exists",
              },
            ]),
          );
        }
        user = newUser(params);
        createdUserIds.push(user.id);
        return Promise.resolve(user);
      },
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
      (input: unknown) => {
        const params = record(input);
        const data = params.userId === actor.userId ? memberships : [];
        return Promise.resolve(page(data, params));
      },
    );
    context.mocks.clerk.users.updateUserMetadata.mockImplementation(
      (id: unknown, input: unknown) => {
        if (!user || id !== user.id) {
          throw new Error("Expected an existing Clerk user");
        }
        const params = record(input);
        user = {
          ...user,
          privateMetadata: {
            ...user.privateMetadata,
            ...(params.privateMetadata === undefined
              ? {}
              : record(params.privateMetadata)),
          },
        };
        return Promise.resolve(user);
      },
    );
    context.mocks.clerk.organizations.createOrganization.mockImplementation(
      (input: unknown) => {
        const params = record(input);
        const slug = stringField(params, "slug");
        if (
          organizations.some((org) => {
            return org.slug === slug;
          })
        ) {
          return Promise.reject(
            new SignupClerkError(422, [
              {
                code: "form_identifier_exists",
                message: "Slug already exists",
              },
            ]),
          );
        }
        const organization: SignupClerkOrganization = {
          id: newOrgId,
          name: stringField(params, "name"),
          slug,
          imageUrl: "",
          hasImage: false,
          createdAt: now(),
          createdBy: stringField(params, "createdBy"),
          privateMetadata:
            params.privateMetadata === undefined
              ? {}
              : record(params.privateMetadata),
        };
        organizations.push(organization);
        createdOrganizationIds.push(organization.id);
        memberships.push({
          id: `orgmem_${actor.userId}_${organization.id}`,
          createdAt: now(),
          organization,
          role: "org:admin",
          publicUserData: { userId: actor.userId },
        });
        return Promise.resolve(organization);
      },
    );
    context.mocks.clerk.organizations.getOrganization.mockImplementation(
      (input: unknown) => {
        const params = record(input);
        const organization = organizations.find((org) => {
          return (
            org.id === params.organizationId ||
            org.slug === params.organizationId
          );
        });
        return organization
          ? Promise.resolve(organization)
          : Promise.reject(
              new SignupClerkError(404, [
                {
                  code: "resource_not_found",
                  message: "Organization not found",
                },
              ]),
            );
      },
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
      (input: unknown) => {
        const params = record(input);
        const data = memberships.filter((membership) => {
          return (
            membership.organization.id === params.organizationId &&
            matchesFilter(params.userId, membership.publicUserData.userId)
          );
        });
        return Promise.resolve(page(data, params));
      },
    );
  }

  apply();
  return {
    apply,
    createdUserIds: createdUserIds as readonly string[],
    createdOrganizationIds: createdOrganizationIds as readonly string[],
    removeUser(): void {
      user = undefined;
      memberships.length = 0;
    },
  };
}
