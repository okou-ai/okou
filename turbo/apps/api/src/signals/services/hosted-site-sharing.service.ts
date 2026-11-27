import { command, computed, type Computed } from "ccstate";
import { and, asc, eq, exists, isNull, sql } from "drizzle-orm";
import type { HostedSiteShareAccount } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import { hostedSiteShares } from "@okouai/db/schema/hosted-site-share";
import { hostedSites } from "@okouai/db/runtime/hosted-site";
import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import { db$, writeDb$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { nowDate } from "../../lib/time";
import hostedSiteInvitationTemplate from "../../lib/hosted-site-invitation-template.json";
import {
  deleteArtifactUserShareBySiteId$,
  syncArtifactUserShareBySiteId$,
} from "./artifact-access-dual-write.service";

interface Owner {
  readonly siteId: string;
  readonly userId: string;
  readonly orgId: string;
}

function ownedSite(owner: Owner) {
  return and(
    eq(hostedSites.id, owner.siteId),
    eq(hostedSites.userId, owner.userId),
    eq(hostedSites.orgId, owner.orgId),
    eq(hostedSites.linkLayoutSegment, "okou"),
    isNull(hostedSites.deletedAt),
  );
}

/** The route verifies current ownership before consuming the list. */
export function hostedSiteShareList(siteId$: Computed<string>) {
  return computed(async (get) => {
    return await get(db$)
      .select({
        id: hostedSiteShares.id,
        email: hostedSiteShares.email,
      })
      .from(hostedSiteShares)
      .where(eq(hostedSiteShares.siteId, get(siteId$)))
      .orderBy(asc(hostedSiteShares.createdAt), asc(hostedSiteShares.id));
  });
}

export const shareHostedSite$ = command(
  async (
    { get, set },
    args: Owner & {
      readonly email: string;
      readonly recipient: HostedSiteShareAccount | undefined;
    },
    signal: AbortSignal,
  ) => {
    const { recipient } = args;
    if (recipient?.userId === args.userId) {
      return { status: "self" as const };
    }
    const inviter = await findClerkUser(get(clerk$), args.userId, signal);
    const database = set(writeDb$);
    const [site] = await database
      .select({ publicSlug: hostedSites.publicSlug })
      .from(hostedSites)
      .where(ownedSite(args))
      .limit(1);
    signal.throwIfAborted();
    if (!site) {
      return { status: "not_found" as const };
    }
    const [share] = await database
      .insert(hostedSiteShares)
      .values({
        siteId: args.siteId,
        email: args.email,
        userId: recipient?.userId ?? null,
      })
      .onConflictDoUpdate({
        target: [hostedSiteShares.siteId, hostedSiteShares.email],
        // Preserve a claimed identity, or claim a previously unclaimed row.
        set: {
          email: args.email,
          userId: sql`COALESCE(${hostedSiteShares.userId}, ${recipient?.userId ?? null})`,
        },
      })
      .returning({
        id: hostedSiteShares.id,
        email: hostedSiteShares.email,
        userId: hostedSiteShares.userId,
      });
    signal.throwIfAborted();
    if (!share) {
      throw new Error("Website sharing did not return its grant");
    }
    if (share.userId) {
      await set(
        syncArtifactUserShareBySiteId$,
        { siteId: args.siteId, userId: share.userId, email: share.email },
        signal,
      );
    }
    // The grant ID is also the email operation ID. Retrying after an uncertain
    // enqueue recovers the same invitation instead of sending another email.
    await database
      .insert(emailOutbox)
      .values({
        id: share.id,
        fromAddress: hostedSiteInvitationTemplate.from,
        toAddresses: args.email,
        subject: "You’re invited to view a website on Okou",
        template: {
          template: "hosted-site-invitation",
          props: {
            inviterName:
              [inviter?.firstName, inviter?.lastName]
                .filter(Boolean)
                .join(" ") || "An Okou user",
            email: args.email,
            siteUrl: `${hostedLinkOrigin("current", site.publicSlug)}/`,
          },
        },
        createdAt: nowDate(),
      })
      .onConflictDoNothing({ target: emailOutbox.id });
    signal.throwIfAborted();
    return {
      status: "ok" as const,
      share: { id: share.id, email: share.email },
      outboxId: share.id,
    };
  },
);

export const removeHostedSiteShare$ = command(
  async (
    { set },
    args: Owner & { readonly shareId: string },
    signal: AbortSignal,
  ) => {
    const database = set(writeDb$);
    const [removed] = await database
      .delete(hostedSiteShares)
      .where(
        and(
          eq(hostedSiteShares.id, args.shareId),
          eq(hostedSiteShares.siteId, args.siteId),
          exists(
            database
              .select({ id: hostedSites.id })
              .from(hostedSites)
              .where(ownedSite(args)),
          ),
        ),
      )
      .returning({
        id: hostedSiteShares.id,
        userId: hostedSiteShares.userId,
      });
    signal.throwIfAborted();
    if (removed?.userId) {
      await set(
        deleteArtifactUserShareBySiteId$,
        { siteId: args.siteId, userId: removed.userId },
        signal,
      );
    }
    return removed ? { id: removed.id } : null;
  },
);
