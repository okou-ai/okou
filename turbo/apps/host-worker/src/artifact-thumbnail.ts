interface ThumbnailOptions {
  readonly width?: number;
  readonly height?: number;
  readonly fit: "cover" | "scale-down";
  readonly quality: number;
}

/** The Cloudflare Images binding consumes bytes without a public source URL. */
export interface ImagesBinding {
  input(body: ReadableStream): {
    transform(options: Omit<ThumbnailOptions, "quality">): {
      output(options: { format: "image/webp"; quality: number }): Promise<{
        response(): Response;
      }>;
    };
  };
}

const MAX_SOURCE_BYTES = 20_000_000;
const SUPPORTED_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/heic",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function thumbnailOptions(url: URL): ThumbnailOptions | null {
  const params = url.searchParams;
  for (const name of ["thumbnail", "width", "height", "fit", "quality"]) {
    if (params.getAll(name).length > 1) return null;
  }
  if (params.get("thumbnail") !== "1") return null;
  const width = params.has("width") ? Number(params.get("width")) : undefined;
  const height = params.has("height")
    ? Number(params.get("height"))
    : undefined;
  for (const dimension of [width, height]) {
    if (
      dimension !== undefined &&
      (!Number.isInteger(dimension) || dimension < 1 || dimension > 2048)
    )
      return null;
  }
  const fit = params.get("fit") ?? "scale-down";
  const quality = params.has("quality") ? Number(params.get("quality")) : 85;
  if (
    (fit !== "cover" && fit !== "scale-down") ||
    !Number.isInteger(quality) ||
    quality < 1 ||
    quality > 100
  )
    return null;
  return {
    width: width ?? (height === undefined ? 800 : undefined),
    height,
    fit,
    quality,
  };
}

/** Call only after current policy authorizes the request, including cache hits. */
export async function serveArtifactThumbnail(
  request: Request,
  args: {
    readonly sourceKey: string;
    readonly images: ImagesBinding | undefined;
    readonly readSource: () => Promise<Response>;
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
): Promise<Response> {
  const options = thumbnailOptions(new URL(request.url));
  if (!options)
    return new Response("Invalid thumbnail options", { status: 400 });
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = `/__artifact-thumbnail/v1/${encodeURIComponent(args.sourceKey)}`;
  cacheUrl.search = new URLSearchParams({
    options: JSON.stringify(options),
  }).toString();
  const key = new Request(cacheUrl);
  const cache = (caches as CacheStorage & { readonly default: Cache }).default;
  const cached = await cache.match(key);
  if (cached)
    return new Response(request.method === "HEAD" ? null : cached.body, cached);

  const source = await args.readSource();
  const type = source.headers
    .get("Content-Type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  // The binding has a 20 MB input limit and cannot rasterize SVG. Keep the
  // authorized original for these inputs; #32492 owns broader format support.
  if (
    !source.ok ||
    !source.body ||
    !type ||
    !SUPPORTED_TYPES.has(type) ||
    Number(source.headers.get("Content-Length")) > MAX_SOURCE_BYTES
  ) {
    return new Response(request.method === "HEAD" ? null : source.body, source);
  }
  if (!args.images)
    throw new Error("Artifact thumbnail Images binding is missing");
  const { quality, ...transform } = options;
  const output = await args.images
    .input(source.body)
    .transform(transform)
    .output({ format: "image/webp", quality });
  const response = output.response();
  const headers = new Headers({
    "Content-Type": "image/webp",
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  });
  const image = new Response(response.body, { headers });
  args.waitUntil(cache.put(key, image.clone()));
  return new Response(request.method === "HEAD" ? null : image.body, image);
}
