/**
 * Release 1 rollout dual-write helpers mirroring legacy visibility/share writes
 * into `artifacts.visibility` and `artifact_user_shares`.
 * Surface: DB vs API & old clients -> API.
 * Remove in Release 2 once outgoing API drains, client-version floor excludes
 * legacy endpoints, and `artifacts.visibility` / `artifact_user_shares` become
 * sole authorities.
 */
import { command } from "ccstate";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  artifacts,
  imageArtifacts,
  presentationArtifacts,
  type ArtifactVisibility,
} from "@okouai/db/schema/artifact";
import { artifactUserShares } from "@okouai/db/schema/artifact-user-share";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";

/**
 * Resolve active `artifacts` rows associated with a hosted site (covers both
 * `hosted-site` and `presentation` artifacts, plus `site:<siteId>` logical keys).
 */
const findActiveArtifactsBySiteId$ = command(
  async ({ set }, siteId: string, signal: AbortSignal) => {
    const database = set(writeDb$);
    const [presentation] = await database
      .select({ id: presentationArtifacts.id })
      .from(presentationArtifacts)
      .where(eq(presentationArtifacts.hostedSiteId, siteId))
      .limit(1);
    signal.throwIfAborted();
    const matchers = [
      and(eq(artifacts.kind, "hosted-site"), eq(artifacts.entityId, siteId)),
      eq(artifacts.logicalKey, `site:${siteId}`),
    ];
    if (presentation) {
      matchers.push(
        and(
          eq(artifacts.kind, "presentation"),
          eq(artifacts.entityId, presentation.id),
        ),
      );
    }
    const rows = await database
      .select({ id: artifacts.id, orgId: artifacts.orgId })
      .from(artifacts)
      .where(and(isNull(artifacts.deletedAt), or(...matchers)));
    signal.throwIfAborted();
    return rows;
  },
);

/**
 * Resolve active `artifacts` rows associated with a binary file (covers both
 * `file` and `image` artifacts, plus `projection_file_id`).
 */
const findActiveArtifactsByFileId$ = command(
  async ({ set }, fileId: string, signal: AbortSignal) => {
    const database = set(writeDb$);
    const [image] = await database
      .select({ id: imageArtifacts.id })
      .from(imageArtifacts)
      .where(eq(imageArtifacts.fileId, fileId))
      .limit(1);
    signal.throwIfAborted();
    const matchers = [
      eq(artifacts.projectionFileId, fileId),
      and(eq(artifacts.kind, "file"), eq(artifacts.entityId, fileId)),
    ];
    if (image) {
      matchers.push(
        and(eq(artifacts.kind, "image"), eq(artifacts.entityId, image.id)),
      );
    }
    const rows = await database
      .select({ id: artifacts.id, orgId: artifacts.orgId })
      .from(artifacts)
      .where(and(isNull(artifacts.deletedAt), or(...matchers)));
    signal.throwIfAborted();
    return rows;
  },
);

/** Dual-write `artifacts.visibility` when a hosted site's visibility changes. */
export const syncArtifactVisibilityBySiteId$ = command(
  async (
    { set },
    args: { readonly siteId: string; readonly visibility: ArtifactVisibility },
    signal: AbortSignal,
  ) => {
    const matched = await set(
      findActiveArtifactsBySiteId$,
      args.siteId,
      signal,
    );
    if (matched.length === 0) {
      return;
    }
    await set(writeDb$)
      .update(artifacts)
      .set({ visibility: args.visibility, updatedAt: nowDate() })
      .where(
        inArray(
          artifacts.id,
          matched.map((row) => {
            return row.id;
          }),
        ),
      );
    signal.throwIfAborted();
  },
);

/** Dual-write `artifacts.visibility` when a file's R2 share policy changes. */
export const syncArtifactVisibilityByFileId$ = command(
  async (
    { set },
    args: { readonly fileId: string; readonly visibility: ArtifactVisibility },
    signal: AbortSignal,
  ) => {
    const matched = await set(
      findActiveArtifactsByFileId$,
      args.fileId,
      signal,
    );
    if (matched.length === 0) {
      return;
    }
    await set(writeDb$)
      .update(artifacts)
      .set({ visibility: args.visibility, updatedAt: nowDate() })
      .where(
        inArray(
          artifacts.id,
          matched.map((row) => {
            return row.id;
          }),
        ),
      );
    signal.throwIfAborted();
  },
);

/** Dual-write a claimed per-user grant into `artifact_user_shares` for a site. */
export const syncArtifactUserShareBySiteId$ = command(
  async (
    { set },
    args: {
      readonly siteId: string;
      readonly userId: string;
      readonly email: string;
    },
    signal: AbortSignal,
  ) => {
    const matched = await set(
      findActiveArtifactsBySiteId$,
      args.siteId,
      signal,
    );
    if (matched.length === 0) {
      return;
    }
    await set(writeDb$)
      .insert(artifactUserShares)
      .values(
        matched.map((row) => {
          return {
            userId: args.userId,
            orgId: row.orgId,
            artifactId: row.id,
            email: args.email,
          };
        }),
      )
      .onConflictDoUpdate({
        target: [
          artifactUserShares.userId,
          artifactUserShares.orgId,
          artifactUserShares.artifactId,
        ],
        set: { email: args.email },
      });
    signal.throwIfAborted();
  },
);

/** Remove a user's grant from `artifact_user_shares` when removed from a site. */
export const deleteArtifactUserShareBySiteId$ = command(
  async (
    { set },
    args: { readonly siteId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const matched = await set(
      findActiveArtifactsBySiteId$,
      args.siteId,
      signal,
    );
    if (matched.length === 0) {
      return;
    }
    await set(writeDb$)
      .delete(artifactUserShares)
      .where(
        and(
          eq(artifactUserShares.userId, args.userId),
          inArray(
            artifactUserShares.artifactId,
            matched.map((row) => {
              return row.id;
            }),
          ),
        ),
      );
    signal.throwIfAborted();
  },
);

/** Dual-write a claimed per-user grant into `artifact_user_shares` for a file. */
export const syncArtifactUserShareByFileId$ = command(
  async (
    { set },
    args: {
      readonly fileId: string;
      readonly userId: string;
      readonly email: string;
    },
    signal: AbortSignal,
  ) => {
    const matched = await set(
      findActiveArtifactsByFileId$,
      args.fileId,
      signal,
    );
    if (matched.length === 0) {
      return;
    }
    await set(writeDb$)
      .insert(artifactUserShares)
      .values(
        matched.map((row) => {
          return {
            userId: args.userId,
            orgId: row.orgId,
            artifactId: row.id,
            email: args.email,
          };
        }),
      )
      .onConflictDoUpdate({
        target: [
          artifactUserShares.userId,
          artifactUserShares.orgId,
          artifactUserShares.artifactId,
        ],
        set: { email: args.email },
      });
    signal.throwIfAborted();
  },
);

/** Remove a user's grant from `artifact_user_shares` when removed from a file. */
export const deleteArtifactUserShareByFileId$ = command(
  async (
    { set },
    args: { readonly fileId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const matched = await set(
      findActiveArtifactsByFileId$,
      args.fileId,
      signal,
    );
    if (matched.length === 0) {
      return;
    }
    await set(writeDb$)
      .delete(artifactUserShares)
      .where(
        and(
          eq(artifactUserShares.userId, args.userId),
          inArray(
            artifactUserShares.artifactId,
            matched.map((row) => {
              return row.id;
            }),
          ),
        ),
      );
    signal.throwIfAborted();
  },
);
