import { createHash } from "node:crypto";

import { command } from "ccstate";
import { z } from "zod";
import {
  clerk$,
  createClerkReadContext,
  isClerkCreationConflict,
  isClerkResourceNotFound,
  isClerkWriteAmbiguous,
  type ClerkClient,
  type ClerkOrganization,
  type ClerkOrganizationMembership,
  type ClerkReadContext,
  type ClerkUser,
} from "../external/clerk";
import { listAllUserOrganizationMemberships } from "../external/clerk-organization-lists";
import { settle } from "../utils";

const SIGNUP_SOURCE = "agentphone-imessage";
const USER_LIST_PAGE_SIZE = 100;

const signupWorkspacePreference = z.object({
  source: z.literal(SIGNUP_SOURCE),
  workspaceId: z.string().min(1),
});
const signupWorkspaceOwner = z.object({
  source: z.literal(SIGNUP_SOURCE),
  ownerUserId: z.string().min(1),
});

interface SignupIdentityArgs {
  readonly phoneHandle: string;
  readonly resolvedUserId?: string;
  readonly onUserResolved: (
    userId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly linkedUser: {
    readonly userId: string;
    readonly orgId: string;
  } | null;
}

type SignupIdentityResult =
  | {
      readonly kind: "ready";
      readonly userId: string;
      readonly orgId: string;
      readonly role: "admin" | "member";
      readonly initializeWorkspace: boolean;
    }
  | { readonly kind: "connect-required" }
  | { readonly kind: "unavailable" };

async function optionalClerkResource<T>(
  read: Promise<T>,
  signal: AbortSignal,
): Promise<T | null> {
  const result = await settle(read, signal);
  if (result.ok) {
    return result.value;
  }
  if (!isClerkResourceNotFound(result.error)) {
    throw result.error;
  }
  return null;
}

function hasExactPhone(user: ClerkUser, phoneHandle: string): boolean {
  return (
    user.phoneNumbers?.some((phone) => {
      return phone.phoneNumber === phoneHandle;
    }) ?? false
  );
}

function hasVerifiedPhone(user: ClerkUser, phoneHandle: string): boolean {
  return (
    user.phoneNumbers?.some((phone) => {
      return (
        phone.phoneNumber === phoneHandle &&
        phone.verification?.status === "verified"
      );
    }) ?? false
  );
}

async function exactPhoneUsers(
  clerk: ClerkClient,
  phoneHandle: string,
  context: ClerkReadContext,
  signal: AbortSignal,
): Promise<ClerkUser[]> {
  const users = new Map<string, ClerkUser>();
  for (let offset = 0; ; offset += USER_LIST_PAGE_SIZE) {
    const page = await clerk.users.getUserList(
      { phoneNumber: [phoneHandle], limit: USER_LIST_PAGE_SIZE, offset },
      context,
      signal,
    );
    signal.throwIfAborted();
    for (const user of page.data) {
      if (hasExactPhone(user, phoneHandle)) {
        users.set(user.id, user);
      }
    }
    // Clerk obtains totalCount separately. Only the exhausted data pages
    // establish that the exact phone has no other matching account.
    if (page.data.length < USER_LIST_PAGE_SIZE) {
      return [...users.values()];
    }
  }
}

async function resolvePhoneUsers(
  clerk: ClerkClient,
  phoneHandle: string,
  context: ClerkReadContext,
  signal: AbortSignal,
): Promise<ClerkUser[]> {
  const existing = await exactPhoneUsers(clerk, phoneHandle, context, signal);
  if (existing.length > 0) {
    return existing;
  }

  const created = await settle(
    clerk.users.createUser(
      {
        phoneNumber: [phoneHandle],
        skipPasswordRequirement: true,
        privateMetadata: { agentphoneSignup: { source: SIGNUP_SOURCE } },
      },
      signal,
    ),
    signal,
  );
  if (created.ok) {
    return [created.value];
  }
  if (
    !isClerkCreationConflict(created.error) &&
    !isClerkWriteAmbiguous(created.error)
  ) {
    throw created.error;
  }

  // A write may have committed before the response was lost. Read the exact
  // identity once; never repeat the create merely because its outcome is unclear.
  const reconciled = await exactPhoneUsers(clerk, phoneHandle, context, signal);
  if (reconciled.length === 0) {
    throw created.error;
  }
  return reconciled;
}

function signupWorkspaceSlug(userId: string): string {
  return `okou-phone-${createHash("sha256").update(userId).digest("hex").slice(0, 24)}`;
}

function isOwnedSignupWorkspace(
  organization: ClerkOrganization,
  userId: string,
): boolean {
  const marker = signupWorkspaceOwner.safeParse(
    organization.privateMetadata?.agentphoneSignup,
  );
  return (
    organization.createdBy === userId &&
    organization.slug === signupWorkspaceSlug(userId) &&
    marker.success &&
    marker.data.ownerUserId === userId
  );
}

async function ensureSignupWorkspace(
  clerk: ClerkClient,
  userId: string,
  context: ClerkReadContext,
  signal: AbortSignal,
): Promise<ClerkOrganization> {
  const slug = signupWorkspaceSlug(userId);
  const existing = await optionalClerkResource(
    clerk.organizations.getOrganization(
      { organizationId: slug },
      context,
      signal,
    ),
    signal,
  );
  if (existing) {
    return existing;
  }

  const created = await settle(
    clerk.organizations.createOrganization(
      {
        name: "My workspace",
        slug,
        createdBy: userId,
        privateMetadata: {
          agentphoneSignup: { source: SIGNUP_SOURCE, ownerUserId: userId },
        },
      },
      signal,
    ),
    signal,
  );
  if (created.ok) {
    return created.value;
  }
  if (
    !isClerkCreationConflict(created.error) &&
    !isClerkWriteAmbiguous(created.error)
  ) {
    throw created.error;
  }

  // The provider's unique deterministic slug serializes jobs for every phone
  // belonging to this user, including a retry after a process interruption.
  const reconciled = await optionalClerkResource(
    clerk.organizations.getOrganization(
      { organizationId: slug },
      context,
      signal,
    ),
    signal,
  );
  if (!reconciled) {
    throw created.error;
  }
  return reconciled;
}

function readyIdentity(
  userId: string,
  membership: ClerkOrganizationMembership,
): SignupIdentityResult {
  const role = membership.role === "org:admin" ? "admin" : "member";
  return {
    kind: "ready",
    userId,
    orgId: membership.organization.id,
    role,
    // Bootstrap writes an admin cache entry. Never invoke it for a member,
    // even when that member happens to be the organization's original creator.
    initializeWorkspace: role === "admin",
  };
}

async function resolvePreferredWorkspace(
  clerk: ClerkClient,
  user: ClerkUser,
  memberships: readonly ClerkOrganizationMembership[],
  context: ClerkReadContext,
  signal: AbortSignal,
): Promise<SignupIdentityResult> {
  const preference = signupWorkspacePreference.safeParse(
    user.privateMetadata.agentphoneSignup,
  );
  const preferredMembership = preference.success
    ? memberships.find((membership) => {
        return membership.organization.id === preference.data.workspaceId;
      })
    : undefined;
  if (!preferredMembership) {
    return { kind: "connect-required" };
  }
  const organization = await optionalClerkResource(
    clerk.organizations.getOrganization(
      { organizationId: preferredMembership.organization.id },
      context,
      signal,
    ),
    signal,
  );
  return organization && isOwnedSignupWorkspace(organization, user.id)
    ? readyIdentity(user.id, preferredMembership)
    : { kind: "connect-required" };
}

async function resolveSignupUser(
  clerk: ClerkClient,
  args: SignupIdentityArgs,
  context: ClerkReadContext,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "resolved"; readonly user: ClerkUser }
  | { readonly kind: "unavailable" }
  | { readonly kind: "connect-required" }
> {
  if (
    args.resolvedUserId &&
    args.linkedUser &&
    args.resolvedUserId !== args.linkedUser.userId
  ) {
    return { kind: "unavailable" };
  }
  const resolvedUserId = args.resolvedUserId ?? args.linkedUser?.userId;
  const users = resolvedUserId
    ? [
        await optionalClerkResource(
          clerk.users.getUser(resolvedUserId, context, signal),
          signal,
        ),
      ]
    : await resolvePhoneUsers(clerk, args.phoneHandle, context, signal);
  if (users.length !== 1) {
    return { kind: "connect-required" };
  }
  const user = users[0];
  if (!user || user.banned || user.locked) {
    return { kind: "unavailable" };
  }
  if (!args.linkedUser && !hasVerifiedPhone(user, args.phoneHandle)) {
    return { kind: "connect-required" };
  }
  // Persist the owner before creating a workspace or any dependent local
  // resources, so interruption and account erasure retain this exact identity.
  await args.onUserResolved(user.id, signal);
  signal.throwIfAborted();
  return { kind: "resolved", user };
}

/** The caller admits only signed, direct iMessage events with an E.164 sender. */
export const resolveAgentPhoneSignupIdentity$ = command(
  async (
    { get },
    args: SignupIdentityArgs,
    signal: AbortSignal,
  ): Promise<SignupIdentityResult> => {
    signal.throwIfAborted();
    if (!/^\+[1-9]\d{1,14}$/u.test(args.phoneHandle)) {
      return { kind: "connect-required" };
    }
    const clerk = get(clerk$);
    const context = createClerkReadContext();
    const resolved = await resolveSignupUser(clerk, args, context, signal);
    if (resolved.kind !== "resolved") {
      return resolved;
    }
    const { user } = resolved;

    const memberships = await optionalClerkResource(
      listAllUserOrganizationMemberships(clerk.users, user.id, context, signal),
      signal,
    );
    if (!memberships) {
      return { kind: "unavailable" };
    }
    if (args.linkedUser) {
      const linkedMembership = memberships.find((membership) => {
        return membership.organization.id === args.linkedUser?.orgId;
      });
      return linkedMembership
        ? readyIdentity(user.id, linkedMembership)
        : { kind: "unavailable" };
    }
    if (memberships.length === 1 && memberships[0]) {
      return readyIdentity(user.id, memberships[0]);
    }
    if (memberships.length > 1) {
      return await resolvePreferredWorkspace(
        clerk,
        user,
        memberships,
        context,
        signal,
      );
    }

    const organization = await ensureSignupWorkspace(
      clerk,
      user.id,
      context,
      signal,
    );
    if (!isOwnedSignupWorkspace(organization, user.id)) {
      return { kind: "connect-required" };
    }
    const currentMemberships = await optionalClerkResource(
      listAllUserOrganizationMemberships(clerk.users, user.id, context, signal),
      signal,
    );
    const ownerMembership = currentMemberships?.find((membership) => {
      return membership.organization.id === organization.id;
    });
    if (!ownerMembership) {
      return { kind: "unavailable" };
    }
    await clerk.users.updateUserMetadata(user.id, {
      privateMetadata: {
        agentphoneSignup: {
          source: SIGNUP_SOURCE,
          workspaceId: organization.id,
        },
      },
    });
    signal.throwIfAborted();
    return readyIdentity(user.id, ownerMembership);
  },
);
