import { command } from "ccstate";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";
import { orgCache } from "@okouai/db/schema/org-cache";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { users } from "@okouai/db/schema/user";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import {
  clerk$,
  createClerkReadContext,
  type ClerkClient,
  type ClerkOrganizationMembership,
} from "../external/clerk";
import { listAllOrganizationMemberships } from "../external/clerk-organization-lists";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  buildOneClickUnsubscribeUrl,
  buildTeamFromAddress,
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
  CREDIT_LOW_BALANCE_EMAIL_SUBJECT,
  EMAIL_PUBLIC_BRAND,
  getUserEmail,
  type EmailTemplate,
} from "./email-common.service";

type OrganizationMembership = ClerkOrganizationMembership;

export const LOW_CREDIT_EMAIL_ALERT_THRESHOLD_CREDITS = 5000;

const L = logger("CreditLowBalanceAlert");
function billingCreditsUrl(): string {
  return `${env("APP_URL")}/?settings=billing&billingView=credits`;
}

export interface CreditLowBalanceAlertArgs {
  readonly orgId: string;
  readonly remainingCredits: number;
  readonly thresholdCredits: number;
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

async function refreshOrgMemberCache(
  db: Db,
  orgId: string,
  memberships: readonly OrganizationMembership[],
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

  await db.transaction(async (tx) => {
    if (rows.length > 0) {
      await tx
        .insert(orgMembersCache)
        .values(rows)
        .onConflictDoUpdate({
          target: [orgMembersCache.orgId, orgMembersCache.userId],
          set: {
            role: sql`excluded.role`,
            cachedAt: sql`excluded.cached_at`,
          },
        });

      await tx.delete(orgMembersCache).where(
        and(
          eq(orgMembersCache.orgId, orgId),
          notInArray(
            orgMembersCache.userId,
            rows.map((row) => {
              return row.userId;
            }),
          ),
        ),
      );
      return;
    }

    await tx.delete(orgMembersCache).where(eq(orgMembersCache.orgId, orgId));
  });
}

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

async function subscribedUserIds(
  db: Db,
  userIds: readonly string[],
): Promise<Set<string>> {
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
}

async function resolveRecipients(
  db: Db,
  clerk: ClerkClient,
  userIds: readonly string[],
  signal: AbortSignal,
): Promise<Recipient[]> {
  const eligibleUserIds = await subscribedUserIds(db, userIds);
  signal.throwIfAborted();

  const byEmail = new Map<string, Recipient>();
  for (const userId of userIds) {
    if (!eligibleUserIds.has(userId)) {
      continue;
    }

    const email = await getUserEmail(db, clerk, userId);
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
}

async function suppressedEmailKeys(
  db: Db,
  emails: readonly string[],
): Promise<Set<string>> {
  if (emails.length === 0) {
    return new Set();
  }

  const lowerEmails = emails.map((email) => {
    return email.toLowerCase();
  });
  const rows = await db
    .select({ emailAddress: emailSuppressions.emailAddress })
    .from(emailSuppressions)
    .where(inArray(sql`lower(${emailSuppressions.emailAddress})`, lowerEmails));

  return new Set(
    rows.map((row) => {
      return row.emailAddress.toLowerCase();
    }),
  );
}

async function orgDisplayName(db: Db, orgId: string): Promise<string> {
  const [cached] = await db
    .select({ name: orgCache.name })
    .from(orgCache)
    .where(eq(orgCache.orgId, orgId))
    .limit(1);
  const name = cached?.name.trim();
  return name || "Your organization";
}

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
    await refreshOrgMemberCache(db, args.orgId, memberships);
    signal.throwIfAborted();

    const userIds = adminUserIds(memberships);
    if (userIds.length === 0) {
      L.warn("No current org admin recipients for low-credit alert", {
        orgId: args.orgId,
      });
      return;
    }

    const recipients = await resolveRecipients(db, clerk, userIds, signal);
    const suppressed = await suppressedEmailKeys(
      db,
      recipients.map((recipient) => {
        return recipient.email;
      }),
    );
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

    const orgName = await orgDisplayName(db, args.orgId);
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
          publicBrand: EMAIL_PUBLIC_BRAND,
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
