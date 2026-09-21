import { createHash } from "node:crypto";

import { userExportEntries } from "@okouai/db/schema/user-export-entry";
import { command } from "ccstate";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";

import type { ApiDb } from "../../lib/db-types";
import {
  planUserExportZipRange,
  serializeUserExportZipCentralHeader,
  serializeUserExportZipEnd,
  serializeUserExportZipLocalHeader,
  type UserExportZipRangeSegment,
} from "../../lib/user-export-zip";
import {
  putS3Object,
  readS3ObjectRange,
  uploadMultipartS3Part,
  type MultipartS3Part,
} from "../external/s3";

const PART_BYTES = 16 * 1024 * 1024;
const STEP_BYTES = 4 * 1024 * 1024;
const MAX_PARTS = 10_000;
const LOCAL_ENTRY_BATCH = 16;
const CENTRAL_ENTRY_BATCH = 1000;

export interface UserExportAssemblyState {
  readonly localSize: number;
  readonly centralSize: number;
  readonly entryCount: number;
  readonly totalSize: number;
  readonly partNumber: number;
  readonly zipOffset: number;
  readonly pendingKey?: string;
  readonly pendingSize: number;
  readonly uploadId: string;
  readonly resultKey: string;
}

interface AssemblyArgs {
  readonly db: ApiDb;
  readonly bucket: string;
  readonly jobId: string;
  readonly userId: string;
  readonly state: UserExportAssemblyState;
}

interface AssemblySegments {
  readonly segments: readonly UserExportZipRangeSegment[];
  readonly etags: ReadonlyMap<string, string>;
  readonly end: number;
}

type ExportEntry = typeof userExportEntries.$inferSelect;

function localHeaderSizeSql() {
  return sql`30 + octet_length(${userExportEntries.path}) +
    CASE WHEN ${userExportEntries.size} >= 4294967295 THEN 20 ELSE 0 END`;
}

function centralHeaderSizeSql() {
  return sql`46 + octet_length(${userExportEntries.path}) +
    CASE WHEN ${userExportEntries.size} >= 4294967295 OR
      ${userExportEntries.localOffset} >= 4294967295 THEN 4 ELSE 0 END +
    CASE WHEN ${userExportEntries.size} >= 4294967295 THEN 16 ELSE 0 END +
    CASE WHEN ${userExportEntries.localOffset} >= 4294967295 THEN 8 ELSE 0 END`;
}

function entryEtag(entry: ExportEntry): string {
  const etag = entry.metadata.etag;
  if (typeof etag !== "string" || etag.length === 0) {
    throw new Error("User export source has an invalid immutable revision");
  }
  return etag;
}

async function localSegments(
  args: AssemblyArgs,
  end: number,
  signal: AbortSignal,
): Promise<AssemblySegments> {
  const rows = await args.db
    .select()
    .from(userExportEntries)
    .where(
      and(
        eq(userExportEntries.jobId, args.jobId),
        eq(userExportEntries.ready, true),
        lt(userExportEntries.localOffset, end),
        gt(
          sql`${userExportEntries.localOffset} + ${localHeaderSizeSql()} + ${userExportEntries.size}`,
          args.state.zipOffset,
        ),
      ),
    )
    .orderBy(asc(userExportEntries.localOffset), asc(userExportEntries.ordinal))
    .limit(LOCAL_ENTRY_BATCH);
  signal.throwIfAborted();
  const segments: UserExportZipRangeSegment[] = [];
  const etags = new Map<string, string>();
  let availableEnd = args.state.zipOffset;
  for (const entry of rows) {
    const header = serializeUserExportZipLocalHeader(entry);
    segments.push({ type: "bytes", offset: entry.localOffset, bytes: header });
    segments.push({
      type: "source",
      offset: entry.localOffset + header.length,
      size: entry.size,
      sourceKey: entry.sourceKey,
      sourceOffset: 0,
    });
    etags.set(entry.sourceKey, entryEtag(entry));
    availableEnd = entry.localOffset + header.length + entry.size;
  }
  return { segments, etags, end: Math.min(end, availableEnd) };
}

async function centralSegments(
  args: AssemblyArgs,
  end: number,
  signal: AbortSignal,
): Promise<AssemblySegments> {
  const rows = await args.db
    .select()
    .from(userExportEntries)
    .where(
      and(
        eq(userExportEntries.jobId, args.jobId),
        eq(userExportEntries.ready, true),
        lt(userExportEntries.centralOffset, end - args.state.localSize),
        gt(
          sql`${userExportEntries.centralOffset} + ${centralHeaderSizeSql()}`,
          args.state.zipOffset - args.state.localSize,
        ),
      ),
    )
    .orderBy(
      asc(userExportEntries.centralOffset),
      asc(userExportEntries.ordinal),
    )
    .limit(CENTRAL_ENTRY_BATCH);
  signal.throwIfAborted();
  const segments: UserExportZipRangeSegment[] = [];
  let availableEnd = args.state.zipOffset;
  for (const entry of rows) {
    const header = serializeUserExportZipCentralHeader({
      ...entry,
      localHeaderOffset: entry.localOffset,
    });
    const offset = args.state.localSize + entry.centralOffset;
    segments.push({ type: "bytes", offset, bytes: header });
    availableEnd = offset + header.length;
  }
  return {
    segments,
    etags: new Map(),
    end: Math.min(end, availableEnd),
  };
}

async function nextSegments(
  args: AssemblyArgs,
  signal: AbortSignal,
): Promise<AssemblySegments> {
  const { state } = args;
  const end = Math.min(
    state.zipOffset + STEP_BYTES,
    state.zipOffset + PART_BYTES - state.pendingSize,
    state.totalSize,
  );
  if (state.zipOffset < state.localSize) {
    return await localSegments(args, Math.min(end, state.localSize), signal);
  }
  const centralEnd = state.localSize + state.centralSize;
  if (state.zipOffset < centralEnd) {
    return await centralSegments(args, Math.min(end, centralEnd), signal);
  }
  const footer = serializeUserExportZipEnd({
    entryCount: state.entryCount,
    centralDirectoryOffset: state.localSize,
    centralDirectorySize: state.centralSize,
  });
  return {
    segments: [{ type: "bytes", offset: centralEnd, bytes: footer }],
    etags: new Map(),
    end,
  };
}

function validateState(state: UserExportAssemblyState): void {
  const sizes = [
    state.localSize,
    state.centralSize,
    state.entryCount,
    state.totalSize,
    state.zipOffset,
    state.pendingSize,
    state.partNumber,
  ];
  if (
    sizes.some((size) => {
      return !Number.isSafeInteger(size) || size < 0;
    })
  ) {
    throw new Error("Invalid persisted user export assembly offset");
  }
  const footer = serializeUserExportZipEnd({
    entryCount: state.entryCount,
    centralDirectoryOffset: state.localSize,
    centralDirectorySize: state.centralSize,
  });
  if (
    state.totalSize !== state.localSize + state.centralSize + footer.length ||
    state.totalSize > PART_BYTES * MAX_PARTS ||
    state.zipOffset > state.totalSize ||
    state.pendingSize >= PART_BYTES ||
    state.pendingSize > 0 !== (state.pendingKey !== undefined) ||
    state.partNumber < 1 ||
    state.partNumber > MAX_PARTS + 1
  ) {
    throw new Error("User export assembly state exceeds its multipart bounds");
  }
  const fullyUploaded =
    state.zipOffset === state.totalSize && state.pendingSize === 0;
  const matchesPart = fullyUploaded
    ? state.partNumber === Math.ceil(state.totalSize / PART_BYTES) + 1
    : state.zipOffset ===
      (state.partNumber - 1) * PART_BYTES + state.pendingSize;
  if (!matchesPart) {
    throw new Error("User export assembly checkpoint does not match its parts");
  }
}

/**
 * A step never owns or aborts the multipart upload. Its caller atomically commits
 * the returned checkpoint and part receipt under the job's current lease.
 */
export const assembleUserExportStep$ = command(
  async (
    { get },
    args: AssemblyArgs,
    signal: AbortSignal,
  ): Promise<{
    readonly state: UserExportAssemblyState;
    readonly part?: MultipartS3Part;
    readonly done: boolean;
  }> => {
    signal.throwIfAborted();
    const { state } = args;
    validateState(state);
    if (state.zipOffset === state.totalSize && state.pendingSize === 0) {
      return { state, done: true };
    }
    if (state.partNumber > MAX_PARTS) {
      throw new Error("User export exceeds the multipart part count limit");
    }
    const buffers: Buffer[] = [];
    if (state.pendingKey !== undefined) {
      const pending = await get(
        readS3ObjectRange(
          {
            bucket: args.bucket,
            key: state.pendingKey,
            offset: 0,
            length: state.pendingSize,
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      const digest = createHash("sha256").update(pending).digest("hex");
      if (
        state.pendingKey !==
        `exports/${args.userId}/${args.jobId}/staging/${digest}`
      ) {
        throw new Error("User export partial part failed its checksum");
      }
      buffers.push(pending);
    }
    const next = await nextSegments(args, signal);
    if (next.end <= state.zipOffset && state.zipOffset < state.totalSize) {
      throw new Error(
        "User export assembly is missing a required inventory entry",
      );
    }
    for (const fragment of planUserExportZipRange({
      offset: state.zipOffset,
      length: next.end - state.zipOffset,
      segments: next.segments,
    })) {
      if (fragment.type === "bytes") {
        buffers.push(fragment.bytes);
      } else {
        const etag = next.etags.get(fragment.sourceKey);
        if (!etag) {
          throw new Error("User export source has no immutable revision");
        }
        buffers.push(
          await get(
            readS3ObjectRange(
              {
                bucket: args.bucket,
                key: fragment.sourceKey,
                offset: fragment.offset,
                length: fragment.length,
                etag,
              },
              signal,
            ),
          ),
        );
      }
    }
    signal.throwIfAborted();
    const body = Buffer.concat(buffers);
    const done = next.end === state.totalSize;
    if (body.length === PART_BYTES || done) {
      const part = await get(
        uploadMultipartS3Part(
          {
            bucket: args.bucket,
            key: state.resultKey,
            uploadId: state.uploadId,
            partNumber: state.partNumber,
            body,
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      return {
        state: {
          ...state,
          zipOffset: next.end,
          partNumber: state.partNumber + 1,
          pendingKey: undefined,
          pendingSize: 0,
        },
        part,
        done,
      };
    }
    const digest = createHash("sha256").update(body).digest("hex");
    const pendingKey = `exports/${args.userId}/${args.jobId}/staging/${digest}`;
    await get(
      putS3Object(
        args.bucket,
        pendingKey,
        body,
        "application/octet-stream",
        signal,
      ),
    );
    signal.throwIfAborted();
    return {
      state: {
        ...state,
        zipOffset: next.end,
        pendingKey,
        pendingSize: body.length,
      },
      done: false,
    };
  },
);
