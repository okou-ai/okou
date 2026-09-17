/**
 * The persisted member locale the language precedence falls back to.
 *
 * `org_members_metadata` is the source of truth for per-member preferences, so
 * this reads the member's own row rather than the request's negotiated
 * language: a scheduled brief has no request headers to negotiate from.
 *
 * An unset locale is returned as `null`, never coerced to the default here. The
 * difference matters to the caller: a recorded `en-US` preference and no
 * preference at all produce the same text, but only one of them is a choice the
 * owner made, and only the first may be recorded as the language's authority.
 */

import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import type { MorningBriefCollectionOwner } from "./morning-brief-collection-occurrence.service";

export async function loadMorningBriefMemberLocale(
  db: Pick<ReadonlyDb, "select">,
  owner: MorningBriefCollectionOwner,
): Promise<string | null> {
  const [member] = await db
    .select({ locale: orgMembersMetadata.locale })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, owner.orgId),
        eq(orgMembersMetadata.userId, owner.userId),
      ),
    )
    .limit(1);
  return member?.locale ?? null;
}
