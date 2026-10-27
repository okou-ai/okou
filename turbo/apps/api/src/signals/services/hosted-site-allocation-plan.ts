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
import { hostedSiteAddressCondition } from "../../lib/hosted-site-address";
import {
  hostedDeployments,
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/schema/hosted-site";
import {
  and,
  eq,
  isNotNull,
  isNull,
  max,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";

function hostedSiteCondition(args: PrepareDeploymentArgs) {
  return and(
    eq(hostedSites.orgId, args.orgId),
    eq(hostedSites.requestedSlug, args.body.site),
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

export function hostedAssetConflictQuery(
  siteId: string,
  assets: Readonly<Record<string, string>>,
) {
  const publishedHash = sql`f.files->requested.key->>'sha256'`;
  return sql`
    with requested as materialized (
      select key, value
      from jsonb_each_text(${sql.param(JSON.stringify(assets))}::jsonb)
    )
    select hit.path
    from (
      select ${hostedDeployments.manifest} as manifest
      from ${hostedDeployments}
      where ${eq(hostedDeployments.siteId, siteId)}
      union all
      select ${privateHostedDeployments.manifest} as manifest
      from ${privateHostedDeployments}
      where ${eq(privateHostedDeployments.siteId, siteId)}
    ) published
    cross join lateral (
      -- Reuse each manifest's file map without materializing all retained history.
      with file_map as materialized (
        select published.manifest->'files' as files
      )
      select requested.key as path
      from file_map f cross join requested
      where ${isNotNull(publishedHash)}
        and ${ne(publishedHash, sql`requested.value`)}
      limit 1
    ) hit
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
  | { readonly kind: "allocation_conflict" }
  | { readonly kind: "content_conflict"; readonly message: string };

type HostedSiteIdentity = Pick<
  HostedSiteRow,
  "id" | "publicSlug" | "linkLayoutSegment"
>;

type HostedSiteResolution =
  | {
      readonly kind: "ok";
      readonly site: HostedSiteIdentity;
      readonly create: typeof hostedSites.$inferInsert | null;
    }
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
  readonly title?: string;
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
    ...(args.title === undefined ? {} : { title: args.title }),
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
    ? { kind: "ok", site, create: null }
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
  site: HostedSiteIdentity,
  deploymentVersion: number,
) {
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
    title: args.body.title,
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
  } satisfies typeof hostedDeployments.$inferInsert;
}

type HostedAllocationQuery =
  | {
      readonly kind: "site";
      readonly condition: SQL | undefined;
    }
  | {
      readonly kind: "public-version" | "private-version";
      readonly siteId: string;
    }
  | { readonly kind: "asset-conflict"; readonly query: SQL };

export interface HostedAllocationQueryResult {
  readonly site?: HostedSiteRow;
  readonly version?: number | null;
  readonly path?: string;
}

type SiteAllocationPlan = Generator<
  HostedAllocationQuery,
  HostedSiteResolution,
  HostedAllocationQueryResult
>;

function* hostedSiteAllocationPlan(
  args: PrepareDeploymentArgs,
  now: Date,
  siteId: string,
): SiteAllocationPlan {
  const existing = (yield {
    kind: "site",
    condition: hostedSiteCondition(args),
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
    const previousOwner = (yield {
      kind: "site",
      condition: hostedSiteAddressCondition(publicSlug),
    }).site;
    // A renamed website keeps its publication history and old R2 pointers.
    // Reusing those names for another site would fail publication or hijack links.
    if (previousOwner) {
      if (
        previousOwner.orgId === args.orgId &&
        previousOwner.linkLayoutSegment ===
          linkLayoutSegment(CURRENT_LINK_LAYOUT) &&
        previousOwner.deletedAt === null &&
        (previousOwner.requestedSlug === args.body.site ||
          previousOwner.slug === publicSlug)
      ) {
        return resolvedHostedSite(previousOwner, args);
      }
      continue;
    }
    return {
      kind: "ok",
      site: {
        id: siteId,
        publicSlug,
        linkLayoutSegment: linkLayoutSegment(CURRENT_LINK_LAYOUT),
      },
      create: {
        ...hostedSiteAllocationValues(args, publicSlug, attempt, now),
        id: siteId,
      },
    };
  }
  return { kind: "slug_conflict" };
}

export interface PreparedHostedAllocation {
  readonly kind: "prepared";
  readonly site: HostedSiteIdentity;
  readonly create: typeof hostedSites.$inferInsert | null;
  readonly deployment: ReturnType<typeof hostedDeploymentValues>;
  readonly version: number;
  readonly assets: Readonly<Record<string, string>>;
}

/** Preparation reads only; publication rechecks these facts in one statement. */
export function* hostedDeploymentAllocationPlan(
  args: PrepareDeploymentArgs,
  context: CreateHostedSiteDeploymentContext,
  siteId: string,
): Generator<
  HostedAllocationQuery,
  | PreparedHostedAllocation
  | Exclude<SiteDeploymentCreationResult, { readonly kind: "ok" }>,
  HostedAllocationQueryResult
> {
  const resolution = yield* hostedSiteAllocationPlan(args, context.now, siteId);
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
  return {
    kind: "prepared",
    site,
    create: resolution.create,
    deployment: values,
    version: deploymentVersion,
    assets,
  };
}

export function hostedAllocationSiteCondition(
  prepared: PreparedHostedAllocation,
  args: PrepareDeploymentArgs,
) {
  return and(
    eq(hostedSites.id, prepared.site.id),
    eq(hostedSites.orgId, args.orgId),
    eq(hostedSites.userId, args.userId),
    eq(hostedSites.publicSlug, prepared.site.publicSlug),
    eq(hostedSites.linkLayoutSegment, prepared.site.linkLayoutSegment),
    isNull(hostedSites.deletedAt),
  );
}

/** History and immutable paths use the same publication snapshot. */
export function hostedAllocationVersionSql(siteId: string) {
  return sql`greatest(
    coalesce((select ${max(sql`(${hostedDeployments.manifest}->>'deploymentVersion')::integer`)}
      from ${hostedDeployments} where ${eq(hostedDeployments.siteId, siteId)}), 0),
    coalesce((select ${max(sql`(${privateHostedDeployments.manifest}->>'deploymentVersion')::integer`)}
      from ${privateHostedDeployments} where ${eq(privateHostedDeployments.siteId, siteId)}), 0)
  ) + 1`;
}

/** INSERT SELECT preserves the original column encoders and database defaults. */
export function hostedAllocationDeploymentSelection(
  value: PreparedHostedAllocation["deployment"],
) {
  return {
    id: sql`${value.id}::uuid`.mapWith(hostedDeployments.id).as("id"),
    siteId: sql`${value.siteId}::uuid`
      .mapWith(hostedDeployments.siteId)
      .as("site_id"),
    orgId: sql`${value.orgId}`.mapWith(hostedDeployments.orgId).as("org_id"),
    userId: sql`${value.userId}`
      .mapWith(hostedDeployments.userId)
      .as("user_id"),
    runId: sql`${value.runId ?? null}`
      .mapWith(nullableDriverValueDecoder(hostedDeployments.runId))
      .as("run_id"),
    linkLayoutSegment: sql`${value.linkLayoutSegment}`
      .mapWith(hostedDeployments.linkLayoutSegment)
      .as("link_layout_segment"),
    status: sql`${value.status}`.mapWith(hostedDeployments.status).as("status"),
    artifactUrl: sql`${value.artifactUrl}`
      .mapWith(nullableDriverValueDecoder(hostedDeployments.artifactUrl))
      .as("artifact_url"),
    r2Prefix: sql`${value.r2Prefix}`
      .mapWith(hostedDeployments.r2Prefix)
      .as("r2_prefix"),
    manifest:
      sql`${sql.param(value.manifest, hostedDeployments.manifest)}::jsonb`
        .mapWith(hostedDeployments.manifest)
        .as("manifest"),
    manifestHash: sql`${value.manifestHash}`
      .mapWith(hostedDeployments.manifestHash)
      .as("manifest_hash"),
    contentHash: sql`${value.contentHash}`
      .mapWith(hostedDeployments.contentHash)
      .as("content_hash"),
    entrypoint: sql`${value.entrypoint}`
      .mapWith(hostedDeployments.entrypoint)
      .as("entrypoint"),
    spaFallback: sql`${value.spaFallback}::boolean`
      .mapWith(hostedDeployments.spaFallback)
      .as("spa_fallback"),
    fileCount: sql`${value.fileCount}::integer`
      .mapWith(hostedDeployments.fileCount)
      .as("file_count"),
    sizeBytes:
      sql`${sql.param(value.sizeBytes, hostedDeployments.sizeBytes)}::bigint`
        .mapWith(hostedDeployments.sizeBytes)
        .as("size_bytes"),
    url: sql`${value.url}`.mapWith(hostedDeployments.url).as("url"),
    error: sql`null`
      .mapWith(nullableDriverValueDecoder(hostedDeployments.error))
      .as("error"),
    createdAt: sql`now()::timestamp`
      .mapWith(hostedDeployments.createdAt)
      .as("created_at"),
    updatedAt:
      sql`${sql.param(value.updatedAt, hostedDeployments.updatedAt)}::timestamp`
        .mapWith(hostedDeployments.updatedAt)
        .as("updated_at"),
    readyAt: sql`null::timestamp`
      .mapWith(nullableDriverValueDecoder(hostedDeployments.readyAt))
      .as("ready_at"),
  };
}
