import { command } from "ccstate";
import { and, asc, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import type {
  ArtifactAccessKind,
  ArtifactShareAccount,
  ArtifactUserShareEntry,
  ArtifactVisibilityResponse,
  ArtifactVisibilityValue,
} from "@okouai/api-contracts/contracts/artifact-access";
import type { ArtifactCatalogKind } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifacts,
  imageArtifacts,
  presentationArtifacts,
} from "@okouai/db/schema/artifact";
import { artifactFileShares } from "@okouai/db/schema/artifact-file-share";
import { artifactUserShares } from "@okouai/db/schema/artifact-user-share";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import { hostedSiteShares } from "@okouai/db/schema/hosted-site-share";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { env } from "../../lib/env";
import { canonicalOkouArtifactCatalogUrl } from "../../lib/file-url";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { nowDate } from "../../lib/time";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { safeUrlParse, settle } from "../utils";
import {
  getHostedSiteVisibility$,
  updateHostedSiteVisibility$,
} from "./hosted-site-access.service";
import { shareHostedSite$ } from "./hosted-site-sharing.service";
import { shareFileArtifact$ } from "./artifact-file-sharing.service";
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
      readonly kind: ArtifactAccessKind;
      readonly orgId: string;
      readonly userId: string;
      readonly targetKind: "site";
      readonly siteId: string;
      readonly publicSlug: string;
      readonly hasArtifactRow: boolean;
      readonly currentVisibility: ArtifactVisibilityValue;
    }
  | {
      readonly artifactId: string;
      readonly kind: ArtifactAccessKind;
      readonly orgId: string;
      readonly userId: string;
      readonly targetKind: "file";
      readonly fileId: string;
      readonly currentVisibility: ArtifactVisibilityValue;
    }
  | {
      readonly artifactId: string;
      readonly kind: ArtifactAccessKind;
      readonly orgId: string;
      readonly userId: string;
      readonly targetKind: "legacy-html-deployment";
      readonly deploymentId: string;
      readonly siteId: string;
    };

function fileArtifactLogicalKey(url: string): string {
  const parsed = safeUrlParse(url);
  return `file:${parsed ? (canonicalOkouArtifactCatalogUrl(parsed) ?? url) : url}`;
}

/** Map historical DB `video` rows onto `file` so retired kinds stay out of the unified contract. */
function effectiveArtifactAccessKind(row: {
  readonly kind: ArtifactCatalogKind;
  readonly displayKind: ArtifactCatalogKind | null;
  readonly logicalKey: string;
}): ArtifactAccessKind {
  if (row.kind === "file" && row.logicalKey.startsWith("shared-thread:")) {
    return "shared-thread";
  }
  const resolved = row.displayKind ?? row.kind;
  return resolved === "video" ? "file" : resolved;
}

interface OwnedArtifactRow {
  readonly id: string;
  readonly kind: ArtifactCatalogKind;
  readonly displayKind: ArtifactCatalogKind | null;
  readonly entityId: string;
  readonly logicalKey: string;
  readonly projectionFileId: string | null;
  readonly visibility: ArtifactVisibilityValue;
  readonly orgId: string;
  readonly authorUserId: string;
}

const OWNED_ARTIFACT_SELECTION = {
  id: artifacts.id,
  kind: artifacts.kind,
  displayKind: artifacts.displayKind,
  entityId: artifacts.entityId,
  logicalKey: artifacts.logicalKey,
  projectionFileId: artifacts.projectionFileId,
  visibility: artifacts.visibility,
  orgId: artifacts.orgId,
  authorUserId: artifacts.authorUserId,
} as const;

const resolveSiteAccessTarget$ = command(
  async (
    { get },
    args: {
      readonly row: OwnedArtifactRow;
      readonly kind: ArtifactAccessKind;
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
      hasArtifactRow: true,
      currentVisibility: row.visibility,
    };
  },
);

const resolveFileAccessTarget$ = command(
  async (
    { get },
    args: {
      readonly row: OwnedArtifactRow;
      readonly kind: ArtifactAccessKind;
    },
    signal: AbortSignal,
  ): Promise<ResolvedArtifactAccessTarget | null> => {
    const { row, kind } = args;
    if (row.logicalKey.startsWith("shared-thread:")) {
      return null;
    }
    const database = get(db$);
    let fileId: string | null = null;
    if (row.kind === "image") {
      const [image] = await database
        .select({ fileId: imageArtifacts.fileId })
        .from(imageArtifacts)
        .where(eq(imageArtifacts.id, row.entityId))
        .limit(1);
      signal.throwIfAborted();
      fileId = image?.fileId ?? row.projectionFileId;
    } else if (row.kind === "file") {
      // Prefer entityId (the canonical private artifact row) over
      // projectionFileId, which can point to a newer run-association shadow row.
      fileId = row.entityId ?? row.projectionFileId;
    } else {
      fileId = row.projectionFileId;
    }
    if (!fileId) {
      return null;
    }
    // If the resolved run_uploaded_files row is a run-association shadow row
    // (storage_key IS NULL, external_id = canonical private file UUID), resolve
    // through to the canonical private file row.
    const [candidate] = await database
      .select({
        id: runUploadedFiles.id,
        storageKey: runUploadedFiles.storageKey,
        externalId: runUploadedFiles.externalId,
      })
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.id, fileId))
      .limit(1);
    signal.throwIfAborted();
    if (
      candidate &&
      !candidate.storageKey &&
      candidate.externalId !== candidate.id &&
      UUID_PATTERN.test(candidate.externalId)
    ) {
      const [canonical] = await database
        .select({ id: runUploadedFiles.id })
        .from(runUploadedFiles)
        .where(
          and(
            eq(runUploadedFiles.id, candidate.externalId),
            isNotNull(runUploadedFiles.storageKey),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (canonical) {
        fileId = canonical.id;
      }
    }
    return {
      artifactId: row.id,
      kind,
      orgId: row.orgId,
      userId: row.authorUserId,
      targetKind: "file",
      fileId,
      currentVisibility: row.visibility,
    };
  },
);

const findOwnedArtifactBySiteId$ = command(
  async (
    { get },
    args: {
      readonly siteId: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<OwnedArtifactRow | null> => {
    const database = get(db$);
    const [presentation] = await database
      .select({ id: presentationArtifacts.id })
      .from(presentationArtifacts)
      .where(eq(presentationArtifacts.hostedSiteId, args.siteId))
      .limit(1);
    signal.throwIfAborted();
    const matchers = [
      and(
        eq(artifacts.kind, "hosted-site"),
        eq(artifacts.entityId, args.siteId),
      ),
      eq(artifacts.logicalKey, `site:${args.siteId}`),
    ];
    if (presentation) {
      matchers.push(
        and(
          eq(artifacts.kind, "presentation"),
          eq(artifacts.entityId, presentation.id),
        ),
      );
    }
    const [row] = await database
      .select(OWNED_ARTIFACT_SELECTION)
      .from(artifacts)
      .where(
        and(
          or(...matchers),
          eq(artifacts.orgId, args.orgId),
          eq(artifacts.authorUserId, args.userId),
          isNull(artifacts.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row ?? null;
  },
);

const findOwnedArtifactByRelatedId$ = command(
  async (
    { get, set },
    args: OwnedArtifactOwner,
    signal: AbortSignal,
  ): Promise<OwnedArtifactRow | null> => {
    const database = get(db$);
    const [image] = await database
      .select({ id: imageArtifacts.id })
      .from(imageArtifacts)
      .where(eq(imageArtifacts.fileId, args.artifactId))
      .limit(1);
    signal.throwIfAborted();
    if (image) {
      const [row] = await database
        .select(OWNED_ARTIFACT_SELECTION)
        .from(artifacts)
        .where(
          and(
            eq(artifacts.kind, "image"),
            eq(artifacts.entityId, image.id),
            eq(artifacts.orgId, args.orgId),
            eq(artifacts.authorUserId, args.userId),
            isNull(artifacts.deletedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (row) {
        return row;
      }
    }

    const [sourceFile] = await database
      .select({ url: runUploadedFiles.url })
      .from(runUploadedFiles)
      .where(
        and(
          eq(runUploadedFiles.id, args.artifactId),
          eq(runUploadedFiles.orgId, args.orgId),
          eq(runUploadedFiles.userId, args.userId),
          isNotNull(runUploadedFiles.url),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (sourceFile?.url) {
      const [byLogicalKey] = await database
        .select(OWNED_ARTIFACT_SELECTION)
        .from(artifacts)
        .where(
          and(
            eq(artifacts.orgId, args.orgId),
            eq(artifacts.authorUserId, args.userId),
            eq(artifacts.logicalKey, fileArtifactLogicalKey(sourceFile.url)),
            isNull(artifacts.deletedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (byLogicalKey) {
        return byLogicalKey;
      }
    }

    const bySite = await set(
      findOwnedArtifactBySiteId$,
      { siteId: args.artifactId, userId: args.userId, orgId: args.orgId },
      signal,
    );
    if (bySite) {
      return bySite;
    }

    const [deployment] = await database
      .select({ siteId: hostedDeployments.siteId })
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, args.artifactId),
          eq(hostedDeployments.userId, args.userId),
          eq(hostedDeployments.orgId, args.orgId),
          eq(hostedDeployments.status, "ready"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!deployment) {
      return null;
    }
    return await set(
      findOwnedArtifactBySiteId$,
      { siteId: deployment.siteId, userId: args.userId, orgId: args.orgId },
      signal,
    );
  },
);

const resolveStandaloneHostedSiteTarget$ = command(
  async (
    { get },
    args: OwnedArtifactOwner,
    signal: AbortSignal,
  ): Promise<ResolvedArtifactAccessTarget | null> => {
    const database = get(db$);
    let siteId = args.artifactId;
    let [site] = await database
      .select({ id: hostedSites.id, publicSlug: hostedSites.publicSlug })
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.id, siteId),
          eq(hostedSites.orgId, args.orgId),
          eq(hostedSites.userId, args.userId),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!site) {
      const [deployment] = await database
        .select({ siteId: hostedDeployments.siteId })
        .from(hostedDeployments)
        .where(
          and(
            eq(hostedDeployments.id, args.artifactId),
            eq(hostedDeployments.userId, args.userId),
            eq(hostedDeployments.orgId, args.orgId),
            eq(hostedDeployments.status, "ready"),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!deployment) {
        return null;
      }
      siteId = deployment.siteId;
      [site] = await database
        .select({ id: hostedSites.id, publicSlug: hostedSites.publicSlug })
        .from(hostedSites)
        .where(
          and(
            eq(hostedSites.id, siteId),
            eq(hostedSites.orgId, args.orgId),
            eq(hostedSites.userId, args.userId),
            isNull(hostedSites.deletedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!site) {
        return null;
      }
    }
    const [presentation] = await database
      .select({ id: presentationArtifacts.id })
      .from(presentationArtifacts)
      .where(eq(presentationArtifacts.hostedSiteId, site.id))
      .limit(1);
    signal.throwIfAborted();
    return {
      artifactId: site.id,
      kind: presentation ? "presentation" : "hosted-site",
      orgId: args.orgId,
      userId: args.userId,
      targetKind: "site",
      siteId: site.id,
      publicSlug: site.publicSlug,
      hasArtifactRow: false,
      currentVisibility: "private",
    };
  },
);

const resolveLegacyHtmlDeploymentTarget$ = command(
  async (
    { get, set },
    args: OwnedArtifactOwner,
    signal: AbortSignal,
  ): Promise<ResolvedArtifactAccessTarget | null> => {
    const [row] = await get(db$)
      .select({
        id: privateHostedDeployments.id,
        siteId: privateHostedDeployments.siteId,
      })
      .from(privateHostedDeployments)
      .innerJoin(
        hostedSites,
        eq(hostedSites.id, privateHostedDeployments.siteId),
      )
      .where(
        and(
          eq(privateHostedDeployments.id, args.artifactId),
          eq(privateHostedDeployments.userId, args.userId),
          eq(privateHostedDeployments.orgId, args.orgId),
          eq(privateHostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const artifact = await set(
      findOwnedArtifactBySiteId$,
      { siteId: row.siteId, userId: args.userId, orgId: args.orgId },
      signal,
    );
    return {
      // Keep the legacy deployment's own UUID as artifactId so follow-up PATCH
      // requests stay scoped to the immutable R2 share and never cross-talk
      // onto the live site's artifacts row.
      artifactId: row.id,
      kind: artifact ? effectiveArtifactAccessKind(artifact) : "hosted-site",
      orgId: args.orgId,
      userId: args.userId,
      targetKind: "legacy-html-deployment",
      deploymentId: row.id,
      siteId: row.siteId,
    };
  },
);

/**
 * Resolve an owned artifact access target by canonical `artifacts.id` or,
 * during Release 1 client cutover, by legacy `entity_id` / `projection_file_id`
 * / `siteId` / `deploymentId` aliases (including standalone hosted sites and
 * legacy private HTML deployments). Remove legacy ID fallbacks in Release 2
 * after all clients address artifacts exclusively by `artifacts.id`.
 */
export const resolveOwnedArtifactAccessTarget$ = command(
  async (
    { get, set },
    args: OwnedArtifactOwner,
    signal: AbortSignal,
  ): Promise<ResolvedArtifactAccessTarget | null> => {
    const [directRow] = await get(db$)
      .select(OWNED_ARTIFACT_SELECTION)
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
    const row =
      directRow ?? (await set(findOwnedArtifactByRelatedId$, args, signal));
    if (!row) {
      const standaloneSite = await set(
        resolveStandaloneHostedSiteTarget$,
        args,
        signal,
      );
      if (standaloneSite) {
        return standaloneSite;
      }
      return await set(resolveLegacyHtmlDeploymentTarget$, args, signal);
    }

    const kind = effectiveArtifactAccessKind(row);
    if (row.kind === "hosted-site" || row.kind === "presentation") {
      return await set(resolveSiteAccessTarget$, { row, kind }, signal);
    }
    if (row.kind === "file" || row.kind === "image" || row.kind === "video") {
      return await set(resolveFileAccessTarget$, { row, kind }, signal);
    }
    return null;
  },
);

/**
 * Read-repair `artifacts.visibility` when the authoritative R1 source (file R2
 * policy or hosted_site_visibility) differs from the cached column value.
 * Remove in Release 2 once `artifacts.visibility` is the sole authority.
 */
const repairArtifactVisibilityIfDrifted$ = command(
  async (
    { set },
    args: {
      readonly artifactId: string;
      readonly currentVisibility: ArtifactVisibilityValue;
      readonly authoritativeVisibility: ArtifactVisibilityValue;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.currentVisibility === args.authoritativeVisibility) {
      return;
    }
    await set(writeDb$)
      .update(artifacts)
      .set({ visibility: args.authoritativeVisibility })
      .where(
        and(
          eq(artifacts.id, args.artifactId),
          ne(artifacts.visibility, args.authoritativeVisibility),
        ),
      );
    signal.throwIfAborted();
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
    if (!result.ok) {
      if (isClerkResourceNotFound(result.error)) {
        return { id: orgId, name: orgId };
      }
      throw result.error;
    }
    return {
      id: orgId,
      name: result.value.name || orgId,
    };
  },
);

const resolveUserDisplayNames$ = command(
  async ({ get }, userIds: readonly string[], signal: AbortSignal) => {
    const names = new Map<string, string | null>();
    if (userIds.length === 0) {
      return names;
    }
    const result = await settle(
      get(clerk$).users.getUserList(
        { userId: [...userIds], limit: Math.min(userIds.length, 100) },
        undefined,
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      if (isClerkResourceNotFound(result.error)) {
        return names;
      }
      throw result.error;
    }
    for (const user of result.value.data) {
      const fullName =
        [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
      names.set(user.id, fullName);
    }
    return names;
  },
);

const upsertArtifactUserShare$ = command(
  async (
    { set },
    args: {
      readonly artifactId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly email: string;
    },
    signal: AbortSignal,
  ) => {
    await set(writeDb$)
      .insert(artifactUserShares)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        artifactId: args.artifactId,
        email: args.email,
      })
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
      if (resolved.hasArtifactRow) {
        await set(
          repairArtifactVisibilityIfDrifted$,
          {
            artifactId: resolved.artifactId,
            currentVisibility: resolved.currentVisibility,
            authoritativeVisibility: policy.visibility,
          },
          signal,
        );
      }
      const siteUrl = `${hostedLinkOrigin("current", resolved.publicSlug)}/`;
      return {
        artifactId: resolved.artifactId,
        kind: resolved.kind,
        visibility: policy.visibility,
        ownerUrl: siteUrl,
        shareUrl: policy.visibility === "private" ? null : siteUrl,
        shortUrl: policy.visibility === "private" ? null : siteUrl,
        organization,
      };
    }

    const shareTarget =
      resolved.targetKind === "legacy-html-deployment"
        ? ({ kind: "html", id: resolved.deploymentId } as const)
        : ({ kind: "file", id: resolved.fileId } as const);
    const share = await set(
      readArtifactShare$,
      {
        target: shareTarget,
        userId: resolved.userId,
        orgId: resolved.orgId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!share) {
      return null;
    }
    if (resolved.targetKind === "file") {
      await set(
        repairArtifactVisibilityIfDrifted$,
        {
          artifactId: resolved.artifactId,
          currentVisibility: resolved.currentVisibility,
          authoritativeVisibility: share.audience,
        },
        signal,
      );
    }
    if (resolved.targetKind === "legacy-html-deployment") {
      const matchesRequestedDeployment =
        share.selectedTarget?.kind === "html" &&
        share.selectedTarget.id === resolved.deploymentId;
      const effectiveVisibility: ArtifactVisibilityValue =
        matchesRequestedDeployment ? share.audience : "private";
      return {
        artifactId: resolved.artifactId,
        kind: resolved.kind,
        visibility: effectiveVisibility,
        ownerUrl: share.ownerUrl,
        shareUrl: effectiveVisibility === "private" ? null : share.url,
        shortUrl: effectiveVisibility === "private" ? null : share.shortUrl,
        deploymentVersion: share.candidateVersion,
        organization: share.organization,
      };
    }
    return {
      artifactId: resolved.artifactId,
      kind: resolved.kind,
      visibility: share.audience,
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
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: "ok"; readonly body: ArtifactVisibilityResponse }
    | { readonly status: "not_found" }
    | { readonly status: "conflict" }
    | { readonly status: "bad_request"; readonly message: string }
  > => {
    const resolved = await set(resolveOwnedArtifactAccessTarget$, args, signal);
    if (!resolved) {
      return { status: "not_found" };
    }

    if (resolved.targetKind === "site") {
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
      const updated = await set(
        updateHostedSiteVisibility$,
        {
          siteId: resolved.siteId,
          userId: resolved.userId,
          orgId: resolved.orgId,
          visibility: args.visibility,
          expectedRevision: current.revision,
        },
        signal,
      );
      if (updated.status === "not_found") {
        return { status: "not_found" };
      }
      if (updated.status === "conflict") {
        return { status: "conflict" };
      }
      if (resolved.hasArtifactRow) {
        await set(writeDb$)
          .update(artifacts)
          .set({ visibility: args.visibility, updatedAt: nowDate() })
          .where(eq(artifacts.id, resolved.artifactId));
        signal.throwIfAborted();
      }
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
          ownerUrl: siteUrl,
          shareUrl: updated.body.visibility === "private" ? null : siteUrl,
          shortUrl: updated.body.visibility === "private" ? null : siteUrl,
          organization,
        },
      };
    }

    const shareTarget =
      resolved.targetKind === "legacy-html-deployment"
        ? ({ kind: "html", id: resolved.deploymentId } as const)
        : ({ kind: "file", id: resolved.fileId } as const);
    const updated = await set(
      updateArtifactShare$,
      {
        target: shareTarget,
        audience: args.visibility,
        userId: resolved.userId,
        orgId: resolved.orgId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!updated) {
      return { status: "not_found" };
    }
    if ("status" in updated) {
      return {
        status: "bad_request",
        message: updated.body.error.message,
      };
    }
    if (resolved.targetKind === "file") {
      await set(writeDb$)
        .update(artifacts)
        .set({ visibility: updated.audience, updatedAt: nowDate() })
        .where(eq(artifacts.id, resolved.artifactId));
      signal.throwIfAborted();
    }
    return {
      status: "ok",
      body: {
        artifactId: resolved.artifactId,
        kind: resolved.kind,
        visibility: updated.audience,
        ownerUrl: updated.ownerUrl,
        shareUrl: updated.url,
        shortUrl: updated.shortUrl,
        ...(resolved.targetKind === "legacy-html-deployment"
          ? { deploymentVersion: updated.candidateVersion }
          : {}),
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
    if (!resolved || resolved.targetKind === "legacy-html-deployment") {
      return null;
    }
    const database = get(db$);
    const [userShares, legacyShares] = await Promise.all([
      database
        .select({
          userId: artifactUserShares.userId,
          email: artifactUserShares.email,
        })
        .from(artifactUserShares)
        .where(
          and(
            eq(artifactUserShares.artifactId, resolved.artifactId),
            eq(artifactUserShares.orgId, resolved.orgId),
          ),
        )
        .orderBy(
          asc(artifactUserShares.createdAt),
          asc(artifactUserShares.userId),
        ),
      resolved.targetKind === "site"
        ? database
            .select({
              userId: hostedSiteShares.userId,
              email: hostedSiteShares.email,
            })
            .from(hostedSiteShares)
            .where(
              and(
                eq(hostedSiteShares.siteId, resolved.siteId),
                isNotNull(hostedSiteShares.userId),
              ),
            )
            .orderBy(asc(hostedSiteShares.createdAt), asc(hostedSiteShares.id))
        : database
            .select({
              userId: artifactFileShares.userId,
              email: artifactFileShares.email,
            })
            .from(artifactFileShares)
            .where(
              and(
                eq(artifactFileShares.fileId, resolved.fileId),
                isNotNull(artifactFileShares.userId),
              ),
            )
            .orderBy(
              asc(artifactFileShares.createdAt),
              asc(artifactFileShares.id),
            ),
    ]);
    signal.throwIfAborted();

    const byUserId = new Map<string, string>();
    for (const share of userShares) {
      byUserId.set(share.userId, share.email);
    }
    // Release 1 compatibility: union legacy per-user grants alongside
    // artifact_user_shares. Remove in Release 2 once legacy share tables retire.
    for (const share of legacyShares) {
      if (share.userId && !byUserId.has(share.userId)) {
        byUserId.set(share.userId, share.email);
      }
    }
    const names = await set(
      resolveUserDisplayNames$,
      [...byUserId.keys()],
      signal,
    );
    return [...byUserId.entries()].map(([userId, email]) => {
      return {
        userId,
        email,
        name: names.get(userId) ?? null,
      };
    });
  },
);

export const addArtifactShare$ = command(
  async (
    { get, set },
    args: OwnedArtifactOwner & {
      readonly recipient: ArtifactShareAccount;
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
    if (args.recipient.userId === args.userId) {
      return { status: "self" };
    }
    const resolved = await set(resolveOwnedArtifactAccessTarget$, args, signal);
    if (!resolved || resolved.targetKind === "legacy-html-deployment") {
      return { status: "not_found" };
    }

    if (resolved.targetKind === "site") {
      const result = await set(
        shareHostedSite$,
        {
          siteId: resolved.siteId,
          userId: resolved.userId,
          orgId: resolved.orgId,
          email: args.recipient.email,
          recipient: args.recipient,
        },
        signal,
      );
      if (result.status !== "ok") {
        return result;
      }
      if (resolved.hasArtifactRow) {
        await set(
          upsertArtifactUserShare$,
          {
            artifactId: resolved.artifactId,
            orgId: resolved.orgId,
            userId: args.recipient.userId,
            email: args.recipient.email,
          },
          signal,
        );
      }
      return {
        status: "ok",
        share: {
          userId: args.recipient.userId,
          email: args.recipient.email,
          name: args.recipient.name,
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
        email: args.recipient.email,
        recipient: args.recipient,
      },
      signal,
    );
    if (result.status !== "ok") {
      return result;
    }
    await set(
      upsertArtifactUserShare$,
      {
        artifactId: resolved.artifactId,
        orgId: resolved.orgId,
        userId: args.recipient.userId,
        email: args.recipient.email,
      },
      signal,
    );
    return {
      status: "ok",
      share: {
        userId: args.recipient.userId,
        email: args.recipient.email,
        name: args.recipient.name,
      },
      outboxId: result.outboxId,
    };
  },
);

export const removeArtifactShare$ = command(
  async (
    { set },
    args: OwnedArtifactOwner & { readonly targetUserId: string },
    signal: AbortSignal,
  ): Promise<{ readonly removed: string } | null> => {
    const resolved = await set(resolveOwnedArtifactAccessTarget$, args, signal);
    if (!resolved || resolved.targetKind === "legacy-html-deployment") {
      return null;
    }
    const database = set(writeDb$);

    const legacyRemoved =
      resolved.targetKind === "site"
        ? await database
            .delete(hostedSiteShares)
            .where(
              and(
                eq(hostedSiteShares.siteId, resolved.siteId),
                eq(hostedSiteShares.userId, args.targetUserId),
              ),
            )
            .returning({ id: hostedSiteShares.id })
        : await database
            .delete(artifactFileShares)
            .where(
              and(
                eq(artifactFileShares.fileId, resolved.fileId),
                eq(artifactFileShares.userId, args.targetUserId),
              ),
            )
            .returning({ id: artifactFileShares.id });
    signal.throwIfAborted();

    const userShareRemoved = await database
      .delete(artifactUserShares)
      .where(
        and(
          eq(artifactUserShares.artifactId, resolved.artifactId),
          eq(artifactUserShares.orgId, resolved.orgId),
          eq(artifactUserShares.userId, args.targetUserId),
        ),
      )
      .returning({ userId: artifactUserShares.userId });
    signal.throwIfAborted();

    return legacyRemoved.length > 0 || userShareRemoved.length > 0
      ? { removed: args.targetUserId }
      : null;
  },
);
