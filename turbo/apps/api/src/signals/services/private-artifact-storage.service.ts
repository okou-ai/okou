import { randomUUID } from "node:crypto";
import {
  artifactReferencePath,
  artifactShareReferencePath,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import { CURRENT_LINK_LAYOUT } from "@okouai/api-contracts/contracts/link-layout";
import { command } from "ccstate";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import { uuid } from "zod";
import { files, type FileOrigin } from "@okouai/db/schema/file";

import { env } from "../../lib/env";
import {
  artifactHash,
  buildFileUrlFromKey,
  sanitizeArtifactFilename,
} from "../../lib/file-url";
import { apiBackendUrl } from "../../lib/api-backend-url";
import { type ReadonlyDb, db$, writeDb$ } from "../external/db";
import { safeUrlParse } from "../utils";
import {
  allocateArtifactReference$,
  artifactReferenceRecord$,
} from "./artifact-reference.service";
import { upsertFileArtifact$ } from "./artifact-catalog.service";

export type PrivateArtifactPurpose =
  "artifact" | "hosted-preview" | "browser-screenshot" | "marketing-handoff";

export type PrivateArtifactUploadProtocol =
  | { readonly kind: "fixed-size-put-v1"; readonly size: number }
  | { readonly kind: "multipart-v1" };

export function fileOriginForPrivateArtifact(
  purpose: PrivateArtifactPurpose | undefined,
  runId: string | undefined,
): FileOrigin {
  if (
    purpose === "hosted-preview" ||
    purpose === "browser-screenshot" ||
    purpose === "marketing-handoff"
  ) {
    return "system";
  }
  return purpose === "artifact" || runId !== undefined ? "agent" : "user";
}

export function readPrivateAttachmentRows(
  db: ReadonlyDb,
  predicate: SQL | undefined,
) {
  return db
    .select({
      id: files.id,
      orgId: files.orgId,
      userId: files.ownerUserId,
      deletedAt: files.deletedAt,
      storageKey: files.storageKey,
      filename: files.filename,
      contentType: files.contentType,
      sizeBytes: files.sizeBytes,
      checksumSha256: files.checksumSha256,
      origin: files.origin,
      createdAt: files.createdAt,
    })
    .from(files)
    .where(predicate);
}

export type PrivateAttachmentRow = Awaited<
  ReturnType<typeof readPrivateAttachmentRows>
>[number];

/** A non-null `sizeBytes` marks a private upload whose bytes were verified. */
export function completedPrivateAttachmentSize(
  row: Pick<PrivateAttachmentRow, "sizeBytes">,
): number | null {
  if (
    row.sizeBytes === null ||
    !Number.isSafeInteger(row.sizeBytes) ||
    row.sizeBytes < 0
  ) {
    return null;
  }
  return row.sizeBytes;
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
    url.pathname !== "/api/web/file-url" ||
    url.username ||
    url.password
  ) {
    return null;
  }
  // Preserve recognition of malformed references so they fail authorization
  // instead of being forwarded to a provider as an arbitrary public URL.
  return { id: url.searchParams.get("file_id") ?? "" };
}

export const resolveArtifactFileReference$ = command(
  async ({ set }, value: string, signal: AbortSignal) => {
    const reference = artifactFileReference(value);
    if (!reference || reference.id || !reference.hash) {
      return reference;
    }
    const record = await set(artifactReferenceRecord$, reference.hash, signal);
    // Share aliases grant viewing only. Provider input still requires ownership.
    return {
      id:
        record?.version === 2 && record.target.kind === "file"
          ? record.target.id
          : "",
    };
  },
);

export function privateArtifactReferenceUrl(
  reference: string,
  filename: string,
): string {
  return new URL(
    artifactShareReferencePath(reference, filename),
    env("APP_URL"),
  ).href;
}

export const resolvePrivateArtifactUrl$ = command(
  async (
    { set },
    args: { readonly id: string; readonly filename: string },
    signal: AbortSignal,
  ): Promise<string> => {
    if (env("R2_HOSTED_SITES_BUCKET_NAME")) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const hash = artifactHash(args.id, `file:${attempt}`);
        const record = await set(artifactReferenceRecord$, hash, signal);
        signal.throwIfAborted();
        if (!record) {
          break;
        }
        if (
          record.version === 2 &&
          record.target.kind === "file" &&
          record.target.id === args.id
        ) {
          return privateArtifactReferenceUrl(hash, args.filename);
        }
      }
    }
    return new URL(
      artifactReferencePath(args.id, args.filename),
      env("APP_URL"),
    ).href;
  },
);

export const resolveFileUrl$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly storageKey: string;
      readonly filename: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    if (args.storageKey.startsWith("private-artifacts/")) {
      return await set(
        resolvePrivateArtifactUrl$,
        { id: args.id, filename: args.filename },
        signal,
      );
    }
    return buildFileUrlFromKey(args.storageKey, CURRENT_LINK_LAYOUT);
  },
);

export function privateArtifactsBucket(): string {
  const bucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
  if (!bucket || bucket === env("R2_USER_ARTIFACTS_BUCKET_NAME")) {
    throw new Error("A separate R2_PRIVATE_ARTIFACTS_BUCKET_NAME is required");
  }
  return bucket;
}

export function fileStorageBucket(storageKey: string): string {
  if (storageKey.startsWith("private-artifacts/")) {
    return privateArtifactsBucket();
  }
  return env("R2_USER_ARTIFACTS_BUCKET_NAME");
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

/** Persist this location with the owning record before starting the upload. */
export const allocatePrivateArtifactLocation$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly filename: string;
      readonly purpose?: PrivateArtifactPurpose;
    },
    signal: AbortSignal,
  ) => {
    const { id, filename } = args;
    const bucket = privateArtifactsBucket();
    const artifactReference = await set(
      allocateArtifactReference$,
      { kind: "file", id },
      signal,
    );
    return {
      id,
      key: `private-artifacts/${id}/${sanitizeArtifactFilename(filename)}`,
      bucket,
      url: privateArtifactReferenceUrl(artifactReference, filename),
      artifactReference,
      layout: CURRENT_LINK_LAYOUT,
      metadata: { "artifact-id": id },
    };
  },
);

export const allocatePrivateArtifact$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly filename: string;
      readonly contentType: string;
      readonly size: number;
      readonly checksumSha256?: string;
      readonly id?: string;
      readonly purpose?: PrivateArtifactPurpose;
      readonly runId?: string;
      readonly uploadProtocol?: PrivateArtifactUploadProtocol;
    },
    signal: AbortSignal,
  ) => {
    const id = args.id ?? randomUUID();
    const location = await set(
      allocatePrivateArtifactLocation$,
      {
        id,
        filename: args.filename,
        ...(args.purpose ? { purpose: args.purpose } : {}),
      },
      signal,
    );
    const { key } = location;
    const origin = fileOriginForPrivateArtifact(args.purpose, args.runId);
    const db = set(writeDb$);
    const [created] = await db
      .insert(files)
      .values({
        id,
        orgId: args.orgId,
        ownerUserId: args.userId,
        storageKey: key,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: null,
        checksumSha256: args.checksumSha256 ?? null,
        origin,
      })
      .onConflictDoNothing({ target: files.id })
      .returning({ id: files.id });
    signal.throwIfAborted();
    if (!created) {
      const [existing] = await db
        .select()
        .from(files)
        .where(eq(files.id, id))
        .limit(1);
      signal.throwIfAborted();
      if (
        !existing ||
        existing.ownerUserId !== args.userId ||
        existing.orgId !== args.orgId ||
        existing.storageKey !== key ||
        existing.filename !== args.filename ||
        existing.contentType !== args.contentType ||
        (args.checksumSha256 !== undefined &&
          existing.checksumSha256 !== args.checksumSha256)
      ) {
        throw new Error("Private artifact identity belongs to another object");
      }
    }
    return location;
  },
);

/** Decode a fetched `files` row when it addresses private object storage. */
export function privateArtifactFromRow<
  Row extends Pick<
    typeof files.$inferSelect,
    | "id"
    | "orgId"
    | "storageKey"
    | "filename"
    | "contentType"
    | "sizeBytes"
    | "checksumSha256"
    | "origin"
    | "createdAt"
    | "deletedAt"
  > & { readonly ownerUserId?: string; readonly userId?: string },
>(row: Row | undefined) {
  if (
    !row ||
    row.deletedAt !== null ||
    !row.storageKey ||
    !row.storageKey.startsWith("private-artifacts/")
  ) {
    return null;
  }
  const userId = row.userId ?? row.ownerUserId;
  if (!userId) {
    throw new Error(`Private artifact ${row.id} has no owner user ID`);
  }
  const bucket = privateArtifactsBucket();
  return {
    id: row.id,
    orgId: row.orgId,
    userId,
    key: row.storageKey,
    storageKey: row.storageKey,
    bucket,
    filename: row.filename ?? "file",
    contentType: row.contentType ?? "application/octet-stream",
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    origin: row.origin,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
    isReady: row.sizeBytes !== null,
    layout: CURRENT_LINK_LAYOUT,
  };
}

export type PrivateArtifactRecord = NonNullable<
  ReturnType<typeof privateArtifactFromRow<typeof files.$inferSelect>>
>;

export const privateArtifactRecord$ = command(
  async ({ get }, id: string, signal: AbortSignal) => {
    if (!uuid().safeParse(id).success) {
      return null;
    }
    const [row] = await get(db$)
      .select()
      .from(files)
      .where(and(eq(files.id, id), isNull(files.deletedAt)))
      .limit(1);
    signal.throwIfAborted();
    return privateArtifactFromRow(row);
  },
);

export const completePrivateArtifact$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      // Internal previews and browser captures pass `null` so they never enter
      // the catalog; agent deliverables pass their canonical `/artifacts/...` URL.
      readonly url: string | null;
      readonly contentType: string;
      readonly size: number;
      readonly checksumSha256?: string;
      readonly runId?: string;
      readonly registerArtifact?: boolean;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [updated] = await db
      .update(files)
      .set({
        contentType: args.contentType,
        sizeBytes: args.size,
        ...(args.checksumSha256 !== undefined
          ? { checksumSha256: args.checksumSha256 }
          : {}),
      })
      .where(and(eq(files.id, args.id), isNull(files.deletedAt)))
      .returning({
        id: files.id,
        orgId: files.orgId,
        ownerUserId: files.ownerUserId,
        filename: files.filename,
        contentType: files.contentType,
        origin: files.origin,
        createdAt: files.createdAt,
      });
    signal.throwIfAborted();
    if (!updated) {
      return;
    }
    const shouldRegister =
      args.registerArtifact !== false &&
      args.url !== null &&
      updated.origin !== "system" &&
      (updated.origin === "agent" || args.runId !== undefined);
    if (shouldRegister) {
      await set(
        upsertFileArtifact$,
        {
          fileId: updated.id,
          orgId: updated.orgId,
          userId: updated.ownerUserId,
          filename: updated.filename ?? "file",
          contentType: updated.contentType,
          sourceUrl: args.url,
          runId: args.runId,
          createdAt: updated.createdAt,
        },
        signal,
      );
    }
  },
);
