import { command } from "ccstate";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { hostedSiteShares } from "@okouai/db/schema/hosted-site-share";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { db$, writeDb$ } from "../external/db";
import { syncArtifactUserShareBySiteId$ } from "./artifact-access-dual-write.service";

export const claimHostedSiteShareAccess$ = command(
  async (
    { get, set },
    args: { readonly siteId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const shares = await get(db$)
      .select()
      .from(hostedSiteShares)
      .where(eq(hostedSiteShares.siteId, args.siteId));
    signal.throwIfAborted();
    if (
      shares.some((share) => {
        return share.userId === args.userId;
      })
    ) {
      return true;
    }
    if (
      !shares.some((share) => {
        return share.userId === null;
      })
    ) {
      return false;
    }
    const user = await findClerkUser(get(clerk$), args.userId, signal);
    if (!user || user.banned) {
      return false;
    }
    const emails = user.emailAddresses
      .filter((address) => {
        return address.verification?.status === "verified";
      })
      .map((address) => {
        return address.emailAddress.trim().toLowerCase();
      });
    if (emails.length === 0) {
      return false;
    }
    // The conditional write cannot resurrect a revoked invitation or transfer
    // an invitation that another account has already claimed.
    const claimed = await set(writeDb$)
      .update(hostedSiteShares)
      .set({ userId: args.userId })
      .where(
        and(
          eq(hostedSiteShares.siteId, args.siteId),
          or(
            isNull(hostedSiteShares.userId),
            eq(hostedSiteShares.userId, args.userId),
          ),
          inArray(hostedSiteShares.email, emails),
        ),
      )
      .returning({
        id: hostedSiteShares.id,
        email: hostedSiteShares.email,
      });
    signal.throwIfAborted();
    if (claimed.length > 0) {
      await set(
        syncArtifactUserShareBySiteId$,
        {
          siteId: args.siteId,
          userId: args.userId,
          email: claimed[0]?.email ?? null,
        },
        signal,
      );
    }
    return claimed.length > 0;
  },
);
