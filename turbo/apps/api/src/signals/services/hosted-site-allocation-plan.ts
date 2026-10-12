import type {
  HostedSiteManifest,
  HostedSiteManifestFile,
} from "@okouai/db/jsonb-contracts/hosted-site";
import { createHash } from "node:crypto";
import {
  hostedSiteAssetContentError,
  isMutableHostedSitePath,
  type HostedArtifactKind,
  type HostedSitePrepareRequest,
  type HostedSitePreview,
} from "@okouai/api-contracts/contracts/host";
import {
  CURRENT_LINK_LAYOUT,
  linkLayoutSegment,
  hostedSitePointerNamespace,
  linkLayoutFromSegment,
  type LinkLayout,
} from "@okouai/api-contracts/contracts/link-layout";
import { hostedLinkOrigin } from "../../lib/link-layout";
import { publicSlugCandidate } from "../../lib/hosted-site-slug";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/runtime/hosted-site";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";

function hostedSiteCondition(args: PrepareDeploymentArgs, publicSlug?: string) {
  return and(
    eq(hostedSites.orgId, args.orgId),
    publicSlug === undefined
      ? eq(hostedSites.requestedSlug, args.body.site)
      : eq(hostedSites.slug, publicSlug),
    eq(hostedSites.linkLayoutSegment, linkLayoutSegment(CURRENT_LINK_LAYOUT)),
    isNull(hostedSites.deletedAt),
  );
}

function hostedSiteAllocationValues(
  args: PrepareDeploymentArgs,
  publicSlug: string,
  attempt: number,
  now: Date,
): typeof hostedSites.$inferInsert {
  return {
    orgId: args.orgId,
    userId: args.userId,
    slug: publicSlug,
    // Only the preferred candidate owns the requested name; fallback names
    // remain reserved under their resolved identity, including after deletion.
    requestedSlug: attempt === 0 ? args.body.site : publicSlug,
    linkLayoutSegment: linkLayoutSegment(CURRENT_LINK_LAYOUT),
    publicSlug,
    createdFromRunId: args.runId,
    updatedAt: now,
  };
}

function hostedAssetConflictQuery(
  siteId: string,
  assets: Readonly<Record<string, string>>,
) {
  return sql`
              select requested.key as path
              from (
                select ${hostedDeployments.manifest} as manifest
                from ${hostedDeployments}
                where ${eq(hostedDeployments.siteId, siteId)}
                union all
                select ${privateHostedDeployments.manifest} as manifest
                from ${privateHostedDeployments}
                where ${eq(privateHostedDeployments.siteId, siteId)}
              ) published
              cross join lateral jsonb_each_text(
                ${sql.param(JSON.stringify(assets))}::jsonb
              ) as requested
              where published.manifest->'files'->requested.key->>'sha256' is distinct from null
                and published.manifest->'files'->requested.key->>'sha256' <> requested.value
              limit 1
            `;
}

type HostedSiteRow = typeof hostedSites.$inferSelect;
type HostedDeploymentRow = typeof hostedDeployments.$inferSelect;
type HostedSiteFile = HostedSitePrepareRequest["files"][number];
const MAX_PUBLIC_SLUG_ATTEMPTS = 5;
export interface PrepareDeploymentArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
  readonly body: HostedSitePrepareRequest;
}

export type SiteDeploymentCreationResult =
  | {
      readonly kind: "ok";
      readonly site: HostedSiteRow;
      readonly deployment: HostedDeploymentRow;
    }
  | { readonly kind: "slug_conflict" }
  | { readonly kind: "owner_conflict" }
  | { readonly kind: "content_conflict"; readonly message: string };

type HostedSiteResolution =
  | { readonly kind: "ok"; readonly site: HostedSiteRow }
  | { readonly kind: "slug_conflict" }
  | { readonly kind: "owner_conflict" };

export interface CreateHostedSiteDeploymentContext {
  readonly now: Date;
  readonly deploymentId: string;
}

function deploymentUrl(layout: LinkLayout, deploymentId: string): string {
  return hostedLinkOrigin(layout, `dpl-${deploymentId}`);
}

function deploymentPrefix(layout: LinkLayout, deploymentId: string) {
  return `${hostedSitePointerNamespace(layout)}/publications/${deploymentId}`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contentHash(files: readonly HostedSiteManifestFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => {
    return a.path.localeCompare(b.path);
  })) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function buildManifest(args: {
  readonly deploymentId: string;
  readonly siteId: string;
  readonly site: string;
  readonly publicSlug: string;
  readonly deploymentVersion: number | null;
  readonly artifactKind: HostedArtifactKind;
  readonly spaFallback: boolean;
  readonly files: readonly HostedSiteFile[];
  readonly preview?: HostedSitePreview;
  readonly createdAt: Date;
  readonly layout: LinkLayout;
}): HostedSiteManifest {
  const manifestFiles: Record<string, HostedSiteManifestFile> = {};
  for (const file of args.files) {
    manifestFiles[file.path] = {
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      contentType: file.contentType,
      immutable: file.immutable,
    };
  }
  return {
    version: 1,
    immutableContent: true,
    // Deployed host Workers treat a manifest without this marker as legacy.
    publicBrand: linkLayoutSegment(args.layout),
    deploymentId: args.deploymentId,
    siteId: args.siteId,
    site: args.site,
    publicSlug: args.publicSlug,
    ...(args.deploymentVersion === null
      ? {}
      : { deploymentVersion: args.deploymentVersion }),
    createdAt: args.createdAt.toISOString(),
    artifactKind: args.artifactKind,
    spaFallback: args.spaFallback,
    files: manifestFiles,
    ...(args.preview ? { preview: args.preview } : {}),
  };
}

function resolvedHostedSite(
  site: HostedSiteRow,
  args: PrepareDeploymentArgs,
): HostedSiteResolution {
  // Redeploying replaces what a site serves, so only its creator may do it.
  // Organization membership alone never carries that authority.
  return site.userId === args.userId
    ? { kind: "ok", site }
    : { kind: "owner_conflict" };
}

/** Immutable asset names retain their bytes across publication histories. */
function immutableHostedAssetHashes(files: readonly HostedSiteFile[]) {
  const assets: Record<string, string> = {};
  for (const file of files) {
    if (!isMutableHostedSitePath(file)) {
      assets[file.path] = file.sha256;
    }
  }
  return assets;
}

function hostedDeploymentValues(
  args: PrepareDeploymentArgs,
  context: CreateHostedSiteDeploymentContext,
  site: HostedSiteRow,
  deploymentVersion: number,
): typeof hostedDeployments.$inferInsert {
  const { deploymentId } = context;
  // Every publication owns its bytes; only the site's alias is reused.
  // Only current-layout sites are allocated for new publications.
  const layout = linkLayoutFromSegment(site.linkLayoutSegment);
  const artifactUrl = deploymentUrl(layout, deploymentId);
  const aliasUrl = hostedLinkOrigin(layout, site.publicSlug);
  const prefix = deploymentPrefix(layout, deploymentId);
  const manifest: HostedSiteManifest = buildManifest({
    deploymentId,
    siteId: site.id,
    site: args.body.site,
    publicSlug: site.publicSlug,
    deploymentVersion,
    artifactKind: args.body.artifactKind,
    spaFallback: args.body.spaFallback,
    files: args.body.files,
    preview: args.body.preview,
    createdAt: context.now,
    layout,
  });
  const files = Object.values(manifest.files);
  return {
    id: deploymentId,
    siteId: site.id,
    orgId: args.orgId,
    userId: args.userId,
    runId: args.runId,
    linkLayoutSegment: linkLayoutSegment(layout),
    status: "uploading",
    artifactUrl,
    r2Prefix: prefix,
    manifest,
    manifestHash: hashJson(manifest),
    contentHash: contentHash(files),
    entrypoint: "/index.html",
    spaFallback: args.body.spaFallback,
    fileCount: files.length,
    sizeBytes: files.reduce((sum, file) => {
      return sum + file.size;
    }, 0),
    url: aliasUrl,
    updatedAt: context.now,
  };
}

type HostedAllocationQuery =
  | {
      readonly kind: "site";
      readonly condition: SQL | undefined;
      readonly lock: boolean;
    }
  | {
      readonly kind: "site-insert";
      readonly values: typeof hostedSites.$inferInsert;
    }
  | {
      readonly kind: "public-version" | "private-version";
      readonly siteId: string;
    }
  | { readonly kind: "asset-conflict"; readonly query: SQL }
  | {
      readonly kind: "deployment-insert";
      readonly values: typeof hostedDeployments.$inferInsert;
    };

export interface HostedAllocationQueryResult {
  readonly site?: HostedSiteRow;
  readonly version?: number | null;
  readonly path?: string;
  readonly deployment?: HostedDeploymentRow;
}

type SiteAllocationPlan = Generator<
  HostedAllocationQuery,
  HostedSiteResolution,
  HostedAllocationQueryResult
>;

function* hostedSiteAllocationPlan(
  args: PrepareDeploymentArgs,
  now: Date,
): SiteAllocationPlan {
  const existing = (yield {
    kind: "site",
    condition: hostedSiteCondition(args),
    lock: true,
  }).site;
  if (existing) {
    return resolvedHostedSite(existing, args);
  }
  for (let attempt = 0; attempt < MAX_PUBLIC_SLUG_ATTEMPTS; attempt += 1) {
    const publicSlug = publicSlugCandidate(
      args.body.site,
      args.orgId,
      "organization",
      attempt,
    );
    const created = (yield {
      kind: "site-insert",
      values: hostedSiteAllocationValues(args, publicSlug, attempt, now),
    }).site;
    if (created) {
      return { kind: "ok", site: created };
    }
    const concurrent =
      (yield {
        kind: "site",
        condition: hostedSiteCondition(args),
        lock: true,
      }).site ??
      (yield {
        kind: "site",
        condition: hostedSiteCondition(args, publicSlug),
        lock: true,
      }).site;
    if (concurrent) {
      return resolvedHostedSite(concurrent, args);
    }
  }
  return { kind: "slug_conflict" };
}

/** Pure query/value plans; only the owning native transaction executes SQL. */
export function* hostedDeploymentAllocationPlan(
  args: PrepareDeploymentArgs,
  context: CreateHostedSiteDeploymentContext,
): Generator<
  HostedAllocationQuery,
  SiteDeploymentCreationResult,
  HostedAllocationQueryResult
> {
  const resolution = yield* hostedSiteAllocationPlan(args, context.now);
  if (resolution.kind !== "ok") {
    return resolution;
  }
  const { site } = resolution;
  const publicVersion = (yield { kind: "public-version", siteId: site.id })
    .version;
  const privateVersion = (yield { kind: "private-version", siteId: site.id })
    .version;
  const deploymentVersion =
    Math.max(publicVersion ?? 0, privateVersion ?? 0) + 1;
  const assets = immutableHostedAssetHashes(args.body.files);
  if (Object.keys(assets).length !== 0) {
    const conflicting = (yield {
      kind: "asset-conflict",
      query: hostedAssetConflictQuery(site.id, assets),
    }).path;
    if (conflicting !== undefined) {
      return {
        kind: "content_conflict",
        message: hostedSiteAssetContentError(conflicting),
      };
    }
  }
  const values = hostedDeploymentValues(args, context, site, deploymentVersion);
  const deployment = (yield { kind: "deployment-insert", values }).deployment;
  if (!deployment) {
    throw new Error("Failed to create hosted deployment");
  }
  return { kind: "ok", site, deployment };
}
