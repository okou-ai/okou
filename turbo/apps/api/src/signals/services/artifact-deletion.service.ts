import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import type { ArtifactCatalogDeleteRouteResponse } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifacts, presentationArtifacts } from "@okouai/db/schema/artifact";
import { hostedSites } from "@okouai/db/runtime/hosted-site";

import { notConfigured, notFound } from "../../lib/error";
import {
  isSharedThreadArtifactLogicalKey,
  sharedThreadArtifactAuthorUserId,
} from "../../lib/shared-thread-artifact";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { deleteSharedThread$ } from "./shared-thread-artifacts.service";
import { deleteHostedSite$ } from "./host.service";

interface ArtifactOwner {
  readonly userId: string;
  readonly orgId: string;
}

interface ArtifactWithdrawalArgs extends ArtifactOwner {
  readonly artifact: typeof artifacts.$inferSelect;
}

function ownedArtifactFilter(artifactId: string, owner: ArtifactOwner) {
  return and(
    eq(artifacts.id, artifactId),
    eq(artifacts.orgId, owner.orgId),
    inArray(artifacts.authorUserId, [
      owner.userId,
      sharedThreadArtifactAuthorUserId(owner.userId),
    ]),
  );
}

const withdrawHostedArtifact$ = command(
  async (
    { get, set },
    { artifact, ...owner }: ArtifactWithdrawalArgs,
    signal: AbortSignal,
  ): Promise<Exclude<
    ArtifactCatalogDeleteRouteResponse,
    { readonly status: 200 }
  > | null> => {
    const db = get(db$);
    let siteId = artifact.entityId;
    if (artifact.kind === "presentation") {
      const [presentation] = await db
        .select({ siteId: presentationArtifacts.hostedSiteId })
        .from(presentationArtifacts)
        .where(eq(presentationArtifacts.id, artifact.entityId))
        .limit(1);
      signal.throwIfAborted();
      if (!presentation) {
        return notFound("Artifact not found");
      }
      siteId = presentation.siteId;
    }
    const [site] = await db
      .select({ publicSlug: hostedSites.publicSlug })
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.id, siteId),
          eq(hostedSites.userId, owner.userId),
          eq(hostedSites.orgId, owner.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!site) {
      return notFound("Artifact not found");
    }
    const result = await set(
      deleteHostedSite$,
      { ...owner, publicSlug: site.publicSlug },
      signal,
    );
    signal.throwIfAborted();
    if (result.status === "config_error") {
      return notConfigured(result.message);
    }
    if (result.status === "not_found") {
      return notFound("Artifact not found");
    }
    return null;
  },
);

/**
 * Soft-delete an artifact from the Library catalog.
 *
 * Principle 4 (Library delete boundary): file-backed artifacts only mark
 * `artifacts.deleted_at`; the underlying `files` record and object bytes stay
 * intact so chat history remains readable by `(ownerUserId, orgId)`, while
 * non-owner visibility and per-user shares stop applying automatically.
 */
export const deleteArtifact$ = command(
  async (
    { set },
    args: ArtifactOwner & { readonly artifactId: string },
    signal: AbortSignal,
  ): Promise<ArtifactCatalogDeleteRouteResponse> => {
    const db = set(writeDb$);
    const ownership = ownedArtifactFilter(args.artifactId, args);
    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(ownership)
      .limit(1);
    signal.throwIfAborted();
    if (!artifact) {
      return notFound("Artifact not found");
    }
    const deletedAt = artifact.deletedAt ?? nowDate();
    const hosted =
      artifact.kind === "hosted-site" || artifact.kind === "presentation";
    const withdrawal = { artifact, userId: args.userId, orgId: args.orgId };
    if (hosted && !artifact.deletedAt) {
      const denied = await set(withdrawHostedArtifact$, withdrawal, signal);
      signal.throwIfAborted();
      if (denied) {
        return denied;
      }
    }
    if (isSharedThreadArtifactLogicalKey(artifact.logicalKey)) {
      await set(
        deleteSharedThread$,
        { id: artifact.entityId, userId: args.userId, orgId: args.orgId },
        signal,
      );
      signal.throwIfAborted();
    }
    await db
      .update(artifacts)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(ownership);
    signal.throwIfAborted();
    return { status: 200, body: { deleted: true } };
  },
);
