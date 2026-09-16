import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { orgCache } from "@okouai/db/schema/org-cache";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { userCache } from "@okouai/db/schema/user-cache";
import { usagePackAllocations } from "@okouai/db/schema/usage-pack-subscription";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import type { OrgResponse } from "@okouai/api-contracts/contracts/orgs";
import {
  orgRoleSchema,
  type OrgMessageResponse,
  type OrgMember,
  type OrgMembersResponse,
  type OrgRole,
} from "@okouai/api-contracts/contracts/org-members";
import { usagePackUsdSchema } from "@okouai/api-contracts/contracts/billing";

import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  clerk$,
  createClerkReadContext,
  type ClerkReadContext,
  type ClerkUser,
} from "../external/clerk";
import {
  listAllOrganizationMemberships,
  listAllPendingOrganizationInvitations,
  listAllUserOrganizationMemberships,
} from "../external/clerk-organization-lists";
import { fetchClerkMembershipRequests } from "../external/clerk-membership-requests";
import { badRequestMessage, notFound } from "../../lib/error";
import { now, nowDate } from "../../lib/time";
import { onRejection, settle } from "../utils";
import { cleanupOrgMemberResources } from "./org-member-cleanup.service";
import { refundUsagePackMemberCredits } from "./usage-pack-credit-refund.service";
import { cancelAndRefundOrgBillingForDeletion } from "./org-deletion-billing.service";
import {
  cancelUsagePackMemberRemovalReservation,
  reserveUsagePackMemberRemoval,
  removeUsagePackMemberAllocation,
} from "./usage-pack-allocation-change.service";

const clerkOrgIdentitySchema = z.object({
  name: z.string().nullable().optional(),
  createdBy: z.string().nullable().optional(),
});

interface OrgIdentity {
  readonly name: string;
  readonly createdBy: string | null;
}

const CACHE_TTL_MS = 60_000;
const USER_PROFILE_CACHE_TTL_MS = 15 * 60 * 1000;
const CLERK_USER_LIST_BATCH_SIZE = 100;

const forbiddenAccess = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Access denied",
      code: "FORBIDDEN",
    }),
  }),
});

const adminCannotLeave = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Admins cannot leave the organization",
      code: "FORBIDDEN",
    }),
  }),
});

const orgDeleteForbidden = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only admins can delete the organization",
      code: "FORBIDDEN",
    }),
  }),
});

type OrgUpdateErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>
  | typeof forbiddenAccess;

type OrgDeleteErrorResponse =
  | ReturnType<typeof notFound>
  | typeof orgDeleteForbidden;

type RemoveOrgMemberErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>
  | typeof forbiddenAccess;

type UpdateOrgMemberRoleErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>
  | typeof forbiddenAccess;

interface UpdateOrgArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}

interface LeaveOrgArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly role: OrgRole;
}

interface DeleteOrgArgs {
  readonly orgId: string;
  readonly callerRole: OrgRole | undefined;
}

interface RemoveOrgMemberArgs {
  readonly orgId: string;
  readonly callerUserId: string;
  readonly callerRole: OrgRole;
  readonly email: string;
}

interface UpdateOrgMemberRoleArgs {
  readonly callerUserId: string;
  readonly orgId: string;
  readonly callerRole: OrgRole | undefined;
  readonly targetEmail: string;
  readonly newRole: OrgRole;
}

function isClerkNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (
    Reflect.get(error, "statusCode") === 404 ||
    Reflect.get(error, "code") === "NOT_FOUND" ||
    Reflect.get(error, "name") === "NotFoundError"
  );
}

/**
 * Deleting an org only needs to know that the org still exists; a fresh cache
 * row is pointless for something we are about to remove.
 */
async function orgExistsForDelete(args: {
  readonly db: ReadonlyDb;
  readonly client: ReturnType<typeof clerk$.read>;
  readonly orgId: string;
}): Promise<boolean> {
  const [cached] = await args.db
    .select({ cachedAt: orgCache.cachedAt })
    .from(orgCache)
    .where(eq(orgCache.orgId, args.orgId))
    .limit(1);

  if (
    cached &&
    nowDate().getTime() - cached.cachedAt.getTime() < CACHE_TTL_MS
  ) {
    return true;
  }

  const clerkOrgSettled = await settle(
    args.client.organizations.getOrganization({ organizationId: args.orgId }),
  );
  if (!clerkOrgSettled.ok) {
    if (isClerkNotFound(clerkOrgSettled.error)) {
      return false;
    }
    throw clerkOrgSettled.error;
  }

  return true;
}

interface OrgDetailArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole?: OrgRole;
}

export const createdOrganizationsCount$ = command(
  async ({ get }, userId: string, signal: AbortSignal): Promise<number> => {
    const client = get(clerk$);
    const memberships = await listAllUserOrganizationMemberships(
      client.users,
      userId,
      createClerkReadContext(),
      signal,
    );
    signal.throwIfAborted();

    return memberships.filter((membership) => {
      return membership.organization.createdBy === userId;
    }).length;
  },
);

export const orgDetail$ = command(
  async (
    { get, set },
    args: OrgDetailArgs,
    signal: AbortSignal,
  ): Promise<OrgResponse | null> => {
    const db = get(db$);

    const [cached, meta, membership] = await Promise.all([
      db
        .select({
          name: orgCache.name,
          createdBy: orgCache.createdBy,
        })
        .from(orgCache)
        .where(eq(orgCache.orgId, args.orgId))
        .limit(1),
      db
        .select({ tier: orgMetadata.tier })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId))
        .limit(1),
      db
        .select({ role: orgMembersCache.role })
        .from(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.orgId, args.orgId),
            eq(orgMembersCache.userId, args.userId),
          ),
        )
        .limit(1),
    ]);
    signal.throwIfAborted();

    let identity: OrgIdentity | undefined = cached[0];
    if (!identity) {
      const client = get(clerk$);
      const clerkOrgSettled = await settle(
        client.organizations.getOrganization({
          organizationId: args.orgId,
        }),
      );
      signal.throwIfAborted();

      if (!clerkOrgSettled.ok) {
        if (isClerkNotFound(clerkOrgSettled.error)) {
          return null;
        }
        throw clerkOrgSettled.error;
      }
      const clerkOrg = clerkOrgSettled.value;

      const parsed = clerkOrgIdentitySchema.parse(clerkOrg);
      identity = {
        name: parsed.name ?? "",
        createdBy: parsed.createdBy ?? null,
      };

      const now = nowDate();
      const writeDb = set(writeDb$);
      const [savedIdentity] = await writeDb
        .insert(orgCache)
        .values({
          orgId: args.orgId,
          name: identity.name,
          createdBy: identity.createdBy,
          cachedAt: now,
        })
        // Preserve a profile update or fill that won during the Clerk read.
        // A no-op update returns that identity atomically without refreshing
        // its timestamp or copying fields from this potentially older snapshot.
        .onConflictDoUpdate({
          target: orgCache.orgId,
          set: { name: orgCache.name },
        })
        .returning({
          name: orgCache.name,
          createdBy: orgCache.createdBy,
        });
      signal.throwIfAborted();

      if (!savedIdentity) {
        throw new Error("Organization identity cache upsert returned no row");
      }
      identity = savedIdentity;
    }

    const cachedRole = membership[0]?.role;
    const role =
      args.orgRole ??
      (cachedRole ? orgRoleSchema.parse(cachedRole) : undefined);
    if (!role) {
      throw new Error(
        `Missing organization membership role for user ${args.userId} in org ${args.orgId}`,
      );
    }

    return {
      id: args.orgId,
      name: identity.name,
      tier: meta[0]?.tier ?? "pro-suspend",
      role,
      createdBy: identity.createdBy ?? undefined,
    };
  },
);

async function commitOrgMemberRemoval(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
  reservationId: string | null,
  deleteMembership: () => Promise<void>,
): Promise<void> {
  // Once Clerk accepts the deletion, billing and resource cleanup must finish
  // even if the originating request disconnects.
  const commitSignal = new AbortController().signal;
  await onRejection(deleteMembership(), async () => {
    await cancelUsagePackMemberRemovalReservation(db, reservationId);
  });
  commitSignal.throwIfAborted();
  await removeUsagePackMemberAllocation(db, args, commitSignal);
  commitSignal.throwIfAborted();
  await refundUsagePackMemberCredits(db, args, commitSignal);
  commitSignal.throwIfAborted();
  await cleanupOrgMemberResources(db, args, commitSignal);
  commitSignal.throwIfAborted();
}

export const leaveOrg$ = command(
  async (
    { get, set },
    args: LeaveOrgArgs,
    signal: AbortSignal,
  ): Promise<OrgMessageResponse | typeof adminCannotLeave> => {
    if (args.role === "admin") {
      return adminCannotLeave;
    }

    const client = get(clerk$);
    const writeDb = set(writeDb$);
    const reservationId = await reserveUsagePackMemberRemoval(
      writeDb,
      {
        orgId: args.orgId,
        userId: args.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    await commitOrgMemberRemoval(writeDb, args, reservationId, async () => {
      await client.organizations.deleteOrganizationMembership({
        organizationId: args.orgId,
        userId: args.userId,
      });
    });
    signal.throwIfAborted();

    return { message: "Left org" };
  },
);

export const removeOrgMember$ = command(
  async (
    { get, set },
    args: RemoveOrgMemberArgs,
    signal: AbortSignal,
  ): Promise<OrgMessageResponse | RemoveOrgMemberErrorResponse> => {
    if (args.callerRole !== "admin") {
      return forbiddenAccess;
    }

    const client = get(clerk$);
    const users = await client.users.getUserList({
      emailAddress: [args.email],
    });
    signal.throwIfAborted();

    const target = users.data[0];
    if (!target) {
      return notFound("Resource not found");
    }

    if (target.id === args.callerUserId) {
      return badRequestMessage("Invalid request");
    }

    const memberships =
      await client.organizations.getOrganizationMembershipList({
        organizationId: args.orgId,
      });
    signal.throwIfAborted();

    const membership = memberships.data.find((entry) => {
      return entry.publicUserData?.userId === target.id;
    });
    if (!membership) {
      return notFound("Resource not found");
    }

    const writeDb = set(writeDb$);
    const reservationId = await reserveUsagePackMemberRemoval(
      writeDb,
      {
        orgId: args.orgId,
        userId: target.id,
      },
      signal,
    );
    signal.throwIfAborted();
    await commitOrgMemberRemoval(
      writeDb,
      { orgId: args.orgId, userId: target.id },
      reservationId,
      async () => {
        await client.organizations.deleteOrganizationMembership({
          organizationId: args.orgId,
          userId: target.id,
        });
      },
    );
    signal.throwIfAborted();

    return { message: `Removed ${args.email} from org` };
  },
);

export const updateOrgMemberRole$ = command(
  async (
    { get },
    args: UpdateOrgMemberRoleArgs,
    signal: AbortSignal,
  ): Promise<OrgMessageResponse | UpdateOrgMemberRoleErrorResponse> => {
    if (args.callerRole !== "admin") {
      return forbiddenAccess;
    }

    const client = get(clerk$);
    const users = await client.users.getUserList({
      emailAddress: [args.targetEmail],
    });
    signal.throwIfAborted();

    const targetUser = users.data[0];
    if (!targetUser) {
      return notFound("Resource not found");
    }

    if (targetUser.id === args.callerUserId) {
      if (args.newRole !== "member") {
        return badRequestMessage("Invalid request");
      }

      const memberships =
        await client.organizations.getOrganizationMembershipList({
          organizationId: args.orgId,
        });
      signal.throwIfAborted();

      const adminCount = memberships.data.filter((membership) => {
        return membership.role === "org:admin";
      }).length;
      if (adminCount < 2) {
        return badRequestMessage("Invalid request");
      }
    }

    await client.organizations.updateOrganizationMembership({
      organizationId: args.orgId,
      userId: targetUser.id,
      role: args.newRole === "admin" ? "org:admin" : "org:member",
    });
    signal.throwIfAborted();

    return { message: `Updated role for ${args.targetEmail}` };
  },
);

export const updateOrg$ = command(
  async (
    { get, set },
    args: UpdateOrgArgs,
    signal: AbortSignal,
  ): Promise<OrgResponse | OrgUpdateErrorResponse> => {
    const db = get(db$);
    const [membership] = await db
      .select({ role: orgMembersCache.role })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, args.orgId),
          eq(orgMembersCache.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!membership) {
      return forbiddenAccess;
    }

    const client = get(clerk$);
    const clerkOrg = await client.organizations.updateOrganization(args.orgId, {
      name: args.name,
    });
    signal.throwIfAborted();

    const writeDb = set(writeDb$);
    const identity = {
      name: clerkOrg.name,
      createdBy: clerkOrg.createdBy ?? null,
      cachedAt: nowDate(),
    };
    await writeDb
      .insert(orgCache)
      .values({ orgId: args.orgId, ...identity })
      .onConflictDoUpdate({ target: orgCache.orgId, set: identity });
    signal.throwIfAborted();

    const org = await set(
      orgDetail$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    signal.throwIfAborted();

    if (!org) {
      return notFound("Organization not found");
    }

    return org;
  },
);

export const deleteOrg$ = command(
  async (
    { get, set },
    args: DeleteOrgArgs,
    signal: AbortSignal,
  ): Promise<{ readonly message: string } | OrgDeleteErrorResponse> => {
    if (args.callerRole !== "admin") {
      return orgDeleteForbidden;
    }

    const db = get(db$);
    const writeDb = set(writeDb$);
    const client = get(clerk$);
    const exists = await orgExistsForDelete({
      db,
      client,
      orgId: args.orgId,
    });
    signal.throwIfAborted();

    if (!exists) {
      return notFound("Resource not found");
    }

    const memberships =
      await client.organizations.getOrganizationMembershipList({
        organizationId: args.orgId,
      });
    signal.throwIfAborted();

    const memberUserIds = memberships.data
      .map((membership) => {
        return membership.publicUserData?.userId;
      })
      .filter((userId): userId is string => {
        return Boolean(userId);
      });

    await cancelAndRefundOrgBillingForDeletion(db, args.orgId, signal);
    signal.throwIfAborted();

    for (const userId of memberUserIds) {
      const [installation] = await db
        .select({
          slackWorkspaceId: slackOrgInstallations.slackWorkspaceId,
        })
        .from(slackOrgInstallations)
        .where(eq(slackOrgInstallations.orgId, args.orgId))
        .limit(1);
      signal.throwIfAborted();

      if (installation) {
        await writeDb
          .delete(slackOrgConnections)
          .where(
            and(
              eq(slackOrgConnections.userId, userId),
              eq(
                slackOrgConnections.slackWorkspaceId,
                installation.slackWorkspaceId,
              ),
            ),
          );
        signal.throwIfAborted();
      }

      await writeDb
        .delete(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.userId, userId),
            eq(orgMembersCache.orgId, args.orgId),
          ),
        );
      signal.throwIfAborted();

      await writeDb
        .delete(orgMembersMetadata)
        .where(
          and(
            eq(orgMembersMetadata.userId, userId),
            eq(orgMembersMetadata.orgId, args.orgId),
          ),
        );
      signal.throwIfAborted();
    }

    await client.organizations.deleteOrganization(args.orgId);
    signal.throwIfAborted();

    return { message: "Organization deleted" };
  },
);

interface OrgMembersListArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly callerRole: OrgRole;
}

interface ClerkUserProfile {
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly imageUrl: string;
}

function mapClerkOrgRole(clerkRole: string): OrgRole {
  return clerkRole === "org:admin" ? "admin" : "member";
}

function requiredClerkMembershipUserId(
  userId: string | null | undefined,
): string {
  if (!userId) {
    throw new Error("Clerk organization membership is missing its user ID");
  }
  return userId;
}

function userPrimaryEmail(user: ClerkUser): string {
  const primary = user.emailAddresses.find((e) => {
    return e.id === user.primaryEmailAddressId;
  });
  return primary?.emailAddress ?? "";
}

async function fetchUserProfileMap(
  db: Db,
  client: ReturnType<typeof clerk$.read>,
  userIds: readonly string[],
  context: ClerkReadContext,
  signal: AbortSignal,
): Promise<Map<string, ClerkUserProfile>> {
  const map = new Map<string, ClerkUserProfile>();
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) {
    return map;
  }

  const currentTime = now();
  const cachedUsers = await db
    .select({
      userId: userCache.userId,
      email: userCache.email,
      name: userCache.name,
      imageUrl: userCache.imageUrl,
      cachedAt: userCache.cachedAt,
    })
    .from(userCache)
    .where(inArray(userCache.userId, uniqueUserIds));
  signal.throwIfAborted();
  const missingUserIds = new Set(uniqueUserIds);
  for (const cached of cachedUsers) {
    if (currentTime - cached.cachedAt.getTime() >= USER_PROFILE_CACHE_TTL_MS) {
      continue;
    }
    const [firstName = null, ...rest] = (cached.name ?? "").split(/\s+/);
    map.set(cached.userId, {
      email: cached.email,
      firstName: firstName || null,
      lastName: rest.join(" ") || null,
      imageUrl: cached.imageUrl ?? "",
    });
    missingUserIds.delete(cached.userId);
  }

  if (missingUserIds.size === 0) {
    return map;
  }

  const refreshedAt = nowDate();
  const userIdsToFetch = [...missingUserIds];
  for (
    let offset = 0;
    offset < userIdsToFetch.length;
    offset += CLERK_USER_LIST_BATCH_SIZE
  ) {
    const users = await client.users.getUserList(
      {
        userId: userIdsToFetch.slice(
          offset,
          offset + CLERK_USER_LIST_BATCH_SIZE,
        ),
        limit: CLERK_USER_LIST_BATCH_SIZE,
      },
      context,
      signal,
    );
    for (const user of users.data) {
      const email = userPrimaryEmail(user);
      const name =
        [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
      const imageUrl = user.imageUrl || null;
      map.set(user.id, {
        email,
        firstName: user.firstName,
        lastName: user.lastName,
        imageUrl: imageUrl ?? "",
      });
      if (email) {
        await db
          .insert(userCache)
          .values({
            userId: user.id,
            email,
            name,
            imageUrl,
            cachedAt: refreshedAt,
          })
          .onConflictDoUpdate({
            target: userCache.userId,
            set: {
              email,
              name,
              imageUrl,
              cachedAt: refreshedAt,
            },
          });
        signal.throwIfAborted();
      }
    }
  }
  return map;
}

async function fetchOrgMemberDirectory(
  client: ReturnType<typeof clerk$.read>,
  orgId: string,
  callerRole: OrgRole,
  context: ClerkReadContext,
  signal: AbortSignal,
) {
  const controller = new AbortController();
  const readSignal = AbortSignal.any([signal, controller.signal]);
  const [organization, memberships, invitations] = await onRejection(
    Promise.all([
      client.organizations.getOrganization(
        {
          organizationId: orgId,
        },
        context,
        readSignal,
      ),
      listAllOrganizationMemberships(
        client.organizations,
        orgId,
        context,
        readSignal,
      ),
      callerRole === "admin"
        ? listAllPendingOrganizationInvitations(
            client.organizations,
            orgId,
            context,
            readSignal,
          )
        : [],
    ]),
    () => {
      controller.abort();
    },
  );
  controller.abort();
  signal.throwIfAborted();
  return { organization, memberships, invitations };
}

async function fetchOrgMembershipRequests(
  db: Db,
  client: ReturnType<typeof clerk$.read>,
  orgId: string,
  context: ClerkReadContext,
  signal: AbortSignal,
): Promise<NonNullable<OrgMembersResponse["membershipRequests"]>> {
  const requestsData = await fetchClerkMembershipRequests(
    orgId,
    context,
    signal,
  );
  const requestProfiles = await fetchUserProfileMap(
    db,
    client,
    requestsData.map((request) => {
      return request.public_user_data.user_id;
    }),
    context,
    signal,
  );
  return requestsData.map((request) => {
    const userId = request.public_user_data.user_id;
    const profile = requestProfiles.get(userId);
    return {
      id: request.id,
      userId,
      email: profile?.email ?? "",
      firstName: profile?.firstName ?? null,
      lastName: profile?.lastName ?? null,
      imageUrl: profile?.imageUrl ?? "",
      createdAt: new Date(request.created_at).toISOString(),
    };
  });
}

export const orgMembersList$ = command(
  async (
    { get },
    args: OrgMembersListArgs,
    signal: AbortSignal,
  ): Promise<OrgMembersResponse> => {
    const client = get(clerk$);
    const db = get(db$) as Db;
    const readContext = createClerkReadContext(now);

    const { organization, memberships, invitations } =
      await fetchOrgMemberDirectory(
        client,
        args.orgId,
        args.callerRole,
        readContext,
        signal,
      );
    signal.throwIfAborted();

    const membersWithUserIds = memberships.map((membership) => {
      return {
        membership,
        userId: requiredClerkMembershipUserId(
          membership.publicUserData?.userId,
        ),
      };
    });
    const memberProfiles = await fetchUserProfileMap(
      db,
      client,
      membersWithUserIds.map((member) => {
        return member.userId;
      }),
      readContext,
      signal,
    );
    signal.throwIfAborted();

    const memberList: OrgMember[] = membersWithUserIds.map((member) => {
      const profile = memberProfiles.get(member.userId);
      return {
        userId: member.userId,
        email: profile?.email ?? "",
        firstName: profile?.firstName ?? null,
        lastName: profile?.lastName ?? null,
        imageUrl: profile?.imageUrl ?? "",
        role: mapClerkOrgRole(member.membership.role),
        joinedAt: member.membership.createdAt
          ? new Date(member.membership.createdAt).toISOString()
          : "",
      };
    });

    const pendingInvitationIds = invitations.map((invitation) => {
      return invitation.id;
    });
    const pendingInvitationAllocations =
      args.callerRole === "admin" && pendingInvitationIds.length > 0
        ? await db
            .select({
              invitationId: usagePackAllocations.invitationId,
              usagePackUsd: usagePackAllocations.usagePackUsd,
            })
            .from(usagePackAllocations)
            .where(
              and(
                eq(usagePackAllocations.orgId, args.orgId),
                inArray(
                  usagePackAllocations.invitationId,
                  pendingInvitationIds,
                ),
                inArray(usagePackAllocations.status, [
                  "pending_invitation",
                  "paid_pending_invitation",
                ]),
              ),
            )
        : [];
    const usagePackByInvitationId = new Map(
      pendingInvitationAllocations.flatMap((allocation) => {
        return allocation.invitationId
          ? [
              [
                allocation.invitationId,
                usagePackUsdSchema.parse(allocation.usagePackUsd),
              ] as const,
            ]
          : [];
      }),
    );
    const pendingInvitations =
      args.callerRole === "admin"
        ? invitations.map((inv) => {
            const usagePackUsd = usagePackByInvitationId.get(inv.id);
            return {
              id: inv.id,
              email: inv.emailAddress,
              role: mapClerkOrgRole(inv.role),
              createdAt: new Date(inv.createdAt).toISOString(),
              ...(usagePackUsd === undefined ? {} : { usagePackUsd }),
            };
          })
        : [];

    const membershipRequests =
      args.callerRole === "admin"
        ? await fetchOrgMembershipRequests(
            db,
            client,
            args.orgId,
            readContext,
            signal,
          )
        : [];

    return {
      name: organization.name,
      role: args.callerRole,
      members: memberList,
      pendingInvitations,
      membershipRequests,
      createdAt: new Date(organization.createdAt).toISOString(),
    };
  },
);
