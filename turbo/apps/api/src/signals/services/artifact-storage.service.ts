import { randomUUID } from "node:crypto";
import { registerLegacyArtifactFile$ } from "./artifact-delivery.service";

import { command, computed, type Computed } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

import { env } from "../../lib/env";
import {
  buildArtifactKeyV2,
  buildArtifactPrefix,
  buildArtifactPrefixV2,
  buildFileUrlFromKey,
  artifactKeyFromShortOkouUrl,
  isArtifactKeyV2,
  OKOU_CDN_ARTIFACTS_ORIGIN,
  OKOU_SHORT_ARTIFACTS_ORIGIN,
  publicArtifactsBaseUrlForBrand,
} from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import {
  listS3Objects,
  putS3Object,
  s3ObjectHead,
  type S3ObjectHead,
  tryListMultipartS3Parts,
} from "../external/s3";
import { safeUriComponentDecode, safeUrlParse } from "../utils";
import {
  allocatePrivateArtifact$,
  completePrivateArtifact$,
} from "./private-artifact-storage.service";

const MAX_ARTIFACT_KEY_ATTEMPTS = 5;
const ARTIFACT_ID_METADATA_KEY = "artifact-id";
const ARTIFACT_FILENAME_METADATA_KEY = "filename";
const ARTIFACT_USER_ID_METADATA_KEY = "user-id";
const ARTIFACT_PUBLIC_BRAND_METADATA_KEY = "public-brand";
const CLOUDFLARE_IMAGE_RESIZE_PATH_PREFIX = "/cdn-cgi/image/";
const PUBLIC_ARTIFACT_PATH_PREFIX = "/artifacts/";

export interface ArtifactObjectLocation {
  readonly id: string;
  readonly key: string;
  readonly url: string;
  readonly publicBrand: PublicBrand;
  readonly metadata: Readonly<Record<string, string>>;
}

type StoredGeneratedArtifactObject = Omit<
  ArtifactObjectLocation,
  "metadata"
> & {
  readonly filename: string;
  readonly isPrivate: boolean;
  readonly metadata: Readonly<Record<string, string>>;
};

export interface ResolvedArtifactObject {
  readonly key: string;
  readonly url: string;
  readonly publicBrand: PublicBrand;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly lastModified: Date | undefined;
}

function publicArtifactPath(pathname: string): string | null {
  if (pathname.startsWith(PUBLIC_ARTIFACT_PATH_PREFIX)) {
    return pathname;
  }
  if (!pathname.startsWith(CLOUDFLARE_IMAGE_RESIZE_PATH_PREFIX)) {
    return null;
  }
  const artifactStart = pathname.indexOf(
    PUBLIC_ARTIFACT_PATH_PREFIX,
    CLOUDFLARE_IMAGE_RESIZE_PATH_PREFIX.length,
  );
  return artifactStart === -1 ? null : pathname.slice(artifactStart);
}

function publicArtifactKeyFromUrl(value: string): string | null {
  const url = safeUrlParse(value);
  if (!url) {
    return null;
  }
  if (url.origin === OKOU_SHORT_ARTIFACTS_ORIGIN) {
    return artifactKeyFromShortOkouUrl(url);
  }
  const allowedOrigins = new Set([
    new URL(publicArtifactsBaseUrlForBrand("vm0")).origin,
    new URL(publicArtifactsBaseUrlForBrand("okou")).origin,
    OKOU_CDN_ARTIFACTS_ORIGIN,
  ]);
  if (!allowedOrigins.has(url.origin)) {
    return null;
  }
  const path = publicArtifactPath(url.pathname);
  return path?.replace(/^\/+/, "") ?? null;
}

function isOwnedLegacyArtifactKey(key: string, userId: string): boolean {
  const segments = key.split("/");
  return (
    segments.length === 4 &&
    segments[0] === "artifacts" &&
    segments[1] === encodeURIComponent(userId) &&
    Boolean(segments[2]) &&
    Boolean(segments[3])
  );
}

export const resolveOwnedPublicArtifactKey$ = command(
  async (
    { get },
    args: { readonly userId: string; readonly url: string },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const key = publicArtifactKeyFromUrl(args.url);
    if (!key) {
      return null;
    }
    if (isOwnedLegacyArtifactKey(key, args.userId)) {
      return key;
    }
    if (!isArtifactKeyV2(key)) {
      return null;
    }

    const head = await get(
      s3ObjectHead(env("R2_USER_ARTIFACTS_BUCKET_NAME"), key),
    );
    signal.throwIfAborted();
    return head.kind === "found" &&
      head.metadata[ARTIFACT_USER_ID_METADATA_KEY] ===
        encodeURIComponent(args.userId)
      ? key
      : null;
  },
);

interface ResolvedArtifactMultipartUpload {
  readonly key: string;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly etag: string;
  }[];
}

export function artifactObjectMetadata(
  userId: string,
  id: string,
  filename: string,
  publicBrand: PublicBrand,
): Readonly<Record<string, string>> {
  return {
    [ARTIFACT_ID_METADATA_KEY]: id,
    [ARTIFACT_FILENAME_METADATA_KEY]: encodeURIComponent(filename),
    [ARTIFACT_USER_ID_METADATA_KEY]: encodeURIComponent(userId),
    [ARTIFACT_PUBLIC_BRAND_METADATA_KEY]: publicBrand,
  };
}

function publicBrandFromMetadata(
  metadata: Readonly<Record<string, string>>,
): PublicBrand {
  const publicBrand = metadata[ARTIFACT_PUBLIC_BRAND_METADATA_KEY];
  if (publicBrand === undefined) {
    // Pre-brand V2 objects remain reachable for their persisted-object
    // lifetime. Remove after all reachable objects are migrated or deleted;
    // tracked by #28449. Present invalid values must fail below.
    return "vm0";
  }
  if (publicBrand === "vm0" || publicBrand === "okou") {
    return publicBrand;
  }
  throw new Error(`Invalid artifact public brand: ${publicBrand}`);
}

function filenameFromMetadata(
  metadata: Readonly<Record<string, string>>,
): string | undefined {
  const encoded = metadata[ARTIFACT_FILENAME_METADATA_KEY];
  if (encoded === undefined) {
    return undefined;
  }
  return safeUriComponentDecode(encoded) ?? undefined;
}

function filenameFromLegacyKey(key: string): string {
  return decodeURIComponent(key.split("/").pop() ?? key);
}

function collisionVariant(variant: string, attempt: number): string {
  return attempt === 0 ? variant : `${variant}\0${String(attempt)}`;
}

export const allocateArtifactObject$ = command(
  async (
    { get },
    args: {
      readonly userId: string;
      readonly filename: string;
      readonly publicBrand: PublicBrand;
      readonly id?: string;
      readonly variant?: string;
    },
    signal: AbortSignal,
  ): Promise<ArtifactObjectLocation> => {
    signal.throwIfAborted();

    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    for (let attempt = 0; attempt < MAX_ARTIFACT_KEY_ATTEMPTS; attempt += 1) {
      const id =
        args.id !== undefined && (args.variant !== undefined || attempt === 0)
          ? args.id
          : randomUUID();
      const variant =
        args.variant === undefined
          ? undefined
          : collisionVariant(args.variant, attempt);
      const prefix = buildArtifactPrefixV2(id, variant);
      const key = buildArtifactKeyV2(id, args.filename, variant);
      const existing = await get(listS3Objects(bucket, prefix));
      signal.throwIfAborted();
      if (existing.length === 0) {
        return {
          id,
          key,
          url: buildFileUrlFromKey(key, args.publicBrand),
          publicBrand: args.publicBrand,
          metadata: artifactObjectMetadata(
            args.userId,
            id,
            args.filename,
            args.publicBrand,
          ),
        };
      }

      if (args.id !== undefined && args.variant !== undefined) {
        const sameKey = existing.find((object) => {
          return object.key === key;
        });
        if (sameKey) {
          const head = await get(s3ObjectHead(bucket, key));
          signal.throwIfAborted();
          if (
            head.kind === "found" &&
            head.metadata[ARTIFACT_ID_METADATA_KEY] === id &&
            head.metadata[ARTIFACT_USER_ID_METADATA_KEY] ===
              encodeURIComponent(args.userId) &&
            filenameFromMetadata(head.metadata) === args.filename
          ) {
            const publicBrand = publicBrandFromMetadata(head.metadata);
            return {
              id,
              key,
              url: buildFileUrlFromKey(key, publicBrand),
              publicBrand,
              metadata: artifactObjectMetadata(
                args.userId,
                id,
                args.filename,
                publicBrand,
              ),
            };
          }
        }
      }
    }

    throw new Error("Unable to allocate a unique artifact key");
  },
);

export const storeGeneratedArtifactObject$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly privateArtifacts: boolean;
      readonly identity?: { readonly id: string; readonly variant: string };
      readonly filenamePrefix: string;
      readonly extension: string;
      readonly body: Buffer;
      readonly contentType: string;
      readonly publicBrand: PublicBrand;
    },
    signal: AbortSignal,
  ): Promise<StoredGeneratedArtifactObject> => {
    const proposedId = args.identity?.id ?? randomUUID();
    const extension = args.extension.replace(/^\./u, "");
    const filenameFor = (id: string) => {
      return `${args.filenamePrefix}-${id.slice(0, 8)}.${extension}`;
    };
    if (args.privateArtifacts) {
      const artifact = await set(
        allocatePrivateArtifact$,
        {
          id: proposedId,
          userId: args.userId,
          orgId: args.orgId,
          filename: filenameFor(proposedId),
          contentType: args.contentType,
          size: args.body.byteLength,
          publicBrand: args.publicBrand,
        },
        signal,
      );
      await get(
        putS3Object(
          artifact.bucket,
          artifact.key,
          args.body,
          args.contentType,
          { signal, metadata: artifact.metadata },
        ),
      );
      signal.throwIfAborted();
      await set(
        completePrivateArtifact$,
        {
          id: artifact.id,
          url: artifact.url,
          contentType: args.contentType,
          size: args.body.byteLength,
        },
        signal,
      );
      return {
        ...artifact,
        filename: filenameFor(proposedId),
        isPrivate: true,
      };
    }
    const artifact = await set(
      allocateArtifactObject$,
      {
        userId: args.userId,
        id: proposedId,
        ...(args.identity ? { variant: args.identity.variant } : {}),
        filename: filenameFor(proposedId),
        publicBrand: args.publicBrand,
      },
      signal,
    );
    const filename = filenameFor(artifact.id);
    const metadata = artifactObjectMetadata(
      args.userId,
      artifact.id,
      filename,
      args.publicBrand,
    );
    await get(
      putS3Object(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        artifact.key,
        args.body,
        args.contentType,
        { signal, metadata },
      ),
    );
    signal.throwIfAborted();
    await set(
      registerLegacyArtifactFile$,
      {
        key: artifact.key,
        filename,
        contentType: args.contentType,
        publicBrand: args.publicBrand,
      },
      signal,
    );
    return { ...artifact, filename, metadata, isPrivate: false };
  },
);

function resolvedV2ArtifactObjectFromHead(args: {
  readonly userId: string;
  readonly id: string;
  readonly key: string;
  readonly head: S3ObjectHead;
  readonly listed?: {
    readonly size: number;
    readonly lastModified: Date;
  };
}): ResolvedArtifactObject | null {
  if (
    args.head.kind === "missing" ||
    args.head.metadata[ARTIFACT_ID_METADATA_KEY] !== args.id ||
    args.head.metadata[ARTIFACT_USER_ID_METADATA_KEY] !==
      encodeURIComponent(args.userId)
  ) {
    return null;
  }
  const size = args.head.contentLength ?? args.listed?.size;
  const lastModified = args.head.lastModified ?? args.listed?.lastModified;
  if (size === undefined || lastModified === undefined) {
    return null;
  }
  const filename =
    filenameFromMetadata(args.head.metadata) ?? filenameFromLegacyKey(args.key);
  const publicBrand = publicBrandFromMetadata(args.head.metadata);
  return {
    key: args.key,
    url: buildFileUrlFromKey(args.key, publicBrand),
    publicBrand,
    filename,
    contentType: args.head.contentType ?? inferMimetype(filename),
    size,
    lastModified,
  };
}

function resolveExactV2ArtifactObject(
  bucket: string,
  userId: string,
  id: string,
  filenameHint: string,
  variant?: string,
): Computed<Promise<ResolvedArtifactObject | null>> {
  return computed(async (get): Promise<ResolvedArtifactObject | null> => {
    const key = buildArtifactKeyV2(id, filenameHint, variant);
    const head = await get(s3ObjectHead(bucket, key));
    return resolvedV2ArtifactObjectFromHead({ userId, id, key, head });
  });
}

function resolveV2ArtifactObject(
  bucket: string,
  userId: string,
  id: string,
): Computed<Promise<ResolvedArtifactObject | null>> {
  return computed(async (get): Promise<ResolvedArtifactObject | null> => {
    const objects = await get(listS3Objects(bucket, buildArtifactPrefixV2(id)));
    for (const object of objects) {
      const head = await get(s3ObjectHead(bucket, object.key));
      const resolved = resolvedV2ArtifactObjectFromHead({
        userId,
        id,
        key: object.key,
        head,
        listed: object,
      });
      if (resolved) {
        return resolved;
      }
    }
    return null;
  });
}

function resolveV1ArtifactObject(
  bucket: string,
  userId: string,
  id: string,
): Computed<Promise<ResolvedArtifactObject | null>> {
  // V1 objects predate publicBrand and remain VM0 for their persisted-object
  // lifetime. Remove with V1 reads once no V1 object remains reachable;
  // tracked by #28449.
  return computed(async (get): Promise<ResolvedArtifactObject | null> => {
    const objects = await get(
      listS3Objects(bucket, buildArtifactPrefix(userId, id)),
    );
    const object = objects[0];
    if (!object) {
      return null;
    }
    const filename = filenameFromLegacyKey(object.key);
    return {
      key: object.key,
      url: buildFileUrlFromKey(object.key, "vm0"),
      publicBrand: "vm0",
      filename,
      contentType: inferMimetype(filename),
      size: object.size,
      lastModified: object.lastModified,
    };
  });
}

export function resolvedArtifactObject(
  userId: string,
  id: string,
  filenameHint?: string,
  variant?: string,
): Computed<Promise<ResolvedArtifactObject | null>> {
  return computed(async (get): Promise<ResolvedArtifactObject | null> => {
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    if (filenameHint !== undefined) {
      const exact = await get(
        resolveExactV2ArtifactObject(bucket, userId, id, filenameHint, variant),
      );
      if (exact) {
        return exact;
      }
    }
    if (variant !== undefined) {
      return null;
    }
    return (
      (await get(resolveV2ArtifactObject(bucket, userId, id))) ??
      (await get(resolveV1ArtifactObject(bucket, userId, id)))
    );
  });
}

export const resolveArtifactMultipartUpload$ = command(
  async (
    { get },
    args: {
      readonly userId: string;
      readonly id: string;
      readonly filename: string;
      readonly uploadId: string;
    },
    signal: AbortSignal,
  ): Promise<ResolvedArtifactMultipartUpload | null> => {
    const key = buildArtifactKeyV2(args.id, args.filename);
    const parts = await get(
      tryListMultipartS3Parts(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        key,
        args.uploadId,
      ),
    );
    signal.throwIfAborted();
    return parts === null ? null : { key, parts };
  },
);
