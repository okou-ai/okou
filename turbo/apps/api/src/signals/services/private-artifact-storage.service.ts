import { randomUUID } from "node:crypto";
import {
  artifactReferencePath,
  artifactShareReferencePath,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import { command } from "ccstate";
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { boolean, literal, number, object, string, uuid } from "zod";
import {
  CURRENT_LINK_LAYOUT,
  linkLayoutFromSegment,
  linkLayoutSegment,
  linkLayoutSegmentSchema,
} from "@okouai/api-contracts/contracts/link-layout";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import type { FileOrigin } from "@okouai/db/schema/file";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import type { RunUploadedFileMetadata } from "@okouai/db/jsonb-contracts/run-uploaded-file";

import { env } from "../../lib/env";
import { sanitizeArtifactFilename } from "../../lib/file-url";
import { nowDate } from "../../lib/time";
import { parseRawRows } from "../../lib/db-raw-rows";
import { apiBackendUrl } from "../../lib/api-backend-url";
import { type ReadonlyDb, db$, writeDb$ } from "../external/db";
import { safeUrlParse } from "../utils";
import {
  allocateArtifactReference$,
  artifactReferenceRecord$,
} from "./artifact-reference.service";
import {
  queueChangedArtifactCatalogFileSql,
  syncArtifactCatalogForFile$,
} from "./artifact-catalog.service";
import {
  dualWriteFileRecord$,
  dualWriteFileUpdate$,
} from "./files-dual-write.service";

const PRIVATE_STORAGE = "private-artifact-v1";
export type PrivateArtifactPurpose =
  "artifact" | "hosted-preview" | "browser-screenshot" | "marketing-handoff";

function fileOriginForPrivateArtifact(
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
export type PrivateArtifactUploadProtocol =
  | { readonly kind: "fixed-size-put-v1"; readonly size: number }
  | { readonly kind: "multipart-v1" };

const uploadProtocolSchema = object({
  kind: literal("fixed-size-put-v1"),
  size: number().int().nonnegative().safe(),
}).or(object({ kind: literal("multipart-v1") }));

export function readPrivateAttachmentRows(
  db: ReadonlyDb,
  predicate: SQL | undefined,
) {
  return db
    .select({
      id: runUploadedFiles.id,
      orgId: runUploadedFiles.orgId,
      userId: runUploadedFiles.userId,
      deletedAt: runUploadedFiles.deletedAt,
      metadata: runUploadedFiles.metadata,
      storageKey: runUploadedFiles.storageKey,
      filename: runUploadedFiles.filename,
      contentType: runUploadedFiles.contentType,
      sizeBytes: runUploadedFiles.sizeBytes,
      materializationStatus: runUploadedFiles.materializationStatus,
    })
    .from(runUploadedFiles)
    .where(predicate);
}

export type PrivateAttachmentRow = Awaited<
  ReturnType<typeof readPrivateAttachmentRows>
>[number];

/** Only ordinary upload preparation mints this metadata-stability contract. */
export function completedPrivateAttachmentSize(
  row: Pick<
    PrivateAttachmentRow,
    "metadata" | "materializationStatus" | "sizeBytes"
  >,
): number | null {
  const protocol = uploadProtocolSchema.safeParse(row.metadata.uploadProtocol);
  if (
    !protocol.success ||
    row.materializationStatus !== "ready" ||
    row.sizeBytes === null ||
    !Number.isSafeInteger(row.sizeBytes) ||
    row.sizeBytes < 0
  ) {
    return null;
  }
  // Single-PUT retries may replace bytes, but the signed length cannot change.
  // Multipart completion consumes the only upload ID issued for this new key.
  // Every ready writer for these identities first verifies the stored object,
  // including canonical registration of a pending attachment after its HEAD.
  return protocol.data.kind === "multipart-v1" ||
    protocol.data.size === row.sizeBytes
    ? row.sizeBytes
    : null;
}
const privateMetadataSchema = object({
  storage: literal(PRIVATE_STORAGE),
  bucket: string().min(1),
  // Link-layout marker of the file's shares; the key name is persisted.
  publicBrand: linkLayoutSegmentSchema,
  artifactReference: string()
    .regex(/^[a-z0-9]{10}$/u)
    .optional(),
});

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

export function privateArtifactUrl(
  id: string,
  filename: string,
  metadata: RunUploadedFileMetadata,
): string {
  if (metadata.artifactReference !== undefined) {
    return privateArtifactReferenceUrl(
      string().parse(metadata.artifactReference),
      filename,
    );
  }
  // Persisted private files created before short references retain their ID.
  return new URL(artifactReferencePath(id, filename), env("APP_URL")).href;
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
      // Declared by the uploader. Only `purpose: "artifact"` belongs in the
      // catalog; ordinary attachments and system-process files do not.
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
    const storageMetadata = {
      storage: PRIVATE_STORAGE,
      bucket,
      publicBrand: linkLayoutSegment(CURRENT_LINK_LAYOUT),
      artifactReference,
      ...(args.purpose ? { purpose: args.purpose } : {}),
    };
    return {
      id,
      key: `private-artifacts/${id}/${sanitizeArtifactFilename(filename)}`,
      bucket,
      url: privateArtifactUrl(id, filename, storageMetadata),
      layout: CURRENT_LINK_LAYOUT,
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
          ...(args.purpose === "artifact" && args.runId
            ? { producingRunId: args.runId }
            : {}),
          ...(args.uploadProtocol
            ? { uploadProtocol: args.uploadProtocol }
            : {}),
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
        existing.metadata.publicBrand !==
          location.storageMetadata.publicBrand ||
        existing.storageKey !== key ||
        existing.filename !== args.filename ||
        existing.contentType !== args.contentType
      ) {
        throw new Error("Private artifact identity belongs to another object");
      }
    }
    await set(
      dualWriteFileRecord$,
      {
        id,
        orgId: args.orgId,
        ownerUserId: args.userId,
        storageKey: key,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.size,
        origin: fileOriginForPrivateArtifact(args.purpose, args.runId),
      },
      signal,
    );
    return location;
  },
);

/** Decode a fetched row without issuing another ownership-record read. */
export function privateArtifactFromRow<
  Row extends Omit<PrivateAttachmentRow, "sizeBytes" | "materializationStatus">,
>(row: Row | undefined) {
  if (!row || row.metadata.storage === undefined || row.deletedAt !== null) {
    return null;
  }
  const { publicBrand, ...metadata } = privateMetadataSchema.parse(
    row.metadata,
  );
  if (!row.orgId || !row.storageKey || !row.filename || !row.contentType) {
    throw new Error(
      `Private artifact ${row.id} has incomplete storage metadata`,
    );
  }
  if (metadata.bucket !== privateArtifactsBucket()) {
    throw new Error(
      `Private artifact ${row.id} does not match the configured private bucket`,
    );
  }
  return {
    ...row,
    orgId: row.orgId,
    key: row.storageKey,
    filename: row.filename,
    contentType: row.contentType,
    ...metadata,
    layout: linkLayoutFromSegment(publicBrand),
  };
}

export type PrivateArtifactRecord = NonNullable<
  ReturnType<
    typeof privateArtifactFromRow<typeof runUploadedFiles.$inferSelect>
  >
>;

export const privateArtifactRecord$ = command(
  async ({ get }, id: string, signal: AbortSignal) => {
    // Historical file IDs are not all UUIDs; the database key is a UUID.
    if (!uuid().safeParse(id).success) {
      return null;
    }
    const [row] = await get(db$)
      .select()
      .from(runUploadedFiles)
      .where(
        and(eq(runUploadedFiles.id, id), isNull(runUploadedFiles.deletedAt)),
      )
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
      // Internal previews and browser captures keep their reference on the
      // owning record, without publishing a standalone catalog file.
      readonly url: string | null;
      readonly contentType: string;
      readonly size: number;
      readonly runId?: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const producingThread = args.runId
      ? sql`(${db
          .select({ chatThreadId: agentRuns.chatThreadId })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, args.runId),
              eq(agentRuns.orgId, runUploadedFiles.orgId),
              isNotNull(agentRuns.triggerSource),
            ),
          )
          .limit(1)})`
      : sql`NULL`;
    // A completed file and its durable catalog handoff must commit together.
    const [outcome] = parseRawRows(
      object({ changed: boolean() }),
      await db.execute(
        queueChangedArtifactCatalogFileSql(
          args.id,
          db
            .update(runUploadedFiles)
            .set({
              // Publish the creating thread with the first URL, before catalog
              // registration. A retry must preserve a deleted thread's NULL.
              chatThreadId: sql`CASE WHEN ${isNull(runUploadedFiles.url)}
                THEN COALESCE(${runUploadedFiles.chatThreadId}, ${producingThread})
                ELSE ${runUploadedFiles.chatThreadId} END`,
              url: args.url,
              contentType: args.contentType,
              sizeBytes: args.size,
              materializationStatus: "ready",
              updatedAt: nowDate(),
            })
            .where(eq(runUploadedFiles.id, args.id))
            .returning({
              id: runUploadedFiles.id,
              orgId: runUploadedFiles.orgId,
              userId: runUploadedFiles.userId,
              chatThreadId: runUploadedFiles.chatThreadId,
              runId: runUploadedFiles.runId,
              url: runUploadedFiles.url,
            })
            .getSQL(),
        ),
      ),
    );
    signal.throwIfAborted();
    if (!outcome) {
      throw new Error("Private artifact completion returned no outcome");
    }
    await set(
      dualWriteFileUpdate$,
      {
        id: args.id,
        contentType: args.contentType,
        sizeBytes: args.size,
      },
      signal,
    );
    if (outcome.changed) {
      await set(syncArtifactCatalogForFile$, args.id, signal);
    }
  },
);
