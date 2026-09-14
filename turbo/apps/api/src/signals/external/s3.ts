import { computed, type Computed } from "ccstate";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  ListPartsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
  SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT,
  type SessionHistoryDownloadSource,
} from "@okouai/api-contracts/contracts/runners";

import { env } from "../../lib/env";
import { detach, Mechanism, settle } from "../utils";
import {
  artifactDeliveryKey,
  artifactDeliveryRecordSchema,
} from "@okouai/api-contracts/contracts/artifact-delivery";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";

const PRIVATE_ARTIFACT_CACHE_CONTROL =
  "private, max-age=31536000, must-revalidate";
const PRIVATE_NO_STORE_CACHE_CONTROL = "private, no-store";
const S3_DELETE_OBJECTS_LIMIT = 1000;

export interface S3Object {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
}

interface LegacyArtifactWrite {
  readonly key: string;
  readonly contentType: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Reserve public delivery before bytes or upload credentials can escape. */
async function registerLegacyArtifactWrite(
  client: S3Client,
  bucket: string,
  write: LegacyArtifactWrite,
  signal?: AbortSignal,
): Promise<void> {
  if (
    write.metadata?.storage === "private-artifact-v1" ||
    write.metadata?.access === "owner-private-v1"
  ) {
    throw new Error(
      "Private artifacts cannot use public delivery registration",
    );
  }
  // Historical public writers without brand/filename metadata use the same
  // interpretation as migration 014; #32492 owns this persisted-data boundary.
  const record = artifactDeliveryRecordSchema.parse({
    version: 1,
    kind: "legacy-file",
    publicBrand: write.metadata?.["public-brand"] ?? "vm0",
    audience: "public",
    key: write.key,
    filename: decodeURIComponent(
      write.metadata?.filename ??
        write.key.slice(write.key.lastIndexOf("/") + 1),
    ),
    contentType: write.contentType,
  });
  const key = artifactDeliveryKey(
    null,
    "file",
    write.key.slice("artifacts/".length),
  );
  const body = JSON.stringify(record);
  const written = await settle(
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        IfNoneMatch: "*",
      }),
      { abortSignal: signal },
    ),
  );
  signal?.throwIfAborted();
  if (written.ok) {
    return;
  }
  if (!isS3PreconditionFailedError(written.error)) {
    throw written.error;
  }
  const existing = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { abortSignal: signal },
  );
  if (!existing.Body) {
    throw new Error("Public artifact registration has no body");
  }
  const previous = artifactDeliveryRecordSchema.parse(
    JSON.parse(await existing.Body.transformToString()),
  );
  if (JSON.stringify(previous) !== body) {
    throw new Error("Artifact delivery alias is already allocated");
  }
  signal?.throwIfAborted();
}

function publicArtifactWriteRegistration(
  bucket: string,
  write: LegacyArtifactWrite,
  signal?: AbortSignal,
): Computed<Promise<void>> {
  return computed(async (get) => {
    if (
      bucket !== env("R2_USER_ARTIFACTS_BUCKET_NAME") ||
      !write.key.startsWith("artifacts/")
    ) {
      return;
    }
    const registryBucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (!registryBucket) {
      throw new Error("Artifact delivery registry storage is not configured");
    }
    await registerLegacyArtifactWrite(
      get(hostedSitesS3Client$),
      registryBucket,
      write,
      signal,
    );
  });
}

interface S3ObjectPage {
  readonly objects: readonly S3Object[];
  readonly isTruncated: boolean;
}

interface S3FileEntry {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

export interface MultipartS3Part {
  readonly partNumber: number;
  readonly etag: string;
}

interface S3StorageManifest {
  readonly version: string;
  readonly createdAt: string;
  readonly totalSize: number;
  readonly fileCount: number;
  readonly files: readonly S3FileEntry[];
}

interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

interface DownloadS3BufferOptions {
  readonly maxBytes?: number;
  readonly onFailure?: (diagnostics: S3DownloadFailureDiagnostics) => void;
}

export interface S3DownloadFailureDiagnostics {
  readonly stage: "get_object" | "read_body";
  readonly stageDurationMs: number;
  readonly receivedBytes: number;
  readonly expectedBytes?: number;
  readonly providerStatus?: number;
  readonly providerRequestId?: string;
  readonly providerAttempts?: number;
  readonly providerRetryDelayMs?: number;
  readonly signalAborted: boolean;
}

export type ConditionalS3BufferDownload =
  | { readonly kind: "not-modified" }
  | {
      readonly kind: "downloaded";
      readonly buffer: Buffer;
      readonly etag: string | null;
    };

export class S3ObjectSizeLimitError extends Error {
  constructor(
    readonly key: string,
    readonly size: number,
    readonly maxBytes: number,
    readonly etag: string | null = null,
  ) {
    super(`S3 object is too large: ${size} bytes exceeds ${maxBytes} bytes`);
    this.name = "S3ObjectSizeLimitError";
  }
}

function createS3Client(
  endpoint: string,
  credentials: S3Credentials,
): S3Client {
  return new S3Client({
    region: env("S3_REGION") ?? "auto",
    endpoint,
    credentials,
    forcePathStyle: env("S3_FORCE_PATH_STYLE") === "true",
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
}

function defaultS3Endpoint(): string {
  return `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
}

function defaultS3Credentials(): S3Credentials {
  return {
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  };
}

export function publicS3DownloadSource(): SessionHistoryDownloadSource {
  // Mirror `generatePresignedGetUrl(..., usePublicEndpoint=true)` without exposing the endpoint.
  return env("S3_PUBLIC_ENDPOINT") || env("S3_ENDPOINT")
    ? SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT
    : SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT;
}

function userArtifactsS3Credentials(): S3Credentials {
  return {
    accessKeyId: env("R2_USER_ARTIFACTS_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_USER_ARTIFACTS_SECRET_ACCESS_KEY"),
  };
}

function hostedSitesS3Credentials(): S3Credentials {
  const accessKeyId = env("R2_HOSTED_SITES_ACCESS_KEY_ID");
  const secretAccessKey = env("R2_HOSTED_SITES_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_HOSTED_SITES_ACCESS_KEY_ID and R2_HOSTED_SITES_SECRET_ACCESS_KEY must be configured",
    );
  }
  return { accessKeyId, secretAccessKey };
}

const s3Client$ = computed((): S3Client => {
  return createS3Client(
    env("S3_ENDPOINT") ?? defaultS3Endpoint(),
    defaultS3Credentials(),
  );
});

const publicS3Client$ = computed((get): S3Client => {
  const publicEndpoint = env("S3_PUBLIC_ENDPOINT");
  if (!publicEndpoint) {
    return get(s3Client$);
  }
  return createS3Client(publicEndpoint, defaultS3Credentials());
});

const userArtifactsS3Client$ = computed((): S3Client => {
  return createS3Client(
    env("S3_ENDPOINT") ?? defaultS3Endpoint(),
    userArtifactsS3Credentials(),
  );
});

const userArtifactsPublicS3Client$ = computed((get): S3Client => {
  const publicEndpoint = env("S3_PUBLIC_ENDPOINT");
  if (!publicEndpoint) {
    return get(userArtifactsS3Client$);
  }
  return createS3Client(publicEndpoint, userArtifactsS3Credentials());
});

function privateArtifactsS3Credentials(): S3Credentials {
  const accessKeyId = env("R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID");
  const secretAccessKey = env("R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID and R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY must be configured",
    );
  }
  return { accessKeyId, secretAccessKey };
}

const privateArtifactsS3Client$ = computed((): S3Client => {
  return createS3Client(
    env("S3_ENDPOINT") ?? defaultS3Endpoint(),
    privateArtifactsS3Credentials(),
  );
});

const privateArtifactsPublicS3Client$ = computed((get): S3Client => {
  const publicEndpoint = env("S3_PUBLIC_ENDPOINT");
  return publicEndpoint
    ? createS3Client(publicEndpoint, privateArtifactsS3Credentials())
    : get(privateArtifactsS3Client$);
});

function s3ClientForBucket(
  bucket: string,
  usePublicEndpoint = false,
): Computed<S3Client> {
  if (bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME")) {
    return usePublicEndpoint
      ? privateArtifactsPublicS3Client$
      : privateArtifactsS3Client$;
  }
  if (bucket === env("R2_USER_ARTIFACTS_BUCKET_NAME")) {
    return usePublicEndpoint
      ? userArtifactsPublicS3Client$
      : userArtifactsS3Client$;
  }
  return usePublicEndpoint ? publicS3Client$ : s3Client$;
}

const hostedSitesS3Client$ = computed((): S3Client => {
  return createS3Client(
    env("S3_ENDPOINT") ?? defaultS3Endpoint(),
    hostedSitesS3Credentials(),
  );
});

const hostedSitesPublicS3Client$ = computed((get): S3Client => {
  const publicEndpoint = env("S3_PUBLIC_ENDPOINT");
  if (!publicEndpoint) {
    return get(hostedSitesS3Client$);
  }
  return createS3Client(publicEndpoint, hostedSitesS3Credentials());
});

export function listS3Objects(
  bucket: string,
  prefix: string,
): Computed<Promise<readonly S3Object[]>> {
  return computed(async (get): Promise<readonly S3Object[]> => {
    const client = get(s3ClientForBucket(bucket));
    const objects: S3Object[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const item of response.Contents ?? []) {
        if (item.Key && item.Size !== undefined && item.LastModified) {
          objects.push({
            key: item.Key,
            size: item.Size,
            lastModified: item.LastModified,
          });
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return objects;
  });
}

/**
 * One bounded, lexicographically ordered object page. Callers that perform
 * maintenance must supply their own durable or deterministic partitioning;
 * this helper never follows continuation tokens implicitly.
 */
export function listS3ObjectsPage(
  bucket: string,
  prefix: string,
  maxKeys: number,
): Computed<Promise<S3ObjectPage>> {
  if (!Number.isInteger(maxKeys) || maxKeys <= 0 || maxKeys > 1000) {
    throw new Error("S3 list page size must be an integer between 1 and 1000");
  }
  return computed(async (get): Promise<S3ObjectPage> => {
    const client = get(s3ClientForBucket(bucket));
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: maxKeys,
      }),
    );
    const objects = (response.Contents ?? []).flatMap((item) => {
      if (!item.Key || item.Size === undefined || !item.LastModified) {
        return [];
      }
      return [
        {
          key: item.Key,
          size: item.Size,
          lastModified: item.LastModified,
        },
      ];
    });
    return { objects, isTruncated: response.IsTruncated === true };
  });
}

export function listS3ObjectsUnderPrefix(
  bucket: string,
  prefix: string,
): Computed<Promise<readonly S3Object[]>> {
  const boundedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return listS3Objects(bucket, boundedPrefix);
}

export function deleteS3Objects(
  bucket: string,
  keys: readonly string[],
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    if (keys.length === 0) {
      return;
    }
    const client = get(s3ClientForBucket(bucket));
    // Stop at the first failed batch. Retrying already deleted keys is safe.
    for (
      let offset = 0;
      offset < keys.length;
      offset += S3_DELETE_OBJECTS_LIMIT
    ) {
      const response = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: keys
              .slice(offset, offset + S3_DELETE_OBJECTS_LIMIT)
              .map((Key) => {
                return { Key };
              }),
          },
        }),
      );
      if (response.Errors && response.Errors.length > 0) {
        throw new Error(
          `S3 object deletion failed for ${response.Errors.length.toString()} object(s)`,
        );
      }
    }
  });
}

export function downloadS3Buffer(
  bucket: string,
  key: string,
  options?:
    | AbortSignal
    | {
        readonly signal?: AbortSignal;
        readonly onFailure?: DownloadS3BufferOptions["onFailure"];
      },
): Computed<Promise<Buffer>> {
  const downloadOptions = isAbortSignal(options)
    ? { signal: options }
    : options;
  return downloadS3BufferWithClient(
    s3ClientForBucket(bucket),
    bucket,
    key,
    { onFailure: downloadOptions?.onFailure },
    downloadOptions?.signal,
  );
}

export function downloadS3BufferWithMaxBytes(
  bucket: string,
  key: string,
  maxBytes: number,
  signal?: AbortSignal,
): Computed<Promise<Buffer>> {
  return downloadS3BufferWithClient(
    s3ClientForBucket(bucket),
    bucket,
    key,
    {
      maxBytes,
    },
    signal,
  );
}

export function downloadS3BufferWithMaxBytesIfChanged(
  bucket: string,
  key: string,
  maxBytes: number,
  ifNoneMatch: string | null,
  signal?: AbortSignal,
): Computed<Promise<ConditionalS3BufferDownload>> {
  return computed(async (get): Promise<ConditionalS3BufferDownload> => {
    const client = get(s3ClientForBucket(bucket));
    const downloaded = await settle(
      client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          IfNoneMatch: ifNoneMatch ?? undefined,
        }),
        { abortSignal: signal },
      ),
    );
    if (!downloaded.ok) {
      if (isS3NotModifiedError(downloaded.error)) {
        return { kind: "not-modified" };
      }
      throw downloaded.error;
    }
    const response: GetObjectCommandOutput = downloaded.value;
    return {
      kind: "downloaded",
      buffer: await readS3ObjectBody(response, key, { maxBytes }, signal),
      etag: response.ETag ?? null,
    };
  });
}

function isAsyncIterableByteStream(
  value: unknown,
): value is AsyncIterable<Uint8Array> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const iterator = (value as { [Symbol.asyncIterator]?: unknown })[
    Symbol.asyncIterator
  ];
  return typeof iterator === "function";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const then = (value as { then?: unknown }).then;
  return typeof then === "function";
}

function isS3NotModifiedError(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("$metadata" in value)) {
    return false;
  }
  const metadata = value.$metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "httpStatusCode" in metadata &&
    metadata.httpStatusCode === 304
  );
}

function closeS3Body(body: unknown): void {
  if (!body || typeof body !== "object") {
    return;
  }

  const destroy = (body as { destroy?: () => void }).destroy;
  if (typeof destroy === "function") {
    destroy.call(body);
    return;
  }

  const cancel = (body as { cancel?: () => unknown }).cancel;
  if (typeof cancel === "function") {
    const result = cancel.call(body);
    if (isPromiseLike(result)) {
      detach(
        Promise.resolve(result),
        Mechanism.BestEffortCleanup,
        "s3 body cancel",
      );
    }
  }
}

function downloadS3BufferWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
  options: DownloadS3BufferOptions = {},
  signal?: AbortSignal,
): Computed<Promise<Buffer>> {
  return computed(async (get): Promise<Buffer> => {
    const client = get(client$);
    const startedAt = performance.now();
    const downloaded = await settle(
      client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: signal,
      }),
    );
    if (!downloaded.ok) {
      options.onFailure?.({
        stage: "get_object",
        stageDurationMs: Math.round(performance.now() - startedAt),
        receivedBytes: 0,
        signalAborted: signal?.aborted ?? false,
      });
      throw downloaded.error;
    }
    return await readS3ObjectBody(downloaded.value, key, options, signal);
  });
}

async function readS3ObjectBody(
  response: {
    readonly Body?: unknown;
    readonly ContentLength?: number;
    readonly ETag?: string;
    readonly $metadata?: GetObjectCommandOutput["$metadata"];
  },
  key: string,
  options: DownloadS3BufferOptions,
  signal?: AbortSignal,
): Promise<Buffer> {
  const startedAt = performance.now();
  let totalLength = 0;
  const downloaded = await settle(
    (async () => {
      if (!response.Body) {
        throw new Error("S3 object body is empty");
      }
      if (!isAsyncIterableByteStream(response.Body)) {
        closeS3Body(response.Body);
        throw new Error("S3 object body is not an async byte stream");
      }
      if (signal?.aborted) {
        closeS3Body(response.Body);
        signal.throwIfAborted();
      }
      if (
        options.maxBytes !== undefined &&
        response.ContentLength !== undefined &&
        response.ContentLength > options.maxBytes
      ) {
        closeS3Body(response.Body);
        throw new S3ObjectSizeLimitError(
          key,
          response.ContentLength,
          options.maxBytes,
          response.ETag ?? null,
        );
      }
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body) {
        if (signal?.aborted) {
          closeS3Body(response.Body);
          signal.throwIfAborted();
        }
        if (!(chunk instanceof Uint8Array)) {
          closeS3Body(response.Body);
          throw new Error("S3 object body yielded a non-byte chunk");
        }
        totalLength += chunk.length;
        if (options.maxBytes !== undefined && totalLength > options.maxBytes) {
          closeS3Body(response.Body);
          throw new S3ObjectSizeLimitError(
            key,
            totalLength,
            options.maxBytes,
            response.ETag ?? null,
          );
        }
        chunks.push(chunk);
      }
      return Buffer.concat(
        chunks.map((chunk) => {
          return Buffer.from(chunk);
        }),
        totalLength,
      );
    })(),
  );
  if (!downloaded.ok) {
    options.onFailure?.({
      stage: "read_body",
      stageDurationMs: Math.round(performance.now() - startedAt),
      receivedBytes: totalLength,
      expectedBytes: response.ContentLength,
      providerStatus: response.$metadata?.httpStatusCode,
      providerRequestId: response.$metadata?.requestId,
      providerAttempts: response.$metadata?.attempts,
      providerRetryDelayMs: response.$metadata?.totalRetryDelay,
      signalAborted: signal?.aborted ?? false,
    });
    throw downloaded.error;
  }
  return downloaded.value;
}

export function downloadHostedSitesS3Buffer(
  bucket: string,
  key: string,
): Computed<Promise<Buffer>> {
  return downloadS3BufferWithClient(hostedSitesS3Client$, bucket, key);
}

/**
 * Generate a presigned PUT URL so the browser/CLI can upload a file body
 * directly to R2. The body never passes through the api runtime, which
 * bypasses the Vercel ~4.5 MB body cap. Callers materialize the URL once
 * per upload; the signature is short-lived and not persistable.
 */
export function generatePresignedPutUrl(
  bucket: string,
  key: string,
  contentType: string,
  options: {
    readonly usePublicEndpoint?: boolean;
    readonly metadata?: Readonly<Record<string, string>>;
  },
  signal?: AbortSignal,
): Computed<Promise<string>> {
  return generatePresignedPutUrlWithClient(
    s3ClientForBucket(bucket, options.usePublicEndpoint ?? false),
    { bucket, key, contentType, ...options },
    signal,
  );
}

export function s3MetadataHeaders(
  metadata: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(metadata).map(([name, value]) => {
      return [`x-amz-meta-${name}`, value];
    }),
  );
}

export function createMultipartS3Upload(
  bucket: string,
  key: string,
  contentType: string,
  metadata?: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    const client = get(s3ClientForBucket(bucket));
    await get(
      publicArtifactWriteRegistration(
        bucket,
        { key, contentType, metadata },
        signal,
      ),
    );
    const response = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        Metadata: metadata,
      }),
      { abortSignal: signal },
    );
    if (!response.UploadId) {
      throw new Error("R2 did not return a multipart upload ID");
    }
    return response.UploadId;
  });
}

export function generatePresignedUploadPartUrl(
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
): Computed<Promise<string>> {
  return computed((get): Promise<string> => {
    const client = get(s3ClientForBucket(bucket, true));
    return getSignedUrl(
      client,
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: PRESIGNED_URL_TTL_SECONDS },
    );
  });
}

export function uploadMultipartS3Part(
  args: {
    readonly bucket: string;
    readonly key: string;
    readonly uploadId: string;
    readonly partNumber: number;
    readonly body: Uint8Array;
  },
  signal?: AbortSignal,
): Computed<Promise<MultipartS3Part>> {
  return computed(async (get): Promise<MultipartS3Part> => {
    const client = get(s3ClientForBucket(args.bucket));
    const result = await client.send(
      new UploadPartCommand({
        Bucket: args.bucket,
        Key: args.key,
        UploadId: args.uploadId,
        PartNumber: args.partNumber,
        Body: args.body,
      }),
      { abortSignal: signal },
    );
    if (!result.ETag) {
      throw new Error("R2 did not return a multipart part ETag");
    }
    return { partNumber: args.partNumber, etag: result.ETag };
  });
}

export function tryListMultipartS3Parts(
  bucket: string,
  key: string,
  uploadId: string,
): Computed<Promise<readonly MultipartS3Part[] | null>> {
  return computed(async (get): Promise<readonly MultipartS3Part[] | null> => {
    const client = get(s3ClientForBucket(bucket));
    const result = await settle(
      client.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MaxParts: 1000,
        }),
      ),
    );
    if (!result.ok) {
      if (isS3NotFoundError(result.error)) {
        return null;
      }
      throw result.error;
    }
    return (result.value.Parts ?? []).map((part) => {
      if (part.PartNumber === undefined || part.ETag === undefined) {
        throw new Error("R2 returned incomplete multipart part metadata");
      }
      return { partNumber: part.PartNumber, etag: part.ETag };
    });
  });
}

export function completeMultipartS3Upload(
  bucket: string,
  key: string,
  uploadId: string,
  parts: readonly MultipartS3Part[],
  signal?: AbortSignal,
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const client = get(s3ClientForBucket(bucket));
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => {
            return { ETag: part.etag, PartNumber: part.partNumber };
          }),
        },
      }),
      { abortSignal: signal },
    );
  });
}

export function abortMultipartS3Upload(
  bucket: string,
  key: string,
  uploadId: string,
  signal?: AbortSignal,
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const client = get(s3ClientForBucket(bucket));
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
      { abortSignal: signal },
    );
  });
}

function generatePresignedPutUrlWithClient(
  client$: Computed<S3Client>,
  options: {
    readonly bucket: string;
    readonly key: string;
    readonly contentType: string;
    readonly metadata?: Readonly<Record<string, string>>;
  },
  signal?: AbortSignal,
): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    const client = get(client$);
    const { bucket, key, contentType } = options;
    await get(
      publicArtifactWriteRegistration(
        bucket,
        { key, contentType, metadata: options.metadata },
        signal,
      ),
    );
    const metadataHeaders = options.metadata
      ? s3MetadataHeaders(options.metadata)
      : undefined;
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      Metadata: options.metadata,
    });
    return getSignedUrl(client, command, {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
      ...(metadataHeaders
        ? {
            unhoistableHeaders: new Set(Object.keys(metadataHeaders)),
          }
        : {}),
    });
  });
}

export function generateHostedSitesPresignedPutUrl(
  bucket: string,
  key: string,
  contentType: string,
  usePublicEndpoint = false,
): Computed<Promise<string>> {
  return generatePresignedPutUrlWithClient(
    usePublicEndpoint ? hostedSitesPublicS3Client$ : hostedSitesS3Client$,
    { bucket, key, contentType },
  );
}

export function generateHostedSitesPresignedGetUrl(
  bucket: string,
  key: string,
  usePublicEndpoint = false,
): Computed<Promise<string>> {
  return generatePresignedGetUrlWithClient(
    usePublicEndpoint ? hostedSitesPublicS3Client$ : hostedSitesS3Client$,
    bucket,
    key,
  );
}

export function generatePresignedGetUrl(
  bucket: string,
  key: string,
  filename?: string,
  usePublicEndpoint = false,
): Computed<Promise<string>> {
  return generatePresignedGetUrlWithClient(
    s3ClientForBucket(bucket, usePublicEndpoint),
    bucket,
    key,
    {
      filename,
      responseCacheControl:
        bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME")
          ? PRIVATE_ARTIFACT_CACHE_CONTROL
          : undefined,
    },
  );
}

/** Private inputs must not remain cached after their signed access expires. */
export function generatePrivatePresignedGetUrl(
  bucket: string,
  key: string,
): Computed<Promise<string>> {
  return generatePresignedGetUrlWithClient(
    s3ClientForBucket(bucket, true),
    bucket,
    key,
    { responseCacheControl: PRIVATE_NO_STORE_CACHE_CONTROL },
  );
}

/** Use the same clock for the signature and its advertised expiration. */
export function generateArtifactPreviewUrl(
  bucket: string,
  key: string,
  options: {
    readonly signingDate: Date;
    readonly filename?: string;
  },
): Computed<Promise<{ url: string; expiresAt: string }>> {
  return computed(async (get) => {
    const { filename } = options;
    const signingDate = new Date(
      Math.floor(options.signingDate.getTime() / 1000) * 1000,
    );
    const url = await get(
      generatePresignedGetUrlWithClient(
        s3ClientForBucket(bucket, true),
        bucket,
        key,
        {
          filename,
          signingDate,
          responseCacheControl:
            bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME")
              ? PRIVATE_ARTIFACT_CACHE_CONTROL
              : undefined,
        },
      ),
    );
    return {
      url,
      expiresAt: new Date(
        signingDate.getTime() + PRESIGNED_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  });
}

function generatePresignedGetUrlWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
  options?: {
    readonly filename?: string;
    readonly responseCacheControl?: string;
    readonly signingDate?: Date;
  },
): Computed<Promise<string>> {
  return computed((get): Promise<string> => {
    const client = get(client$);
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(options?.responseCacheControl
        ? { ResponseCacheControl: options.responseCacheControl }
        : {}),
      ...(options?.filename
        ? {
            ResponseContentDisposition: `attachment; filename="${options.filename}"`,
          }
        : {}),
    });
    return getSignedUrl(client, command, {
      expiresIn: PRESIGNED_URL_TTL_SECONDS,
      ...(options?.signingDate ? { signingDate: options.signingDate } : {}),
    });
  });
}

export function putS3Object(
  bucket: string,
  key: string,
  body: string | Buffer,
  contentType: string,
  options?:
    | AbortSignal
    | {
        readonly signal?: AbortSignal;
        readonly metadata?: Readonly<Record<string, string>>;
      },
): Computed<Promise<void>> {
  const writeOptions = isAbortSignal(options) ? { signal: options } : options;
  return putS3ObjectWithClient(
    s3ClientForBucket(bucket),
    {
      bucket,
      key,
      body,
      contentType,
      metadata: writeOptions?.metadata,
    },
    writeOptions?.signal,
  );
}

interface PutS3ObjectArgs {
  readonly bucket: string;
  readonly key: string;
  readonly body: string | Buffer;
  readonly contentType: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    "addEventListener" in value
  );
}

function putS3ObjectWithClient(
  client$: Computed<S3Client>,
  args: PutS3ObjectArgs,
  signal?: AbortSignal,
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const client = get(client$);
    await get(publicArtifactWriteRegistration(args.bucket, args, signal));
    await client.send(
      new PutObjectCommand({
        Bucket: args.bucket,
        Key: args.key,
        Body: args.body,
        ContentType: args.contentType,
        Metadata: args.metadata,
      }),
      signal ? { abortSignal: signal } : undefined,
    );
  });
}

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

function isS3PreconditionFailedError(error: unknown): boolean {
  const candidate = error as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return (
    candidate.name === "PreconditionFailed" ||
    candidate.$metadata?.httpStatusCode === 412
  );
}

/**
 * Upload an object exactly once. An existing key is an idempotent success, so
 * callers can safely retry without changing bytes behind an immutable URL.
 */
export function putImmutableS3Object(
  bucket: string,
  key: string,
  body: string | Buffer,
  contentType: string,
  options?:
    | AbortSignal
    | {
        readonly signal?: AbortSignal;
        readonly metadata?: Readonly<Record<string, string>>;
        readonly contentEncoding?: string;
      },
): Computed<Promise<void>> {
  const writeOptions = isAbortSignal(options) ? { signal: options } : options;
  return putImmutableS3ObjectWithOptions(
    {
      bucket,
      key,
      body,
      contentType,
      metadata: writeOptions?.metadata,
      contentEncoding: writeOptions?.contentEncoding,
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    },
    writeOptions?.signal,
  );
}

export function putPrivateImmutableS3Object(
  bucket: string,
  key: string,
  body: string | Buffer,
  contentType: string,
  signal: AbortSignal,
): Computed<Promise<void>> {
  return putImmutableS3ObjectWithOptions(
    {
      bucket,
      key,
      body,
      contentType,
      cacheControl: PRIVATE_NO_STORE_CACHE_CONTROL,
    },
    signal,
  );
}

function putImmutableS3ObjectWithOptions(
  args: {
    readonly bucket: string;
    readonly key: string;
    readonly body: string | Buffer;
    readonly contentType: string;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly contentEncoding?: string;
    readonly cacheControl: string;
  },
  signal?: AbortSignal,
): Computed<Promise<void>> {
  return computed(async (get): Promise<void> => {
    const { bucket, key, body, contentType } = args;
    const client = get(s3ClientForBucket(bucket));
    await get(
      publicArtifactWriteRegistration(
        bucket,
        { key, contentType, metadata: args.metadata },
        signal,
      ),
    );
    const uploaded = await settle(
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentEncoding: args.contentEncoding,
          Metadata: args.metadata,
          CacheControl: args.cacheControl,
          IfNoneMatch: "*",
        }),
        signal ? { abortSignal: signal } : undefined,
      ),
    );
    if (!uploaded.ok && !isS3PreconditionFailedError(uploaded.error)) {
      throw uploaded.error;
    }
  });
}

/** Server-side immutable sharing copies never receive upload credentials. */
export function copyArtifactShareObject(
  bucket: string,
  sourceKey: string,
  targetKey: string,
  hosted: boolean,
  signal: AbortSignal,
): Computed<Promise<void>> {
  return computed(async (get) => {
    const client = get(
      hosted ? hostedSitesS3Client$ : s3ClientForBucket(bucket),
    );
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: targetKey,
        CopySource: `${bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
      }),
      { abortSignal: signal },
    );
  });
}

/** Read the body and revision validator from the same strongly consistent read. */
export function readArtifactSharePolicyObject(
  bucket: string,
  key: string,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    const response = await get(hostedSitesS3Client$).send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: signal },
    );
    const buffer = await readS3ObjectBody(response, key, {}, signal);
    if (!response.ETag) {
      throw new Error("Artifact sharing policy has no storage revision");
    }
    return { buffer, etag: response.ETag };
  });
}

/** A delayed writer cannot overwrite a policy acknowledged by a newer writer. */
export function writeArtifactSharePolicyObject(
  bucket: string,
  key: string,
  body: string,
  etag: string | null,
  signal: AbortSignal,
) {
  return computed(async (get): Promise<void> => {
    await get(hostedSitesS3Client$).send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        ...(etag === null ? { IfNoneMatch: "*" } : { IfMatch: etag }),
      }),
      { abortSignal: signal },
    );
  });
}

export function putHostedSitesS3Object(
  bucket: string,
  key: string,
  body: string | Buffer,
  contentType: string,
): Computed<Promise<void>> {
  return putS3ObjectWithClient(hostedSitesS3Client$, {
    bucket,
    key,
    body,
    contentType,
  });
}

export function downloadManifest(
  bucket: string,
  s3Key: string,
): Computed<Promise<S3StorageManifest>> {
  return computed(async (get): Promise<S3StorageManifest> => {
    const manifestBuffer = await get(
      downloadS3Buffer(bucket, `${s3Key}/manifest.json`),
    );
    return JSON.parse(manifestBuffer.toString("utf8")) as S3StorageManifest;
  });
}

export function s3ObjectContentLength(
  bucket: string,
  key: string,
  maxBytes?: number,
): Computed<Promise<number | undefined>> {
  return s3ObjectContentLengthWithClient(
    s3ClientForBucket(bucket),
    bucket,
    key,
    maxBytes,
  );
}

export type S3ObjectHead =
  | { readonly kind: "missing" }
  | {
      readonly kind: "found";
      readonly contentLength: number | undefined;
      readonly contentType: string | undefined;
      readonly lastModified: Date | undefined;
      readonly metadata: Readonly<Record<string, string>>;
    };

function isS3NotFoundError(error: unknown): boolean {
  const candidate = error as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchUpload" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export function s3ObjectHead(
  bucket: string,
  key: string,
): Computed<Promise<S3ObjectHead>> {
  return s3ObjectHeadWithClient(s3ClientForBucket(bucket), bucket, key);
}

function s3ObjectHeadWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
): Computed<Promise<S3ObjectHead>> {
  return computed(async (get): Promise<S3ObjectHead> => {
    const client = get(client$);
    const result = await settle(
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
    );
    if (!result.ok) {
      if (isS3NotFoundError(result.error)) {
        return { kind: "missing" };
      }
      throw result.error;
    }

    return {
      kind: "found",
      contentLength: result.value.ContentLength,
      contentType: result.value.ContentType,
      lastModified: result.value.LastModified,
      metadata: result.value.Metadata ?? {},
    };
  });
}

function s3ObjectContentLengthWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
  maxBytes: number | undefined,
): Computed<Promise<number | undefined>> {
  return computed(async (get): Promise<number | undefined> => {
    const result = await get(s3ObjectHeadWithClient(client$, bucket, key));
    if (result.kind === "missing") {
      return undefined;
    }

    const contentLength = result.contentLength;
    if (contentLength === undefined) {
      return undefined;
    }
    if (maxBytes !== undefined && contentLength > maxBytes) {
      throw new S3ObjectSizeLimitError(key, contentLength, maxBytes);
    }
    return contentLength;
  });
}

export function s3ObjectExists(
  bucket: string,
  key: string,
): Computed<Promise<boolean>> {
  return s3ObjectExistsWithClient(s3ClientForBucket(bucket), bucket, key);
}

function s3ObjectExistsWithClient(
  client$: Computed<S3Client>,
  bucket: string,
  key: string,
): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const client = get(client$);
    const result = await settle(
      client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
    );
    if (result.ok) {
      return true;
    }
    if (isS3NotFoundError(result.error)) {
      return false;
    }
    throw result.error;
  });
}

export function hostedSitesS3ObjectExists(
  bucket: string,
  key: string,
): Computed<Promise<boolean>> {
  return s3ObjectExistsWithClient(hostedSitesS3Client$, bucket, key);
}

export function verifyS3FilesExist(
  bucket: string,
  s3Key: string,
  fileCount: number,
  options?: {
    readonly allowMissingObjectsForEmptyVersion?: boolean;
  },
): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    if (
      fileCount === 0 &&
      options?.allowMissingObjectsForEmptyVersion === true
    ) {
      return true;
    }

    const manifestKey = `${s3Key}/manifest.json`;
    const archiveKey = `${s3Key}/archive.tar.gz`;
    const [manifestExists, archiveExists] = await Promise.all([
      get(s3ObjectExists(bucket, manifestKey)),
      fileCount > 0
        ? get(s3ObjectExists(bucket, archiveKey))
        : Promise.resolve(true),
    ]);

    return manifestExists && archiveExists;
  });
}
