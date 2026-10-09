import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { command } from "ccstate";
import {
  hostedSiteAssetNameError,
  type HostedSiteDeleteResponse,
  type HostedSiteFilesResponse,
  type HostedSiteDeploymentsResponse,
  type HostedSitePrepareRequest,
} from "@okouai/api-contracts/contracts/host";
import { z } from "zod";
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
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { artifactShares } from "@okouai/db/schema/artifact-share";
import {
  hostedDeployments,
  privateHostedDeployments,
  hostedSites,
} from "@okouai/db/runtime/hosted-site";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
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
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { executeRawRows } from "../../lib/db-raw-rows";
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
import {
  scheduleArtifactPreviewRender$,
  type RenderArtifactPreviewArgs,
} from "./artifact-preview.service";
import { recordHostedSiteArtifact$ } from "./run-uploaded-files.service";
import {
  completeHostedPreview$,
  prepareHostedPreview$,
} from "./hosted-preview.service";
import { privateArtifactsBucket } from "./private-artifact-storage.service";
import {
  collectHostedSiteDependencies$,
  hostedSiteDeliveryManifest,
} from "./hosted-site-dependencies.service";
import { HostedSiteScopeError } from "./hosted-site-scope.service";
import {
  hostedDeploymentAllocationPlan,
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

/** R2 references do not carry authority over a deployment's current lifecycle. */
export const authorizeHostedSiteDelivery$ = command(
  async (
    { get },
    args: {
      readonly siteId: string;
      readonly deploymentId: string;
      readonly alias: string;
      readonly publicSlug: string;
      readonly publicBrand: "vm0" | "okou";
      readonly prefix: string;
      readonly manifestKey: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = get(db$);
    const [owned] = await db
      .select({
        prefix: hostedDeployments.r2Prefix,
        activeDeploymentId: hostedSites.activeDeploymentId,
        userId: hostedDeployments.userId,
        orgId: hostedDeployments.orgId,
        siteUserId: hostedSites.userId,
        siteOrgId: hostedSites.orgId,
        identity: sql`jsonb_build_object(
          'deploymentId', ${hostedDeployments.manifest}->'deploymentId',
          'siteId', ${hostedDeployments.manifest}->'siteId',
          'publicSlug', ${hostedDeployments.manifest}->'publicSlug',
          'access', ${hostedDeployments.manifest}->'access',
          'hasAccess', ${hostedDeployments.manifest} ? 'access'
        )`.mapWith(
          zodDriverValueDecoder(
            z.object({
              deploymentId: z.string().uuid(),
              siteId: z.string().uuid(),
              publicSlug: z.string(),
              access: z.literal("owner-private-v1").nullable(),
              hasAccess: z.boolean(),
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
          eq(hostedSites.publicSlug, args.publicSlug),
          eq(hostedSites.linkLayoutSegment, args.publicBrand),
          eq(hostedDeployments.linkLayoutSegment, args.publicBrand),
          eq(hostedDeployments.status, "ready"),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!owned) {
      return false;
    }
    if (
      owned.userId !== owned.siteUserId ||
      owned.orgId !== owned.siteOrgId ||
      owned.identity.deploymentId !== args.deploymentId ||
      owned.identity.siteId !== args.siteId ||
      owned.identity.publicSlug !== args.publicSlug ||
      (owned.identity.hasAccess && owned.identity.access === null)
    ) {
      throw new Error("Hosted deployment has an invalid publication identity");
    }
    return (
      !owned.identity.hasAccess &&
      owned.prefix === args.prefix &&
      args.manifestKey === `${args.prefix}/manifest.json` &&
      (args.alias === `dpl-${args.deploymentId}` ||
        (args.alias === args.publicSlug &&
          owned.activeDeploymentId === args.deploymentId))
    );
  },
);

interface CompleteDeploymentArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
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
  readonly runId?: string;
  readonly site: string;
}

type PrepareDeploymentResult =
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
  | { readonly status: "preview_unavailable" }
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

type CompleteDeploymentResult =
  | { readonly status: "preview_unavailable" }
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

const resolveChatThreadId$ = command(
  async (
    { get },
    runId: string | undefined,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = get(db$);
    if (runId === undefined) {
      return null;
    }
    const [run] = await db
      .select({ chatThreadId: agentRuns.chatThreadId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
      .limit(1);
    signal.throwIfAborted();
    return run?.chatThreadId ?? null;
  },
);

const hostedDeploymentScopeError$ = command(
  async (
    { set },
    runId: string | undefined,
    owningChatThreadId: string | null,
    signal: AbortSignal,
  ): Promise<Extract<
    CompleteDeploymentResult,
    { status: "conflict" }
  > | null> => {
    const chatThreadId = await set(resolveChatThreadId$, runId, signal);
    return owningChatThreadId === chatThreadId
      ? null
      : {
          status: "conflict",
          message: "Hosted deployment belongs to a different chat",
        };
  },
);

type CompleteDeploymentLookupResult =
  | { readonly status: "ok"; readonly deployment: HostedDeploymentRow }
  | Extract<CompleteDeploymentResult, { status: "not_found" | "conflict" }>;

const resolveHostedDeploymentForCompletion$ = command(
  async (
    { get, set },
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
      const scopeError = await set(
        hostedDeploymentScopeError$,
        args.runId,
        site.chatThreadId,
        signal,
      );
      return scopeError ?? { status: "ok", deployment: privateDeployment };
    }
    const [ownedDeployment] = await db
      .select({
        deployment: hostedDeployments,
        chatThreadId: hostedSites.chatThreadId,
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
    const scopeError = await set(
      hostedDeploymentScopeError$,
      args.runId,
      ownedDeployment.chatThreadId,
      signal,
    );
    return (
      scopeError ?? {
        status: "ok",
        deployment: ownedDeployment.deployment,
      }
    );
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

function artifactPreviewArgs(
  deployment: HostedDeploymentRow,
  artifactRow: {
    readonly id: string;
    readonly previewImageUrl: string | null;
  } | null,
): RenderArtifactPreviewArgs | null {
  if (!artifactRow || artifactRow.previewImageUrl || !deployment.runId) {
    return null;
  }
  return {
    id: artifactRow.id,
    runId: deployment.runId,
    userId: deployment.userId,
    orgId: deployment.orgId,
    url: deployment.artifactUrl ?? deployment.url,
    deploymentId: deployment.id,
  };
}

function hostedSiteArtifactArgs(deployment: HostedDeploymentRow) {
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
    publicSlug: deployment.manifest.publicSlug,
    aliasUrl: deployment.manifest.access ? undefined : deployment.url,
    access: deployment.manifest.access,
    url: deployment.artifactUrl ?? deployment.url,
    fileCount: deployment.fileCount,
    sizeBytes: deployment.sizeBytes,
    entrypoint: deployment.entrypoint,
    spaFallback: deployment.spaFallback,
    layout: rowLinkLayout(deployment),
  };
}

const publishedAssetRowSchema = z.object({ path: z.string() });

const createHostedSiteDeployment$ = command(
  async (
    { set },
    args: PrepareDeploymentArgs,
    context: CreateHostedSiteDeploymentContext,
  ): Promise<SiteDeploymentCreationResult> => {
    const db = set(writeDb$);
    const result = await settle(
      db.transaction(async (tx): Promise<SiteDeploymentCreationResult> => {
        const plan = hostedDeploymentAllocationPlan(args, context);
        let step = plan.next();
        while (!step.done) {
          const query = step.value;
          let result: HostedAllocationQueryResult;
          switch (query.kind) {
            case "run": {
              const [run] = await tx
                .select({
                  chatThreadId: agentRuns.chatThreadId,
                  triggerSource: agentRuns.triggerSource,
                })
                .from(agentRuns)
                .where(eq(agentRuns.id, query.runId))
                .for("share")
                .limit(1);
              result = { run };
              break;
            }
            case "site": {
              const lookup = tx
                .select()
                .from(hostedSites)
                .where(query.condition);
              const [site] = query.lock
                ? await lookup.for("update").limit(1)
                : await lookup.limit(1);
              result = { site };
              break;
            }
            case "unscoped": {
              const [unscoped] = await tx
                .select({ id: hostedSites.id })
                .from(hostedSites)
                .where(query.condition)
                .limit(1);
              result = { unscoped };
              break;
            }
            case "site-insert": {
              const [site] = await tx
                .insert(hostedSites)
                .values(query.values)
                .onConflictDoNothing()
                .returning();
              result = { site };
              break;
            }
            case "public-version":
            case "private-version": {
              const table =
                query.kind === "public-version"
                  ? hostedDeployments
                  : privateHostedDeployments;
              const [row] = await tx
                .select({
                  version:
                    sql`max((${table.manifest}->>'deploymentVersion')::integer)`.mapWith(
                      nullableDriverValueDecoder(pgIntegerDecoder),
                    ),
                })
                .from(table)
                .where(eq(table.siteId, query.siteId));
              result = { version: row?.version };
              break;
            }
            case "asset-conflict": {
              const rows = await executeRawRows(
                tx,
                query.query,
                publishedAssetRowSchema,
              );
              result = { path: rows[0]?.path };
              break;
            }
            case "admission": {
              const [admission] = await tx
                .select({ chatThreadId: hostedSites.chatThreadId })
                .from(hostedSites)
                .where(
                  and(
                    eq(hostedSites.id, query.siteId),
                    eq(hostedSites.orgId, query.orgId),
                  ),
                )
                .for("share")
                .limit(1);
              result = { admission };
              break;
            }
            case "deployment-insert": {
              const [deployment] = await tx
                .insert(hostedDeployments)
                .values(query.values)
                .returning();
              result = { deployment };
              break;
            }
          }
          step = plan.next(result);
        }
        return step.value;
      }),
    );
    if (!result.ok) {
      if (result.error instanceof HostedSiteScopeError) {
        return { kind: "scope_conflict", message: result.error.message };
      }
      throw result.error;
    }
    return result.value;
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

    // Hosted sites are public publications. A site's alias is its durable
    // address, so it never takes a private artifact reference.
    if (args.body.requirePrivateArtifact) {
      return { status: "forbidden" };
    }
    if (args.body.preview) {
      const features = await set(
        loadUserFeatureSwitchContext$,
        args.orgId,
        args.userId,
        signal,
      );
      signal.throwIfAborted();
      if (!isFeatureEnabled(FeatureSwitchKey.ArtifactPreviews, features)) {
        return { status: "preview_unavailable" };
      }
      // Fail before creating a deployment if private preview storage is absent.
      privateArtifactsBucket();
    }
    const siteAndDeployment = await set(createHostedSiteDeployment$, args, {
      now: nowDate(),
      deploymentId: crypto.randomUUID(),
    });
    // Allocation commits one SQL unit before request cancellation is observed.
    signal.throwIfAborted();
    if (
      siteAndDeployment.kind === "scope_conflict" ||
      siteAndDeployment.kind === "content_conflict"
    ) {
      return { status: "conflict", message: siteAndDeployment.message };
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

    const uploads = await Promise.all(
      Object.values(siteAndDeployment.deployment.manifest.files).map(
        async (file) => {
          const uploadUrl = await get(
            generateHostedSitesPresignedPutUrl(
              hostedR2.config.bucket,
              fileKey(siteAndDeployment.deployment.r2Prefix, file.path),
              file.contentType,
              true,
            ),
          );
          return { path: file.path, uploadUrl };
        },
      ),
    );
    signal.throwIfAborted();

    const preview = args.body.preview
      ? await set(
          prepareHostedPreview$,
          siteAndDeployment.deployment.id,
          args.body.preview,
          signal,
        )
      : undefined;
    return {
      status: "ok",
      body: {
        siteId: siteAndDeployment.site.id,
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
    site.linkLayoutSegment !== deployment.linkLayoutSegment ||
    site.publicSlug !== deployment.manifest.publicSlug
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

const bindHostedSiteDeployment$ = command(
  (
    { get, set },
    args: HostedSiteBindingArgs,
    signal: AbortSignal,
  ): Promise<HostedSitePromotion> => {
    const writeDb = set(writeDb$);
    return writeDb.transaction(async (tx) => {
      const [ownedSite] = await tx
        .select()
        .from(hostedSites)
        .where(hostedBindingSiteCondition(args.deployment.siteId, args.orgId))
        .for("update")
        .limit(1);
      const site = ownedHostedBindingSite(ownedSite, args.deployment);
      const deploymentTable = args.deployment.manifest.access
        ? privateHostedDeployments
        : hostedDeployments;
      // Deleted versions withdraw their immutable address under the same site lock.
      const [current] = await tx
        .select({ status: deploymentTable.status })
        .from(deploymentTable)
        .where(eq(deploymentTable.id, args.deployment.id))
        .limit(1);
      if (current?.status === "deleted") {
        await get(
          deleteHostedSitesS3Objects(
            args.bucket,
            deletedHostedVersionKeys(args.deployment),
            signal,
          ),
        );
        throw new ArtifactDeliveryAliasConflict("Hosted deployment is deleted");
      }
      let activeDeploymentVersion: number | null = null;
      if (site.activeDeploymentId !== null) {
        const [active] = await tx
          .select({
            version:
              sql`(${hostedDeployments.manifest}->>'deploymentVersion')::integer`.mapWith(
                nullableDriverValueDecoder(pgIntegerDecoder),
              ),
          })
          .from(hostedDeployments)
          .where(activeHostedBindingCondition(site.activeDeploymentId, site.id))
          .limit(1);
        activeDeploymentVersion = activeHostedBindingVersion(active);
      }
      signal.throwIfAborted();
      let published: HostedSitePointer | null = null;
      if (
        shouldBindHostedDeployment(args.deployment, activeDeploymentVersion)
      ) {
        const publication = await set(
          readHostedPointerPublication$,
          { site, bucket: args.bucket, pointer: args.pointer },
          signal,
        );
        if (publication.retained) {
          const [retained] = await tx
            .select()
            .from(hostedDeployments)
            .where(
              retainedHostedDeploymentCondition(site, publication.pointer),
            );
          validateRetainedHostedDeployment(retained, publication.pointer);
        }
        signal.throwIfAborted();
        if (publication.previous?.kind === "publication") {
          const [share] = await tx
            .select()
            .from(artifactShares)
            .where(eq(artifactShares.id, publication.previous.shareId))
            .for("update");
          signal.throwIfAborted();
          const snapshot = await set(
            readHostedSnapshotPolicy$,
            { site, bucket: args.bucket, record: publication.previous, share },
            signal,
          );
          const [source] = await tx
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
      const ready = hostedDeploymentReadyValues(args.readyAt);
      await tx
        .update(deploymentTable)
        .set(ready)
        .where(eq(deploymentTable.id, args.deployment.id));
      if (published) {
        // Recover an acknowledged newer pointer after its earlier SQL rollback.
        if (published.deploymentId !== args.deployment.id) {
          await tx
            .update(hostedDeployments)
            .set(ready)
            .where(eq(hostedDeployments.id, published.deploymentId));
        }
        await tx
          .update(hostedSites)
          .set({
            activeDeploymentId: published.deploymentId,
            updatedAt: args.readyAt,
          })
          .where(eq(hostedSites.id, args.deployment.siteId));
      }
      return {
        activeDeploymentId: published?.deploymentId ?? site.activeDeploymentId,
        activeDeploymentVersion: published
          ? (published.deploymentVersion ?? null)
          : activeDeploymentVersion,
      };
    });
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
  previewImageUrl: string | undefined,
): CompleteDeploymentResult {
  const deploymentVersion = legacyHostedDeploymentVersion(deployment.manifest);
  return {
    status: "ok",
    body: {
      siteId: deployment.siteId,
      deploymentId: deployment.id,
      publicSlug: deployment.manifest.publicSlug,
      url: deployment.url,
      ...deploymentVersionResponseFields(deployment),
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
      ...(previewImageUrl ? { previewImageUrl } : {}),
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
    if (preview && preview.status !== "ok") {
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

    const artifactRow = await set(
      recordHostedSiteArtifact$,
      {
        ...hostedSiteArtifactArgs(deployment),
        ...(preview ? { previewImageUrl: preview.url } : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    // Render the artifact preview as soon as the deploy is recorded. Detached
    // via waitUntil so it survives the response; failures leave the preview
    // empty without blocking the deployment.
    // Retain the old-client producer until the sandbox rollout drains (PR 3 of #36205).
    // A supplied preview never falls back to remote rendering.
    if (!deployment.manifest.preview) {
      set(
        scheduleArtifactPreviewRender$,
        artifactPreviewArgs(deployment, artifactRow),
      );
    }

    return completedHostedSiteResponse(deployment, promotion, preview?.url);
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
    const { deployment, site } = target;
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
            publicSlug: site.publicSlug,
            url: deployment.url,
            ...deploymentVersionResponseFields(deployment),
          },
          manifest: deployment.manifest,
          prefix: deployment.r2Prefix,
        },
        signal,
      ),
    };
  },
);

export const getHostedSiteDeployments$ = command(
  async (
    { get, set },
    args: GetHostedSiteDeploymentsArgs,
    signal: AbortSignal,
  ): Promise<GetHostedSiteDeploymentsResult> => {
    const db = get(db$);
    const chatThreadId = await set(resolveChatThreadId$, args.runId, signal);
    signal.throwIfAborted();
    const scopeCondition =
      chatThreadId === null
        ? isNull(hostedSites.chatThreadId)
        : eq(hostedSites.chatThreadId, chatThreadId);
    const [site] = await db
      .select()
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.orgId, args.orgId),
          eq(hostedSites.requestedSlug, args.site),
          scopeCondition,
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
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

/** Only the creator may take a site offline, as only the creator may redeploy it. */
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

/**
 * Soft-delete a site: every version stops serving while its rows and bytes are
 * kept. The site keeps its name, so redeploying it publishes a new active
 * version at the same address. Deleted versions never serve again.
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
    // Legacy-layout sites are never redeployed, so deletion could not be undone.
    if (rowLinkLayout(candidate) !== CURRENT_LINK_LAYOUT) {
      return {
        status: "bad_request",
        message:
          "Hosted sites on the legacy domain cannot be redeployed, so they cannot be deleted",
      };
    }
    await set(revokeHostedSiteShare$, candidate, signal);
    signal.throwIfAborted();

    const deleted = await set(writeDb$).transaction(async (tx) => {
      // The publisher binds under this lock, so a completion cannot reactivate
      // a version after deletion commits.
      const [site] = await tx
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
        .for("update")
        .limit(1);
      if (!site) {
        return null;
      }
      const layout = rowLinkLayout(site);
      const deployments = await tx
        .select({
          id: hostedDeployments.id,
          artifactUrl: hostedDeployments.artifactUrl,
          readyAt: hostedDeployments.readyAt,
        })
        .from(hostedDeployments)
        .where(eq(hostedDeployments.siteId, site.id))
        .orderBy(desc(hostedDeployments.createdAt));
      signal.throwIfAborted();
      const aliases = [
        {
          alias: site.publicSlug,
          pointerKey: `${hostedSitePointerNamespace(layout)}/${site.publicSlug}/active.json`,
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
      // Pointers decide what serves; registry records only route to them.
      // Repeating the delete after a partial failure is safe.
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

      const now = nowDate();
      for (const table of [hostedDeployments, privateHostedDeployments]) {
        await tx
          .update(table)
          .set({ status: "deleted", updatedAt: now })
          .where(
            and(
              eq(table.siteId, site.id),
              inArray(table.status, ["uploading", "ready"]),
            ),
          );
      }
      await tx
        .update(hostedSites)
        .set({ activeDeploymentId: null, updatedAt: now })
        .where(eq(hostedSites.id, site.id));
      return { site, layout, deployments };
    });
    signal.throwIfAborted();
    if (!deleted) {
      return notFound;
    }

    const { site, layout, deployments } = deleted;
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
