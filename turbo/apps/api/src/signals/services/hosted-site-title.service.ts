import { command } from "ccstate";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { hostedSites } from "@okouai/db/runtime/hosted-site";
import { artifacts, presentationArtifacts } from "@okouai/db/schema/artifact";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  hostedSiteDirectArtifact,
  hostedSiteDirectArtifactJoin,
  hostedSitePresentationArtifact,
  hostedSitePresentationArtifactJoin,
} from "./hosted-site-artifact.service";

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
    const db = set(writeDb$);
    const target = db.$with("target").as(
      db
        .select({
          siteId: hostedSites.id,
          publicSlug: hostedSites.publicSlug,
          artifactId:
            sql`COALESCE(${hostedSiteDirectArtifact.id}, ${hostedSitePresentationArtifact.id})`
              .mapWith(artifacts.id)
              .as("artifact_id"),
        })
        .from(hostedSites)
        .leftJoin(
          presentationArtifacts,
          eq(presentationArtifacts.hostedSiteId, hostedSites.id),
        )
        .leftJoin(
          hostedSiteDirectArtifact,
          hostedSiteDirectArtifactJoin({ matchAuthor: true }),
        )
        .leftJoin(
          hostedSitePresentationArtifact,
          hostedSitePresentationArtifactJoin({ matchAuthor: true }),
        )
        .where(
          and(
            eq(hostedSites.orgId, args.orgId),
            eq(hostedSites.userId, args.userId),
            eq(hostedSites.publicSlug, args.publicSlug),
            isNull(hostedSites.deletedAt),
            or(
              isNotNull(hostedSiteDirectArtifact.id),
              isNotNull(hostedSitePresentationArtifact.id),
            ),
          ),
        )
        .limit(1),
    );
    const [site] = await db
      .with(target)
      .update(artifacts)
      .set({ title: args.title, updatedAt: nowDate() })
      .from(target)
      .where(
        and(
          eq(artifacts.id, target.artifactId),
          eq(artifacts.orgId, args.orgId),
          eq(artifacts.authorUserId, args.userId),
        ),
      )
      .returning({
        siteId: target.siteId,
        publicSlug: target.publicSlug,
        title: artifacts.title,
      });
    signal.throwIfAborted();
    return site ?? null;
  },
);
