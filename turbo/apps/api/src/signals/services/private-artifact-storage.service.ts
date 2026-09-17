import { randomUUID } from "node:crypto";
import {
  artifactReferencePath,
  artifactShareReferencePath,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import { command, computed } from "ccstate";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import type { RunUploadedFileMetadata } from "@okouai/db/jsonb-contracts/run-uploaded-file";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { env } from "../../lib/env";
import { sanitizeArtifactFilename } from "../../lib/file-url";
import { nowDate } from "../../lib/time";
import { apiBackendUrl } from "../../lib/api-backend-url";
import { db$, writeDb$ } from "../external/db";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { safeUrlParse } from "../utils";
import {
  allocateArtifactReference$,
  artifactReferenceRecord,
} from "./artifact-reference.service";

const PRIVATE_STORAGE = "private-artifact-v1";
const privateMetadataSchema = z.object({
  storage: z.literal(PRIVATE_STORAGE),
  bucket: z.string().min(1),
  publicBrand: z.enum(["vm0", "okou"]),
  artifactReference: z
    .string()
    .regex(/^[a-z0-9]{10}$/u)
    .optional(),
});

export function privateArtifactCreationEnabled(orgId: string, userId: string) {
  return computed(async (get) => {
    const context = await get(userFeatureSwitchContext(orgId, userId));
    return isFeatureEnabled(FeatureSwitchKey.PrivateArtifacts, context);
  });
}

export function artifactFileReference(
  value: string,
): { readonly id: string; readonly hash?: string } | null {
  const reference = parseArtifactReference(value, env("APP_URL"));
  if (reference) {
    return { id: reference.id ?? "", hash: reference.hash };
  }
  if (value.startsWith("/artifacts/")) {
    return { id: "" };
  }
  const origin = apiBackendUrl();
  const url = safeUrlParse(value);
  if (
    !origin ||
    !url ||
    url.origin !== new URL(origin).origin ||
    url.pathname !== "/api/web/download-file" ||
    url.username ||
    url.password
  ) {
    return null;
  }
  // Preserve recognition of malformed references so they fail authorization
  // instead of being forwarded to a provider as an arbitrary public URL.
  return { id: url.searchParams.get("file_id") ?? "" };
}

export function resolveArtifactFileReference(
  value: string,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    const reference = artifactFileReference(value);
    if (!reference || reference.id || !reference.hash) {
      return reference;
    }
    const record = await get(artifactReferenceRecord(reference.hash, signal));
    // Share aliases grant viewing only. Provider input still requires ownership.
    return {
      id:
        record?.version === 2 && record.target.kind === "file"
          ? record.target.id
          : "",
    };
  });
}

export function privateArtifactUrl(
  id: string,
  filename: string,
  metadata: RunUploadedFileMetadata,
): string {
  if (metadata.artifactReference !== undefined) {
    return artifactShareReferencePath(
      z.string().parse(metadata.artifactReference),
      filename,
    );
  }
  // Persisted private files created before short references retain their URL.
  return artifactReferencePath(id, filename);
}

export function privateArtifactsBucket(): string {
  const bucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
  if (!bucket || bucket === env("R2_USER_ARTIFACTS_BUCKET_NAME")) {
    throw new Error("A separate R2_PRIVATE_ARTIFACTS_BUCKET_NAME is required");
  }
  return bucket;
}

/** Persist this location with the owning record before starting the upload. */
export const allocatePrivateArtifactLocation$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly filename: string;
      readonly publicBrand: PublicBrand;
    },
    signal: AbortSignal,
  ) => {
    const { id, filename, publicBrand } = args;
    const bucket = privateArtifactsBucket();
    const artifactReference = await set(
      allocateArtifactReference$,
      { kind: "file", id },
      signal,
    );
    const storageMetadata = {
      storage: PRIVATE_STORAGE,
      bucket,
      publicBrand,
      artifactReference,
    };
    return {
      id,
      key: `private-artifacts/${id}/${sanitizeArtifactFilename(filename)}`,
      bucket,
      url: privateArtifactUrl(id, filename, storageMetadata),
      publicBrand,
      metadata: { "artifact-id": id },
      storageMetadata,
    };
  },
);

/** Historical accessLevel="private" records still address public objects. */
export function artifactStorageBucket(
  metadata: RunUploadedFileMetadata,
): string {
  if (metadata.storage === undefined) {
    return env("R2_USER_ARTIFACTS_BUCKET_NAME");
  }
  const storage = privateMetadataSchema.parse(metadata);
  if (storage.bucket !== privateArtifactsBucket()) {
    throw new Error("Artifact does not match the configured private bucket");
  }
  return storage.bucket;
}

/** Template records persist their authorized source keys, including old public keys. */
export function templateArtifactBucket(key: string): string {
  if (key.startsWith("private-artifacts/")) {
    return privateArtifactsBucket();
  }
  if (!key.startsWith("artifacts/")) {
    throw new Error("Unsupported presentation template storage key");
  }
  return env("R2_USER_ARTIFACTS_BUCKET_NAME");
}

export const allocatePrivateArtifact$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly filename: string;
      readonly contentType: string;
      readonly size: number;
      readonly publicBrand: PublicBrand;
      readonly id?: string;
    },
    signal: AbortSignal,
  ) => {
    const id = args.id ?? randomUUID();
    const location = await set(
      allocatePrivateArtifactLocation$,
      { id, filename: args.filename, publicBrand: args.publicBrand },
      signal,
    );
    const { bucket, key } = location;
    const db = set(writeDb$);
    // This independent ownership record also covers uploads outside a run.
    // Historical accessLevel="private" rows still use public storage; only
    // this versioned storage marker identifies the new private policy.
    const [created] = await db
      .insert(runUploadedFiles)
      .values({
        id,
        source: "web",
        externalId: id,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.size,
        storageKey: key,
        accessLevel: "private",
        materializationStatus: "pending",
        metadata: {
          ...location.storageMetadata,
        },
      })
      .onConflictDoNothing({ target: runUploadedFiles.id })
      .returning({ id: runUploadedFiles.id });
    signal.throwIfAborted();
    if (!created) {
      const [existing] = await db
        .select()
        .from(runUploadedFiles)
        .where(eq(runUploadedFiles.id, id))
        .limit(1);
      signal.throwIfAborted();
      if (
        !existing ||
        existing.userId !== args.userId ||
        existing.orgId !== args.orgId ||
        existing.metadata.storage !== PRIVATE_STORAGE ||
        existing.metadata.bucket !== bucket ||
        existing.metadata.publicBrand !== args.publicBrand ||
        existing.storageKey !== key ||
        existing.filename !== args.filename ||
        existing.contentType !== args.contentType
      ) {
        throw new Error("Private artifact identity belongs to another object");
      }
    }
    return location;
  },
);

export function privateArtifactRecord(id: string) {
  return computed(async (get) => {
    // Historical file IDs are not all UUIDs; the database key is a UUID.
    if (!z.uuid().safeParse(id).success) {
      return null;
    }
    const [row] = await get(db$)
      .select()
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.id, id))
      .limit(1);
    if (!row || row.metadata.storage === undefined) {
      return null;
    }
    const metadata = privateMetadataSchema.parse(row.metadata);
    if (!row.orgId || !row.storageKey || !row.filename || !row.contentType) {
      throw new Error(`Private artifact ${id} has incomplete storage metadata`);
    }
    if (metadata.bucket !== privateArtifactsBucket()) {
      throw new Error(
        `Private artifact ${id} does not match the configured private bucket`,
      );
    }
    return {
      ...row,
      orgId: row.orgId,
      key: row.storageKey,
      filename: row.filename,
      contentType: row.contentType,
      ...metadata,
    };
  });
}

export const completePrivateArtifact$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      // Internal previews and browser captures keep their reference on the
      // owning record, without publishing a standalone catalog file.
      readonly url: string | null;
      readonly contentType: string;
      readonly size: number;
    },
    signal: AbortSignal,
  ) => {
    await set(writeDb$)
      .update(runUploadedFiles)
      .set({
        url: args.url,
        contentType: args.contentType,
        sizeBytes: args.size,
        materializationStatus: "ready",
        updatedAt: nowDate(),
      })
      .where(eq(runUploadedFiles.id, args.id));
    signal.throwIfAborted();
  },
);
