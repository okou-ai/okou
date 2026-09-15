import { createHash } from "node:crypto";
import { command } from "ccstate";
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
  type HostedSiteManifest,
  type HostedSiteManifestFile,
} from "@okouai/db/schema/hosted-site";
import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { env } from "../../lib/env";
import { publicSlugCandidate } from "../../lib/hosted-site-slug";
import { type Db, writeDb$ } from "../external/db";
import { settle } from "../utils";
import type { Tx } from "../../lib/db-types";
import {
  generateHostedSitesPresignedGetUrl,
  generateHostedSitesPresignedPutUrl,
  hostedSitesS3ObjectExists,
  putHostedSitesS3Object,
} from "../external/s3";
import { nowDate } from "../../lib/time";
import { privateArtifactCreationEnabled } from "./private-artifact-storage.service";
import { registerLegacyHostedSite$ } from "./artifact-delivery.service";
import { privateHostedArtifactUrl } from "./private-hosted-preview.service";
import {
  scheduleArtifactPreviewRender$,
  type RenderArtifactPreviewArgs,
} from "./artifact-preview.service";
import { recordHostedSiteArtifact$ } from "./run-uploaded-files.service";
import {
  assertHostedDeploymentScope,
  canonicalizeHostedSiteScope,
  HostedSiteScopeError,
  lockHostedRunChatThreadId,
} from "./hosted-site-scope.service";
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
  readonly orgId: string;
  readonly userId: string;
  readonly publicSlug: string;
  readonly version?: number;
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
}

interface HostedSiteAllocation {
  readonly site: HostedSiteRow;
  readonly deploymentVersion: number;
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

function deploymentPrefix(
  orgId: string,
  site: string,
  deploymentVersion: number,
): string {
  return `sites/orgs/${encodeURIComponent(orgId)}/${site}/versions/${deploymentVersion}`;
}

function hostedSiteScopeKey(args: ScopedPrepareDeploymentArgs): string {
  return args.chatThreadId ?? "organization";
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

async function findScopedHostedSite(
  db: Db,
  args: ScopedPrepareDeploymentArgs,
  lock: boolean,
): Promise<HostedSiteRow | undefined> {
  const scopeCondition =
    args.chatThreadId === null
      ? isNull(hostedSites.chatThreadId)
      : eq(hostedSites.chatThreadId, args.chatThreadId);
  const query = db
    .select()
    .from(hostedSites)
    .where(
      and(
        eq(hostedSites.orgId, args.orgId),
        eq(hostedSites.requestedSlug, args.body.site),
        scopeCondition,
        isNull(hostedSites.deletedAt),
      ),
    );
  const [site] = lock
    ? await query.for("update").limit(1)
    : await query.limit(1);
  return site;
}

async function hasUnscopedHostedSiteConflict(
  db: Db,
  args: ScopedPrepareDeploymentArgs,
): Promise<boolean> {
  if (args.chatThreadId === null) {
    return false;
  }
  const scopedSite = await findScopedHostedSite(db, args, false);
  if (scopedSite) {
    return false;
  }
  const [unscopedSite] = await db
    .select({ id: hostedSites.id })
    .from(hostedSites)
    .where(
      and(
        eq(hostedSites.orgId, args.orgId),
        isNull(hostedSites.chatThreadId),
        or(
          eq(hostedSites.requestedSlug, args.body.site),
          and(
            isNull(hostedSites.requestedSlug),
            eq(hostedSites.slug, args.body.site),
          ),
        ),
        isNull(hostedSites.deletedAt),
      ),
    )
    .limit(1);
  return unscopedSite !== undefined;
}

function deploymentVersionResponseFields(deployment: HostedDeploymentRow): {
  readonly deploymentVersion?: number;
  readonly artifactUrl?: string;
  readonly aliasUrl?: string;
} {
  if (
    deployment.deploymentVersion === null ||
    deployment.artifactUrl === null
  ) {
    return {};
  }
  return {
    deploymentVersion: deployment.deploymentVersion,
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
  if (
    deployment.manifest.access ||
    !artifactRow ||
    artifactRow.previewImageUrl ||
    !deployment.runId
  ) {
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
    deploymentVersion: deployment.deploymentVersion,
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

async function findOrCreateHostedSite(
  db: Tx,
  args: ScopedPrepareDeploymentArgs,
  now: Date,
): Promise<HostedSiteRow | null> {
  const existingSite = await findScopedHostedSite(db, args, true);
  if (existingSite) {
    return args.privateArtifacts && existingSite.userId !== args.userId
      ? null
      : existingSite;
  }

  const scopeKey = hostedSiteScopeKey(args);
  const scope = await canonicalizeHostedSiteScope(db, {
    orgId: args.orgId,
    slug: args.body.site,
    requestedSlug: args.body.site,
    chatThreadId: args.chatThreadId,
    createdFromRunId: args.runId,
  });
  for (let attempt = 0; attempt < MAX_PUBLIC_SLUG_ATTEMPTS; attempt += 1) {
    const publicSlug = publicSlugCandidate(
      args.body.site,
      args.orgId,
      scopeKey,
      attempt,
    );
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
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (createdSite) {
      return createdSite;
    }

    const concurrentSite = await findScopedHostedSite(db, args, true);
    if (concurrentSite) {
      return args.privateArtifacts && concurrentSite.userId !== args.userId
        ? null
        : concurrentSite;
    }
  }
  return null;
}

async function allocateHostedSite(
  db: Tx,
  args: ScopedPrepareDeploymentArgs,
  now: Date,
): Promise<HostedSiteAllocation | null> {
  const site = await findOrCreateHostedSite(db, args, now);
  if (!site) {
    return null;
  }
  const deploymentVersion = site.nextDeploymentVersion;
  const [updatedSite] = await db
    .update(hostedSites)
    .set({
      nextDeploymentVersion: deploymentVersion + 1,
      updatedAt: now,
    })
    .where(eq(hostedSites.id, site.id))
    .returning();
  if (!updatedSite) {
    throw new Error("Failed to allocate hosted deployment version");
  }
  return { site: updatedSite, deploymentVersion };
}

async function insertHostedDeployment(
  db: Tx,
  args: ScopedPrepareDeploymentArgs,
  context: CreateHostedSiteDeploymentContext,
  allocation: HostedSiteAllocation,
): Promise<HostedDeploymentRow> {
  const { deploymentVersion, site } = allocation;
  const deploymentId = crypto.randomUUID();
  const artifactUrl = args.privateArtifacts
    ? privateHostedArtifactUrl(deploymentId)
    : deploymentUrl(site.publicBrand, deploymentId);
  const aliasUrl = args.privateArtifacts
    ? artifactUrl
    : publicUrl(site.publicBrand, site.publicSlug);
  const prefix = args.privateArtifacts
    ? `private-sites/${site.publicBrand}/${deploymentId}`
    : deploymentPrefix(args.orgId, site.slug, deploymentVersion);
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
      deploymentVersion,
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
      if (await hasUnscopedHostedSiteConflict(tx, scopedArgs)) {
        return {
          kind: "scope_conflict",
          message: `Hosted site slug "${args.body.site}" is owned outside this chat. Choose a different --site value and rerun the same okou host command.`,
        };
      }
      const allocation = await allocateHostedSite(tx, scopedArgs, context.now);
      if (!allocation) {
        return { kind: "slug_conflict" };
      }
      const deployment = await insertHostedDeployment(
        tx,
        scopedArgs,
        context,
        allocation,
      );
      return { kind: "ok", site: allocation.site, deployment };
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
    const now = nowDate();
    const siteAndDeployment = await createHostedSiteDeployment(
      writeDb,
      creationArgs,
      { now },
    );
    signal.throwIfAborted();
    if (siteAndDeployment.kind === "scope_conflict") {
      return { status: "conflict", message: siteAndDeployment.message };
    }
    if (siteAndDeployment.kind === "slug_conflict") {
      return {
        status: "conflict",
        message: "Unable to allocate a unique hosted site slug",
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
  return {
    version: 1,
    publicBrand: deployment.publicBrand,
    publicSlug: deployment.manifest.publicSlug,
    siteId: deployment.siteId,
    deploymentId: deployment.id,
    ...(deployment.deploymentVersion === null
      ? {}
      : { deploymentVersion: deployment.deploymentVersion }),
    ...(deployment.artifactUrl === null
      ? {}
      : { artifactUrl: deployment.artifactUrl }),
    prefix: deployment.r2Prefix,
    manifestKey,
    spaFallback: deployment.spaFallback,
    updatedAt: readyAt.toISOString(),
  };
}

const promoteHostedSiteDeployment$ = command(
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

      const shouldPromote =
        !args.deployment.manifest.access &&
        (args.deployment.deploymentVersion === null
          ? site.activeDeploymentVersion === null
          : site.activeDeploymentVersion === null ||
            args.deployment.deploymentVersion >= site.activeDeploymentVersion);
      if (shouldPromote) {
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
      if (shouldPromote) {
        await tx
          .update(hostedSites)
          .set({
            activeDeploymentId: args.deployment.id,
            activeDeploymentVersion: args.deployment.deploymentVersion,
            updatedAt: args.readyAt,
          })
          .where(eq(hostedSites.id, args.deployment.siteId));
      }

      return {
        activeDeploymentId: shouldPromote
          ? args.deployment.id
          : site.activeDeploymentId,
        activeDeploymentVersion: shouldPromote
          ? args.deployment.deploymentVersion
          : site.activeDeploymentVersion,
      };
    });
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

    const manifestKey = `${deployment.r2Prefix}/manifest.json`;
    await get(
      putHostedSitesS3Object(
        hostedR2.config.bucket,
        manifestKey,
        JSON.stringify(deployment.manifest, null, 2),
        "application/json",
      ),
    );
    signal.throwIfAborted();

    const readyAt = nowDate();
    const pointer = activeSitePointerForDeployment(
      deployment,
      manifestKey,
      readyAt,
    );

    if (deployment.deploymentVersion !== null && !deployment.manifest.access) {
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
      promoteHostedSiteDeployment$,
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
        ...(deployment.deploymentVersion === null
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
        eq(hostedDeployments.orgId, args.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!deployment) {
    return { status: "not_found", message: "Hosted deployment not found" };
  }
  if (
    args.version !== undefined &&
    deployment.deploymentVersion !== args.version
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
        eq(hostedSites.orgId, args.orgId),
        isNull(hostedSites.deletedAt),
      ),
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
        eq(hostedSites.orgId, args.orgId),
        isNull(hostedSites.deletedAt),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!site) {
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
      if (!publicDeployment && site.userId !== args.userId) {
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
          eq(hostedDeployments.orgId, args.orgId),
        ),
      )
      .limit(1);
  } else {
    [deployment] = await db
      .select()
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.deploymentVersion, args.version),
          eq(hostedDeployments.siteId, site.id),
          eq(hostedDeployments.orgId, args.orgId),
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
          : eq(privateHostedDeployments.deploymentVersion, args.version),
      ),
    )
    .orderBy(desc(privateHostedDeployments.deploymentVersion))
    .limit(1);
  signal.throwIfAborted();
  if (target && target.deployment.manifest.access !== "owner-private-v1") {
    throw new Error("Private hosted deployment has an invalid access policy");
  }
  if (
    target &&
    !deploymentId &&
    args.version === undefined &&
    target.deployment.deploymentVersion <=
      (target.site.activeDeploymentVersion ?? 0)
  ) {
    return null;
  }
  return target ? { status: "ok", ...target } : null;
}

async function loadHostedSiteFilesTarget(
  db: Db,
  args: GetHostedSiteFilesArgs,
  signal: AbortSignal,
): Promise<HostedSiteFilesTargetResult> {
  const deploymentId = IMMUTABLE_DEPLOYMENT_HOST_PATTERN.exec(
    args.publicSlug,
  )?.[1];
  const privateTarget = await loadPrivateHostedSiteFilesTarget(
    db,
    args,
    deploymentId,
    signal,
  );
  return (
    privateTarget ??
    (deploymentId
      ? await loadImmutableHostedSiteFilesTarget(db, args, deploymentId, signal)
      : await loadAliasedHostedSiteFilesTarget(db, args, signal))
  );
}

export const getHostedSiteFiles$ = command(
  async (
    { get, set },
    args: GetHostedSiteFilesArgs,
    signal: AbortSignal,
  ): Promise<GetHostedSiteFilesResult> => {
    const writeDb = set(writeDb$);
    const target = await loadHostedSiteFilesTarget(writeDb, args, signal);
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

    const manifestFiles = Object.values(deployment.manifest.files).sort(
      (a, b) => {
        return a.path.localeCompare(b.path);
      },
    );
    signal.throwIfAborted();

    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }

    const files = await Promise.all(
      manifestFiles.map(async (file) => {
        const downloadUrl = await get(
          generateHostedSitesPresignedGetUrl(
            hostedR2.config.bucket,
            fileKey(deployment.r2Prefix, file.path),
            true,
          ),
        );
        return { ...file, downloadUrl };
      }),
    );
    signal.throwIfAborted();

    return {
      status: "ok",
      body: {
        siteId: site.id,
        deploymentId: deployment.id,
        publicSlug: site.publicSlug,
        url: deployment.url,
        ...deploymentVersionResponseFields(deployment),
        fileCount: deployment.fileCount,
        size: deployment.sizeBytes,
        files,
      },
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
        activeDeploymentVersion: site.activeDeploymentVersion,
        deployments: [...privateVersions, ...deployments]
          .sort((a, b) => {
            return b.createdAt.getTime() - a.createdAt.getTime();
          })
          .map((deployment) => {
            return {
              deploymentId: deployment.id,
              deploymentVersion: deployment.deploymentVersion,
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
