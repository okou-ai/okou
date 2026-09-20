import type {
  HostedSiteManifest,
  HostedSiteManifestFile,
} from "@okouai/db/jsonb-contracts/hosted-site";
import { createHash } from "node:crypto";
import { command } from "ccstate";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import type {
  HostedArtifactKind,
  HostedSiteFilesResponse,
  HostedSiteDeploymentsResponse,
  HostedSitePrepareRequest,
} from "@okouai/api-contracts/contracts/host";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  hostedDeployments,
  privateHostedDeployments,
  hostedSites,
} from "@okouai/db/runtime/hosted-site";
import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { env } from "../../lib/env";
import { publicSlugCandidate } from "../../lib/hosted-site-slug";
import {
  legacyHostedDeploymentVersion,
  legacyPrivateHostedDeploymentVersion,
} from "../../lib/hosted-publication";
import {
  nullableDriverValueDecoder,
  pgIntegerDecoder,
} from "../../lib/db-structured-result";
import { type Db, writeDb$ } from "../external/db";
import { settle } from "../utils";
import type { Tx } from "../../lib/db-types";
import {
  generateHostedSitesPresignedPutUrl,
  hostedSitesS3ObjectExists,
  putHostedSitesS3Object,
} from "../external/s3";
import { nowDate } from "../../lib/time";
import {
  privateArtifactCreationEnabled,
  privateArtifactReferenceUrl,
} from "./private-artifact-storage.service";
import { registerLegacyHostedSite$ } from "./artifact-delivery.service";
import { allocateArtifactReference$ } from "./artifact-reference.service";
import {
  scheduleArtifactPreviewRender$,
  type RenderArtifactPreviewArgs,
} from "./artifact-preview.service";
import { recordHostedSiteArtifact$ } from "./run-uploaded-files.service";
import {
  collectHostedSiteDependencies$,
  hostedSiteDeliveryManifest,
} from "./hosted-site-dependencies.service";
import {
  assertHostedDeploymentScope,
  canonicalizeHostedSiteScope,
  HostedSiteScopeError,
  lockHostedRunChatThreadId,
} from "./hosted-site-scope.service";
import { signHostedSiteFiles$ } from "./hosted-site-files.service";
import {
  resolveArtifactShareDownload$,
  resolveHostedSitePublicationDownload$,
} from "./artifact-shares.service";
const MAX_HOSTED_SITE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_HOSTED_SITE_FILE_BYTES = 100 * 1024 * 1024;
const MAX_PUBLIC_SLUG_ATTEMPTS = 5;
const IMMUTABLE_DEPLOYMENT_HOST_PATTERN =
  /^dpl-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

interface PrepareDeploymentArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
  readonly publicBrand: PublicBrand;
  readonly body: HostedSitePrepareRequest;
}

interface ScopedPrepareDeploymentArgs extends PrepareDeploymentArgs {
  readonly chatThreadId: string | null;
  readonly privateArtifacts: boolean;
}

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

interface ActiveSitePointer {
  readonly version: 1;
  readonly publicBrand: PublicBrand;
  readonly publicSlug: string;
  readonly siteId: string;
  readonly deploymentId: string;
  readonly deploymentVersion?: number;
  readonly artifactUrl?: string;
  readonly prefix: string;
  readonly manifestKey: string;
  readonly spaFallback: boolean;
  readonly updatedAt: string;
}

type HostedSiteRow = typeof hostedSites.$inferSelect;
type HostedDeploymentRow = typeof hostedDeployments.$inferSelect;
type HostedSiteFile = HostedSitePrepareRequest["files"][number];

type SiteDeploymentCreationResult =
  | {
      readonly kind: "ok";
      readonly site: HostedSiteRow;
      readonly deployment: HostedDeploymentRow;
    }
  | { readonly kind: "slug_conflict" }
  | { readonly kind: "scope_conflict"; readonly message: string };

interface CreateHostedSiteDeploymentContext {
  readonly now: Date;
  readonly deploymentId: string;
  readonly privateReference: string | null;
}

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

function publicHostDomain(publicBrand: PublicBrand): string {
  return publicBrand === "okou"
    ? env("OKOU_PUBLIC_HOST_DOMAIN")
    : env("ZERO_HOST_DOMAIN");
}

function publicHostScheme(publicBrand: PublicBrand): string {
  return publicBrand === "okou"
    ? env("OKOU_HOST_SCHEME")
    : env("ZERO_HOST_SCHEME");
}

function publicUrl(publicBrand: PublicBrand, publicSlug: string): string {
  return `${publicHostScheme(publicBrand)}://${publicSlug}.${publicHostDomain(publicBrand)}`;
}

function deploymentUrl(publicBrand: PublicBrand, deploymentId: string): string {
  return publicUrl(publicBrand, `dpl-${deploymentId}`);
}

function pointerNamespace(publicBrand: PublicBrand): string {
  return publicBrand === "okou" ? "sites/brands/okou" : "sites";
}

function activePointerKey(
  publicBrand: PublicBrand,
  publicSlug: string,
): string {
  return `${pointerNamespace(publicBrand)}/${publicSlug}/active.json`;
}

function immutableDeploymentPointerKey(
  publicBrand: PublicBrand,
  deploymentId: string,
): string {
  return `${pointerNamespace(publicBrand)}/deployments/${deploymentId}.json`;
}

function hostedSiteRequestedSlug(site: HostedSiteRow): string {
  return site.requestedSlug ?? site.slug;
}

async function resolveChatThreadId(
  db: Db,
  runId: string | undefined,
): Promise<string | null> {
  if (runId === undefined) {
    return null;
  }
  const [run] = await db
    .select({ chatThreadId: agentRuns.chatThreadId })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  return run?.chatThreadId ?? null;
}

async function hostedDeploymentScopeError(
  db: Db,
  runId: string | undefined,
  owningChatThreadId: string | null,
): Promise<Extract<CompleteDeploymentResult, { status: "conflict" }> | null> {
  const chatThreadId = await resolveChatThreadId(db, runId);
  return owningChatThreadId === chatThreadId
    ? null
    : {
        status: "conflict",
        message: "Hosted deployment belongs to a different chat",
      };
}

type CompleteDeploymentLookupResult =
  | { readonly status: "ok"; readonly deployment: HostedDeploymentRow }
  | Extract<CompleteDeploymentResult, { status: "not_found" | "conflict" }>;

async function resolveHostedDeploymentForCompletion(
  db: Db,
  args: CompleteDeploymentArgs,
): Promise<CompleteDeploymentLookupResult> {
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
  if (privateDeployment) {
    if (privateDeployment.manifest.access !== "owner-private-v1") {
      throw new Error("Private hosted deployment has an invalid access policy");
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
    if (!site) {
      return { status: "not_found", message: "Hosted deployment not found" };
    }
    const scopeError = await hostedDeploymentScopeError(
      db,
      args.runId,
      site.chatThreadId,
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
      ),
    )
    .limit(1);
  if (!ownedDeployment) {
    return { status: "not_found", message: "Hosted deployment not found" };
  }
  const scopeError = await hostedDeploymentScopeError(
    db,
    args.runId,
    ownedDeployment.chatThreadId,
  );
  return (
    scopeError ?? {
      status: "ok",
      deployment: ownedDeployment.deployment,
    }
  );
}

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

function buildManifest(args: {
  readonly deploymentId: string;
  readonly siteId: string;
  readonly site: string;
  readonly publicSlug: string;
  readonly deploymentVersion: number | null;
  readonly artifactKind: HostedArtifactKind;
  readonly spaFallback: boolean;
  readonly files: readonly HostedSiteFile[];
  readonly createdAt: Date;
  readonly publicBrand: PublicBrand;
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
    publicBrand: args.publicBrand,
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
  };
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
    contentType: "text/html",
    publicBrand: deployment.publicBrand,
    deploymentId: deployment.id,
    privateHosted: deployment.manifest.access === "owner-private-v1",
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
    publicBrand: deployment.publicBrand,
  };
}

async function createHostedSite(
  db: Tx,
  args: ScopedPrepareDeploymentArgs,
  context: CreateHostedSiteDeploymentContext,
): Promise<HostedSiteRow | null> {
  for (let attempt = 0; attempt < MAX_PUBLIC_SLUG_ATTEMPTS; attempt += 1) {
    const publicSlug = publicSlugCandidate(
      args.body.site,
      args.orgId,
      context.deploymentId,
      attempt,
    );
    const scope = await canonicalizeHostedSiteScope(db, {
      orgId: args.orgId,
      slug: publicSlug,
      // Each publication owns its resolved name, including for older readers.
      requestedSlug: publicSlug,
      chatThreadId: args.chatThreadId,
      createdFromRunId: args.runId,
    });
    const [createdSite] = await db
      .insert(hostedSites)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        slug: publicSlug,
        ...scope,
        publicBrand: args.publicBrand,
        publicSlug,
        createdFromRunId: args.runId,
        updatedAt: context.now,
      })
      .onConflictDoNothing()
      .returning();
    if (createdSite) {
      return createdSite;
    }
  }
  return null;
}

async function insertHostedDeployment(
  db: Tx,
  args: ScopedPrepareDeploymentArgs,
  context: CreateHostedSiteDeploymentContext,
  site: HostedSiteRow,
): Promise<HostedDeploymentRow> {
  // Retained wire/storage projection for pinned CLIs and old API readers.
  // Publication identity and storage paths use deploymentId, never this value.
  const deploymentVersion = 1;
  const { deploymentId } = context;
  if (args.privateArtifacts !== (context.privateReference !== null)) {
    throw new Error("Deployment reference does not match its storage policy");
  }
  const artifactUrl =
    context.privateReference === null
      ? deploymentUrl(site.publicBrand, deploymentId)
      : privateArtifactReferenceUrl(context.privateReference, "index.html");
  const aliasUrl = args.privateArtifacts
    ? artifactUrl
    : publicUrl(site.publicBrand, site.publicSlug);
  const prefix = args.privateArtifacts
    ? `private-sites/${site.publicBrand}/${deploymentId}`
    : `${pointerNamespace(site.publicBrand)}/publications/${deploymentId}`;
  const manifest: HostedSiteManifest = {
    ...buildManifest({
      deploymentId,
      siteId: site.id,
      site: args.body.site,
      publicSlug: site.publicSlug,
      deploymentVersion,
      artifactKind: args.body.artifactKind,
      spaFallback: args.body.spaFallback,
      files: args.body.files,
      createdAt: context.now,
      publicBrand: site.publicBrand,
    }),
    ...(args.privateArtifacts ? { access: "owner-private-v1" as const } : {}),
  };
  const files = Object.values(manifest.files);
  await assertHostedDeploymentScope(db, {
    siteId: site.id,
    orgId: args.orgId,
    runId: args.runId,
  });
  const [deployment] = await db
    .insert(
      args.privateArtifacts ? privateHostedDeployments : hostedDeployments,
    )
    .values({
      id: deploymentId,
      siteId: site.id,
      orgId: args.orgId,
      userId: args.userId,
      runId: args.runId,
      publicBrand: site.publicBrand,
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
    })
    .returning();
  if (!deployment) {
    throw new Error("Failed to create hosted deployment");
  }
  return deployment;
}

export async function createHostedSiteDeployment(
  writeDb: Db,
  args: PrepareDeploymentArgs & { readonly privateArtifacts: boolean },
  context: CreateHostedSiteDeploymentContext,
): Promise<SiteDeploymentCreationResult> {
  const result = await settle(
    writeDb.transaction(async (tx): Promise<SiteDeploymentCreationResult> => {
      // Hold run ownership stable through allocation and deployment admission.
      // FOR SHARE also blocks non-key metadata updates and run cleanup.
      const chatThreadId = await lockHostedRunChatThreadId(tx, args.runId);
      const scopedArgs = { ...args, chatThreadId };
      const site = await createHostedSite(tx, scopedArgs, context);
      if (!site) {
        return { kind: "slug_conflict" };
      }
      const deployment = await insertHostedDeployment(
        tx,
        scopedArgs,
        context,
        site,
      );
      return { kind: "ok", site, deployment };
    }),
  );
  if (!result.ok) {
    if (result.error instanceof HostedSiteScopeError) {
      return { kind: "scope_conflict", message: result.error.message };
    }
    throw result.error;
  }
  return result.value;
}

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

    const writeDb = set(writeDb$);
    const creationArgs = {
      ...args,
      privateArtifacts: await get(
        privateArtifactCreationEnabled(args.orgId, args.userId),
      ),
    };
    signal.throwIfAborted();
    if (args.body.requirePrivateArtifact && !creationArgs.privateArtifacts) {
      return { status: "forbidden" };
    }
    const now = nowDate();
    const deploymentId = crypto.randomUUID();
    const privateReference = creationArgs.privateArtifacts
      ? await set(
          allocateArtifactReference$,
          { kind: "html", id: deploymentId },
          signal,
        )
      : null;
    const siteAndDeployment = await createHostedSiteDeployment(
      writeDb,
      creationArgs,
      { now, deploymentId, privateReference },
    );
    signal.throwIfAborted();
    if (siteAndDeployment.kind === "scope_conflict") {
      return { status: "conflict", message: siteAndDeployment.message };
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
              file.sha256,
              true,
            ),
          );
          return { path: file.path, uploadUrl };
        },
      ),
    );
    signal.throwIfAborted();

    return {
      status: "ok",
      body: {
        siteId: siteAndDeployment.site.id,
        deploymentId: siteAndDeployment.deployment.id,
        publicSlug,
        url,
        ...deploymentVersionResponseFields(siteAndDeployment.deployment),
        uploads,
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
): ActiveSitePointer {
  const deploymentVersion = legacyHostedDeploymentVersion(deployment.manifest);
  return {
    version: 1,
    publicBrand: deployment.publicBrand,
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

async function loadActiveHostedDeploymentVersion(
  db: Db | Tx,
  site: HostedSiteRow,
): Promise<number | null> {
  if (site.activeDeploymentId === null) {
    return null;
  }
  const [deployment] = await db
    .select({
      version:
        sql`(${hostedDeployments.manifest}->>'deploymentVersion')::integer`.mapWith(
          nullableDriverValueDecoder(pgIntegerDecoder),
        ),
    })
    .from(hostedDeployments)
    .where(
      and(
        eq(hostedDeployments.id, site.activeDeploymentId),
        eq(hostedDeployments.siteId, site.id),
      ),
    )
    .limit(1);
  if (!deployment) {
    throw new Error("Hosted site has an invalid public deployment binding");
  }
  return deployment.version;
}

const bindHostedSiteDeployment$ = command(
  (
    { get, set },
    args: {
      readonly bucket: string;
      readonly deployment: HostedDeploymentRow;
      readonly orgId: string;
      readonly pointer: ActiveSitePointer;
      readonly readyAt: Date;
    },
    signal: AbortSignal,
  ): Promise<HostedSitePromotion> => {
    const writeDb = set(writeDb$);
    return writeDb.transaction(async (tx) => {
      const [site] = await tx
        .select()
        .from(hostedSites)
        .where(
          and(
            eq(hostedSites.id, args.deployment.siteId),
            eq(hostedSites.orgId, args.orgId),
          ),
        )
        .for("update")
        .limit(1);
      if (!site) {
        throw new Error("Hosted site not found for deployment");
      }

      const activeDeploymentVersion = await loadActiveHostedDeploymentVersion(
        tx,
        site,
      );
      signal.throwIfAborted();
      const deploymentVersion = legacyHostedDeploymentVersion(
        args.deployment.manifest,
      );
      const shouldBind =
        !args.deployment.manifest.access &&
        (args.deployment.manifest.immutableContent
          ? site.activeDeploymentId === null ||
            site.activeDeploymentId === args.deployment.id
          : // Historical pending uploads can still complete out of order.
            // Keep their alias selection until the #35240 migration/drain gate.
            deploymentVersion === null
            ? activeDeploymentVersion === null
            : activeDeploymentVersion === null ||
              deploymentVersion >= activeDeploymentVersion);
      if (shouldBind) {
        await set(
          registerLegacyHostedSite$,
          {
            alias: args.deployment.manifest.publicSlug,
            publicBrand: args.deployment.publicBrand,
            pointerKey: activePointerKey(
              args.deployment.publicBrand,
              args.deployment.manifest.publicSlug,
            ),
          },
          signal,
        );
        await get(
          putHostedSitesS3Object(
            args.bucket,
            activePointerKey(
              args.deployment.publicBrand,
              args.deployment.manifest.publicSlug,
            ),
            JSON.stringify(args.pointer, null, 2),
            "application/json",
          ),
        );
        signal.throwIfAborted();
      }

      const deploymentTable = args.deployment.manifest.access
        ? privateHostedDeployments
        : hostedDeployments;
      await tx
        .update(deploymentTable)
        .set({
          status: "ready",
          readyAt: args.readyAt,
          updatedAt: args.readyAt,
          error: null,
        })
        .where(eq(deploymentTable.id, args.deployment.id));
      if (shouldBind) {
        await tx
          .update(hostedSites)
          .set({
            activeDeploymentId: args.deployment.id,
            updatedAt: args.readyAt,
          })
          .where(eq(hostedSites.id, args.deployment.siteId));
      }

      return {
        activeDeploymentId: shouldBind
          ? args.deployment.id
          : site.activeDeploymentId,
        activeDeploymentVersion: shouldBind
          ? deploymentVersion
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

export const completeHostedSiteDeployment$ = command(
  async (
    { get, set },
    args: CompleteDeploymentArgs,
    signal: AbortSignal,
  ): Promise<CompleteDeploymentResult> => {
    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }

    const writeDb = set(writeDb$);
    const deploymentResult = await resolveHostedDeploymentForCompletion(
      writeDb,
      args,
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

    const deploymentVersion = legacyHostedDeploymentVersion(
      deployment.manifest,
    );
    if (deploymentVersion !== null && !deployment.manifest.access) {
      await set(
        registerLegacyHostedSite$,
        {
          alias: `dpl-${deployment.id}`,
          publicBrand: deployment.publicBrand,
          pointerKey: immutableDeploymentPointerKey(
            deployment.publicBrand,
            deployment.id,
          ),
        },
        signal,
      );
      await get(
        putHostedSitesS3Object(
          hostedR2.config.bucket,
          immutableDeploymentPointerKey(deployment.publicBrand, deployment.id),
          JSON.stringify(pointer, null, 2),
          "application/json",
        ),
      );
      signal.throwIfAborted();
    }

    const promotion = await set(
      bindHostedSiteDeployment$,
      {
        bucket: hostedR2.config.bucket,
        deployment,
        orgId: args.orgId,
        pointer,
        readyAt,
      },
      signal,
    );
    signal.throwIfAborted();

    const artifactRow = await set(
      recordHostedSiteArtifact$,
      hostedSiteArtifactArgs(deployment),
      signal,
    );
    signal.throwIfAborted();

    // Render the artifact preview as soon as the deploy is recorded. Detached
    // via waitUntil so it survives the response; failures leave the preview
    // empty without blocking the deployment.
    set(
      scheduleArtifactPreviewRender$,
      artifactPreviewArgs(deployment, artifactRow),
    );

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
      },
    };
  },
);

async function loadImmutableHostedSiteFilesTarget(
  db: Db,
  args: GetHostedSiteFilesArgs,
  deploymentId: string,
  signal: AbortSignal,
): Promise<HostedSiteFilesTargetResult> {
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
      and(eq(hostedSites.id, deployment.siteId), isNull(hostedSites.deletedAt)),
    )
    .limit(1);
  signal.throwIfAborted();
  return site
    ? { status: "ok", site, deployment }
    : { status: "not_found", message: "Hosted site not found" };
}

async function loadAliasedHostedSiteFilesTarget(
  db: Db,
  args: GetHostedSiteFilesArgs,
  signal: AbortSignal,
): Promise<HostedSiteFilesTargetResult> {
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
  if (args.hostname && hostedDownloadBrand(args) !== site.publicBrand) {
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
}

async function loadPrivateHostedSiteFilesTarget(
  db: Db,
  args: GetHostedSiteFilesArgs,
  deploymentId: string | undefined,
  signal: AbortSignal,
): Promise<HostedSiteFilesTargetResult | null> {
  // Explicit site URLs name published content; owner editing uses bare slugs
  // or exact deployment identities.
  if (!args.orgId || (!deploymentId && args.hostname !== undefined)) {
    return null;
  }
  const [target] = await db
    .select({ site: hostedSites, deployment: privateHostedDeployments })
    .from(privateHostedDeployments)
    .innerJoin(hostedSites, eq(hostedSites.id, privateHostedDeployments.siteId))
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
    const activeVersion = await loadActiveHostedDeploymentVersion(
      db,
      target.site,
    );
    signal.throwIfAborted();
    if (
      legacyPrivateHostedDeploymentVersion(target.deployment.manifest) <=
      (activeVersion ?? 0)
    ) {
      return null;
    }
  }
  return target ? { status: "ok", ...target } : null;
}

const sharedHostedSiteFiles$ = command(
  async (
    { set },
    args: GetHostedSiteFilesArgs,
    deploymentId: string | undefined,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
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

function hostedDownloadBrand(args: GetHostedSiteFilesArgs): PublicBrand | null {
  if (!args.hostname) {
    return PUBLIC_BRAND;
  }
  for (const brand of ["okou", "vm0"] as const) {
    if (
      args.hostname.toLowerCase() ===
      `${args.publicSlug}.${publicHostDomain(brand)}`.toLowerCase()
    ) {
      return brand;
    }
  }
  return null;
}

export const getHostedSiteFiles$ = command(
  async (
    { set },
    args: GetHostedSiteFilesArgs,
    signal: AbortSignal,
  ): Promise<GetHostedSiteFilesResult> => {
    const writeDb = set(writeDb$);
    const deploymentId = IMMUTABLE_DEPLOYMENT_HOST_PATTERN.exec(
      args.publicSlug,
    )?.[1];
    const publicBrand = deploymentId ? PUBLIC_BRAND : hostedDownloadBrand(args);
    if (!publicBrand) {
      return {
        status: "bad_request",
        message:
          "Hosted site hostname does not match its slug and configured domain",
      };
    }
    const owned = await loadPrivateHostedSiteFilesTarget(
      writeDb,
      args,
      deploymentId,
      signal,
    );
    const publication =
      deploymentId || owned
        ? null
        : await set(
            resolveHostedSitePublicationDownload$,
            { ...args, publicBrand },
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
    const legacyUrl = !deploymentId && args.hostname !== undefined;
    if (!owned && !legacyUrl) {
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
        ? await loadImmutableHostedSiteFilesTarget(
            writeDb,
            args,
            deploymentId,
            signal,
          )
        : await loadAliasedHostedSiteFilesTarget(writeDb, args, signal));
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
    { set },
    args: GetHostedSiteDeploymentsArgs,
    signal: AbortSignal,
  ): Promise<GetHostedSiteDeploymentsResult> => {
    const writeDb = set(writeDb$);
    const chatThreadId = await resolveChatThreadId(writeDb, args.runId);
    signal.throwIfAborted();
    const scopeCondition =
      chatThreadId === null
        ? isNull(hostedSites.chatThreadId)
        : eq(hostedSites.chatThreadId, chatThreadId);
    const [site] = await writeDb
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

    const privateVersions = await writeDb
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
    const deployments = await writeDb
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
            ? publicUrl(site.publicBrand, site.publicSlug)
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
