import { computed, type Computed } from "ccstate";
import { and, asc, eq, isNull } from "drizzle-orm";
import { artifactFileShares } from "@okouai/db/schema/artifact-file-share";
import { hostedSiteShares } from "@okouai/db/schema/hosted-site-share";
import { hostedSites } from "@okouai/db/runtime/hosted-site";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { env } from "../../lib/env";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { db$ } from "../external/db";
import {
  privateArtifactFromRow,
  privateArtifactUrl,
} from "./private-artifact-storage.service";

export interface ArtifactSharingResource {
  readonly kind: "file" | "site";
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly url: string;
}

type OwnerInput = Omit<ArtifactSharingResource, "url">;

export function artifactSharingResource(input$: Computed<OwnerInput>) {
  return computed(async (get): Promise<ArtifactSharingResource | null> => {
    const input = get(input$);
    if (input.kind === "file") {
      const [row] = await get(db$)
        .select()
        .from(runUploadedFiles)
        .where(
          and(
            eq(runUploadedFiles.id, input.id),
            eq(runUploadedFiles.userId, input.userId),
            eq(runUploadedFiles.orgId, input.orgId),
            isNull(runUploadedFiles.deletedAt),
          ),
        )
        .limit(1);
      const file = privateArtifactFromRow(row);
      return file?.materializationStatus === "ready"
        ? {
            ...input,
            url: new URL(
              privateArtifactUrl(file.id, file.filename, file.metadata),
              env("APP_URL"),
            ).href,
          }
        : null;
    }
    const [site] = await get(db$)
      .select({ publicSlug: hostedSites.publicSlug })
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.id, input.id),
          eq(hostedSites.userId, input.userId),
          eq(hostedSites.orgId, input.orgId),
          eq(hostedSites.linkLayoutSegment, "okou"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    return site
      ? { ...input, url: `${hostedLinkOrigin("current", site.publicSlug)}/` }
      : null;
  });
}

export function artifactSharingRecipients(
  resource$: Computed<Promise<ArtifactSharingResource | null>>,
) {
  return computed(async (get) => {
    const resource = await get(resource$);
    if (!resource) {
      return [];
    }
    return resource.kind === "file"
      ? await get(db$)
          .select({
            id: artifactFileShares.id,
            email: artifactFileShares.email,
          })
          .from(artifactFileShares)
          .where(eq(artifactFileShares.fileId, resource.id))
          .orderBy(
            asc(artifactFileShares.createdAt),
            asc(artifactFileShares.id),
          )
      : await get(db$)
          .select({ id: hostedSiteShares.id, email: hostedSiteShares.email })
          .from(hostedSiteShares)
          .where(eq(hostedSiteShares.siteId, resource.id))
          .orderBy(asc(hostedSiteShares.createdAt), asc(hostedSiteShares.id));
  });
}
