import {
  artifactDeliveryKey,
  artifactDeliveryRecordSchema,
  artifactDeliveryRegistrationKey,
  isArtifactDeliveryFilePath,
  type ArtifactDeliveryRecord,
} from "@okouai/api-contracts/contracts/artifact-delivery";
import {
  PRIVATE_ARTIFACT_CACHE_CONTROL,
  PRIVATE_NO_STORE_CACHE_CONTROL,
} from "@okouai/api-contracts/contracts/artifact-cache";
import {
  artifactSharePolicySchema,
  type ArtifactSharePolicy,
} from "@okouai/api-contracts/contracts/artifact-shares";
import {
  sharedThreadArtifactPolicyKey,
  sharedThreadArtifactPolicySchema,
} from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import {
  serveArtifactThumbnail,
  type ImagesBinding,
} from "./artifact-thumbnail";
import { PRIVATE_VIDEO_POSTER_PATH } from "@okouai/api-contracts/contracts/artifact-video-preview";
import {
  servePrivateVideoPoster,
  type MediaBinding,
} from "./private-video-preview";

interface R2ObjectBody {
  readonly size: number;
  readonly body: ReadableStream;
  readonly httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

interface R2Bucket {
  get(
    key: string,
    options?: {
      readonly range: { readonly offset: number; readonly length: number };
    },
  ): Promise<R2ObjectBody | null>;
  head(key: string): Promise<Pick<R2ObjectBody, "size" | "httpEtag"> | null>;
}

interface Env {
  readonly IMAGES?: ImagesBinding;
  readonly MEDIA?: MediaBinding;
  readonly HOSTED_SITES_BUCKET: R2Bucket;
  readonly PRIVATE_ARTIFACTS_BUCKET?: R2Bucket;
  readonly PUBLIC_ARTIFACTS_BUCKET?: R2Bucket;
  readonly PUBLIC_ARTIFACT_HOST?: string;
  readonly HOST_DOMAIN: string;
  readonly OKOU_HOST_DOMAIN: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Hosted sites and artifacts live in one of two read-only storage layouts.
 * Objects issued on the original sites domain keep the legacy layout forever
 * (#28449); current writers use the current layout. The segments below are
 * persisted in R2 keys, stored records and cache keys, so they never change.
 */
type StorageLayout = "legacy" | "current";

const LAYOUT_SEGMENT = { legacy: "vm0", current: "okou" } as const;

type LayoutSegment = (typeof LAYOUT_SEGMENT)[StorageLayout];

function layoutOfSegment(segment: LayoutSegment): StorageLayout {
  switch (segment) {
    case LAYOUT_SEGMENT.legacy:
      return "legacy";
    case LAYOUT_SEGMENT.current:
      return "current";
  }
  throw new Error("Unknown storage layout segment");
}

interface ActiveSitePointer {
  readonly version: 1;
  /** Stored layout segment; objects written before it existed omit it. */
  readonly publicBrand?: LayoutSegment;
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

interface ManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly immutable?: boolean;
}

function isHtmlManifestFile(file: ManifestFile): boolean {
  return (
    /\.html?$/iu.test(file.path) ||
    file.contentType.toLowerCase().startsWith("text/html")
  );
}

interface HostedSiteManifest {
  readonly version: 1;
  readonly immutableContent?: true;
  readonly access?: "owner-private-v1";
  /** Stored layout segment; objects written before it existed omit it. */
  readonly publicBrand?: LayoutSegment;
  readonly deploymentId: string;
  readonly siteId: string;
  readonly publicSlug: string;
  readonly createdAt: string;
  readonly spaFallback: boolean;
  readonly files: Record<string, ManifestFile>;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Accept, Content-Type, Range, If-Range",
  "Access-Control-Expose-Headers":
    "Accept-Ranges, Content-Length, Content-Range, ETag",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Max-Age": "86400",
} as const;
const STATIC_ALLOWED_ORIGINS = new Set([
  "https://okou.ai",
  "https://app.vm7.ai:8443",
]);
const DEFAULT_ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
const IMMUTABLE_DEPLOYMENT_HOST_PATTERN =
  /^dpl-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

function isSubdomainOf(hostname: string, domain: string): boolean {
  return hostname.endsWith(`.${domain}`) && hostname.length > domain.length + 1;
}

function allowedCorsOrigin(origin: string | null): string | null {
  if (!origin) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  const normalizedOrigin = url.origin;
  if (STATIC_ALLOWED_ORIGINS.has(normalizedOrigin)) {
    return normalizedOrigin;
  }

  const hostname = url.hostname.toLowerCase();
  if (
    isSubdomainOf(hostname, "okou.ai") ||
    isSubdomainOf(hostname, "vm6.ai") ||
    isSubdomainOf(hostname, "omby.ai")
  ) {
    return normalizedOrigin;
  }
  if (isSubdomainOf(hostname, "vm7.ai") && url.port === "8443") {
    return normalizedOrigin;
  }
  return null;
}

function appendVaryOrigin(headers: Headers): void {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", "Origin");
    return;
  }
  const values = current.split(",").map((value) => {
    return value.trim().toLowerCase();
  });
  if (!values.includes("origin")) {
    headers.set("Vary", `${current}, Origin`);
  }
}

function setCorsHeaders(headers: Headers, request: Request): void {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  const origin = allowedCorsOrigin(request.headers.get("Origin"));
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  appendVaryOrigin(headers);
}

function corsResponse(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  setCorsHeaders(headers, request);
  headers.set("X-Robots-Tag", "noindex");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function optionsResponse(request: Request): Response {
  const headers = new Headers();
  setCorsHeaders(headers, request);
  return new Response(null, { headers, status: 204 });
}

function notFoundResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "public, max-age=60" },
  });
}

function defaultRobotsResponse(request: Request): Response {
  return new Response(request.method === "HEAD" ? null : DEFAULT_ROBOTS_TXT, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function pointerNamespace(layout: StorageLayout): string {
  // Legacy pointers keep their original keys. Current pointers use a separate
  // namespace so the legacy host never discovers current content.
  return layout === "current"
    ? `sites/brands/${LAYOUT_SEGMENT.current}`
    : "sites";
}

function activePointerKey(layout: StorageLayout, publicSlug: string): string {
  return `${pointerNamespace(layout)}/${publicSlug}/active.json`;
}

function immutableDeploymentPointerKey(
  layout: StorageLayout,
  deploymentId: string,
): string {
  return `${pointerNamespace(layout)}/deployments/${deploymentId}.json`;
}

function siteSlugFromHost(hostname: string, hostDomain: string): string | null {
  const suffix = `.${hostDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) {
    return null;
  }
  const slug = hostname.slice(0, -suffix.length);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(slug)) {
    return null;
  }
  return slug;
}

interface HostedSiteRequestTarget {
  readonly publicSlug: string;
  readonly layouts: readonly StorageLayout[];
}

function hostedSiteRequestTarget(
  hostname: string,
  env: Env,
): HostedSiteRequestTarget | null {
  const normalizedHostname = hostname.toLowerCase();
  const candidates = [
    { layout: "legacy", hostDomain: env.HOST_DOMAIN },
    { layout: "current", hostDomain: env.OKOU_HOST_DOMAIN },
  ] as const;
  const matches = candidates.flatMap(({ layout, hostDomain }) => {
    const publicSlug = siteSlugFromHost(normalizedHostname, hostDomain);
    return publicSlug ? [{ layout, publicSlug }] : [];
  });
  const publicSlug = matches[0]?.publicSlug;
  if (
    !publicSlug ||
    matches.some((match) => {
      return match.publicSlug !== publicSlug;
    })
  ) {
    return null;
  }
  return {
    publicSlug,
    layouts: matches.map((match) => {
      return match.layout;
    }),
  };
}

function storedInLayout(
  value: ActiveSitePointer | HostedSiteManifest,
  layout: StorageLayout,
): boolean {
  // Persisted hosted-site R2 pointers and manifests have no drain window.
  // Objects without a layout segment belong to the legacy layout permanently;
  // see the retained-object decision in #28449.
  return (
    (value.publicBrand ?? LAYOUT_SEGMENT.legacy) === LAYOUT_SEGMENT[layout]
  );
}

interface ResolvedPointer {
  readonly layout: StorageLayout;
  readonly pointer: ActiveSitePointer;
}

async function resolvePointerInLayout(
  bucket: R2Bucket,
  layout: StorageLayout,
  publicSlug: string,
  deploymentId: string | undefined,
  registered = false,
): Promise<ResolvedPointer | null> {
  let pointer = deploymentId
    ? await readJson<ActiveSitePointer>(
        bucket,
        immutableDeploymentPointerKey(layout, deploymentId),
      )
    : null;
  if (
    pointer &&
    (pointer.deploymentId !== deploymentId || !storedInLayout(pointer, layout))
  ) {
    return null;
  }
  if (!pointer && deploymentId && registered) return null;
  if (!pointer) {
    pointer = await readJson<ActiveSitePointer>(
      bucket,
      activePointerKey(layout, publicSlug),
    );
    if (
      !pointer ||
      pointer.publicSlug !== publicSlug ||
      !storedInLayout(pointer, layout)
    ) {
      return null;
    }
  }
  return { layout, pointer };
}

function safeDecodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function normalizeRequestPath(pathname: string): string | null {
  const decoded = safeDecodePath(pathname);
  if (!decoded || !decoded.startsWith("/") || decoded.includes("\0")) {
    return null;
  }
  if (decoded.includes("\\") || decoded.startsWith("//")) {
    return null;
  }
  const parts = decoded.split("/").filter(Boolean);
  if (
    parts.some((part) => {
      return part === "." || part === "..";
    })
  ) {
    return null;
  }
  return `/${parts.join("/")}`;
}

function looksLikeAssetPath(path: string): boolean {
  return /\.[A-Za-z0-9]+$/u.test(path) || path.startsWith("/assets/");
}

function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") || accept.includes("*/*");
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) {
    return null;
  }
  const text = await new Response(object.body).text();
  return JSON.parse(text) as T;
}

function resolveFilePath(
  request: Request,
  pathname: string,
  pointer: Pick<ActiveSitePointer, "spaFallback">,
  manifest: HostedSiteManifest,
): string | null {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  if (manifest.files[requestedPath]) {
    return requestedPath;
  }
  if (
    pointer.spaFallback &&
    acceptsHtml(request) &&
    !looksLikeAssetPath(requestedPath) &&
    manifest.files["/index.html"]
  ) {
    return "/index.html";
  }
  return null;
}

function cacheControl(file: ManifestFile): string {
  // A redeploy replaces the documents behind one address while every other
  // published path keeps its original bytes. Never reuse stored markup.
  if (isHtmlManifestFile(file)) {
    return "no-store";
  }
  if (file.immutable) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

async function serveHostedSite(
  request: Request,
  env: Env,
  execution: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.pathname === PRIVATE_VIDEO_POSTER_PATH &&
    [env.HOST_DOMAIN, env.OKOU_HOST_DOMAIN].some((domain) => {
      return url.hostname === `files.${domain}`;
    })
  ) {
    return servePrivateVideoPoster(
      request,
      env.PRIVATE_ARTIFACTS_BUCKET,
      env.MEDIA,
    );
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS" },
    });
  }

  const pathname = normalizeRequestPath(url.pathname);
  if (!pathname) return new Response("Bad path", { status: 400 });
  const fileHost = url.hostname === env.PUBLIC_ARTIFACT_HOST;
  const target = hostedSiteRequestTarget(url.hostname, env);
  if (!fileHost && !target) return notFoundResponse();
  // Previously emitted share links survive the URL change. Keep this reader
  // until #32492 verifies that no retained pre-registry share links need it.
  const shared = target
    ? /^sh-([a-f0-9]{32})-([a-f0-9]{24})$/u.exec(target.publicSlug)
    : null;
  if (shared?.[1] && shared[2]) {
    const hash = shared[1];
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
    const artifact = await readPublicShare(env, target!.layouts, id, shared[2]);
    if (artifact instanceof Response) return artifact;
    if (artifact)
      return serveAuthorizedArtifact(
        request,
        env,
        pathname,
        artifact,
        execution,
      );
  }
  const previewToken =
    !fileHost && target
      ? /^p[vs]-([a-f0-9]{48})$/u.exec(target.publicSlug)?.[1]
      : undefined;
  if (previewToken && target) {
    const preview = await servePrivatePreview(
      request,
      env,
      target,
      pathname,
      previewToken,
    );
    if (preview) {
      return preview;
    }
  }

  return serveArtifactDelivery(
    request,
    env,
    pathname,
    target,
    fileHost,
    execution,
  );
}

/** File aliases are immutable; HTML aliases can move from snapshots to site pointers. */
async function readDeliveryRecord(
  request: Request,
  bucket: R2Bucket,
  key: string,
  targetKind: "file" | "html",
  execution: ExecutionContext,
): Promise<ArtifactDeliveryRecord | null> {
  // Never consult old HTML registry entries: a warm pre-migration cache must
  // not keep a named site bound to its former snapshot for another day.
  const cache =
    targetKind === "file" ? await caches.open("artifact-delivery-v1") : null;
  const cacheKey = new Request(
    new URL(`/__artifact-delivery/${encodeURIComponent(key)}`, request.url),
  );
  const cached = await cache?.match(cacheKey);
  if (cached) {
    const record = artifactDeliveryRecordSchema.parse(await cached.json());
    // Publication and thread records recheck their policy before content.
    // Legacy files have no policy, so their registry key is the revocation
    // authority. A warm alias must not reach the one-year content cache after
    // erasure has removed that key.
    if (record.kind === "legacy-file" && !(await bucket.head(key))) {
      return null;
    }
    return record;
  }
  const object = await bucket.get(key);
  if (!object) return null;
  const record = artifactDeliveryRecordSchema.parse(
    await new Response(object.body).json(),
  );
  if (cache) {
    execution.waitUntil(
      cache.put(
        cacheKey,
        new Response(JSON.stringify(record), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=86400",
          },
        }),
      ),
    );
  }
  return record;
}

function artifactFileAlias(
  pathname: string,
  hostname: string | undefined,
): string {
  // The live a.okou.io rewrite adds /artifacts before Workers run. Keep old
  // links available while routing moves to this Worker; #32492 can remove this
  // normalization once that Cloudflare rule is disabled and rollback excludes it.
  const prefix = "/artifacts/";
  if (hostname === "a.okou.io" && pathname.startsWith(prefix))
    return pathname.slice(prefix.length);
  return pathname.slice(1);
}

async function serveGrantedArtifactDelivery(
  request: Request,
  env: Env,
  delivery: {
    readonly record: Extract<
      ArtifactDeliveryRecord,
      { kind: "publication" | "thread-resource" }
    >;
    readonly pathname: string;
    readonly fileHost: boolean;
  },
  execution: ExecutionContext,
): Promise<Response> {
  const { record, pathname, fileHost } = delivery;
  if ((record.targetKind === "file") !== fileHost)
    return privateResponse(notFoundResponse());
  // The legacy one-year cache rule excludes only canonical share paths.
  // Decoding or trimming a different path must not expose share bytes there.
  if (
    fileHost &&
    !isArtifactDeliveryFilePath(
      `/${artifactFileAlias(new URL(request.url).pathname, env.PUBLIC_ARTIFACT_HOST)}`,
    )
  )
    return privateResponse(notFoundResponse());
  const artifact =
    record.kind === "thread-resource"
      ? await readSharedThreadResource(env, record)
      : await readPublicShare(
          env,
          [layoutOfSegment(record.publicBrand)],
          record.shareId,
          record.publicToken,
        );
  if (artifact instanceof Response) return artifact;
  if (!artifact || artifact.target.kind !== record.targetKind)
    return privateResponse(notFoundResponse());
  const response = await serveAuthorizedArtifact(
    request,
    env,
    fileHost ? "/" : pathname,
    artifact,
    execution,
  );
  if (
    record.kind === "thread-resource" &&
    response.ok &&
    !response.headers.get("Content-Type")?.toLowerCase().startsWith("text/html")
  )
    response.headers.set(
      "Cache-Control",
      "private, max-age=31536000, immutable",
    );
  return response;
}

async function serveArtifactDelivery(
  request: Request,
  env: Env,
  pathname: string,
  target: HostedSiteRequestTarget | null,
  fileHost: boolean,
  execution: ExecutionContext,
): Promise<Response> {
  // One file hostname serves every layout, so file aliases share a namespace.
  const layouts = fileHost ? [null] : target!.layouts;
  const alias = fileHost
    ? artifactFileAlias(pathname, env.PUBLIC_ARTIFACT_HOST)
    : target!.publicSlug;
  const records = await Promise.all(
    layouts.map(async (layout) => {
      const record = await readDeliveryRecord(
        request,
        env.HOSTED_SITES_BUCKET,
        artifactDeliveryKey(
          layout && LAYOUT_SEGMENT[layout],
          fileHost ? "file" : "html",
          alias,
        ),
        fileHost ? "file" : "html",
        execution,
      );
      if (!record) return null;
      if (layout !== null && layoutOfSegment(record.publicBrand) !== layout)
        throw new Error("Artifact delivery layout mismatch");
      return record;
    }),
  );
  const registered = records.filter(
    (record): record is ArtifactDeliveryRecord => {
      return record !== null;
    },
  );
  if (registered.length > 1) return privateResponse(notFoundResponse());
  const record = registered[0];
  if (record?.kind === "publication" || record?.kind === "thread-resource") {
    return await serveGrantedArtifactDelivery(
      request,
      env,
      { record, pathname, fileHost },
      execution,
    );
  }
  if (fileHost) {
    if (record?.kind !== "legacy-file" || !env.PUBLIC_ARTIFACTS_BUCKET)
      return privateResponse(notFoundResponse());
    return serveLegacyArtifactFile(
      request,
      env,
      env.PUBLIC_ARTIFACTS_BUCKET,
      record,
      execution,
    );
  }
  if (!target) return notFoundResponse();
  if (record && record.kind !== "legacy-site")
    return privateResponse(notFoundResponse());

  return serveLegacyHostedSite(request, env, pathname, target, record);
}

async function serveLegacyArtifactFile(
  request: Request,
  env: Env,
  bucket: R2Bucket,
  file: Extract<ArtifactDeliveryRecord, { kind: "legacy-file" }>,
  execution: ExecutionContext,
): Promise<Response> {
  if (new URL(request.url).searchParams.has("thumbnail")) {
    const response = await serveArtifactThumbnail(request, {
      sourceKey: `public:${file.key}`,
      images: env.IMAGES,
      readSource: () => {
        return serveArtifactFile(new Request(request.url), bucket, file);
      },
      waitUntil: (promise) => {
        return execution.waitUntil(promise);
      },
    });
    if (!response.ok) return privateResponse(response);
    response.headers.set("Cache-Control", PRIVATE_NO_STORE_CACHE_CONTROL);
    return response;
  }
  const cache = (caches as CacheStorage & { readonly default: Cache }).default;
  const key = new Request(request.url);
  const ranged = request.headers.has("Range");
  const cached = ranged ? undefined : await cache.match(key);
  if (cached)
    return new Response(request.method === "HEAD" ? null : cached.body, cached);

  const response = await serveArtifactFile(request, bucket, file);
  if (!response.ok) return privateResponse(response);
  response.headers.set("Cache-Control", PRIVATE_NO_STORE_CACHE_CONTROL);
  if (request.method === "GET" && response.status === 200 && !ranged)
    execution.waitUntil(cache.put(key, response.clone()));
  return response;
}

async function registrationComplete(
  bucket: R2Bucket,
  layout: StorageLayout,
): Promise<boolean> {
  const object = await bucket.get(
    artifactDeliveryRegistrationKey(LAYOUT_SEGMENT[layout]),
  );
  if (!object) return false;
  const marker: unknown = await new Response(object.body).json();
  if (
    !marker ||
    typeof marker !== "object" ||
    !("version" in marker) ||
    marker.version !== 1 ||
    !("complete" in marker) ||
    marker.complete !== true
  ) {
    throw new Error("Invalid artifact registration marker");
  }
  return true;
}

async function serveLegacyHostedSite(
  request: Request,
  env: Env,
  pathname: string,
  target: HostedSiteRequestTarget,
  record: Extract<ArtifactDeliveryRecord, { kind: "legacy-site" }> | undefined,
): Promise<Response> {
  const deploymentId = IMMUTABLE_DEPLOYMENT_HOST_PATTERN.exec(
    target.publicSlug,
  )?.[1];
  let pointerLayouts = target.layouts;
  if (!record) {
    // Existing public aliases predate the delivery registry. Remove this
    // compatibility read after #32492 verifies registration for every layout
    // and old API writers have drained; the completion marker closes it now.
    const completed = await Promise.all(
      target.layouts.map((layout) => {
        return registrationComplete(env.HOSTED_SITES_BUCKET, layout);
      }),
    );
    pointerLayouts = target.layouts.filter((_, index) => {
      return !completed[index];
    });
    if (pointerLayouts.length === 0) return privateResponse(notFoundResponse());
  }
  const pointers = (
    await Promise.all(
      pointerLayouts.map((layout) => {
        if (record?.kind === "legacy-site") {
          if (layoutOfSegment(record.publicBrand) !== layout)
            return Promise.resolve(null);
          const expectedKey = deploymentId
            ? immutableDeploymentPointerKey(layout, deploymentId)
            : activePointerKey(layout, target.publicSlug);
          if (record.pointerKey !== expectedKey)
            throw new Error("Legacy artifact pointer mismatch");
        }
        return resolvePointerInLayout(
          env.HOSTED_SITES_BUCKET,
          layout,
          target.publicSlug,
          deploymentId,
          record?.kind === "legacy-site",
        );
      }),
    )
  ).filter((pointer): pointer is ResolvedPointer => {
    return pointer !== null;
  });
  if (pointers.length !== 1) {
    return notFoundResponse();
  }
  const { pointer, layout } = pointers[0]!;
  const manifest = await readJson<HostedSiteManifest>(
    env.HOSTED_SITES_BUCKET,
    pointer.manifestKey,
  );
  if (
    !manifest ||
    manifest.access !== undefined ||
    manifest.version !== 1 ||
    pointer.version !== 1 ||
    !pointer.prefix.startsWith("sites/") ||
    manifest.deploymentId !== pointer.deploymentId ||
    manifest.siteId !== pointer.siteId ||
    !storedInLayout(manifest, layout)
  ) {
    return notFoundResponse();
  }

  return serveManifestFile(request, env, pathname, pointer, manifest);
}

async function serveManifestFile(
  request: Request,
  env: Env,
  pathname: string,
  pointer: Pick<ActiveSitePointer, "prefix" | "spaFallback">,
  manifest: HostedSiteManifest,
): Promise<Response> {
  if (pathname === "/robots.txt" && !manifest.files["/robots.txt"]) {
    return defaultRobotsResponse(request);
  }

  const filePath = resolveFilePath(request, pathname, pointer, manifest);
  if (!filePath) {
    return notFoundResponse();
  }

  const file = manifest.files[filePath];
  if (!file) {
    return notFoundResponse();
  }

  const object = await env.HOSTED_SITES_BUCKET.get(
    `${pointer.prefix}${filePath}`,
  );
  if (!object) {
    return notFoundResponse();
  }

  const headers = new Headers();
  // Upload checksums bind bytes, but not arbitrary object metadata such as
  // Content-Encoding. Immutable delivery uses server-owned manifest headers.
  if (!manifest.immutableContent) {
    object.writeHttpMetadata(headers);
  }
  headers.set("Content-Type", file.contentType);
  headers.set("Cache-Control", cacheControl(file));
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers,
  });
}

async function artifactFileRange(
  request: Request,
  bucket: R2Bucket,
  key: string,
): Promise<{ offset: number; length: number } | Response | undefined> {
  let range: { offset: number; length: number } | undefined;
  const requested =
    request.method === "GET" ? request.headers.get("Range") : null;
  if (requested) {
    const head = await bucket.head(key);
    if (!head) return notFoundResponse();
    const ifRange = request.headers.get("If-Range");
    const match = /^bytes=(\d*)-(\d*)$/u.exec(requested);
    // HTTP permits ignoring malformed/multipart ranges and stale If-Range.
    if (match && (!ifRange || ifRange === head.httpEtag)) {
      const start = match[1]
        ? Number(match[1])
        : Math.max(0, head.size - Number(match[2]));
      const end =
        match[1] && match[2]
          ? Math.min(Number(match[2]), head.size - 1)
          : head.size - 1;
      if (
        (!match[1] && !match[2]) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= head.size
      ) {
        return new Response(null, {
          status: 416,
          headers: {
            "Content-Range": `bytes */${head.size}`,
            "Accept-Ranges": "bytes",
          },
        });
      }
      range = { offset: start, length: end - start + 1 };
    }
  }
  return range;
}

async function serveArtifactFile(
  request: Request,
  bucket: R2Bucket,
  file: {
    readonly key: string;
    readonly filename: string;
    readonly contentType: string;
  },
): Promise<Response> {
  const range = await artifactFileRange(request, bucket, file.key);
  if (range instanceof Response) return range;
  const object = await bucket.get(file.key, range ? { range } : undefined);
  if (!object) return notFoundResponse();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", file.contentType);
  headers.set("Content-Length", String(range?.length ?? object.size));
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  if (range)
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    );
  if (/html|svg|xml/iu.test(file.contentType))
    headers.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: range ? 206 : 200,
    headers,
  });
}

interface PrivatePreviewGrant {
  readonly snapshotId?: string;
  // Legacy credentials stay uncached until #35240 seals old content and old
  // writers/grants leave serving. Uploadable manifests cannot assert this.
  readonly immutableContent?: true;
  readonly version: 1;
  /** Stored layout segment; must match the layout the grant was read from. */
  readonly publicBrand: LayoutSegment;
  readonly deploymentId: string;
  readonly expiresAt: string;
}

function privateResponse(
  response: Response,
  immutableContent = false,
): Response {
  const headers = new Headers(response.headers);
  // HTML documents follow their site's newest publication under one address,
  // so they are always fetched even behind a long-lived credential.
  const html = response.headers
    .get("Content-Type")
    ?.toLowerCase()
    .startsWith("text/html");
  headers.set(
    "Cache-Control",
    immutableContent && response.ok && !html
      ? PRIVATE_ARTIFACT_CACHE_CONTROL
      : PRIVATE_NO_STORE_CACHE_CONTROL,
  );
  // Let this isolated origin identify its own CSS/JS/image requests to the
  // hosted-site WAF. Cross-origin requests must not disclose preview tokens.
  headers.set("Referrer-Policy", "same-origin");
  // Generated code receives only its own short-lived origin, never app cookies.
  // Prevent service workers from bypassing the network authorization expiry.
  headers.set(
    "Content-Security-Policy",
    "sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-downloads; worker-src 'none'",
  );
  return new Response(response.body, { status: response.status, headers });
}

function privatePreviewPrefix(
  deploymentId: string,
  snapshotId: string | undefined,
  layout: StorageLayout,
  shared: boolean,
): string | null {
  if (!shared)
    return snapshotId === undefined
      ? `private-sites/${LAYOUT_SEGMENT[layout]}/${deploymentId}`
      : null;
  if (
    !snapshotId ||
    !IMMUTABLE_DEPLOYMENT_HOST_PATTERN.test(`dpl-${snapshotId}`)
  )
    return null;
  return `shared-artifacts/${LAYOUT_SEGMENT[layout]}/${snapshotId}/${deploymentId}`;
}

async function servePrivatePreview(
  request: Request,
  env: Env,
  target: HostedSiteRequestTarget,
  pathname: string,
  token: string,
): Promise<Response | null> {
  const shared = target.publicSlug.startsWith("ps-");
  const grants = (
    await Promise.all(
      target.layouts.map(async (layout) => {
        const object = await env.HOSTED_SITES_BUCKET.get(
          `${shared ? "shared-previews" : "private-previews"}/${LAYOUT_SEGMENT[layout]}/${token}.json`,
        );
        if (!object) {
          return null;
        }
        const text = await new Response(object.body).text();
        let grant: Partial<PrivatePreviewGrant> | null;
        try {
          grant = JSON.parse(text) as Partial<PrivatePreviewGrant> | null;
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
          grant = null;
        }
        return { grant, layout };
      }),
    )
  ).filter((entry) => {
    return entry !== null;
  });
  // Keep any historical public alias with this shape reachable. No private
  // manifest is ever served by the legacy public-pointer path below.
  if (grants.length === 0) {
    return null;
  }
  const entry = grants[0];
  if (grants.length !== 1 || !entry) {
    return privateResponse(notFoundResponse());
  }
  const { grant, layout } = entry;
  if (
    !grant ||
    typeof grant !== "object" ||
    typeof grant.expiresAt !== "string"
  ) {
    return privateResponse(notFoundResponse());
  }
  const expiresAt = Date.parse(grant.expiresAt);
  if (
    grant.version !== 1 ||
    grant.publicBrand !== LAYOUT_SEGMENT[layout] ||
    typeof grant.deploymentId !== "string" ||
    !IMMUTABLE_DEPLOYMENT_HOST_PATTERN.test(`dpl-${grant.deploymentId}`) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    return privateResponse(notFoundResponse());
  }
  const prefix = privatePreviewPrefix(
    grant.deploymentId,
    grant.snapshotId,
    layout,
    shared,
  );
  if (!prefix) return privateResponse(notFoundResponse());
  const manifest = await readJson<HostedSiteManifest>(
    env.HOSTED_SITES_BUCKET,
    `${prefix}/manifest.json`,
  );
  if (
    !manifest ||
    manifest.access !== "owner-private-v1" ||
    manifest.deploymentId !== grant.deploymentId ||
    manifest.publicBrand !== LAYOUT_SEGMENT[layout]
  ) {
    return privateResponse(notFoundResponse());
  }
  // Authorize every network request before reading content. Browser caching
  // matches files only when the bytes cannot change under this credential.
  const response = await serveManifestFile(
    request,
    env,
    pathname,
    { prefix, spaFallback: manifest.spaFallback },
    manifest,
  );
  if (expiresAt <= Date.now()) {
    return privateResponse(notFoundResponse());
  }
  return privateResponse(response, shared || grant.immutableContent === true);
}

/** An authorized artifact target and the storage layout of its content. */
interface AuthorizedArtifact {
  readonly layout: StorageLayout;
  readonly target: ArtifactSharePolicy["target"];
}

async function readPublicShare(
  env: Env,
  layouts: readonly StorageLayout[],
  id: string,
  token: string,
): Promise<AuthorizedArtifact | Response | null> {
  const denied = () => {
    return privateResponse(notFoundResponse());
  };
  const records: (ArtifactSharePolicy & { readonly layout: StorageLayout })[] =
    [];
  try {
    for (const layout of layouts) {
      const object = await env.HOSTED_SITES_BUCKET.get(
        `artifact-shares/${LAYOUT_SEGMENT[layout]}/${id}.json`,
      );
      if (!object) continue;
      const parsed = artifactSharePolicySchema.safeParse(
        await new Response(object.body).json(),
      );
      if (
        !parsed.success ||
        parsed.data.shareId !== id ||
        parsed.data.publicBrand !== LAYOUT_SEGMENT[layout]
      )
        return denied();
      records.push({ ...parsed.data, layout });
    }
  } catch {
    // Unavailable authorization state never falls through to cached bytes.
    return new Response("Artifact unavailable", {
      status: 503,
      headers: { "Cache-Control": PRIVATE_NO_STORE_CACHE_CONTROL },
    });
  }
  if (records.length === 0) return null;
  const policy = records[0];
  if (
    records.length !== 1 ||
    !policy ||
    policy.status !== "active" ||
    policy.audience !== "public" ||
    policy.publicToken !== token
  )
    return denied();
  return { layout: policy.layout, target: policy.target };
}

/** Callers must read current authorization before every content-cache hit. */
async function readSharedThreadResource(
  env: Env,
  record: Extract<ArtifactDeliveryRecord, { kind: "thread-resource" }>,
): Promise<AuthorizedArtifact | null> {
  const object = await env.HOSTED_SITES_BUCKET.get(
    sharedThreadArtifactPolicyKey(record.publicBrand, record.threadId),
  );
  if (!object) return null;
  const parsed = sharedThreadArtifactPolicySchema.safeParse(
    await new Response(object.body).json(),
  );
  if (
    !parsed.success ||
    parsed.data.threadId !== record.threadId ||
    parsed.data.publicBrand !== record.publicBrand ||
    parsed.data.status !== "active"
  )
    return null;
  const target = parsed.data.resources[record.publicToken];
  return target?.kind === record.targetKind &&
    (record.targetId === undefined || target.id === record.targetId)
    ? { layout: layoutOfSegment(record.publicBrand), target }
    : null;
}

/** Authorization is evaluated before reading these immutable cached bytes. */
async function serveAuthorizedArtifact(
  request: Request,
  env: Env,
  pathname: string,
  artifact: AuthorizedArtifact,
  execution: ExecutionContext,
): Promise<Response> {
  const denied = () => {
    return privateResponse(notFoundResponse());
  };
  const { target } = artifact;
  const segment = LAYOUT_SEGMENT[artifact.layout];
  // Image Resizing caches derivatives outside this Worker's policy checks.
  // Public files must re-enter authorization even when their bytes are warm.
  if (
    target.kind === "file" &&
    (pathname !== "/" || request.headers.get("Via")?.includes("image-resizing"))
  )
    return denied();
  if (
    target.kind === "file" &&
    new URL(request.url).searchParams.has("thumbnail")
  ) {
    const bucket = env.PRIVATE_ARTIFACTS_BUCKET;
    if (!bucket) return denied();
    return privateResponse(
      await serveArtifactThumbnail(request, {
        sourceKey: `private:${target.key}`,
        images: env.IMAGES,
        readSource: () => {
          return serveArtifactFile(new Request(request.url), bucket, target);
        },
        waitUntil: (promise) => {
          return execution.waitUntil(promise);
        },
      }),
    );
  }
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = `/__artifact-content/${segment}/${target.kind === "html" ? `${target.snapshotId}/${target.id}` : encodeURIComponent(target.key)}${pathname}`;
  cacheUrl.search = `?html=${acceptsHtml(request)}`;
  const key = new Request(cacheUrl);
  // Cache bytes separately from authorization. Delivery applies its browser
  // cache policy after this lookup; every network request checks the grant.
  const cache = (caches as CacheStorage & { readonly default: Cache }).default;
  const rangedFile = target.kind === "file" && request.headers.has("Range");
  const cached = rangedFile ? undefined : await cache.match(key);
  if (cached)
    return privateResponse(
      new Response(request.method === "HEAD" ? null : cached.body, cached),
    );
  let response: Response;
  if (target.kind === "html") {
    response = await serveManifestFile(
      request,
      env,
      pathname,
      {
        prefix: `shared-artifacts/${segment}/${target.snapshotId}/${target.id}`,
        spaFallback: target.manifest.spaFallback,
      },
      target.manifest,
    );
  } else {
    if (!env.PRIVATE_ARTIFACTS_BUCKET) return denied();
    response = await serveArtifactFile(
      request,
      env.PRIVATE_ARTIFACTS_BUCKET,
      target,
    );
  }
  if (request.method === "GET" && response.status === 200 && !rangedFile) {
    const stored = response.clone();
    stored.headers.set("Cache-Control", "public, max-age=86400");
    execution.waitUntil(cache.put(key, stored));
  }
  return privateResponse(response);
}

export default {
  fetch(
    request: Request,
    env: Env,
    execution: ExecutionContext,
  ): Promise<Response> {
    if (request.method === "OPTIONS") {
      return Promise.resolve(optionsResponse(request));
    }
    return serveHostedSite(request, env, execution)
      .catch(() => {
        // A registry/policy/storage failure is unavailable, never anonymous access.
        return new Response("Artifact unavailable", {
          status: 503,
          headers: { "Cache-Control": PRIVATE_NO_STORE_CACHE_CONTROL },
        });
      })
      .then((response) => {
        return corsResponse(response, request);
      });
  },
};
