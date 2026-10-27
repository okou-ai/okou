import { command } from "ccstate";
import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";
import { orgCache } from "@okouai/db/schema/org-cache";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { users } from "@okouai/db/schema/user";
import { and, count, eq, gte, inArray, not, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import {
  clerk$,
  createClerkReadContext,
  type ClerkOrganizationMembership,
} from "../external/clerk";
import { listAllOrganizationMemberships } from "../external/clerk-organization-lists";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import type { CreditLowBalanceAlertArgs } from "./credit-low-balance-threshold";
import {
  buildOneClickUnsubscribeUrl,
  buildTeamFromAddress,
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
  CREDIT_LOW_BALANCE_EMAIL_SUBJECT,
  getUserEmail$,
  type EmailTemplate,
} from "./email-common.service";

type OrganizationMembership = ClerkOrganizationMembership;

const L = logger("CreditLowBalanceAlert");
function billingCreditsUrl(): string {
  return `${env("APP_URL")}/?settings=billing&billingView=credits`;
}

interface Recipient {
  readonly userId: string;
  readonly email: string;
}

interface OrgMemberCacheRow {
  readonly orgId: string;
  readonly userId: string;
  readonly role: "admin" | "member";
  readonly cachedAt: Date;
}

function membershipUserId(
  membership: OrganizationMembership,
): string | undefined {
  return membership.publicUserData?.userId;
}

// Cache replacement is uninterrupted; the original owner checks cancellation
// only after the write commits.
const replaceOrgMemberCache$ = command(
  async (
    { set },
    orgId: string,
    rows: readonly OrgMemberCacheRow[],
  ): Promise<void> => {
    const db = set(writeDb$);
    if (rows.length === 0) {
      await db.delete(orgMembersCache).where(eq(orgMembersCache.orgId, orgId));
      return;
    }

    const refreshedMembers = db.$with("refreshed_members").as(
      db
        .insert(orgMembersCache)
        .values([...rows])
        .onConflictDoUpdate({
          target: [orgMembersCache.orgId, orgMembersCache.userId],
          set: {
            role: sql`excluded.role`,
            cachedAt: sql`excluded.cached_at`,
          },
        })
        .returning({ userId: orgMembersCache.userId }),
    );
    const userIds = rows.map((row) => {
      return row.userId;
    });
    // COUNT consumes the whole UPSERT even at zero rows. Exclude the complete
    // input cohort, keeping both mutations disjoint and the array one binding.
    // Cleanup uses this statement's snapshot; unrelated rows inserted during
    // an UPSERT wait may survive without receiving a fresh cachedAt.
    await db
      .with(refreshedMembers)
      .delete(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, orgId),
          not(
            sql`${orgMembersCache.userId} = ANY(${sql.param(userIds)}::text[])`,
          ),
          gte(
            db.select({ refreshedMembers: count() }).from(refreshedMembers),
            0,
          ),
        ),
      );
  },
);

const refreshOrgMemberCache$ = command(async function refreshOrgMemberCache(
  { set },
  orgId: string,
  memberships: readonly OrganizationMembership[],
  signal: AbortSignal,
): Promise<void> {
  const cachedAt = nowDate();
  const rowsByUserId = new Map<string, OrgMemberCacheRow>();
  for (const membership of memberships) {
    const userId = membershipUserId(membership);
    if (!userId) {
      continue;
    }
    const role = membership.role === "org:admin" ? "admin" : "member";
    const existing = rowsByUserId.get(userId);
    if (existing?.role === "admin") {
      continue;
    }
    rowsByUserId.set(userId, {
      orgId,
      userId,
      role,
      cachedAt,
    });
  }
  const rows = [...rowsByUserId.values()];

  await set(replaceOrgMemberCache$, orgId, rows);
  signal.throwIfAborted();
});

function adminUserIds(
  memberships: readonly OrganizationMembership[],
): string[] {
  return [
    ...new Set(
      memberships.flatMap((membership) => {
        if (membership.role !== "org:admin") {
          return [];
        }
        const userId = membershipUserId(membership);
        return userId ? [userId] : [];
      }),
    ),
  ];
}

const subscribedUserIds$ = command(
  async (
    { get },
    userIds: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>> => {
    const db = get(db$);
    if (userIds.length === 0) {
      return new Set();
    }

    const unsubscribedRows = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          inArray(users.id, [...userIds].sort()),
          eq(users.emailUnsubscribed, true),
        ),
      );
    signal.throwIfAborted();
    const unsubscribed = new Set(
      unsubscribedRows.map((row) => {
        return row.id;
      }),
    );
    return new Set(
      userIds.filter((userId) => {
        return !unsubscribed.has(userId);
      }),
    );
  },
);

const resolveRecipients$ = command(
  async (
    { set },
    userIds: readonly string[],
    signal: AbortSignal,
  ): Promise<Recipient[]> => {
    const eligibleUserIds = await set(subscribedUserIds$, userIds, signal);
    signal.throwIfAborted();

    const byEmail = new Map<string, Recipient>();
    for (const userId of userIds) {
      if (!eligibleUserIds.has(userId)) {
        continue;
      }

      const email = await set(getUserEmail$, userId, signal);
      signal.throwIfAborted();
      if (!email) {
        continue;
      }

      const key = email.toLowerCase();
      if (!byEmail.has(key)) {
        byEmail.set(key, { userId, email });
      }
    }
    return [...byEmail.values()];
  },
);

export const enqueueCreditLowBalanceAlert$ = command(
  async (
    { get, set },
    args: CreditLowBalanceAlertArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    const memberships = await listAllOrganizationMemberships(
      clerk.organizations,
      args.orgId,
      createClerkReadContext(),
      signal,
    );
    await set(refreshOrgMemberCache$, args.orgId, memberships, signal);
    signal.throwIfAborted();

    const userIds = adminUserIds(memberships);
    if (userIds.length === 0) {
      L.warn("No current org admin recipients for low-credit alert", {
        orgId: args.orgId,
      });
      return;
    }

    const recipients = await set(resolveRecipients$, userIds, signal);
    const emails = recipients.map((recipient) => {
      return recipient.email;
    });
    const suppressed = await (async (): Promise<Set<string>> => {
      if (emails.length === 0) {
        return new Set();
      }

      const lowerEmails = emails.map((email) => {
        return email.toLowerCase();
      });
      const rows = await db
        .select({ emailAddress: emailSuppressions.emailAddress })
        .from(emailSuppressions)
        .where(
          inArray(sql`lower(${emailSuppressions.emailAddress})`, lowerEmails),
        );

      return new Set(
        rows.map((row) => {
          return row.emailAddress.toLowerCase();
        }),
      );
    })();
    signal.throwIfAborted();

    const deliverableRecipients = recipients.filter((recipient) => {
      return !suppressed.has(recipient.email.toLowerCase());
    });
    if (deliverableRecipients.length === 0) {
      L.warn("No eligible org admin recipients for low-credit alert", {
        orgId: args.orgId,
      });
      return;
    }

    const orgId = args.orgId;
    const orgName = await (async () => {
      const [cached] = await db
        .select({ name: orgCache.name })
        .from(orgCache)
        .where(eq(orgCache.orgId, orgId))
        .limit(1);
      const name = cached?.name.trim();
      return name || "Your organization";
    })();
    signal.throwIfAborted();
    const billingUrl = billingCreditsUrl();

    await db.insert(emailOutbox).values(
      deliverableRecipients.map((recipient) => {
        const unsubscribeUrl = buildUnsubscribeUrl(recipient.userId);
        const template = {
          template: "credit-low-balance",
          props: {
            orgName,
            remainingCredits: args.remainingCredits,
            thresholdCredits: args.thresholdCredits,
            billingUrl,
            unsubscribeUrl,
          },
        } satisfies EmailTemplate;
        return {
          fromAddress: buildTeamFromAddress(),
          toAddresses: recipient.email,
          ccAddresses: null,
          subject: CREDIT_LOW_BALANCE_EMAIL_SUBJECT,
          replyTo: null,
          headers: buildUnsubscribeHeaders(
            buildOneClickUnsubscribeUrl(recipient.userId),
          ),
          template,
          status: "pending",
          attempts: 0,
        } as const;
      }),
    );
  },
);
