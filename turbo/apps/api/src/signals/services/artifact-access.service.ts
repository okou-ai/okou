import { command } from "ccstate";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type {
  ArtifactUserShareEntry,
  ArtifactVisibilityResponse,
  ArtifactVisibilityValue,
} from "@okouai/api-contracts/contracts/artifact-access";
import type { ArtifactCatalogKind } from "@okouai/api-contracts/contracts/artifact-catalog";
import type { HostedSiteShareAccount } from "@okouai/api-contracts/contracts/hosted-site-sharing";
import {
  artifacts,
  imageArtifacts,
  presentationArtifacts,
} from "@okouai/db/schema/artifact";
import { artifactFileShares } from "@okouai/db/schema/artifact-file-share";
import { artifactUserShares } from "@okouai/db/schema/artifact-user-share";
import { hostedSites } from "@okouai/db/runtime/hosted-site";
import { hostedSiteShares } from "@okouai/db/schema/hosted-site-share";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { env } from "../../lib/env";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { nowDate } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  getHostedSiteVisibility$,
  updateHostedSiteVisibility$,
} from "./hosted-site-access.service";
import {
  removeHostedSiteShare$,
  shareHostedSite$,
} from "./hosted-site-sharing.service";
import {
  removeFileArtifactShare$,
  shareFileArtifact$,
} from "./artifact-file-sharing.service";
import {
  readArtifactShare$,
  updateArtifactShare$,
} from "./artifact-shares.service";
import {
  privateArtifactFromRow,
  privateArtifactUrl,
} from "./private-artifact-storage.service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface OwnedArtifactOwner {
  readonly artifactId: string;
  readonly userId: string;
  readonly orgId: string;
}

type ResolvedArtifactAccessTarget =
  | {
      readonly artifactId: string;
      readonly kind: ArtifactCatalogKind;
      readonly orgId: string;
      readonly userId: string;
      readonly targetKind: "site";
      readonly siteId: string;
      readonly publicSlug: string;
    }
  | {
      readonly artifactId: string;
      readonly kind: ArtifactCatalogKind;
      readonly orgId: string;
      readonly userId: string;
      readonly targetKind: "file";
      readonly fileId: string;
    };

function effectiveArtifactKind(row: {
  readonly kind: ArtifactCatalogKind;
  readonly displayKind: ArtifactCatalogKind | null;
  readonly logicalKey: string;
}): ArtifactCatalogKind {
  if (row.kind === "file" && row.logicalKey.startsWith("shared-thread:")) {
    return "shared-thread";
  }
  return row.displayKind ?? row.kind;
}

interface OwnedArtifactRow {
  readonly id: string;
  readonly kind: ArtifactCatalogKind;
  readonly displayKind: ArtifactCatalogKind | null;
  readonly entityId: string;
  readonly logicalKey: string;
  readonly projectionFileId: string | null;
  readonly orgId: string;
  readonly authorUserId: string;
}

const resolveSiteAccessTarget$ = command(
  async (
    { get },
    args: {
      readonly row: OwnedArtifactRow;
      readonly kind: ArtifactCatalogKind;
    },
    signal: AbortSignal,
  ): Promise<ResolvedArtifactAccessTarget | null> => {
    const database = get(db$);
    const { row, kind } = args;
    let siteId: string | null =
      row.kind === "hosted-site" ? row.entityId : null;
    if (!siteId && row.kind === "presentation") {
      const [presentation] = await database
        .select({ hostedSiteId: presentationArtifacts.hostedSiteId })
        .from(presentationArtifacts)
        .where(eq(presentationArtifacts.id, row.entityId))
        .limit(1);
      signal.throwIfAborted();
      siteId = presentation?.hostedSiteId ?? null;
    }
    if (!siteId && row.logicalKey.startsWith("site:")) {
      const candidate = row.logicalKey.slice("site:".length);
      if (UUID_PATTERN.test(candidate)) {
        siteId = candidate;
      }
    }
    if (!siteId) {
      return null;
    }
    const [site] = await database
      .select({ id: hostedSites.id, publicSlug: hostedSites.publicSlug })
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.id, siteId),
          eq(hostedSites.orgId, row.orgId),
          eq(hostedSites.userId, row.authorUserId),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!site) {
      return null;
    }
    return {
      artifactId: row.id,
      kind,
      orgId: row.orgId,
      userId: row.authorUserId,
      targetKind: "site",
      siteId: site.id,
      publicSlug: site.publicSlug,
    };
  },
);

const resolveFileAccessTarget$ = command(
  async (
    { get },
    args: {
      readonly row: OwnedArtifactRow;
      readonly kind: ArtifactCatalogKind;
    },
    signal: AbortSignal,
  ): Promise<ResolvedArtifactAccessTarget | null> => {
    const { row, kind } = args;
    if (row.logicalKey.startsWith("shared-thread:")) {
      return null;
    }
    let fileId: string | null =
      row.kind === "file"
        ? (row.projectionFileId ?? row.entityId)
        : row.projectionFileId;
    if (!fileId && row.kind === "image") {
      const [image] = await get(db$)
        .select({ fileId: imageArtifacts.fileId })
        .from(imageArtifacts)
        .where(eq(imageArtifacts.id, row.entityId))
        .limit(1);
      signal.throwIfAborted();
      fileId = image?.fileId ?? null;
    }
    if (!fileId) {
      return null;
    }
    return {
      artifactId: row.id,
      kind,
      orgId: row.orgId,
      userId: row.authorUserId,
      targetKind: "file",
      fileId,
    };
  },
);

export const resolveOwnedArtifactAccessTarget$ = command(
  async (
    { get, set },
    args: OwnedArtifactOwner,
    signal: AbortSignal,
  ): Promise<ResolvedArtifactAccessTarget | null> => {
    const [row] = await get(db$)
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        displayKind: artifacts.displayKind,
        entityId: artifacts.entityId,
        logicalKey: artifacts.logicalKey,
        projectionFileId: artifacts.projectionFileId,
        orgId: artifacts.orgId,
        authorUserId: artifacts.authorUserId,
      })
      .from(artifacts)
      .where(
        and(
          or(
            eq(artifacts.id, args.artifactId),
            eq(artifacts.entityId, args.artifactId),
            eq(artifacts.projectionFileId, args.artifactId),
            eq(artifacts.logicalKey, `site:${args.artifactId}`),
          ),
          eq(artifacts.orgId, args.orgId),
          eq(artifacts.authorUserId, args.userId),
          isNull(artifacts.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }

    const kind = effectiveArtifactKind(row);
    if (row.kind === "hosted-site" || row.kind === "presentation") {
      return await set(resolveSiteAccessTarget$, { row, kind }, signal);
    }
    if (row.kind === "file" || row.kind === "image" || row.kind === "video") {
      return await set(resolveFileAccessTarget$, { row, kind }, signal);
    }
    return null;
  },
);

const resolveOrganizationSummary$ = command(
  async ({ get }, orgId: string, signal: AbortSignal) => {
    const result = await settle(
      get(clerk$).organizations.getOrganization(
        { organizationId: orgId },
        undefined,
        signal,
      ),
      signal,
    );
    return {
      id: orgId,
      name: result.ok ? result.value.name : orgId,
    };
  },
);

export const getArtifactVisibility$ = command(
  async (
    { set },
    args: OwnedArtifactOwner,
    signal: AbortSignal,
  ): Promise<ArtifactVisibilityResponse | null> => {
    const resolved = await set(resolveOwnedArtifactAccessTarget$, args, signal);
    if (!resolved) {
      return null;
    }

    if (resolved.targetKind === "site") {
      const [policy, organization] = await Promise.all([
        set(
          getHostedSiteVisibility$,
          {
            siteId: resolved.siteId,
            userId: resolved.userId,
            orgId: resolved.orgId,
          },
          signal,
        ),
        set(resolveOrganizationSummary$, resolved.orgId, signal),
      ]);
      signal.throwIfAborted();
      if (!policy) {
        return null;
      }
      const siteUrl = `${hostedLinkOrigin("current", resolved.publicSlug)}/`;
      return {
        artifactId: resolved.artifactId,
        kind: resolved.kind,
        visibility: policy.visibility,
        revision: policy.revision,
        ownerUrl: siteUrl,
        shareUrl: policy.visibility === "private" ? null : siteUrl,
        shortUrl: policy.visibility === "private" ? null : siteUrl,
        organization,
      };
    }

    const share = await set(
      readArtifactShare$,
      {
        target: { kind: "file", id: resolved.fileId },
        userId: resolved.userId,
        orgId: resolved.orgId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!share) {
      return null;
    }
    return {
      artifactId: resolved.artifactId,
      kind: resolved.kind,
      visibility: share.audience,
      revision: null,
      ownerUrl: share.ownerUrl,
      shareUrl: share.url,
      shortUrl: share.shortUrl,
      organization: share.organization,
    };
  },
);

export const updateArtifactVisibility$ = command(
  async (
    { set },
    args: OwnedArtifactOwner & {
      readonly visibility: ArtifactVisibilityValue;
      readonly expectedRevision?: string | null;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: "ok"; readonly body: ArtifactVisibilityResponse }
    | { readonly status: "not_found" }
    | { readonly status: "conflict" }
  > => {
    const resolved = await set(resolveOwnedArtifactAccessTarget$, args, signal);
    if (!resolved) {
      return { status: "not_found" };
    }

    if (resolved.targetKind === "site") {
      let expectedRevision = args.expectedRevision;
      if (expectedRevision === undefined) {
        const current = await set(
          getHostedSiteVisibility$,
          {
            siteId: resolved.siteId,
            userId: resolved.userId,
            orgId: resolved.orgId,
          },
          signal,
        );
        if (!current) {
          return { status: "not_found" };
        }
        expectedRevision = current.revision;
      }
      const updated = await set(
        updateHostedSiteVisibility$,
        {
          siteId: resolved.siteId,
          userId: resolved.userId,
          orgId: resolved.orgId,
          visibility: args.visibility,
          expectedRevision,
        },
        signal,
      );
      if (updated.status === "not_found") {
        return { status: "not_found" };
      }
      if (updated.status === "conflict") {
        return { status: "conflict" };
      }
      await set(writeDb$)
        .update(artifacts)
        .set({ visibility: args.visibility, updatedAt: nowDate() })
        .where(eq(artifacts.id, resolved.artifactId));
      signal.throwIfAborted();
      const organization = await set(
        resolveOrganizationSummary$,
        resolved.orgId,
        signal,
      );
      const siteUrl = `${hostedLinkOrigin("current", resolved.publicSlug)}/`;
      return {
        status: "ok",
        body: {
          artifactId: resolved.artifactId,
          kind: resolved.kind,
          visibility: updated.body.visibility,
          revision: updated.body.revision,
          ownerUrl: siteUrl,
          shareUrl: updated.body.visibility === "private" ? null : siteUrl,
          shortUrl: updated.body.visibility === "private" ? null : siteUrl,
          organization,
        },
      };
    }

    const updated = await set(
      updateArtifactShare$,
      {
        target: { kind: "file", id: resolved.fileId },
        audience: args.visibility,
        userId: resolved.userId,
        orgId: resolved.orgId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!updated || "status" in updated) {
      return { status: "not_found" };
    }
    await set(writeDb$)
      .update(artifacts)
      .set({ visibility: args.visibility, updatedAt: nowDate() })
      .where(eq(artifacts.id, resolved.artifactId));
    signal.throwIfAborted();
    return {
      status: "ok",
      body: {
        artifactId: resolved.artifactId,
        kind: resolved.kind,
        visibility: updated.audience,
        revision: null,
        ownerUrl: updated.ownerUrl,
        shareUrl: updated.url,
        shortUrl: updated.shortUrl,
        organization: updated.organization,
      },
    };
  },
);

export const listArtifactShares$ = command(
  async (
    { get, set },
    args: OwnedArtifactOwner,
    signal: AbortSignal,
  ): Promise<ArtifactUserShareEntry[] | null> => {
    const resolved = await set(resolveOwnedArtifactAccessTarget$, args, signal);
    if (!resolved) {
      return null;
    }
    const database = get(db$);
    const [legacyShares, userShares] = await Promise.all([
      resolved.targetKind === "site"
        ? database
            .select({
              id: hostedSiteShares.id,
              userId: hostedSiteShares.userId,
              email: hostedSiteShares.email,
            })
            .from(hostedSiteShares)
            .where(eq(hostedSiteShares.siteId, resolved.siteId))
            .orderBy(asc(hostedSiteShares.createdAt), asc(hostedSiteShares.id))
        : database
            .select({
              id: artifactFileShares.id,
              userId: artifactFileShares.userId,
              email: artifactFileShares.email,
            })
            .from(artifactFileShares)
            .where(eq(artifactFileShares.fileId, resolved.fileId))
            .orderBy(
              asc(artifactFileShares.createdAt),
              asc(artifactFileShares.id),
            ),
      database
        .select({
          userId: artifactUserShares.userId,
          email: artifactUserShares.email,
        })
        .from(artifactUserShares)
        .where(eq(artifactUserShares.artifactId, resolved.artifactId))
        .orderBy(
          asc(artifactUserShares.createdAt),
          asc(artifactUserShares.userId),
        ),
    ]);
    signal.throwIfAborted();

    const seenUserIds = new Set<string>();
    const results: ArtifactUserShareEntry[] = [];
    for (const share of legacyShares) {
      if (share.userId) {
        seenUserIds.add(share.userId);
      }
      results.push({
        id: share.id,
        userId: share.userId,
        email: share.email,
      });
    }
    for (const share of userShares) {
      if (seenUserIds.has(share.userId)) {
        continue;
      }
      seenUserIds.add(share.userId);
      results.push({
        id: share.userId,
        userId: share.userId,
        email: share.email ?? share.userId,
      });
    }
    return results;
  },
);

export const addArtifactShare$ = command(
  async (
    { get, set },
    args: OwnedArtifactOwner & {
      readonly email: string;
      readonly recipient: HostedSiteShareAccount | undefined;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly status: "ok";
        readonly share: ArtifactUserShareEntry;
        readonly outboxId: string | null;
      }
    | { readonly status: "self" }
    | { readonly status: "not_found" }
  > => {
    const resolved = await set(resolveOwnedArtifactAccessTarget$, args, signal);
    if (!resolved) {
      return { status: "not_found" };
    }

    if (resolved.targetKind === "site") {
      const result = await set(
        shareHostedSite$,
        {
          siteId: resolved.siteId,
          userId: resolved.userId,
          orgId: resolved.orgId,
          email: args.email,
          recipient: args.recipient,
        },
        signal,
      );
      if (result.status !== "ok") {
        return result;
      }
      return {
        status: "ok",
        share: {
          id: result.share.id,
          userId: args.recipient?.userId ?? null,
          email: result.share.email,
        },
        outboxId: result.outboxId,
      };
    }

    const [row] = await get(db$)
      .select()
      .from(runUploadedFiles)
      .where(
        and(
          eq(runUploadedFiles.id, resolved.fileId),
          eq(runUploadedFiles.userId, resolved.userId),
          eq(runUploadedFiles.orgId, resolved.orgId),
          isNull(runUploadedFiles.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const file = privateArtifactFromRow(row);
    if (file?.materializationStatus !== "ready") {
      return { status: "not_found" };
    }
    const resource = {
      kind: "file" as const,
      id: file.id,
      userId: resolved.userId,
      orgId: resolved.orgId,
      url: new URL(
        privateArtifactUrl(file.id, file.filename, file.metadata),
        env("APP_URL"),
      ).href,
    };
    const result = await set(
      shareFileArtifact$,
      {
        resource,
        email: args.email,
        recipient: args.recipient,
      },
      signal,
    );
    if (result.status !== "ok") {
      return result;
    }
    return {
      status: "ok",
      share: {
        id: result.share.id,
        userId: args.recipient?.userId ?? null,
        email: result.share.email,
      },
      outboxId: result.outboxId,
    };
  },
);

export const removeArtifactShare$ = command(
  async (
    { get, set },
    args: OwnedArtifactOwner & { readonly shareId: string },
    signal: AbortSignal,
  ): Promise<{ readonly removed: string } | null> => {
    const resolved = await set(resolveOwnedArtifactAccessTarget$, args, signal);
    if (!resolved) {
      return null;
    }
    const isUuid = UUID_PATTERN.test(args.shareId);
    const database = set(writeDb$);

    if (resolved.targetKind === "site") {
      let removedId: string | null = null;
      if (isUuid) {
        const legacyRemoved = await set(
          removeHostedSiteShare$,
          {
            siteId: resolved.siteId,
            userId: resolved.userId,
            orgId: resolved.orgId,
            shareId: args.shareId,
          },
          signal,
        );
        if (legacyRemoved) {
          removedId = legacyRemoved.id;
        }
      } else {
        const legacyRows = await database
          .delete(hostedSiteShares)
          .where(
            and(
              eq(hostedSiteShares.siteId, resolved.siteId),
              eq(hostedSiteShares.userId, args.shareId),
            ),
          )
          .returning({ id: hostedSiteShares.id });
        signal.throwIfAborted();
        if (legacyRows.length > 0) {
          removedId = args.shareId;
        }
      }

      const [userShareRemoved] = await database
        .delete(artifactUserShares)
        .where(
          and(
            eq(artifactUserShares.artifactId, resolved.artifactId),
            eq(artifactUserShares.orgId, resolved.orgId),
            eq(artifactUserShares.userId, args.shareId),
          ),
        )
        .returning({ userId: artifactUserShares.userId });
      signal.throwIfAborted();
      if (userShareRemoved && !removedId) {
        removedId = userShareRemoved.userId;
      }
      return removedId ? { removed: removedId } : null;
    }

    let removedId: string | null = null;
    if (isUuid) {
      const [row] = await get(db$)
        .select({ id: runUploadedFiles.id })
        .from(runUploadedFiles)
        .where(
          and(
            eq(runUploadedFiles.id, resolved.fileId),
            eq(runUploadedFiles.userId, resolved.userId),
            eq(runUploadedFiles.orgId, resolved.orgId),
            isNull(runUploadedFiles.deletedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (row) {
        const legacyRemoved = await set(
          removeFileArtifactShare$,
          {
            resource: {
              kind: "file",
              id: resolved.fileId,
              userId: resolved.userId,
              orgId: resolved.orgId,
              url: "",
            },
            shareId: args.shareId,
          },
          signal,
        );
        if (legacyRemoved) {
          removedId = legacyRemoved.id;
        }
      }
    } else {
      const legacyRows = await database
        .delete(artifactFileShares)
        .where(
          and(
            eq(artifactFileShares.fileId, resolved.fileId),
            eq(artifactFileShares.userId, args.shareId),
          ),
        )
        .returning({ id: artifactFileShares.id });
      signal.throwIfAborted();
      if (legacyRows.length > 0) {
        removedId = args.shareId;
      }
    }

    const [userShareRemoved] = await database
      .delete(artifactUserShares)
      .where(
        and(
          eq(artifactUserShares.artifactId, resolved.artifactId),
          eq(artifactUserShares.orgId, resolved.orgId),
          or(eq(artifactUserShares.userId, args.shareId)),
        ),
      )
      .returning({ userId: artifactUserShares.userId });
    signal.throwIfAborted();
    if (userShareRemoved && !removedId) {
      removedId = userShareRemoved.userId;
    }
    return removedId ? { removed: removedId } : null;
  },
);
