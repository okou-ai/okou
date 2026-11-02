import type {
  HostedSiteAccessDecision,
  HostedSiteVisibility,
} from "@okouai/api-contracts/contracts/hosted-site-access";
import {
  checkHostedSiteAccess$,
  prepareHostedSiteVisibility$,
} from "./hosted-site-access.service";
import { command } from "ccstate";
import {
  hostedSiteAssetNameError,
  type HostedSiteDeleteResponse,
  type HostedSiteFilesResponse,
  type HostedSiteDeploymentsResponse,
  type HostedSitePrepareRequest,
} from "@okouai/api-contracts/contracts/host";
import { boolean, literal, object, string, uuid } from "zod";
import {
  CURRENT_LINK_LAYOUT,
  hostedSitePointerNamespace,
  linkLayoutFromSegment,
  linkLayoutSegment,
  type LinkLayout,
} from "@okouai/api-contracts/contracts/link-layout";
import {
  artifactDeliveryKey,
  artifactDeliveryRecordSchema,
} from "@okouai/api-contracts/contracts/artifact-delivery";
import { artifactShares } from "@okouai/db/schema/artifact-share";
import {
  hostedDeployments,
  privateHostedDeployments,
  hostedSites,
} from "@okouai/db/runtime/hosted-site";
import {
  and,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { env } from "../../lib/env";
import { hostedLinkDomain, hostedLinkOrigin } from "../../lib/link-layout";
import {
  legacyHostedDeploymentVersion,
  legacyPrivateHostedDeploymentVersion,
} from "../../lib/hosted-publication";
import {
  nullableDriverValueDecoder,
  pgIntegerDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { isUniqueViolation } from "../../lib/pg-errors";
import type { HostedSitePointer } from "../../lib/hosted-site-pointer";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  deleteHostedSitesS3Objects,
  generateHostedSitesPresignedPutUrl,
  hostedSitesS3ObjectExists,
  putHostedSitesS3Object,
} from "../external/s3";
import { nowDate } from "../../lib/time";
import {
  ArtifactDeliveryAliasConflict,
  registerLegacyHostedSite$,
} from "./artifact-delivery.service";
import {
  readHostedPointerPublication$,
  readHostedSnapshotPolicy$,
  preserveHostedSnapshotToken$,
  writeHostedPointerPublication$,
  retainedHostedDeploymentCondition,
  validateRetainedHostedDeployment,
  hostedSnapshotSourceCondition,
  hostedSiteAliasConflict,
  storedObject,
} from "./hosted-site-publication-migration.service";
import { recordHostedSiteArtifact$ } from "./run-uploaded-files.service";
import { artifacts } from "@okouai/db/schema/artifact";
import {
  completeHostedPreview$,
  prepareHostedPreview$,
} from "./hosted-preview.service";
import { privateArtifactsBucket } from "./private-artifact-storage.service";
import {
  collectHostedSiteDependencies$,
  hostedSiteDeliveryManifest,
} from "./hosted-site-dependencies.service";
import {
  hostedDeploymentAllocationPlan,
  hostedAllocationSiteCondition,
  hostedAllocationVersionSql,
  hostedAllocationDeploymentSelection,
  hostedAssetConflictQuery,
  type HostedAllocationQueryResult,
  type PrepareDeploymentArgs,
  type SiteDeploymentCreationResult,
  type CreateHostedSiteDeploymentContext,
} from "./hosted-site-allocation-plan";
import { signHostedSiteFiles$ } from "./hosted-site-files.service";
import {
  resolveArtifactShareDownload$,
  resolveHostedSitePublicationDownload$,
  updateArtifactShare$,
} from "./artifact-shares.service";
const MAX_HOSTED_SITE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_HOSTED_SITE_FILE_BYTES = 100 * 1024 * 1024;
const IMMUTABLE_DEPLOYMENT_HOST_PATTERN =
  /^dpl-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

function publicationIdentityViolation(
  owned: {
    readonly orgId: string;
    readonly siteOrgId: string;
    readonly identity: {
      readonly deploymentId: string;
      readonly siteId: string;
      readonly publicSlug: string;
      readonly access: "owner-private-v1" | null;
      readonly hasAccess: boolean;
    };
  },
  args: {
    readonly deploymentId: string;
    readonly siteId: string;
    readonly publicSlug: string;
  },
): "org_mismatch" | "manifest_identity" | "access_marker" | null {
  if (owned.orgId !== owned.siteOrgId) {
    return "org_mismatch";
  }
  if (
    owned.identity.deploymentId !== args.deploymentId ||
    owned.identity.siteId !== args.siteId
  ) {
    return "manifest_identity";
  }
  if (owned.identity.hasAccess && owned.identity.access === null) {
    return "access_marker";
  }
  return null;
}

/** R2 references do not carry authority over a deployment's current lifecycle. */
export const authorizeHostedSiteDelivery$ = command(
  async (
    { get, set },
    args: {
      readonly siteId: string;
      readonly viewerUserId?: string;
      readonly deploymentId: string;
      readonly alias: string;
      readonly publicSlug: string;
      readonly publicBrand: "vm0" | "okou";
      readonly prefix: string;
      readonly manifestKey: string;
    },
    signal: AbortSignal,
  ): Promise<HostedSiteAccessDecision> => {
    const db = get(db$);
    const [owned] = await db
      .select({
        prefix: hostedDeployments.r2Prefix,
        activeDeploymentId: hostedSites.activeDeploymentId,
        currentPublicSlug: hostedSites.publicSlug,
        orgId: hostedDeployments.orgId,
        siteOrgId: hostedSites.orgId,
        identity: sql`jsonb_build_object(
          'deploymentId', ${hostedDeployments.manifest}->'deploymentId',
          'siteId', ${hostedDeployments.manifest}->'siteId',
          'publicSlug', ${hostedDeployments.manifest}->'publicSlug',
          'access', ${hostedDeployments.manifest}->'access',
          'hasAccess', ${hostedDeployments.manifest} ? 'access'
        )`.mapWith(
          zodDriverValueDecoder(
            object({
              deploymentId: uuid(),
              siteId: uuid(),
              publicSlug: string(),
              access: literal("owner-private-v1").nullable(),
              hasAccess: boolean(),
            }),
          ),
        ),
      })
      .from(hostedDeployments)
      .innerJoin(hostedSites, eq(hostedSites.id, hostedDeployments.siteId))
      .where(
        and(
          eq(hostedDeployments.id, args.deploymentId),
          eq(hostedSites.id, args.siteId),
          eq(hostedSites.linkLayoutSegment, args.publicBrand),
          eq(hostedDeployments.linkLayoutSegment, args.publicBrand),
          eq(hostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!owned) {
      return { allowed: false, decision: "deny" };
    }
    // Organization-scoped sites (before #23908) let any member publish to a
    // site another member created, so the deployment publisher need not be
    // the site creator. Allocation now rejects such redeploys.
    const violation = publicationIdentityViolation(owned, args);
    if (violation) {
      throw new Error(
        `Hosted deployment has an invalid publication identity: ${violation}`,
      );
    }
    const valid =
      !owned.identity.hasAccess &&
      owned.identity.publicSlug === args.publicSlug &&
      owned.prefix === args.prefix &&
      args.manifestKey === `${args.prefix}/manifest.json` &&
      (args.alias === `dpl-${args.deploymentId}` ||
        (args.alias === owned.currentPublicSlug &&
          owned.activeDeploymentId === args.deploymentId));
    if (!valid) {
      return { allowed: false, decision: "deny" };
    }
    return set(
      checkHostedSiteAccess$,
      { siteId: args.siteId, userId: args.viewerUserId },
      signal,
    );
  },
);

interface CompleteDeploymentArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly deploymentId: string;
}

interface GetHostedSiteFilesArgs {
  readonly orgId?: string;
  readonly userId: string;
  readonly publicSlug: string;
  readonly version?: number;
  readonly hostname?: string;
}

interface GetHostedSiteDeploymentsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly site: string;
}

type PrepareDeploymentResult =
  | {
      readonly status: "ok";
      readonly body: {
        readonly siteId: string;
        readonly visibility: HostedSiteVisibility;
        readonly deploymentId: string;
        readonly publicSlug: string;
        readonly url: string;
        readonly deploymentVersion?: number;
        readonly artifactUrl?: string;
        readonly aliasUrl?: string;
        readonly uploads: readonly {
          readonly path: string;
          readonly uploadUrl: string;
        }[];
        readonly preview?: {
          readonly uploadUrl: string;
          readonly sha256: string;
        };
      };
    }
  | { readonly status: "forbidden" }
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

type CompleteDeploymentResult =
  | {
      readonly status: "ok";
      readonly body: {
        readonly siteId: string;
        readonly deploymentId: string;
        readonly publicSlug: string;
        readonly url: string;
        readonly deploymentVersion?: number;
        readonly artifactUrl?: string;
        readonly aliasUrl?: string;
        readonly isActive?: boolean;
        readonly activeDeploymentVersion?: number;
        readonly status: "ready";
        readonly previewImageUrl?: string;
      };
    }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

type GetHostedSiteFilesResult =
  | {
      readonly status: "ok";
      readonly body: HostedSiteFilesResponse;
    }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

type GetHostedSiteDeploymentsResult =
  | {
      readonly status: "ok";
      readonly body: HostedSiteDeploymentsResponse;
    }
  | { readonly status: "not_found"; readonly message: string };

type HostedSiteRow = typeof hostedSites.$inferSelect;
type HostedDeploymentRow = typeof hostedDeployments.$inferSelect;

type HostedSiteFilesTargetResult =
  | {
      readonly status: "ok";
      readonly site: HostedSiteRow;
      readonly deployment: HostedDeploymentRow;
    }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string };

interface HostedSitePromotion {
  readonly publicSlug: string;
  readonly activeDeploymentId: string | null;
  readonly activeDeploymentVersion: number | null;
}

interface HostedR2Config {
  readonly bucket: string;
}

type HostedR2ConfigResult =
  | { readonly status: "ok"; readonly config: HostedR2Config }
  | { readonly status: "config_error"; readonly message: string };

function hostedR2Config(): HostedR2ConfigResult {
  const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (!bucket) {
    return {
      status: "config_error",
      message: "R2_HOSTED_SITES_BUCKET_NAME is not configured",
    };
  }
  if (!env("R2_HOSTED_SITES_ACCESS_KEY_ID")) {
    return {
      status: "config_error",
      message: "R2_HOSTED_SITES_ACCESS_KEY_ID is not configured",
    };
  }
  if (!env("R2_HOSTED_SITES_SECRET_ACCESS_KEY")) {
    return {
      status: "config_error",
      message: "R2_HOSTED_SITES_SECRET_ACCESS_KEY is not configured",
    };
  }
  return { status: "ok", config: { bucket } };
}

/** Stored layout of a site or deployment row; legacy rows keep their links. */
function rowLinkLayout(row: {
  readonly linkLayoutSegment: string;
}): LinkLayout {
  return linkLayoutFromSegment(row.linkLayoutSegment);
}

function immutableDeploymentPointerKey(
  layout: LinkLayout,
  deploymentId: string,
): string {
  return `${hostedSitePointerNamespace(layout)}/deployments/${deploymentId}.json`;
}

function hostedSiteRequestedSlug(site: HostedSiteRow): string {
  return site.requestedSlug ?? site.slug;
}

type CompleteDeploymentLookupResult =
  | { readonly status: "ok"; readonly deployment: HostedDeploymentRow }
  | Extract<CompleteDeploymentResult, { status: "not_found" }>;

const resolveHostedDeploymentForCompletion$ = command(
  async (
    { get },
    args: CompleteDeploymentArgs,
    signal: AbortSignal,
  ): Promise<CompleteDeploymentLookupResult> => {
    const db = get(db$);
    const [privateDeployment] = await db
      .select()
      .from(privateHostedDeployments)
      .where(
        and(
          eq(privateHostedDeployments.id, args.deploymentId),
          eq(privateHostedDeployments.orgId, args.orgId),
          eq(privateHostedDeployments.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (privateDeployment) {
      if (privateDeployment.manifest.access !== "owner-private-v1") {
        throw new Error(
          "Private hosted deployment has an invalid access policy",
        );
      }
      const [site] = await db
        .select()
        .from(hostedSites)
        .where(
          and(
            eq(hostedSites.id, privateDeployment.siteId),
            isNull(hostedSites.deletedAt),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!site) {
        return { status: "not_found", message: "Hosted deployment not found" };
      }
      return { status: "ok", deployment: privateDeployment };
    }
    const [ownedDeployment] = await db
      .select({
        deployment: hostedDeployments,
      })
      .from(hostedDeployments)
      .innerJoin(hostedSites, eq(hostedSites.id, hostedDeployments.siteId))
      .where(
        and(
          eq(hostedDeployments.id, args.deploymentId),
          eq(hostedDeployments.orgId, args.orgId),
          eq(hostedDeployments.userId, args.userId),
          eq(hostedSites.userId, args.userId),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!ownedDeployment) {
      return { status: "not_found", message: "Hosted deployment not found" };
    }
    return {
      status: "ok",
      deployment: ownedDeployment.deployment,
    };
  },
);

function deploymentVersionResponseFields(deployment: HostedDeploymentRow): {
  readonly deploymentVersion?: number;
  readonly artifactUrl?: string;
  readonly aliasUrl?: string;
} {
  const deploymentVersion = legacyHostedDeploymentVersion(deployment.manifest);
  if (deploymentVersion === null || deployment.artifactUrl === null) {
    return {};
  }
  return {
    deploymentVersion,
    artifactUrl: deployment.artifactUrl,
    ...(deployment.manifest.access ? {} : { aliasUrl: deployment.url }),
  };
}

function hostedSiteResponseAddress(
  deployment: HostedDeploymentRow,
  publicSlug: string,
) {
  const aliasUrl = hostedLinkOrigin(rowLinkLayout(deployment), publicSlug);
  return {
    publicSlug,
    url: deployment.manifest.access ? deployment.url : aliasUrl,
    ...deploymentVersionResponseFields(deployment),
    ...(deployment.manifest.access ? {} : { aliasUrl }),
  };
}

function fileKey(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

function isSafeSitePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }
  if (path.includes("\\") || path.includes("\0")) {
    return false;
  }
  const segments = path.split("/").filter((segment) => {
    return segment.length > 0;
  });
  return !segments.some((segment) => {
    return segment === "." || segment === "..";
  });
}

function validateFiles(
  files: readonly HostedSitePrepareRequest["files"][number][],
): string | null {
  const seen = new Set<string>();
  let totalSize = 0;
  for (const file of files) {
    if (!isSafeSitePath(file.path)) {
      return `Invalid hosted-site path: ${file.path}`;
    }
    if (file.path === "/manifest.json") {
      return "Hosted-site path is reserved: /manifest.json";
    }
    if (seen.has(file.path)) {
      return `Duplicate hosted-site path: ${file.path}`;
    }
    seen.add(file.path);
    const nameError = hostedSiteAssetNameError(file);
    if (nameError) {
      return nameError;
    }
    if (file.size > MAX_HOSTED_SITE_FILE_BYTES) {
      return `Hosted-site file too large: ${file.path}`;
    }
    totalSize += file.size;
    if (totalSize > MAX_HOSTED_SITE_TOTAL_BYTES) {
      return "Hosted-site deployment is too large";
    }
  }
  if (!seen.has("/index.html")) {
    return "Hosted-site deployment must include /index.html";
  }
  return null;
}

function hostedSiteArtifactArgs(
  deployment: HostedDeploymentRow,
  publicSlug: string,
) {
  const artifactKind = deployment.manifest.artifactKind ?? "hosted-site";
  return {
    runId: deployment.runId,
    userId: deployment.userId,
    orgId: deployment.orgId,
    artifactKind,
    siteId: deployment.siteId,
    deploymentId: deployment.id,
    deploymentVersion: legacyHostedDeploymentVersion(deployment.manifest),
    immutableContent: deployment.manifest.immutableContent === true,
    site: deployment.manifest.site ?? deployment.manifest.publicSlug,
    title: deployment.manifest.title,
    publicSlug,
    aliasUrl: deployment.manifest.access
      ? undefined
      : hostedLinkOrigin(rowLinkLayout(deployment), publicSlug),
    access: deployment.manifest.access,
    url: deployment.artifactUrl ?? deployment.url,
    fileCount: deployment.fileCount,
    sizeBytes: deployment.sizeBytes,
    entrypoint: deployment.entrypoint,
    spaFallback: deployment.spaFallback,
    layout: rowLinkLayout(deployment),
  };
}

const createHostedSiteDeployment$ = command(
  async (
    { get, set },
    args: PrepareDeploymentArgs,
    context: CreateHostedSiteDeploymentContext,
  ): Promise<SiteDeploymentCreationResult> => {
    const readDb = get(db$);
    const plan = hostedDeploymentAllocationPlan(
      args,
      context,
      crypto.randomUUID(),
    );
    let step = plan.next();
    while (!step.done) {
      const query = step.value;
      let result: HostedAllocationQueryResult;
      if (query.kind === "site") {
        const [site] = await readDb
          .select()
          .from(hostedSites)
          .where(query.condition)
          .limit(1);
        result = { site };
      } else if (query.kind === "asset-conflict") {
        const rows = await readDb
          .select({
            path: sql`hosted_asset_conflict.path`.mapWith(pgTextDecoder),
          })
          .from(sql`(${query.query}) AS hosted_asset_conflict`);
        result = { path: rows[0]?.path };
      } else {
        const table =
          query.kind === "public-version"
            ? hostedDeployments
            : privateHostedDeployments;
        const [row] = await readDb
          .select({
            version:
              sql`max((${table.manifest}->>'deploymentVersion')::integer)`.mapWith(
                nullableDriverValueDecoder(pgIntegerDecoder),
              ),
          })
          .from(table)
          .where(eq(table.siteId, query.siteId));
        result = { version: row?.version };
      }
      step = plan.next(result);
    }
    const prepared = step.value;
    if (prepared.kind !== "prepared") {
      return prepared;
    }
    const db = set(writeDb$);
    const site = db
      .$with("allocation_site")
      .as(
        prepared.create
          ? db
              .insert(hostedSites)
              .values(prepared.create)
              .onConflictDoNothing()
              .returning()
          : db
              .select()
              .from(hostedSites)
              .where(hostedAllocationSiteCondition(prepared, args))
              .for("update")
              .limit(1),
      );
    const deployment = db.$with("allocation_deployment").as(
      db
        .insert(hostedDeployments)
        .select(
          db
            .select(hostedAllocationDeploymentSelection(prepared.deployment))
            .from(site)
            .where(
              and(
                eq(
                  hostedAllocationVersionSql(prepared.site.id),
                  prepared.version,
                ),
                Object.keys(prepared.assets).length === 0
                  ? undefined
                  : notExists(
                      sql`(${hostedAssetConflictQuery(
                        prepared.site.id,
                        prepared.assets,
                      )})`,
                    ),
              ),
            ),
        )
        .returning(),
    );
    // Retain the existing site lock. A writer that committed after this
    // statement's snapshot is rejected by the existing version unique key.
    const result = await settle(
      db
        .with(site, deployment)
        .select()
        .from(deployment)
        .innerJoin(site, eq(site.id, deployment.siteId)),
    );
    if (!result.ok) {
      if (
        isUniqueViolation(
          result.error,
          "idx_hosted_deployments_site_manifest_version",
        )
      ) {
        return { kind: "allocation_conflict" };
      }
      throw result.error;
    }
    const written = result.value[0];
    return written
      ? {
          kind: "ok",
          site: written.allocation_site,
          deployment: written.allocation_deployment,
        }
      : { kind: "allocation_conflict" };
  },
);

export const prepareHostedSiteDeployment$ = command(
  async (
    { get, set },
    args: PrepareDeploymentArgs,
    signal: AbortSignal,
  ): Promise<PrepareDeploymentResult> => {
    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }

    const fileError = validateFiles(args.body.files);
    if (fileError) {
      return { status: "bad_request", message: fileError };
    }

    // A site's alias is its durable address; site policies do not turn it into
    // a private artifact reference.
    if (args.body.requirePrivateArtifact) {
      return { status: "forbidden" };
    }
    const previewRequest = args.body.preview;
    if (previewRequest) {
      // Fail before creating a deployment if private preview storage is absent.
      privateArtifactsBucket();
    }
    const siteAndDeployment = await set(createHostedSiteDeployment$, args, {
      now: nowDate(),
      deploymentId: crypto.randomUUID(),
    });
    // Allocation commits one SQL unit before request cancellation is observed.
    signal.throwIfAborted();
    if (siteAndDeployment.kind === "content_conflict") {
      return { status: "conflict", message: siteAndDeployment.message };
    }
    if (siteAndDeployment.kind === "allocation_conflict") {
      return {
        status: "conflict",
        message:
          "Hosted site allocation changed. Retry publishing the same site.",
      };
    }
    if (siteAndDeployment.kind === "owner_conflict") {
      return {
        status: "conflict",
        message: `Hosted site "${args.body.site}" belongs to another owner. Choose a different --site value and rerun the same okou host command.`,
      };
    }
    if (siteAndDeployment.kind === "slug_conflict") {
      return {
        status: "conflict",
        message: `Unable to allocate a unique hosted site slug for "${args.body.site}". Retry publishing or choose a different --site value.`,
      };
    }
    const publicSlug = siteAndDeployment.site.publicSlug;
    const url = siteAndDeployment.deployment.url;

    const visibility = await set(
      prepareHostedSiteVisibility$,
      {
        orgId: args.orgId,
        userId: args.userId,
        siteId: siteAndDeployment.site.id,
        visibility: args.body.visibility,
        unpublished: siteAndDeployment.site.activeDeploymentId === null,
      },
      signal,
    );
    if (visibility.status !== "ok") {
      return visibility;
    }

    const uploadRequests = [];
    for (const file of Object.values(
      siteAndDeployment.deployment.manifest.files,
    )) {
      uploadRequests.push(
        (async () => {
          const uploadUrl = await get(
            generateHostedSitesPresignedPutUrl(
              hostedR2.config.bucket,
              fileKey(siteAndDeployment.deployment.r2Prefix, file.path),
              file.contentType,
              true,
            ),
          );
          return { path: file.path, uploadUrl };
        })(),
      );
    }
    const uploads = await Promise.all(uploadRequests);
    signal.throwIfAborted();

    const preview = previewRequest
      ? await set(
          prepareHostedPreview$,
          siteAndDeployment.deployment.id,
          previewRequest,
          signal,
        )
      : undefined;
    // The caller supplies an initial name; a published site's catalog owns
    // subsequent title changes, including redeploys from another chat.
    const [artifact] =
      args.body.title === undefined
        ? []
        : await get(db$)
            .select({ title: artifacts.title })
            .from(artifacts)
            .where(
              and(
                eq(artifacts.orgId, args.orgId),
                eq(artifacts.logicalKey, `site:${siteAndDeployment.site.id}`),
              ),
            )
            .limit(1);
    signal.throwIfAborted();
    return {
      status: "ok",
      body: {
        siteId: siteAndDeployment.site.id,
        visibility: visibility.visibility,
        ...(args.body.title === undefined
          ? {}
          : { title: artifact?.title ?? args.body.title }),
        deploymentId: siteAndDeployment.deployment.id,
        publicSlug,
        url,
        ...deploymentVersionResponseFields(siteAndDeployment.deployment),
        uploads,
        ...(preview ? { preview } : {}),
      },
    };
  },
);

const firstMissingHostedDeploymentPath$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly deployment: HostedDeploymentRow;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    for (const file of Object.values(args.deployment.manifest.files)) {
      const exists = await get(
        hostedSitesS3ObjectExists(
          args.bucket,
          fileKey(args.deployment.r2Prefix, file.path),
        ),
      );
      signal.throwIfAborted();
      if (!exists) {
        return file.path;
      }
    }
    return null;
  },
);

function activeSitePointerForDeployment(
  deployment: HostedDeploymentRow,
  manifestKey: string,
  readyAt: Date,
): HostedSitePointer {
  const deploymentVersion = legacyHostedDeploymentVersion(deployment.manifest);
  return {
    version: 1,
    // Persisted layout marker; deployed Workers treat its absence as legacy.
    publicBrand: linkLayoutSegment(rowLinkLayout(deployment)),
    publicSlug: deployment.manifest.publicSlug,
    siteId: deployment.siteId,
    deploymentId: deployment.id,
    ...(deploymentVersion === null ? {} : { deploymentVersion }),
    ...(deployment.artifactUrl === null
      ? {}
      : { artifactUrl: deployment.artifactUrl }),
    prefix: deployment.r2Prefix,
    manifestKey,
    spaFallback: deployment.spaFallback,
    updatedAt: readyAt.toISOString(),
  };
}

interface HostedSiteBindingArgs {
  readonly bucket: string;
  readonly deployment: HostedDeploymentRow;
  readonly orgId: string;
  readonly pointer: HostedSitePointer;
  readonly readyAt: Date;
}

function ownedHostedBindingSite(
  site: HostedSiteRow | undefined,
  deployment: HostedDeploymentRow,
): HostedSiteRow {
  if (!site) {
    throw new Error("Hosted site not found for deployment");
  }
  if (
    site.deletedAt !== null ||
    site.userId !== deployment.userId ||
    site.linkLayoutSegment !== deployment.linkLayoutSegment
  ) {
    throw new ArtifactDeliveryAliasConflict(
      "Hosted deployment no longer matches its owned site",
    );
  }
  return site;
}

function activeHostedBindingVersion(
  active: { readonly version: number | null } | undefined,
): number | null {
  if (!active) {
    throw new Error("Hosted site has an invalid public deployment binding");
  }
  return active.version;
}

function shouldBindHostedDeployment(
  deployment: HostedDeploymentRow,
  activeVersion: number | null,
) {
  const version = legacyHostedDeploymentVersion(deployment.manifest);
  return (
    !deployment.manifest.access &&
    (version === null
      ? activeVersion === null
      : activeVersion === null || version >= activeVersion)
  );
}

function hostedDeploymentReadyValues(readyAt: Date) {
  return { status: "ready" as const, readyAt, updatedAt: readyAt, error: null };
}

function deletedHostedVersionKeys(deployment: HostedDeploymentRow) {
  const layout = rowLinkLayout(deployment);
  return [
    immutableDeploymentPointerKey(layout, deployment.id),
    artifactDeliveryKey(
      linkLayoutSegment(layout),
      "html",
      `dpl-${deployment.id}`,
    ),
  ];
}

function hostedBindingSiteCondition(siteId: string, orgId: string) {
  return and(eq(hostedSites.id, siteId), eq(hostedSites.orgId, orgId));
}

function activeHostedBindingCondition(deploymentId: string, siteId: string) {
  return and(
    eq(hostedDeployments.id, deploymentId),
    eq(hostedDeployments.siteId, siteId),
  );
}

const commitHostedSiteDeployment$ = command(
  async (
    { get, set },
    args: HostedSiteBindingArgs,
    site: HostedSiteRow,
    published: HostedSitePointer | null,
    signal: AbortSignal,
  ): Promise<HostedSitePromotion | undefined> => {
    const db = get(db$);
    const writeDb = set(writeDb$);
    const deploymentTable = args.deployment.manifest.access
      ? privateHostedDeployments
      : hostedDeployments;
    const readyIds =
      published && published.deploymentId !== args.deployment.id
        ? [args.deployment.id, published.deploymentId]
        : [args.deployment.id];
    const ready = writeDb.$with("ready_hosted_deployments").as(
      writeDb
        .update(deploymentTable)
        .set(hostedDeploymentReadyValues(args.readyAt))
        .where(
          and(
            inArray(deploymentTable.id, readyIds),
            eq(deploymentTable.siteId, site.id),
            eq(deploymentTable.orgId, args.orgId),
            eq(deploymentTable.userId, args.deployment.userId),
            eq(
              deploymentTable.linkLayoutSegment,
              args.deployment.linkLayoutSegment,
            ),
            ne(deploymentTable.status, "deleted"),
          ),
        )
        .returning({ id: deploymentTable.id }),
    );
    const activeBinding = db
      .select({
        version:
          sql`(${hostedDeployments.manifest}->>'deploymentVersion')::integer`.mapWith(
            nullableDriverValueDecoder(pgIntegerDecoder),
          ),
      })
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, hostedSites.activeDeploymentId),
          eq(hostedDeployments.siteId, hostedSites.id),
        ),
      );
    const activeVersion = sql`(${activeBinding})`;
    // A newer completion can bind while this one waits. Compare immutable
    // versions against the actual Site row rather than the earlier read.
    const nextBinding = published
      ? sql`CASE
          WHEN ${isNull(hostedSites.activeDeploymentId)} THEN ${published.deploymentId}::uuid
          WHEN ${exists(activeBinding)} AND (
            ${isNull(activeVersion)}
            OR ${gte(sql`${published.deploymentVersion ?? null}::integer`, activeVersion)}
          ) THEN ${published.deploymentId}::uuid
          ELSE ${hostedSites.activeDeploymentId}
        END`
      : hostedSites.activeDeploymentId;
    // Remote publication is complete before this one local atomic statement.
    // A concurrent deletion may win; publication does not hold a site lock
    // while waiting for storage, and does not revive a deleted version.
    const [promotion] = await writeDb
      .with(ready)
      .update(hostedSites)
      .set({
        activeDeploymentId: nextBinding,
        updatedAt: published ? args.readyAt : hostedSites.updatedAt,
      })
      .where(
        and(
          hostedBindingSiteCondition(site.id, args.orgId),
          eq(hostedSites.userId, args.deployment.userId),
          eq(hostedSites.linkLayoutSegment, args.deployment.linkLayoutSegment),
          isNull(hostedSites.deletedAt),
          eq(db.select({ count: count() }).from(ready), readyIds.length),
        ),
      )
      .returning({
        publicSlug: hostedSites.publicSlug,
        activeDeploymentId: hostedSites.activeDeploymentId,
        activeDeploymentVersion: activeVersion.mapWith(
          nullableDriverValueDecoder(pgIntegerDecoder),
        ),
      });
    signal.throwIfAborted();
    return promotion;
  },
);

const bindHostedSiteDeployment$ = command(
  async (
    { get, set },
    args: HostedSiteBindingArgs,
    signal: AbortSignal,
  ): Promise<HostedSitePromotion> => {
    const db = get(db$);
    const [ownedSite] = await db
      .select()
      .from(hostedSites)
      .where(hostedBindingSiteCondition(args.deployment.siteId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    const site = ownedHostedBindingSite(ownedSite, args.deployment);
    const deploymentTable = args.deployment.manifest.access
      ? privateHostedDeployments
      : hostedDeployments;
    const [current] = await db
      .select({ status: deploymentTable.status })
      .from(deploymentTable)
      .where(eq(deploymentTable.id, args.deployment.id))
      .limit(1);
    signal.throwIfAborted();
    if (current?.status === "deleted") {
      await get(
        deleteHostedSitesS3Objects(
          args.bucket,
          deletedHostedVersionKeys(args.deployment),
          signal,
        ),
      );
      signal.throwIfAborted();
      throw new ArtifactDeliveryAliasConflict("Hosted deployment is deleted");
    }
    let activeDeploymentVersion: number | null = null;
    if (site.activeDeploymentId !== null) {
      const [active] = await db
        .select({
          version:
            sql`(${hostedDeployments.manifest}->>'deploymentVersion')::integer`.mapWith(
              nullableDriverValueDecoder(pgIntegerDecoder),
            ),
        })
        .from(hostedDeployments)
        .where(activeHostedBindingCondition(site.activeDeploymentId, site.id))
        .limit(1);
      signal.throwIfAborted();
      activeDeploymentVersion = activeHostedBindingVersion(active);
    }
    signal.throwIfAborted();
    let published: HostedSitePointer | null = null;
    if (shouldBindHostedDeployment(args.deployment, activeDeploymentVersion)) {
      const publication = await set(
        readHostedPointerPublication$,
        { site, bucket: args.bucket, pointer: args.pointer },
        signal,
      );
      if (publication.retained) {
        const [retained] = await db
          .select()
          .from(hostedDeployments)
          .where(retainedHostedDeploymentCondition(site, publication.pointer));
        signal.throwIfAborted();
        validateRetainedHostedDeployment(retained, publication.pointer);
      }
      signal.throwIfAborted();
      if (publication.previous?.kind === "publication") {
        const [share] = await db
          .select()
          .from(artifactShares)
          .where(eq(artifactShares.id, publication.previous.shareId));
        signal.throwIfAborted();
        const snapshot = await set(
          readHostedSnapshotPolicy$,
          { site, bucket: args.bucket, record: publication.previous, share },
          signal,
        );
        const [source] = await db
          .select({ id: privateHostedDeployments.id })
          .from(privateHostedDeployments)
          .where(hostedSnapshotSourceCondition(snapshot));
        signal.throwIfAborted();
        if (!source) {
          hostedSiteAliasConflict();
        }
        await set(preserveHostedSnapshotToken$, snapshot, signal);
      }
      signal.throwIfAborted();
      published = await set(
        writeHostedPointerPublication$,
        publication,
        signal,
      );
    }
    signal.throwIfAborted();
    const promotion = await set(
      commitHostedSiteDeployment$,
      args,
      site,
      published,
      signal,
    );
    if (!promotion) {
      const [latest] = await db
        .select({ status: deploymentTable.status })
        .from(deploymentTable)
        .where(eq(deploymentTable.id, args.deployment.id));
      signal.throwIfAborted();
      if (latest?.status === "deleted") {
        await get(
          deleteHostedSitesS3Objects(
            args.bucket,
            deletedHostedVersionKeys(args.deployment),
            signal,
          ),
        );
        signal.throwIfAborted();
        throw new ArtifactDeliveryAliasConflict("Hosted deployment is deleted");
      }
      throw new ArtifactDeliveryAliasConflict(
        "Hosted deployment changed during publication",
      );
    }
    return promotion;
  },
);

const publishHostedSiteManifest$ = command(
  async (
    { get, set },
    deployment: HostedDeploymentRow,
    bucket: string,
    signal: AbortSignal,
  ) => {
    if (deployment.manifest.access === "owner-private-v1") {
      await set(collectHostedSiteDependencies$, deployment, bucket, signal);
      signal.throwIfAborted();
    }
    const manifestKey = `${deployment.r2Prefix}/manifest.json`;
    await get(
      putHostedSitesS3Object(
        bucket,
        manifestKey,
        JSON.stringify(
          hostedSiteDeliveryManifest(deployment.manifest),
          null,
          2,
        ),
        "application/json",
      ),
    );
    signal.throwIfAborted();

    return manifestKey;
  },
);

const publishHostedSiteDeploymentPointers$ = command(
  async (
    { get, set },
    args: {
      readonly bucket: string;
      readonly deployment: HostedDeploymentRow;
      readonly orgId: string;
      readonly pointer: HostedSitePointer;
      readonly readyAt: Date;
    },
    signal: AbortSignal,
  ) => {
    const { deployment, pointer } = args;
    if (
      legacyHostedDeploymentVersion(deployment.manifest) !== null &&
      !deployment.manifest.access
    ) {
      const pointerKey = immutableDeploymentPointerKey(
        rowLinkLayout(deployment),
        deployment.id,
      );
      await get(
        putHostedSitesS3Object(
          args.bucket,
          pointerKey,
          JSON.stringify(pointer),
          "application/json",
          signal,
        ),
      );
      signal.throwIfAborted();
      await set(
        registerLegacyHostedSite$,
        {
          alias: `dpl-${deployment.id}`,
          layout: rowLinkLayout(deployment),
          pointerKey,
        },
        signal,
      );
    }
    return await set(bindHostedSiteDeployment$, args, signal);
  },
);

function completedHostedSiteResponse(
  deployment: HostedDeploymentRow,
  promotion: HostedSitePromotion,
  preview: { readonly status: "ok"; readonly url: string } | undefined,
): CompleteDeploymentResult {
  const deploymentVersion = legacyHostedDeploymentVersion(deployment.manifest);
  return {
    status: "ok",
    body: {
      siteId: deployment.siteId,
      deploymentId: deployment.id,
      ...hostedSiteResponseAddress(deployment, promotion.publicSlug),
      ...(deploymentVersion === null
        ? {}
        : {
            isActive: promotion.activeDeploymentId === deployment.id,
            ...(promotion.activeDeploymentVersion === null
              ? {}
              : {
                  activeDeploymentVersion: promotion.activeDeploymentVersion,
                }),
          }),
      status: "ready",
      ...(preview?.url ? { previewImageUrl: preview.url } : {}),
    },
  };
}

export const completeHostedSiteDeployment$ = command(
  async (
    { set },
    args: CompleteDeploymentArgs,
    signal: AbortSignal,
  ): Promise<CompleteDeploymentResult> => {
    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }

    const writeDb = set(writeDb$);
    const deploymentResult = await set(
      resolveHostedDeploymentForCompletion$,
      args,
      signal,
    );
    signal.throwIfAborted();
    if (deploymentResult.status !== "ok") {
      return deploymentResult;
    }
    const { deployment } = deploymentResult;
    if (deployment.status !== "uploading" && deployment.status !== "ready") {
      return {
        status: "conflict",
        message: `Hosted deployment is ${deployment.status}`,
      };
    }

    const missingPath = await set(
      firstMissingHostedDeploymentPath$,
      {
        bucket: hostedR2.config.bucket,
        deployment,
      },
      signal,
    );
    signal.throwIfAborted();

    if (missingPath) {
      return {
        status: "bad_request",
        message: `Hosted deployment file was not uploaded: ${missingPath}`,
      };
    }

    const preview = deployment.manifest.preview
      ? await set(
          completeHostedPreview$,
          {
            deploymentId: deployment.id,
            userId: deployment.userId,
            orgId: deployment.orgId,
            preview: deployment.manifest.preview,
          },
          signal,
        )
      : undefined;
    signal.throwIfAborted();
    if (preview?.status === "bad_request") {
      return preview;
    }

    const manifestKey = await set(
      publishHostedSiteManifest$,
      deployment,
      hostedR2.config.bucket,
      signal,
    );
    signal.throwIfAborted();

    const readyAt = nowDate();
    const pointer = activeSitePointerForDeployment(
      deployment,
      manifestKey,
      readyAt,
    );

    const promoted = await settle(
      set(
        publishHostedSiteDeploymentPointers$,
        {
          bucket: hostedR2.config.bucket,
          deployment,
          orgId: args.orgId,
          pointer,
          readyAt,
        },
        signal,
      ),
      signal,
    );
    if (!promoted.ok) {
      if (!(promoted.error instanceof ArtifactDeliveryAliasConflict)) {
        throw promoted.error;
      }
      const deploymentTable = deployment.manifest.access
        ? privateHostedDeployments
        : hostedDeployments;
      await writeDb
        .update(deploymentTable)
        .set({
          status: "failed",
          error: promoted.error.message,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(deploymentTable.id, deployment.id),
            eq(deploymentTable.status, "uploading"),
          ),
        );
      signal.throwIfAborted();
      return { status: "conflict", message: promoted.error.message };
    }
    const promotion = promoted.value;
    signal.throwIfAborted();

    await set(
      recordHostedSiteArtifact$,
      {
        ...hostedSiteArtifactArgs(deployment, promotion.publicSlug),
        ...(preview ? { previewImageUrl: preview.url } : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    return completedHostedSiteResponse(deployment, promotion, preview);
  },
);

const loadImmutableHostedSiteFilesTarget$ = command(
  async (
    { get },
    args: GetHostedSiteFilesArgs,
    deploymentId: string,
    signal: AbortSignal,
  ): Promise<HostedSiteFilesTargetResult> => {
    const db = get(db$);
    const [deployment] = await db
      .select()
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, deploymentId),
          or(
            eq(hostedDeployments.status, "ready"),
            args.orgId ? eq(hostedDeployments.orgId, args.orgId) : undefined,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!deployment) {
      return { status: "not_found", message: "Hosted deployment not found" };
    }
    if (
      args.version !== undefined &&
      legacyHostedDeploymentVersion(deployment.manifest) !== args.version
    ) {
      return {
        status: "not_found",
        message: `Hosted deployment version not found: ${args.version}`,
      };
    }

    const [site] = await db
      .select()
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.id, deployment.siteId),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return site
      ? { status: "ok", site, deployment }
      : { status: "not_found", message: "Hosted site not found" };
  },
);

const loadAliasedHostedSiteFilesTarget$ = command(
  async (
    { get },
    args: GetHostedSiteFilesArgs,
    signal: AbortSignal,
  ): Promise<HostedSiteFilesTargetResult> => {
    const db = get(db$);
    const [site] = await db
      .select()
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.publicSlug, args.publicSlug),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!site) {
      return { status: "not_found", message: "Hosted site not found" };
    }
    if (args.hostname && hostedDownloadLayout(args) !== rowLinkLayout(site)) {
      return { status: "not_found", message: "Hosted site not found" };
    }
    let deployment: HostedDeploymentRow | undefined;
    if (args.version === undefined) {
      if (!site.activeDeploymentId) {
        const [publicDeployment] = await db
          .select({ id: hostedDeployments.id })
          .from(hostedDeployments)
          .where(eq(hostedDeployments.siteId, site.id))
          .limit(1);
        signal.throwIfAborted();
        if (
          site.orgId !== args.orgId ||
          (!publicDeployment && site.userId !== args.userId)
        ) {
          return { status: "not_found", message: "Hosted site not found" };
        }
        return {
          status: "conflict",
          message: "Hosted site has no active deployment",
        };
      }
      [deployment] = await db
        .select()
        .from(hostedDeployments)
        .where(
          and(
            eq(hostedDeployments.id, site.activeDeploymentId),
            eq(hostedDeployments.siteId, site.id),
            or(
              eq(hostedDeployments.status, "ready"),
              args.orgId ? eq(hostedDeployments.orgId, args.orgId) : undefined,
            ),
          ),
        )
        .limit(1);
    } else {
      [deployment] = await db
        .select()
        .from(hostedDeployments)
        .where(
          and(
            eq(
              sql`(${hostedDeployments.manifest}->>'deploymentVersion')::integer`,
              args.version,
            ),
            eq(hostedDeployments.siteId, site.id),
            or(
              eq(hostedDeployments.status, "ready"),
              args.orgId ? eq(hostedDeployments.orgId, args.orgId) : undefined,
            ),
          ),
        )
        .limit(1);
    }
    signal.throwIfAborted();
    if (!deployment) {
      return {
        status: "not_found",
        message:
          args.version === undefined
            ? "Active hosted deployment not found"
            : `Hosted deployment version not found: ${args.version}`,
      };
    }
    return { status: "ok", site, deployment };
  },
);

const loadPrivateHostedSiteFilesTarget$ = command(
  async (
    { get },
    args: GetHostedSiteFilesArgs,
    deploymentId: string | undefined,
    signal: AbortSignal,
  ): Promise<HostedSiteFilesTargetResult | null> => {
    const db = get(db$);
    // Explicit site URLs name published content; owner editing uses bare slugs
    // or exact deployment identities.
    if (!args.orgId || (!deploymentId && args.hostname !== undefined)) {
      return null;
    }
    const [target] = await db
      .select({ site: hostedSites, deployment: privateHostedDeployments })
      .from(privateHostedDeployments)
      .innerJoin(
        hostedSites,
        eq(hostedSites.id, privateHostedDeployments.siteId),
      )
      .where(
        and(
          eq(privateHostedDeployments.orgId, args.orgId),
          eq(privateHostedDeployments.userId, args.userId),
          isNull(hostedSites.deletedAt),
          deploymentId
            ? eq(privateHostedDeployments.id, deploymentId)
            : eq(hostedSites.publicSlug, args.publicSlug),
          args.version === undefined
            ? undefined
            : eq(
                sql`(${privateHostedDeployments.manifest}->>'deploymentVersion')::integer`,
                args.version,
              ),
        ),
      )
      .orderBy(
        desc(
          sql`(${privateHostedDeployments.manifest}->>'deploymentVersion')::integer`,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (target && target.deployment.manifest.access !== "owner-private-v1") {
      throw new Error("Private hosted deployment has an invalid access policy");
    }
    if (target && !deploymentId && args.version === undefined) {
      let activeVersion: number | null = null;
      if (target.site.activeDeploymentId !== null) {
        const [active] = await db
          .select({
            version:
              sql`(${hostedDeployments.manifest}->>'deploymentVersion')::integer`.mapWith(
                nullableDriverValueDecoder(pgIntegerDecoder),
              ),
          })
          .from(hostedDeployments)
          .where(
            and(
              eq(hostedDeployments.id, target.site.activeDeploymentId),
              eq(hostedDeployments.siteId, target.site.id),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        if (!active) {
          throw new Error(
            "Hosted site has an invalid public deployment binding",
          );
        }
        activeVersion = active.version;
      }
      if (
        legacyPrivateHostedDeploymentVersion(target.deployment.manifest) <=
        (activeVersion ?? 0)
      ) {
        return null;
      }
    }
    return target ? { status: "ok", ...target } : null;
  },
);

const sharedHostedSiteFiles$ = command(
  async (
    { get, set },
    args: GetHostedSiteFilesArgs,
    deploymentId: string | undefined,
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const [site] = deploymentId
      ? await db
          .select({ id: hostedSites.id })
          .from(privateHostedDeployments)
          .innerJoin(
            hostedSites,
            eq(hostedSites.id, privateHostedDeployments.siteId),
          )
          .where(
            and(
              eq(privateHostedDeployments.id, deploymentId),
              isNull(hostedSites.deletedAt),
            ),
          )
          .limit(1)
      : await db
          .select({ id: hostedSites.id })
          .from(hostedSites)
          .where(
            and(
              eq(hostedSites.publicSlug, args.publicSlug),
              isNull(hostedSites.deletedAt),
            ),
          )
          .limit(1);
    signal.throwIfAborted();
    if (!site) {
      return null;
    }
    const download = await set(
      resolveArtifactShareDownload$,
      {
        userId: args.userId,
        selector: deploymentId
          ? {
              kind: "target",
              target: { kind: "html", id: deploymentId },
              targetId: site.id,
            }
          : { kind: "site", id: site.id },
      },
      signal,
    );
    return download?.kind === "html" &&
      matchesHostedSiteVersion(download.site, args.version)
      ? download.site
      : null;
  },
);

function matchesHostedSiteVersion(
  site: Pick<HostedSiteFilesResponse, "deploymentVersion">,
  version: number | undefined,
): boolean {
  return version === undefined || version === site.deploymentVersion;
}

/** A site hostname selects the layout its link was issued in. */
function hostedDownloadLayout(args: GetHostedSiteFilesArgs): LinkLayout | null {
  if (!args.hostname) {
    return CURRENT_LINK_LAYOUT;
  }
  for (const layout of ["current", "legacy"] as const) {
    if (
      args.hostname.toLowerCase() ===
      `${args.publicSlug}.${hostedLinkDomain(layout)}`.toLowerCase()
    ) {
      return layout;
    }
  }
  return null;
}

function isPublicHostedSiteUrl(
  args: GetHostedSiteFilesArgs,
  deploymentId: string | undefined,
  registeredSite: boolean,
): boolean {
  return registeredSite || (!deploymentId && args.hostname !== undefined);
}

const signAuthorizedHostedFiles$ = command(
  async (
    { set },
    target: Extract<HostedSiteFilesTargetResult, { status: "ok" }>,
    viewerId: string,
    signal: AbortSignal,
  ): Promise<GetHostedSiteFilesResult> => {
    const { deployment, site } = target;
    const access = await set(
      checkHostedSiteAccess$,
      { siteId: site.id, userId: viewerId },
      signal,
    );
    if (!access.allowed) {
      return { status: "not_found", message: "Hosted site not found" };
    }
    if (deployment.status !== "ready") {
      return {
        status: "conflict",
        message: `Hosted deployment is ${deployment.status}`,
      };
    }

    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }

    return {
      status: "ok",
      body: await set(
        signHostedSiteFiles$,
        {
          metadata: {
            siteId: site.id,
            deploymentId: deployment.id,
            ...hostedSiteResponseAddress(deployment, site.publicSlug),
          },
          manifest: deployment.manifest,
          prefix: deployment.r2Prefix,
          viewerId: viewerId,
        },
        signal,
      ),
    };
  },
);

export const getHostedSiteFiles$ = command(
  async (
    { set },
    args: GetHostedSiteFilesArgs,
    signal: AbortSignal,
  ): Promise<GetHostedSiteFilesResult> => {
    const deploymentId = IMMUTABLE_DEPLOYMENT_HOST_PATTERN.exec(
      args.publicSlug,
    )?.[1];
    const layout = deploymentId
      ? CURRENT_LINK_LAYOUT
      : hostedDownloadLayout(args);
    if (!layout) {
      return {
        status: "bad_request",
        message:
          "Hosted site hostname does not match its slug and configured domain",
      };
    }
    const owned = await set(
      loadPrivateHostedSiteFilesTarget$,
      args,
      deploymentId,
      signal,
    );
    const publication =
      deploymentId || owned
        ? null
        : await set(
            resolveHostedSitePublicationDownload$,
            { ...args, layout },
            signal,
          );
    if (publication?.kind === "unavailable") {
      return { status: "not_found", message: "Hosted site not found" };
    }
    if (publication?.kind === "shared") {
      return matchesHostedSiteVersion(publication.site, args.version)
        ? { status: "ok", body: publication.site }
        : {
            status: "not_found",
            message: "Hosted deployment version not found",
          };
    }
    // A public site URL identifies its published bytes, including older sites
    // that predate the delivery registry. It cannot select a newer private draft.
    const publicSiteUrl = isPublicHostedSiteUrl(
      args,
      deploymentId,
      publication?.kind === "legacy",
    );
    if (!owned && !publicSiteUrl) {
      const shared = await set(
        sharedHostedSiteFiles$,
        args,
        deploymentId,
        signal,
      );
      if (shared) {
        return { status: "ok", body: shared };
      }
    }
    const target =
      owned ??
      (deploymentId
        ? await set(
            loadImmutableHostedSiteFilesTarget$,
            args,
            deploymentId,
            signal,
          )
        : await set(loadAliasedHostedSiteFilesTarget$, args, signal));
    signal.throwIfAborted();
    if (target.status !== "ok") {
      return target;
    }
    return set(signAuthorizedHostedFiles$, target, args.userId, signal);
  },
);

export const getHostedSiteDeployments$ = command(
  async (
    { get },
    args: GetHostedSiteDeploymentsArgs,
    signal: AbortSignal,
  ): Promise<GetHostedSiteDeploymentsResult> => {
    const db = get(db$);
    const [site] = await db
      .select()
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.orgId, args.orgId),
          eq(hostedSites.requestedSlug, args.site),
          eq(hostedSites.userId, args.userId),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!site) {
      return { status: "not_found", message: "Hosted site not found" };
    }

    const privateVersions = await db
      .select()
      .from(privateHostedDeployments)
      .where(
        and(
          eq(privateHostedDeployments.siteId, site.id),
          eq(privateHostedDeployments.orgId, args.orgId),
          eq(privateHostedDeployments.userId, args.userId),
        ),
      )
      .orderBy(desc(privateHostedDeployments.createdAt));
    signal.throwIfAborted();
    const deployments = await db
      .select()
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.siteId, site.id),
          eq(hostedDeployments.orgId, args.orgId),
        ),
      )
      .orderBy(desc(hostedDeployments.createdAt));
    signal.throwIfAborted();
    if (
      !site.activeDeploymentId &&
      deployments.length === 0 &&
      site.userId !== args.userId
    ) {
      return { status: "not_found", message: "Hosted site not found" };
    }

    const activeDeployment = deployments.find((deployment) => {
      return deployment.id === site.activeDeploymentId;
    });
    if (site.activeDeploymentId !== null && !activeDeployment) {
      throw new Error("Hosted site has an invalid public deployment binding");
    }
    return {
      status: "ok",
      body: {
        siteId: site.id,
        site: hostedSiteRequestedSlug(site),
        publicSlug: site.publicSlug,
        aliasUrl:
          site.activeDeploymentId || deployments.length > 0
            ? hostedLinkOrigin(rowLinkLayout(site), site.publicSlug)
            : null,
        activeDeploymentId: site.activeDeploymentId,
        activeDeploymentVersion: activeDeployment
          ? legacyHostedDeploymentVersion(activeDeployment.manifest)
          : null,
        deployments: [...privateVersions, ...deployments]
          .sort((a, b) => {
            return b.createdAt.getTime() - a.createdAt.getTime();
          })
          .map((deployment) => {
            return {
              deploymentId: deployment.id,
              deploymentVersion: legacyHostedDeploymentVersion(
                deployment.manifest,
              ),
              artifactUrl: deployment.artifactUrl,
              status: deployment.status,
              isActive: deployment.id === site.activeDeploymentId,
              createdAt: deployment.createdAt.toISOString(),
              readyAt: deployment.readyAt?.toISOString() ?? null,
            };
          }),
      },
    };
  },
);

interface DeleteHostedSiteArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly publicSlug: string;
}

type DeleteHostedSiteResult =
  | { readonly status: "ok"; readonly body: HostedSiteDeleteResponse }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

/** Only the creator may take a site offline. */
const ownedHostedSiteForDeletion$ = command(
  async (
    { get },
    args: DeleteHostedSiteArgs,
    signal: AbortSignal,
  ): Promise<HostedSiteRow | undefined> => {
    const db = get(db$);
    const [site] = await db
      .select()
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.publicSlug, args.publicSlug),
          eq(hostedSites.orgId, args.orgId),
          eq(hostedSites.userId, args.userId),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return site;
  },
);

/**
 * Historical private publications may carry a share link served from its own
 * snapshot. Revoke it before the private versions stop being share targets.
 */
const revokeHostedSiteShare$ = command(
  async ({ get, set }, site: HostedSiteRow, signal: AbortSignal) => {
    const db = get(db$);
    const [share] = await db
      .select({ id: artifactShares.id })
      .from(artifactShares)
      .where(
        and(
          eq(artifactShares.targetKind, "html"),
          eq(artifactShares.targetId, site.id),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!share) {
      return;
    }
    const [privateDeployment] = await db
      .select({ id: privateHostedDeployments.id })
      .from(privateHostedDeployments)
      .where(
        and(
          eq(privateHostedDeployments.siteId, site.id),
          eq(privateHostedDeployments.userId, site.userId),
          eq(privateHostedDeployments.status, "ready"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    // Without a ready private version, an earlier deletion already revoked it.
    if (!privateDeployment) {
      return;
    }
    const revoked = await set(
      updateArtifactShare$,
      {
        target: { kind: "html", id: privateDeployment.id },
        userId: site.userId,
        orgId: site.orgId,
        audience: "private",
      },
      signal,
    );
    if (!revoked) {
      throw new Error("Hosted site share could not be revoked");
    }
  },
);

/** Delivery records are removed only when they still route to this site. */
const ownedDeliveryRecordKeys$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly layout: LinkLayout;
      readonly aliases: readonly {
        readonly alias: string;
        readonly pointerKey: string;
      }[];
    },
    signal: AbortSignal,
  ): Promise<string[]> => {
    const segment = linkLayoutSegment(args.layout);
    const owned = await Promise.all(
      args.aliases.map(async ({ alias, pointerKey }) => {
        const key = artifactDeliveryKey(segment, "html", alias);
        const stored = await get(storedObject(args.bucket, key, signal));
        if (!stored) {
          return null;
        }
        const record = artifactDeliveryRecordSchema.parse(
          JSON.parse(stored.buffer.toString("utf8")),
        );
        return record.kind === "legacy-site" && record.pointerKey === pointerKey
          ? key
          : null;
      }),
    );
    signal.throwIfAborted();
    return owned.filter((key): key is string => {
      return key !== null;
    });
  },
);

const takeHostedSiteOffline$ = command(
  async (
    { get, set },
    args: DeleteHostedSiteArgs,
    siteId: string,
    signal: AbortSignal,
  ): Promise<HostedSiteRow | undefined> => {
    const db = get(db$);
    const writeDb = set(writeDb$);
    const ownership = and(
      eq(hostedSites.id, siteId),
      eq(hostedSites.orgId, args.orgId),
      eq(hostedSites.userId, args.userId),
      isNull(hostedSites.deletedAt),
    );
    const owned = db
      .select({ id: hostedSites.id })
      .from(hostedSites)
      .where(ownership);
    const deleted = { status: "deleted" as const, updatedAt: nowDate() };
    const publicVersions = writeDb.$with("deleted_public_hosted_versions").as(
      writeDb
        .update(hostedDeployments)
        .set(deleted)
        .where(
          and(
            eq(hostedDeployments.siteId, siteId),
            inArray(hostedDeployments.status, ["uploading", "ready"]),
            exists(owned),
          ),
        )
        .returning({ id: hostedDeployments.id }),
    );
    const privateVersions = writeDb.$with("deleted_private_hosted_versions").as(
      writeDb
        .update(privateHostedDeployments)
        .set(deleted)
        .where(
          and(
            eq(privateHostedDeployments.siteId, siteId),
            inArray(privateHostedDeployments.status, ["uploading", "ready"]),
            exists(owned),
          ),
        )
        .returning({ id: privateHostedDeployments.id }),
    );
    // Both version tables and the live binding change in one local statement.
    // Address changes do not change the captured, owned Site identity.
    const [site] = await writeDb
      .with(publicVersions, privateVersions)
      .update(hostedSites)
      .set({ activeDeploymentId: null, updatedAt: deleted.updatedAt })
      .where(ownership)
      .returning();
    signal.throwIfAborted();
    return site;
  },
);

/**
 * Soft-delete a site: every version stops serving while its rows and bytes are
 * kept. Current-domain sites keep their name for redeployment; legacy-domain
 * sites cannot be redeployed. Deleted versions never serve again.
 */
export const deleteHostedSite$ = command(
  async (
    { get, set },
    args: DeleteHostedSiteArgs,
    signal: AbortSignal,
  ): Promise<DeleteHostedSiteResult> => {
    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }
    const notFound = {
      status: "not_found",
      message: "Hosted site not found",
    } as const;
    const candidate = await set(ownedHostedSiteForDeletion$, args, signal);
    signal.throwIfAborted();
    if (!candidate) {
      return notFound;
    }
    await set(revokeHostedSiteShare$, candidate, signal);
    signal.throwIfAborted();

    const db = get(db$);
    const layout = rowLinkLayout(candidate);
    const deployments = await db
      .select({
        id: hostedDeployments.id,
        artifactUrl: hostedDeployments.artifactUrl,
        readyAt: hostedDeployments.readyAt,
      })
      .from(hostedDeployments)
      .where(eq(hostedDeployments.siteId, candidate.id))
      .orderBy(desc(hostedDeployments.createdAt));
    signal.throwIfAborted();
    const aliases = [
      {
        alias: candidate.publicSlug,
        pointerKey: `${hostedSitePointerNamespace(layout)}/${candidate.publicSlug}/active.json`,
      },
      ...deployments.map((deployment) => {
        return {
          alias: `dpl-${deployment.id}`,
          pointerKey: immutableDeploymentPointerKey(layout, deployment.id),
        };
      }),
    ];
    const recordKeys = await set(
      ownedDeliveryRecordKeys$,
      { bucket: hostedR2.config.bucket, layout, aliases },
      signal,
    );
    // Keep database state available for retry if storage deletion fails.
    // Overlapping publication and deletion no longer wait on a Site lock.
    await get(
      deleteHostedSitesS3Objects(
        hostedR2.config.bucket,
        [
          ...aliases.map(({ pointerKey }) => {
            return pointerKey;
          }),
          ...recordKeys,
        ],
        signal,
      ),
    );
    signal.throwIfAborted();
    const site = await set(takeHostedSiteOffline$, args, candidate.id, signal);
    if (!site) {
      return notFound;
    }

    const aliasUrl = hostedLinkOrigin(layout, site.publicSlug);
    return {
      status: "ok",
      body: {
        siteId: site.id,
        site: hostedSiteRequestedSlug(site),
        publicSlug: site.publicSlug,
        aliasUrl,
        offlineUrls: [
          aliasUrl,
          ...deployments.flatMap((deployment) => {
            // Uploads that never completed never served a URL.
            return deployment.artifactUrl !== null &&
              deployment.readyAt !== null
              ? [deployment.artifactUrl]
              : [];
          }),
        ],
      },
    };
  },
);
