import { command } from "ccstate";
import { and, eq, isNull, sql } from "drizzle-orm";
import { hostedSites } from "@okouai/db/runtime/hosted-site";
import { artifacts } from "@okouai/db/schema/artifact";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

export const updateHostedSiteTitle$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly publicSlug: string;
      readonly title: string;
    },
    signal: AbortSignal,
  ) => {
    const [site] = await set(writeDb$)
      .update(artifacts)
      .set({ title: args.title, updatedAt: nowDate() })
      .from(hostedSites)
      .where(
        and(
          eq(artifacts.logicalKey, sql`'site:' || ${hostedSites.id}::text`),
          eq(artifacts.orgId, args.orgId),
          eq(artifacts.authorUserId, args.userId),
          eq(hostedSites.orgId, args.orgId),
          eq(hostedSites.userId, args.userId),
          eq(hostedSites.publicSlug, args.publicSlug),
          isNull(hostedSites.deletedAt),
        ),
      )
      .returning({
        siteId: hostedSites.id,
        publicSlug: hostedSites.publicSlug,
        title: artifacts.title,
      });
    signal.throwIfAborted();
    return site ?? null;
  },
);
