import { randomUUID } from "node:crypto";
import {
  artifactReferencePath,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import { command, computed } from "ccstate";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { env } from "../../lib/env";
import { sanitizeArtifactFilename } from "../../lib/file-url";
import { nowDate } from "../../lib/time";
import { apiBackendUrl } from "../../lib/api-backend-url";
import { db$, writeDb$ } from "../external/db";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { safeUrlParse } from "../utils";

const PRIVATE_STORAGE = "private-artifact-v1";

/**
 * A private artifact that exists only to back one record of the named feature.
 * That feature owns the object's lifetime and may delete it with its record;
 * an artifact without this marker is the user's own and must never be reclaimed
 * by a feature that merely references it.
 */
export const IMAGE_REFERENCE_EXCLUSIVE_OWNER = "image-reference";
export const PRIVATE_ARTIFACT_EXCLUSIVE_OWNERS = [
  IMAGE_REFERENCE_EXCLUSIVE_OWNER,
] as const;
export type PrivateArtifactExclusiveOwner =
  (typeof PRIVATE_ARTIFACT_EXCLUSIVE_OWNERS)[number];

const privateMetadataSchema = z.object({
  storage: z.literal(PRIVATE_STORAGE),
  bucket: z.string().min(1),
  publicBrand: z.enum(["vm0", "okou"]),
  exclusiveOwner: z.enum(PRIVATE_ARTIFACT_EXCLUSIVE_OWNERS).optional(),
});

export function privateArtifactCreationEnabled(orgId: string, userId: string) {
  return computed(async (get) => {
    const context = await get(userFeatureSwitchContext(orgId, userId));
    return isFeatureEnabled(FeatureSwitchKey.PrivateArtifacts, context);
  });
}

export function artifactFileReference(
  value: string,
): { readonly id: string } | null {
  const reference = parseArtifactReference(value, env("APP_URL"));
  if (reference) {
    return { id: reference.id ?? "" };
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

export function privateArtifactUrl(id: string, filename: string): string {
  return artifactReferencePath(id, filename);
}

export function privateArtifactsBucket(): string {
  const bucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
  if (!bucket || bucket === env("R2_USER_ARTIFACTS_BUCKET_NAME")) {
    throw new Error("A separate R2_PRIVATE_ARTIFACTS_BUCKET_NAME is required");
  }
  return bucket;
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
      readonly exclusiveOwner?: PrivateArtifactExclusiveOwner;
    },
    signal: AbortSignal,
  ) => {
    const bucket = privateArtifactsBucket();
    const id = args.id ?? randomUUID();
    const key = `private-artifacts/${id}/${sanitizeArtifactFilename(args.filename)}`;
    const url = privateArtifactUrl(id, args.filename);
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
          storage: PRIVATE_STORAGE,
          bucket,
          publicBrand: args.publicBrand,
          ...(args.exclusiveOwner === undefined
            ? {}
            : { exclusiveOwner: args.exclusiveOwner }),
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
        existing.metadata.exclusiveOwner !== args.exclusiveOwner ||
        existing.storageKey !== key ||
        existing.filename !== args.filename ||
        existing.contentType !== args.contentType
      ) {
        throw new Error("Private artifact identity belongs to another object");
      }
    }
    return {
      id,
      key,
      bucket,
      url,
      publicBrand: args.publicBrand,
      metadata: { "artifact-id": id },
    };
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
    if (!row || row.metadata.storage !== PRIVATE_STORAGE) {
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
      readonly url: string;
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
