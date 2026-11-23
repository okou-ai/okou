import { command, computed } from "ccstate";
import { and, asc, eq, exists, isNull } from "drizzle-orm";
import { hostedSiteShares } from "@okouai/db/schema/hosted-site-share";
import { hostedSites } from "@okouai/db/runtime/hosted-site";
import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import { db$, writeDb$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { nowDate } from "../../lib/time";
import { buildTeamFromAddress } from "./email-common.service";
import { hostedSiteWorkspaceAccounts } from "./hosted-site-share-directory.service";

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

/** The route checks current ownership before reading either directory. */
export function hostedSiteSharingReads(
  siteId: string,
  orgId: string,
  query?: string,
) {
  const shares$ = computed(async (get) => {
    return await get(db$)
      .select({
        id: hostedSiteShares.id,
        email: hostedSiteShares.email,
      })
      .from(hostedSiteShares)
      .where(eq(hostedSiteShares.siteId, siteId))
      .orderBy(asc(hostedSiteShares.createdAt), asc(hostedSiteShares.id));
  });
  const accounts$ = hostedSiteWorkspaceAccounts(orgId, { query });
  return { shares$, accounts$ };
}

export const shareHostedSite$ = command(
  async (
    { get, set },
    args: Owner & { readonly email: string },
    signal: AbortSignal,
  ) => {
    const recipients = await get(
      hostedSiteWorkspaceAccounts(args.orgId, { emailAddress: [args.email] }),
    );
    signal.throwIfAborted();
    const recipient = recipients[0];
    if (recipient?.userId === args.userId) {
      return { status: "self" as const };
    }
    const inviter = recipient
      ? null
      : await findClerkUser(get(clerk$), args.userId, signal);
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
        // Preserve a claimed identity, including if that user changed email.
        set: { email: args.email },
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
    if (share.userId !== null) {
      return {
        status: "ok" as const,
        share: { id: share.id, email: share.email },
        outboxId: null,
      };
    }
    // The grant ID is also the email operation ID. Retrying after an uncertain
    // enqueue recovers the same invitation instead of sending another email.
    await database
      .insert(emailOutbox)
      .values({
        id: share.id,
        fromAddress: buildTeamFromAddress(),
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
      .returning({ id: hostedSiteShares.id });
    signal.throwIfAborted();
    return removed ?? null;
  },
);
