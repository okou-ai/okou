import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, asc, eq, isNull, or } from "drizzle-orm";
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
import { artifactUserShares } from "@okouai/db/schema/artifact-user-share";
import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";

import { env } from "../../lib/env";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { legacyPrivateHostedDeploymentVersion } from "../../lib/hosted-publication";
import { nowDate } from "../../lib/time";
import artifactInvitationTemplate from "../../lib/artifact-invitation-template.json";
import hostedSiteInvitationTemplate from "../../lib/hosted-site-invitation-template.json";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  getHostedSiteVisibility$,
  updateHostedSiteVisibility$,
} from "./hosted-site-access.service";
import {
  privateArtifactRecord$,
  resolvePrivateArtifactUrl$,
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
      readonly ownerUrl: string;
      readonly deploymentVersion: number | null;
    };

function shareOutboxId(
  artifactId: string,
  orgId: string,
  recipientUserId: string,
): string {
  const bytes = createHash("sha256")
    .update(
      JSON.stringify([
        "artifact-share-outbox-v2",
        artifactId,
        orgId,
        recipientUserId,
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function effectiveArtifactAccessKind(row: {
  readonly kind: ArtifactCatalogKind;
  readonly displayKind: ArtifactCatalogKind | null;
  readonly logicalKey: string;
}): ArtifactAccessKind {
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
      fileId = image?.fileId ?? null;
    } else if (row.kind === "file") {
      fileId = row.entityId;
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

/**
 * Bounded compatibility for already-released R1 mobile/CLI clients (Android
 * 0.69.0, iOS 0.74.0, CLI 10.45.0) that address `/api/artifacts/:id/...` using
 * canonical entity IDs (`files.id`, `hosted_sites.id`, `hosted_deployments.id`)
 * before R2 clients adopt `artifactId` from resolve responses.
 */
const findOwnedArtifactByEntityId$ = command(
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
        artifactUrl: privateHostedDeployments.artifactUrl,
        manifest: privateHostedDeployments.manifest,
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
      // requests stay isolated from the live site's `artifacts` visibility.
      artifactId: row.id,
      kind: artifact ? effectiveArtifactAccessKind(artifact) : "hosted-site",
      orgId: args.orgId,
      userId: args.userId,
      targetKind: "legacy-html-deployment",
      deploymentId: row.id,
      siteId: row.siteId,
      ownerUrl: new URL(row.artifactUrl, env("APP_URL")).href,
      deploymentVersion: legacyPrivateHostedDeploymentVersion(row.manifest),
    };
  },
);

/**
 * Resolve an owned artifact access target primarily by canonical `artifacts.id`,
 * with bounded entity-ID lookup for already-released R1 clients and read-only
 * isolation for historical `private_hosted_deployments`.
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
      directRow ?? (await set(findOwnedArtifactByEntityId$, args, signal));
    if (!row) {
      return await set(resolveLegacyHtmlDeploymentTarget$, args, signal);
    }

    const kind = effectiveArtifactAccessKind(row);
    if (row.kind === "hosted-site" || row.kind === "presentation") {
      return await set(resolveSiteAccessTarget$, { row, kind }, signal);
    }
    if (row.kind === "file" || row.kind === "image") {
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
    if (!result.ok) {
      if (isClerkResourceNotFound(result.error)) {
        return { id: orgId, name: orgId };
      }
      throw result.error;
    }
    return {
      id: orgId,
      name: result.value?.name || orgId,
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

    if (resolved.targetKind === "legacy-html-deployment") {
      const organization = await set(
        resolveOrganizationSummary$,
        resolved.orgId,
        signal,
      );
      return {
        artifactId: resolved.artifactId,
        kind: resolved.kind,
        visibility: "private",
        ownerUrl: resolved.ownerUrl,
        shareUrl: null,
        shortUrl: null,
        deploymentVersion: resolved.deploymentVersion,
        organization,
      };
    }

    const file = await set(privateArtifactRecord$, resolved.fileId, signal);
    signal.throwIfAborted();
    if (
      !file ||
      file.userId !== resolved.userId ||
      file.orgId !== resolved.orgId ||
      !file.isReady
    ) {
      return null;
    }
    const [ownerUrl, organization] = await Promise.all([
      set(
        resolvePrivateArtifactUrl$,
        { id: file.id, filename: file.filename },
        signal,
      ),
      set(resolveOrganizationSummary$, resolved.orgId, signal),
    ]);
    signal.throwIfAborted();
    return {
      artifactId: resolved.artifactId,
      kind: resolved.kind,
      visibility: resolved.currentVisibility,
      ownerUrl,
      shareUrl: resolved.currentVisibility === "private" ? null : ownerUrl,
      shortUrl: resolved.currentVisibility === "private" ? null : ownerUrl,
      organization,
    };
  },
);

const updateSiteArtifactVisibility$ = command(
  async (
    { set },
    args: {
      readonly resolved: Extract<
        ResolvedArtifactAccessTarget,
        { targetKind: "site" }
      >;
      readonly visibility: ArtifactVisibilityValue;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: "ok"; readonly body: ArtifactVisibilityResponse }
    | { readonly status: "not_found" }
    | { readonly status: "conflict" }
  > => {
    const { resolved } = args;
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
    if (updated.status !== "ok") {
      return { status: updated.status };
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
      return await set(
        updateSiteArtifactVisibility$,
        { resolved, visibility: args.visibility },
        signal,
      );
    }

    if (resolved.targetKind === "legacy-html-deployment") {
      if (args.visibility !== "private") {
        return {
          status: "bad_request",
          message:
            "Hosted sites are managed from their live publication. Publish a new deployment to update visibility.",
        };
      }
      const organization = await set(
        resolveOrganizationSummary$,
        resolved.orgId,
        signal,
      );
      return {
        status: "ok",
        body: {
          artifactId: resolved.artifactId,
          kind: resolved.kind,
          visibility: "private",
          ownerUrl: resolved.ownerUrl,
          shareUrl: null,
          shortUrl: null,
          deploymentVersion: resolved.deploymentVersion,
          organization,
        },
      };
    }

    const file = await set(privateArtifactRecord$, resolved.fileId, signal);
    signal.throwIfAborted();
    if (
      !file ||
      file.userId !== resolved.userId ||
      file.orgId !== resolved.orgId ||
      !file.isReady
    ) {
      return { status: "not_found" };
    }
    const [changed] = await set(writeDb$)
      .update(artifacts)
      .set({ visibility: args.visibility, updatedAt: nowDate() })
      .where(
        and(eq(artifacts.id, resolved.artifactId), isNull(artifacts.deletedAt)),
      )
      .returning({ visibility: artifacts.visibility });
    signal.throwIfAborted();
    if (!changed) {
      return { status: "not_found" };
    }
    const [ownerUrl, organization] = await Promise.all([
      set(
        resolvePrivateArtifactUrl$,
        { id: file.id, filename: file.filename },
        signal,
      ),
      set(resolveOrganizationSummary$, resolved.orgId, signal),
    ]);
    signal.throwIfAborted();
    return {
      status: "ok",
      body: {
        artifactId: resolved.artifactId,
        kind: resolved.kind,
        visibility: changed.visibility,
        ownerUrl,
        shareUrl: changed.visibility === "private" ? null : ownerUrl,
        shortUrl: changed.visibility === "private" ? null : ownerUrl,
        organization,
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
    const userShares = await get(db$)
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
      );
    signal.throwIfAborted();

    const names = await set(
      resolveUserDisplayNames$,
      userShares.map((share) => {
        return share.userId;
      }),
      signal,
    );
    return userShares.map((share) => {
      return {
        userId: share.userId,
        email: share.email,
        name: names.get(share.userId) ?? null,
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
        readonly outboxId: string;
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

    let resourceUrl: string;
    if (resolved.targetKind === "site") {
      resourceUrl = `${hostedLinkOrigin("current", resolved.publicSlug)}/`;
    } else {
      const file = await set(privateArtifactRecord$, resolved.fileId, signal);
      signal.throwIfAborted();
      if (
        !file ||
        file.userId !== resolved.userId ||
        file.orgId !== resolved.orgId ||
        !file.isReady
      ) {
        return { status: "not_found" };
      }
      resourceUrl = await set(
        resolvePrivateArtifactUrl$,
        { id: file.id, filename: file.filename },
        signal,
      );
    }

    const inviter = await findClerkUser(get(clerk$), resolved.userId, signal);
    const inviterName =
      [inviter?.firstName, inviter?.lastName].filter(Boolean).join(" ") ||
      "An Okou user";

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

    const outboxId = shareOutboxId(
      resolved.artifactId,
      resolved.orgId,
      args.recipient.userId,
    );
    await set(writeDb$)
      .insert(emailOutbox)
      .values(
        resolved.targetKind === "site"
          ? {
              id: outboxId,
              fromAddress: hostedSiteInvitationTemplate.from,
              toAddresses: args.recipient.email,
              subject: "You’re invited to view a website on Okou",
              template: {
                template: "hosted-site-invitation",
                props: {
                  inviterName,
                  email: args.recipient.email,
                  siteUrl: resourceUrl,
                },
              },
              createdAt: nowDate(),
            }
          : {
              id: outboxId,
              fromAddress: artifactInvitationTemplate.from,
              toAddresses: args.recipient.email,
              subject: "You’re invited to view a file on Okou",
              template: {
                template: "artifact-invitation",
                props: {
                  inviterName,
                  email: args.recipient.email,
                  artifactUrl: resourceUrl,
                },
              },
              createdAt: nowDate(),
            },
      )
      .onConflictDoNothing({ target: emailOutbox.id });
    signal.throwIfAborted();

    return {
      status: "ok",
      share: {
        userId: args.recipient.userId,
        email: args.recipient.email,
        name: args.recipient.name,
      },
      outboxId,
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
    const removed = await set(writeDb$)
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

    return removed.length > 0 ? { removed: args.targetUserId } : null;
  },
);
