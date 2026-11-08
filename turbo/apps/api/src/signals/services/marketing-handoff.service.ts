import { createHash } from "node:crypto";
import { accept } from "@okouai/connectors/accept";
import { command } from "ccstate";
import { object, boolean, record, string, unknown } from "zod";
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

function marketingManifestBucketKey(bucket: string): string {
  return `${env("R2_ACCOUNT_ID")}/${bucket}`;
}

export const grantMarketingContent$ = command(
  async (
    { set },
    args: {
      resourceType: "manifest" | "file";
      resourceHash: string;
      subject: string;
      verifiedManifestBucket?: string;
    },
    signal: AbortSignal,
  ) => {
    const expiresAt = args.subject.startsWith("session:")
      ? new Date(nowDate().getTime() + 7 * 24 * 60 * 60 * 1000)
      : null;
    await set(writeDb$)
      .insert(marketingContentGrants)
      .values({ ...args, expiresAt })
      .onConflictDoUpdate({
        target: [
          marketingContentGrants.resourceType,
          marketingContentGrants.resourceHash,
          marketingContentGrants.subject,
        ],
        set: { expiresAt, verifiedManifestBucket: args.verifiedManifestBucket },
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

/** Public grants are publication receipts, written only after immutable storage. */
export const publicMarketingContentHashes$ = command(
  async (
    { get },
    args: { resourceType: "manifest" | "file"; hashes: readonly string[] },
    signal: AbortSignal,
  ) => {
    if (args.hashes.length === 0) {
      return new Set<string>();
    }
    const table = marketingContentGrants;
    const grants = await get(db$)
      .select({ hash: table.resourceHash })
      .from(table)
      .where(
        and(
          eq(table.resourceType, args.resourceType),
          inArray(table.resourceHash, args.hashes),
          eq(table.subject, "public"),
          isNull(table.expiresAt),
        ),
      );
    signal.throwIfAborted();
    return new Set(
      grants.map(({ hash }) => {
        return hash;
      }),
    );
  },
);

/** Bind a guest grant to one signed-in identity without consuming a shared hash. */
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
    // Consuming the guest manifest and publishing all user grants commit together.
    // A concurrent loser cannot publish grants from the same guest authorization.
    const rows = parseRawRows(
      object({ allowed: boolean() }),
      await db.execute(sql`
      WITH direct AS (
        SELECT 1 FROM ${table}
        WHERE resource_type = 'manifest' AND resource_hash = ${args.hash}
          AND subject IN (${subject}, 'public')
          AND (expires_at IS NULL OR expires_at > ${current.toISOString()})
      ), claimed AS (
        DELETE FROM ${table}
        WHERE resource_type = 'manifest' AND resource_hash = ${args.hash}
          AND subject = ${args.sessionSubject}
          AND expires_at > ${current.toISOString()}
          AND NOT EXISTS (SELECT 1 FROM direct)
        RETURNING resource_hash
      ), permitted AS (
        SELECT 1 FROM direct UNION ALL SELECT 1 FROM claimed
      ), published AS (
        INSERT INTO ${table} (resource_type, resource_hash, subject)
        SELECT resource_type, resource_hash, ${subject}
        FROM jsonb_to_recordset(${JSON.stringify(resources)}::jsonb)
          AS content(resource_type text, resource_hash text)
        WHERE EXISTS (SELECT 1 FROM permitted)
        ON CONFLICT DO NOTHING RETURNING resource_hash
      ), removed_files AS (
        DELETE FROM ${table}
        WHERE resource_type = 'file' AND subject = ${args.sessionSubject}
          AND resource_hash IN (
            SELECT resource_hash FROM jsonb_to_recordset(${JSON.stringify(resources)}::jsonb)
              AS content(resource_type text, resource_hash text)
            WHERE resource_type = 'file'
          )
          AND EXISTS (SELECT 1 FROM permitted)
        RETURNING resource_hash
      )
      SELECT EXISTS (SELECT 1 FROM permitted) AS allowed
    `),
    );
    signal.throwIfAborted();
    if (rows[0]?.allowed) {
      return true;
    }
    // A concurrent request by this same user may have committed after our snapshot.
    const [transferred] = await db
      .select({ subject: table.subject })
      .from(table)
      .where(
        and(
          eq(table.resourceType, "manifest"),
          eq(table.resourceHash, args.hash),
          eq(table.subject, subject),
          or(isNull(table.expiresAt), gt(table.expiresAt, current)),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return transferred !== undefined;
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

/** Reuse immutable full/short bindings only in the R2 account/bucket verified. */
export const publicMarketingManifestHashes$ = command(
  async (
    { get, set },
    args: { bucket: string; hashes: readonly string[] },
    signal: AbortSignal,
  ) => {
    if (args.hashes.length === 0) {
      return new Set<string>();
    }
    const table = marketingContentGrants;
    const verifiedBucket = marketingManifestBucketKey(args.bucket);
    const grants = await get(db$)
      .select({
        hash: table.resourceHash,
        verifiedBucket: table.verifiedManifestBucket,
      })
      .from(table)
      .where(
        and(
          eq(table.resourceType, "manifest"),
          inArray(table.resourceHash, args.hashes),
          eq(table.subject, "public"),
          isNull(table.expiresAt),
        ),
      );
    signal.throwIfAborted();
    const verified = new Set<string>();
    const unverified = [];
    for (const grant of grants) {
      if (grant.verifiedBucket === verifiedBucket) {
        verified.add(grant.hash);
      } else {
        unverified.push(grant.hash);
      }
    }
    // Backfill old receipts in bounded groups so a cancelled inventory keeps
    // completed verification work. Missing grants never qualify for backfill.
    for (let start = 0; start < unverified.length; start += 100) {
      const hashes = unverified.slice(start, start + 100);
      const checked: string[] = [];
      for (let offset = 0; offset < hashes.length; offset += 4) {
        const results = await Promise.allSettled(
          hashes.slice(offset, offset + 4).map(async (hash) => {
            const short = await set(
              readMarketingManifest$,
              { bucket: args.bucket, hash: hash.slice(0, 12) },
              signal,
            );
            if (short?.hash !== hash) {
              return;
            }
            const full = await set(
              readMarketingManifest$,
              { bucket: args.bucket, hash },
              signal,
            );
            if (full?.hash === hash) {
              checked.push(hash);
            }
          }),
        );
        signal.throwIfAborted();
        const failure = results.find((result) => {
          return result.status === "rejected";
        });
        if (failure) {
          throw failure.reason;
        }
      }
      if (checked.length === 0) {
        continue;
      }
      const recorded = await set(writeDb$)
        .update(table)
        .set({ verifiedManifestBucket: verifiedBucket })
        .where(
          and(
            eq(table.resourceType, "manifest"),
            inArray(table.resourceHash, checked),
            eq(table.subject, "public"),
            isNull(table.expiresAt),
          ),
        )
        .returning({ hash: table.resourceHash });
      signal.throwIfAborted();
      for (const { hash } of recorded) {
        verified.add(hash);
      }
    }
    return verified;
  },
);

export const storeMarketingManifest$ = command(
  async (
    { get, set },
    args: {
      bucket: string;
      manifest: MarketingHandoffManifest;
      subject: string;
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
        subject: args.subject,
        verifiedManifestBucket: marketingManifestBucketKey(args.bucket),
      },
      signal,
    );
    return { hash, shortHash };
  },
);

const MARKETING_PRESET_SHARD_MAX_BYTES = 256 * 1024;
const MARKETING_PRESET_FETCH_TIMEOUT_MS = 10_000;
const marketingPresetShardSchema = record(string(), unknown());

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        throw new Error("Marketing preset shard is too large");
      }
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/**
 * Marketing deploys every preset in static shards keyed by the 12-character
 * address its links carry: `/handoff/v1/<first two hex characters>.json`.
 * Only an entry whose canonical digest matches the requested address counts.
 */
async function fetchMarketingPreset(
  origin: string,
  hash: string,
  signal: AbortSignal,
): Promise<MarketingHandoffManifest | null> {
  const response = await accept(
    fetch(new URL(`/handoff/v1/${hash.slice(0, 2)}.json`, origin), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(MARKETING_PRESET_FETCH_TIMEOUT_MS),
      ]),
    }),
    [200, 404],
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  const shard = marketingPresetShardSchema.parse(
    JSON.parse(
      await readBoundedText(response, MARKETING_PRESET_SHARD_MAX_BYTES),
    ),
  );
  const entry = shard[hash.slice(0, 12)];
  if (entry === undefined) {
    return null;
  }
  const manifest = marketingHandoffManifestSchema.parse(entry);
  if (
    !marketingContentHash(serializeMarketingHandoff(manifest)).startsWith(hash)
  ) {
    return null;
  }
  // Public file access needs its own publication; presets carry prompts only.
  if (manifest.files.length > 0) {
    throw new Error("Marketing presets cannot reference files");
  }
  return manifest;
}

/** Grant a preset served by the deployed Marketing site as public content. */
export const publishServedMarketingPreset$ = command(
  async (
    { set },
    args: { bucket: string; hash: string },
    signal: AbortSignal,
  ): Promise<{ hash: string; manifest: MarketingHandoffManifest } | null> => {
    const origin = env("MARKETING_HANDOFF_PRESET_ORIGIN");
    if (!origin) {
      return null;
    }
    const manifest = await fetchMarketingPreset(origin, args.hash, signal);
    signal.throwIfAborted();
    if (!manifest) {
      return null;
    }
    const stored = await set(
      storeMarketingManifest$,
      { bucket: args.bucket, manifest, subject: "public" },
      signal,
    );
    return "status" in stored ? null : { hash: stored.hash, manifest };
  },
);

export const publishMarketingManifests$ = command(
  async (
    { get, set },
    args: { bucket: string; manifests: readonly MarketingHandoffManifest[] },
    signal: AbortSignal,
  ) => {
    const verifiedManifestBucket = marketingManifestBucketKey(args.bucket);
    const publications = new Map(
      args.manifests.map((manifest) => {
        const body = serializeMarketingHandoff(manifest);
        return [marketingContentHash(body), { body, manifest }] as const;
      }),
    );
    const hashes = [...publications.keys()];
    const published = await set(
      publicMarketingManifestHashes$,
      { bucket: args.bucket, hashes },
      signal,
    );
    const missing = [...publications].filter(([hash]) => {
      return !published.has(hash);
    });
    if (missing.length === 0) {
      return hashes;
    }
    const fileHashes = [
      ...new Set(
        missing.flatMap(([, { manifest }]) => {
          return manifest.files.map((file) => {
            return file.hash;
          });
        }),
      ),
    ];
    const publicFiles = await set(
      publicMarketingContentHashes$,
      { resourceType: "file", hashes: fileHashes },
      signal,
    );
    if (
      fileHashes.some((hash) => {
        return !publicFiles.has(hash);
      })
    ) {
      return null;
    }
    // Bound R2 pressure and settle every owned write before failing the request.
    // Failed batches publish no grants; retry safely reuses any immutable objects.
    for (let offset = 0; offset < missing.length; offset += 4) {
      signal.throwIfAborted();
      const results = await Promise.allSettled(
        missing.slice(offset, offset + 4).map(async ([hash, { body }]) => {
          const reserved = await set(
            reserveMarketingManifestAddress$,
            { bucket: args.bucket, hash, body },
            signal,
          );
          if (!reserved) {
            return false;
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
          return true;
        }),
      );
      signal.throwIfAborted();
      const failure = results.find((result) => {
        return result.status === "rejected";
      });
      if (failure) {
        throw failure.reason;
      }
      if (
        results.some((result) => {
          return result.status === "fulfilled" && !result.value;
        })
      ) {
        return conflict(
          "This handoff address is already in use. Edit your request and try again.",
        );
      }
    }
    await set(writeDb$)
      .insert(marketingContentGrants)
      .values(
        missing.map(([hash]) => {
          return {
            resourceType: "manifest" as const,
            resourceHash: hash,
            subject: "public",
            expiresAt: null,
            verifiedManifestBucket,
          };
        }),
      )
      .onConflictDoUpdate({
        target: [
          marketingContentGrants.resourceType,
          marketingContentGrants.resourceHash,
          marketingContentGrants.subject,
        ],
        set: { expiresAt: null, verifiedManifestBucket },
      });
    signal.throwIfAborted();
    return hashes;
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
