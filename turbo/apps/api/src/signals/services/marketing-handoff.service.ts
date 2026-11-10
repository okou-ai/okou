import { createHash } from "node:crypto";
import { command } from "ccstate";
import { object, boolean } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { marketingContentGrants } from "@okouai/db/schema/marketing-content-grant";
import {
  MARKETING_HANDOFF_MAX_FILE_BYTES,
  marketingHandoffManifestSchema,
  serializeMarketingHandoff,
  type MarketingHandoffManifest,
} from "@okouai/api-contracts/contracts/marketing-handoffs";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { conflict } from "../../lib/error";
import { db$, writeDb$ } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  isS3NotFoundError,
  putImmutableS3Object,
} from "../external/s3";
import { settle } from "../utils";
import {
  allocatePrivateArtifact$,
  completePrivateArtifact$,
  privateArtifactRecord$,
} from "./private-artifact-storage.service";

export function marketingContentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function marketingHandoffBucket(): string | undefined {
  const bucket = env("R2_MARKETING_HANDOFF_BUCKET_NAME");
  if (!bucket) {
    return undefined;
  }
  if (
    bucket === env("R2_USER_ARTIFACTS_BUCKET_NAME") ||
    bucket === env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME") ||
    bucket === env("R2_USER_STORAGES_BUCKET_NAME") ||
    bucket === env("R2_HOSTED_SITES_BUCKET_NAME")
  ) {
    throw new Error("Marketing handoffs require a separate private bucket");
  }
  return bucket;
}

export const grantMarketingContent$ = command(
  async (
    { set },
    args: {
      resourceType: "manifest" | "file";
      resourceHash: string;
      subjects: readonly string[];
    },
    signal: AbortSignal,
  ) => {
    const sessionExpiry = new Date(
      nowDate().getTime() + 7 * 24 * 60 * 60 * 1000,
    );
    await set(writeDb$)
      .insert(marketingContentGrants)
      .values(
        args.subjects.map((subject) => {
          return {
            resourceType: args.resourceType,
            resourceHash: args.resourceHash,
            subject,
            expiresAt: subject.startsWith("session:") ? sessionExpiry : null,
          };
        }),
      )
      .onConflictDoUpdate({
        target: [
          marketingContentGrants.resourceType,
          marketingContentGrants.resourceHash,
          marketingContentGrants.subject,
        ],
        set: { expiresAt: sql`excluded.expires_at` },
      });
    signal.throwIfAborted();
  },
);

export const canReadMarketingContent$ = command(
  async (
    { get },
    args: {
      resourceType: "manifest" | "file";
      resourceHash: string;
      subjects: readonly string[];
    },
    signal: AbortSignal,
  ) => {
    const table = marketingContentGrants;
    const [grant] = await get(db$)
      .select({ subject: table.subject })
      .from(table)
      .where(
        and(
          eq(table.resourceType, args.resourceType),
          eq(table.resourceHash, args.resourceHash),
          inArray(table.subject, [...args.subjects, "public"]),
          or(isNull(table.expiresAt), gt(table.expiresAt, nowDate())),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return grant !== undefined;
  },
);

export const claimMarketingManifest$ = command(
  async (
    { set },
    args: {
      hash: string;
      userId: string;
      sessionSubject: string | null;
      manifest: MarketingHandoffManifest;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const table = marketingContentGrants;
    const subject = `user:${args.userId}`;
    const current = nowDate();
    const resources = [
      { resource_type: "manifest", resource_hash: args.hash },
      ...args.manifest.files.map((file) => {
        return { resource_type: "file", resource_hash: file.hash };
      }),
    ];
    // A valid browser session can authorize every account using that session.
    // Keep its grants until expiry while atomically publishing the user's grants.
    const rows = parseRawRows(
      object({ allowed: boolean() }),
      await db.execute(sql`
      WITH permitted AS (
        SELECT 1 FROM ${table}
        WHERE resource_type = 'manifest' AND resource_hash = ${args.hash}
          AND subject IN (${subject}, 'public', ${args.sessionSubject})
          AND (expires_at IS NULL OR expires_at > ${current.toISOString()})
      ), published AS (
        INSERT INTO ${table} (resource_type, resource_hash, subject)
        SELECT resource_type, resource_hash, ${subject}
        FROM jsonb_to_recordset(${JSON.stringify(resources)}::jsonb)
          AS content(resource_type text, resource_hash text)
        WHERE EXISTS (SELECT 1 FROM permitted)
        ON CONFLICT DO NOTHING RETURNING resource_hash
      )
      SELECT EXISTS (SELECT 1 FROM permitted) AS allowed
    `),
    );
    signal.throwIfAborted();
    const outcome = rows[0];
    if (!outcome) {
      throw new Error("Marketing authorization query returned no outcome");
    }
    return outcome.allowed;
  },
);

const reserveMarketingManifestAddress$ = command(
  async (
    { get, set },
    args: { bucket: string; hash: string; body: string },
    signal: AbortSignal,
  ) => {
    const shortHash = args.hash.slice(0, 12);
    await get(
      putImmutableS3Object(
        args.bucket,
        `manifest/${shortHash}.json`,
        args.body,
        "application/json",
        signal,
      ),
    );
    signal.throwIfAborted();
    const stored = await set(
      readMarketingManifest$,
      { bucket: args.bucket, hash: shortHash },
      signal,
    );
    return stored?.hash === args.hash;
  },
);

export const storeMarketingManifest$ = command(
  async (
    { get, set },
    args: {
      bucket: string;
      manifest: MarketingHandoffManifest;
      subjects: readonly string[];
    },
    signal: AbortSignal,
  ) => {
    const body = serializeMarketingHandoff(args.manifest);
    const hash = marketingContentHash(body);
    const shortHash = hash.slice(0, 12);
    // Conditional writes reserve the short address; compare full digests before granting access.
    const reserved = await set(
      reserveMarketingManifestAddress$,
      { bucket: args.bucket, hash, body },
      signal,
    );
    if (!reserved) {
      return conflict(
        "This handoff address is already in use. Edit your request and try again.",
      );
    }
    await get(
      putImmutableS3Object(
        args.bucket,
        `manifest/${hash}.json`,
        body,
        "application/json",
        signal,
      ),
    );
    signal.throwIfAborted();
    await set(
      grantMarketingContent$,
      {
        resourceType: "manifest",
        resourceHash: hash,
        subjects: args.subjects,
      },
      signal,
    );
    return { hash, shortHash };
  },
);

export const readMarketingManifest$ = command(
  async (
    { get },
    args: { bucket: string; hash: string },
    signal: AbortSignal,
  ): Promise<{ hash: string; manifest: MarketingHandoffManifest } | null> => {
    const downloaded = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          args.bucket,
          `manifest/${args.hash}.json`,
          128 * 1024,
          signal,
        ),
      ),
      signal,
    );
    if (!downloaded.ok) {
      if (isS3NotFoundError(downloaded.error)) {
        return null;
      }
      throw downloaded.error;
    }
    const body = downloaded.value;
    const hash = marketingContentHash(body);
    if (hash.slice(0, args.hash.length) !== args.hash) {
      throw new Error("Marketing manifest digest mismatch");
    }
    return {
      hash,
      manifest: marketingHandoffManifestSchema.parse(
        JSON.parse(body.toString("utf8")),
      ),
    };
  },
);

/** Retries share an import intent; another use of the same preset creates independent files. */
function importedFileId(
  userId: string,
  orgId: string,
  manifestHash: string,
  intentId: string,
  index: number,
): string {
  const bytes = createHash("sha256")
    .update(
      JSON.stringify([
        "marketing-handoff-v1",
        userId,
        orgId,
        manifestHash,
        intentId,
        index,
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const importMarketingFiles$ = command(
  async (
    { get, set },
    args: {
      bucket: string;
      hash: string;
      manifest: MarketingHandoffManifest;
      userId: string;
      orgId: string;
      intentId: string;
    },
    signal: AbortSignal,
  ) => {
    const files = [];
    for (const [index, file] of args.manifest.files.entries()) {
      const content = await get(
        downloadS3BufferWithMaxBytes(
          args.bucket,
          `files/${file.hash}`,
          MARKETING_HANDOFF_MAX_FILE_BYTES,
          signal,
        ),
      );
      signal.throwIfAborted();
      if (
        content.length !== file.size ||
        marketingContentHash(content) !== file.hash
      ) {
        throw new Error("Marketing file digest mismatch");
      }
      const location = await set(
        allocatePrivateArtifact$,
        {
          id: importedFileId(
            args.userId,
            args.orgId,
            args.hash,
            args.intentId,
            index,
          ),
          userId: args.userId,
          orgId: args.orgId,
          filename: file.filename,
          contentType: file.contentType,
          size: file.size,
        },
        signal,
      );
      await get(
        putImmutableS3Object(
          location.bucket,
          location.key,
          content,
          file.contentType,
          { signal, metadata: location.metadata },
        ),
      );
      signal.throwIfAborted();
      await set(
        completePrivateArtifact$,
        {
          id: location.id,
          url: location.url,
          contentType: file.contentType,
          size: file.size,
        },
        signal,
      );
      if (!(await set(privateArtifactRecord$, location.id, signal))) {
        throw new Error("The imported attachment is no longer available");
      }
      files.push({
        id: location.id,
        url: location.url,
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
      });
    }
    return files;
  },
);

export const deleteMarketingContentGrants$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    await set(writeDb$)
      .delete(marketingContentGrants)
      .where(eq(marketingContentGrants.subject, `user:${userId}`));
    signal.throwIfAborted();
  },
);
