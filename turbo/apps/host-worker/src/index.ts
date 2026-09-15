import {
  artifactDeliveryKey,
  artifactDeliveryRecordSchema,
  artifactDeliveryRegistrationKey,
  isArtifactDeliveryFilePath,
  type ArtifactDeliveryRecord,
} from "@okouai/api-contracts/contracts/artifact-delivery";
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

type PublicBrand = "vm0" | "okou";

interface ActiveSitePointer {
  readonly version: 1;
  readonly publicBrand?: PublicBrand;
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

interface HostedSiteManifest {
  readonly version: 1;
  readonly access?: "owner-private-v1";
  readonly publicBrand?: PublicBrand;
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

function pointerNamespace(publicBrand: PublicBrand): string {
  // Keep VM0 on its legacy keys. Okou uses a separate discovery namespace so
  // rolling back to a brand-unaware Worker cannot expose Okou content on VM0.
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
  readonly publicBrands: readonly PublicBrand[];
}

function hostedSiteRequestTarget(
  hostname: string,
  env: Env,
): HostedSiteRequestTarget | null {
  const normalizedHostname = hostname.toLowerCase();
  const candidates = [
    { publicBrand: "vm0", hostDomain: env.HOST_DOMAIN },
    { publicBrand: "okou", hostDomain: env.OKOU_HOST_DOMAIN },
  ] as const;
  const matches = candidates.flatMap(({ publicBrand, hostDomain }) => {
    const publicSlug = siteSlugFromHost(normalizedHostname, hostDomain);
    return publicSlug ? [{ publicBrand, publicSlug }] : [];
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
    publicBrands: matches.map((match) => {
      return match.publicBrand;
    }),
  };
}

function storedPublicBrand(
  value: ActiveSitePointer | HostedSiteManifest,
): PublicBrand {
  // Persisted hosted-site R2 pointers and manifests have no drain window.
  // Brandless objects retain their historical VM0 identity permanently;
  // see the retained-object decision in #28449.
  return value.publicBrand ?? "vm0";
}

interface ResolvedPointer {
  readonly publicBrand: PublicBrand;
  readonly pointer: ActiveSitePointer;
}

async function resolvePointerForBrand(
  bucket: R2Bucket,
  publicBrand: PublicBrand,
  publicSlug: string,
  deploymentId: string | undefined,
  registered = false,
): Promise<ResolvedPointer | null> {
  let pointer = deploymentId
    ? await readJson<ActiveSitePointer>(
        bucket,
        immutableDeploymentPointerKey(publicBrand, deploymentId),
      )
    : null;
  if (
    pointer &&
    (pointer.deploymentId !== deploymentId ||
      storedPublicBrand(pointer) !== publicBrand)
  ) {
    return null;
  }
  if (!pointer && deploymentId && registered) return null;
  if (!pointer) {
    pointer = await readJson<ActiveSitePointer>(
      bucket,
      activePointerKey(publicBrand, publicSlug),
    );
    if (
      !pointer ||
      pointer.publicSlug !== publicSlug ||
      storedPublicBrand(pointer) !== publicBrand
    ) {
      return null;
    }
  }
  return { publicBrand, pointer };
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
  if (file.immutable) {
    return "public, max-age=31536000, immutable";
  }
  if (file.path === "/index.html" || file.contentType.startsWith("text/html")) {
    return "public, max-age=0, must-revalidate";
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
    const policy = await readPublicShare(
      env,
      target!.publicBrands,
      id,
      shared[2],
    );
    if (policy instanceof Response) return policy;
    if (policy)
      return serveAuthorizedArtifact(request, env, pathname, policy, execution);
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

/** Alias ownership is immutable; permission state is read separately on every request. */
async function readDeliveryRecord(
  request: Request,
  bucket: R2Bucket,
  key: string,
  execution: ExecutionContext,
): Promise<ArtifactDeliveryRecord | null> {
  const cache = await caches.open("artifact-delivery-v1");
  const cacheKey = new Request(
    new URL(`/__artifact-delivery/${encodeURIComponent(key)}`, request.url),
  );
  const cached = await cache.match(cacheKey);
  if (cached) return artifactDeliveryRecordSchema.parse(await cached.json());
  const object = await bucket.get(key);
  if (!object) return null;
  const record = artifactDeliveryRecordSchema.parse(
    await new Response(object.body).json(),
  );
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
  const policy =
    record.kind === "thread-resource"
      ? await readSharedThreadResource(env, record)
      : await readPublicShare(
          env,
          [record.publicBrand],
          record.shareId,
          record.publicToken,
        );
  if (policy instanceof Response) return policy;
  if (!policy || policy.target.kind !== record.targetKind)
    return privateResponse(notFoundResponse());
  const response = await serveAuthorizedArtifact(
    request,
    env,
    fileHost ? "/" : pathname,
    policy,
    execution,
  );
  if (record.kind === "thread-resource" && response.ok)
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
  const brands = fileHost ? [null] : target!.publicBrands;
  const alias = fileHost
    ? artifactFileAlias(pathname, env.PUBLIC_ARTIFACT_HOST)
    : target!.publicSlug;
  const records = await Promise.all(
    brands.map(async (brand) => {
      const record = await readDeliveryRecord(
        request,
        env.HOSTED_SITES_BUCKET,
        artifactDeliveryKey(brand, fileHost ? "file" : "html", alias),
        execution,
      );
      if (!record) return null;
      if (brand !== null && record.publicBrand !== brand)
        throw new Error("Artifact delivery brand mismatch");
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
    response.headers.set(
      "Cache-Control",
      "public, max-age=31536000, immutable",
    );
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
  response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (request.method === "GET" && response.status === 200 && !ranged)
    execution.waitUntil(cache.put(key, response.clone()));
  return response;
}

async function registrationComplete(
  bucket: R2Bucket,
  brand: PublicBrand,
): Promise<boolean> {
  const object = await bucket.get(artifactDeliveryRegistrationKey(brand));
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
  let legacyBrands = target.publicBrands;
  if (!record) {
    // Existing public aliases predate the delivery registry. Remove this
    // compatibility read after #32492 verifies registration for every brand
    // and old API writers have drained; the completion marker closes it now.
    const completed = await Promise.all(
      target.publicBrands.map((brand) => {
        return registrationComplete(env.HOSTED_SITES_BUCKET, brand);
      }),
    );
    legacyBrands = target.publicBrands.filter((_, index) => {
      return !completed[index];
    });
    if (legacyBrands.length === 0) return privateResponse(notFoundResponse());
  }
  const pointers = (
    await Promise.all(
      legacyBrands.map((publicBrand) => {
        if (record?.kind === "legacy-site") {
          if (record.publicBrand !== publicBrand) return Promise.resolve(null);
          const expectedKey = deploymentId
            ? immutableDeploymentPointerKey(publicBrand, deploymentId)
            : activePointerKey(publicBrand, target.publicSlug);
          if (record.pointerKey !== expectedKey)
            throw new Error("Legacy artifact pointer mismatch");
        }
        return resolvePointerForBrand(
          env.HOSTED_SITES_BUCKET,
          publicBrand,
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
  const { pointer, publicBrand } = pointers[0]!;
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
    storedPublicBrand(manifest) !== publicBrand
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
  object.writeHttpMetadata(headers);
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
  readonly version: 1;
  readonly publicBrand: PublicBrand;
  readonly deploymentId: string;
  readonly expiresAt: string;
}

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
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
  publicBrand: PublicBrand,
  shared: boolean,
): string | null {
  if (!shared)
    return snapshotId === undefined
      ? `private-sites/${publicBrand}/${deploymentId}`
      : null;
  if (
    !snapshotId ||
    !IMMUTABLE_DEPLOYMENT_HOST_PATTERN.test(`dpl-${snapshotId}`)
  )
    return null;
  return `shared-artifacts/${publicBrand}/${snapshotId}/${deploymentId}`;
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
      target.publicBrands.map(async (publicBrand) => {
        const object = await env.HOSTED_SITES_BUCKET.get(
          `${shared ? "shared-previews" : "private-previews"}/${publicBrand}/${token}.json`,
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
        return { grant, publicBrand };
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
  const { grant, publicBrand } = entry;
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
    grant.publicBrand !== publicBrand ||
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
    publicBrand,
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
    manifest.publicBrand !== publicBrand
  ) {
    return privateResponse(notFoundResponse());
  }
  // Authorize every request before reading content; no shared content cache.
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
  return privateResponse(response);
}

async function readPublicShare(
  env: Env,
  brands: readonly PublicBrand[],
  id: string,
  token: string,
): Promise<ArtifactSharePolicy | Response | null> {
  const denied = () => {
    return privateResponse(notFoundResponse());
  };
  const records: ArtifactSharePolicy[] = [];
  try {
    for (const brand of brands) {
      const object = await env.HOSTED_SITES_BUCKET.get(
        `artifact-shares/${brand}/${id}.json`,
      );
      if (!object) continue;
      const parsed = artifactSharePolicySchema.safeParse(
        await new Response(object.body).json(),
      );
      if (
        !parsed.success ||
        parsed.data.shareId !== id ||
        parsed.data.publicBrand !== brand
      )
        return denied();
      records.push(parsed.data);
    }
  } catch {
    // Unavailable authorization state never falls through to cached bytes.
    return new Response("Artifact unavailable", {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
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
  return policy;
}

/** Callers must read current authorization before every content-cache hit. */
async function readSharedThreadResource(
  env: Env,
  record: Extract<ArtifactDeliveryRecord, { kind: "thread-resource" }>,
): Promise<Pick<ArtifactSharePolicy, "publicBrand" | "target"> | null> {
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
  return target?.kind === record.targetKind
    ? { publicBrand: record.publicBrand, target }
    : null;
}

/** Authorization is evaluated before reading these immutable cached bytes. */
async function serveAuthorizedArtifact(
  request: Request,
  env: Env,
  pathname: string,
  policy: Pick<ArtifactSharePolicy, "publicBrand" | "target">,
  execution: ExecutionContext,
): Promise<Response> {
  const denied = () => {
    return privateResponse(notFoundResponse());
  };
  const target = policy.target;
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
  cacheUrl.pathname = `/__artifact-content/${policy.publicBrand}/${target.kind === "html" ? `${target.snapshotId}/${target.id}` : encodeURIComponent(target.key)}${pathname}`;
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
        prefix: `shared-artifacts/${policy.publicBrand}/${target.snapshotId}/${target.id}`,
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
          headers: { "Cache-Control": "private, no-store" },
        });
      })
      .then((response) => {
        return corsResponse(response, request);
      });
  },
};
