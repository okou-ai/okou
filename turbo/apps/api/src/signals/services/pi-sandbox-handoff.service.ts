import { createHash } from "node:crypto";

import {
  CANONICAL_WORKING_DIR,
  PI_API_FIRST_TURN_SESSION_MAX_BYTES,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  type PiApiFirstTurnManifest,
  type StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";
import { blobs } from "@okouai/db/schema/blob";
import { createPiSessionJsonl } from "@okouai/pi-agent-runtime/api";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { isPiLangfuseDebugRunEnvironment } from "../../lib/pi-langfuse-debug";
import { piLangfuseSandboxParent } from "../../lib/pi-langfuse-tracing";
import { now } from "../../lib/time";
import type { Db } from "../external/db";
import { generatePresignedGetUrl, putS3Object } from "../external/s3";
import {
  normalizeSessionHistoryBlobEncoding,
  resumeSessionHistoryBlobKey,
  SESSION_HISTORY_ENCODING_IDENTITY,
} from "./session-history-blobs";

/**
 * Pi sandbox launch handoff.
 *
 * Every Pi run executes its turns in the Sandbox. The runner-facing launch
 * contract (`piLaunchConfig.apiFirstTurn`) still makes the Pi CLI poll a
 * per-run manifest and restore the session it names before the official RPC
 * host starts, so the API publishes a no-inference `sandbox-first` handoff
 * before the run and its runner job are committed:
 *
 * - a first turn or inline resume history publishes the session bytes as the
 *   per-run session object plus a v3 manifest;
 * - blob-backed resume history publishes only a v4 manifest that references
 *   the stored history blob by a signed URL.
 *
 * The objects live under the `pi-api-first-turn/<runId>/` prefix. Completion
 * deletes them and the cleanup cron sweeps expired leftovers.
 */

/** Wire deadline for the CLI to read the manifest and restore the session. */
export const PI_SANDBOX_HANDOFF_DEADLINE_MS = 55_000;
export const PI_SANDBOX_HANDOFF_OBJECT_TTL_SECONDS = PRESIGNED_URL_TTL_SECONDS;
export const PI_SANDBOX_HANDOFF_OBJECT_PREFIX = "pi-api-first-turn";

export function piSandboxHandoffObjectKey(
  runId: string,
  object: "manifest" | "session",
): string {
  return `${PI_SANDBOX_HANDOFF_OBJECT_PREFIX}/${runId}/${object}.json${
    object === "session" ? "l" : ""
  }`;
}

type HandoffExecutionContext = Pick<
  StoredExecutionContext,
  "piLaunchConfig" | "piSessionId" | "platformEnvironment" | "resumeSession"
>;

type BlobHistoryRef = Extract<
  NonNullable<StoredExecutionContext["resumeSession"]>,
  { historyRef: unknown }
>["historyRef"];

async function readHistoryBlobMetadata(
  db: Db,
  historyRef: BlobHistoryRef,
  signal: AbortSignal,
) {
  const [metadata] = await db
    .select({
      rawSize: blobs.rawSize,
      encoding: blobs.encoding,
      encodedSize: blobs.encodedSize,
    })
    .from(blobs)
    .where(eq(blobs.hash, historyRef.hash))
    .limit(1);
  signal.throwIfAborted();
  if (
    !metadata ||
    metadata.rawSize <= 0 ||
    metadata.encodedSize <= 0 ||
    metadata.rawSize > RESUME_SESSION_HISTORY_MAX_BYTES ||
    metadata.encodedSize > RESUME_SESSION_HISTORY_MAX_BYTES
  ) {
    throw new Error("Pi resume history metadata is unavailable or invalid");
  }
  const encoding = normalizeSessionHistoryBlobEncoding(metadata.encoding);
  if (encoding !== (historyRef.encoding ?? SESSION_HISTORY_ENCODING_IDENTITY)) {
    throw new Error(
      "Pi resume history encoding does not match the stored reference",
    );
  }
  return {
    rawSize: metadata.rawSize,
    encodedSize: metadata.encodedSize,
    encoding,
  };
}

/** Publish the launch handoff the Pi CLI waits for; maintenance runs have none. */
export const publishPiSandboxHandoff$ = command(
  async function publishPiSandboxHandoff(
    { get },
    args: {
      readonly db: Db;
      readonly runId: string;
      readonly apiStartTime: number;
      readonly executionContext: HandoffExecutionContext;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const { piLaunchConfig, piSessionId, resumeSession } =
      args.executionContext;
    if (!piLaunchConfig || piLaunchConfig.maintenance) {
      return;
    }
    if (!piSessionId) {
      throw new Error("Pi launch is missing its session id");
    }
    const launch = piLaunchConfig.apiFirstTurn;
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const shared = {
      outcome: "ownership-transfer",
      mode: "sandbox-first",
      baseSession: launch.baseSession,
      sandboxEventSequenceStart: launch.sandboxEventSequenceStart,
      langfuseParent: piLangfuseSandboxParent({
        enabled: isPiLangfuseDebugRunEnvironment(
          args.executionContext.platformEnvironment,
        ),
        runId: args.runId,
        sessionId: piSessionId,
        sandboxWaitStartedAt: now(),
      }),
      apiUsage: {
        schemaVersion: 1,
        state: "no-inference",
        sampledAt: now(),
      },
    } as const;
    const writeManifest = (
      manifest: PiApiFirstTurnManifest,
      writeSignal: AbortSignal,
    ) => {
      return get(
        putS3Object(
          bucket,
          piSandboxHandoffObjectKey(args.runId, "manifest"),
          JSON.stringify(manifest),
          "application/json",
          writeSignal,
        ),
      );
    };

    if (resumeSession && "historyRef" in resumeSession) {
      const { historyRef } = resumeSession;
      const metadata = await readHistoryBlobMetadata(
        args.db,
        historyRef,
        signal,
      );
      const url = await get(
        generatePresignedGetUrl(
          bucket,
          resumeSessionHistoryBlobKey(historyRef.hash, metadata.encoding),
          undefined,
          true,
        ),
      );
      signal.throwIfAborted();
      await writeManifest(
        {
          ...shared,
          schemaVersion: 4,
          session: {
            sessionId: piSessionId,
            sha256: historyRef.hash,
            rawSize: metadata.rawSize,
          },
          history: {
            url,
            encoding: metadata.encoding,
            encodedSize: metadata.encodedSize,
          },
        },
        signal,
      );
      return;
    }

    const bytes = Buffer.from(
      resumeSession
        ? resumeSession.sessionHistory
        : createPiSessionJsonl({
            cwd: CANONICAL_WORKING_DIR,
            sessionId: piSessionId,
            timestamp: new Date(args.apiStartTime).toISOString(),
          }),
      "utf8",
    );
    if (
      bytes.length === 0 ||
      bytes.length > PI_API_FIRST_TURN_SESSION_MAX_BYTES
    ) {
      throw new Error("Pi launch session is empty or exceeds its size limit");
    }
    // Nothing can claim the run before its commit. The manifest names the
    // session, so it is written only after the session exists.
    await get(
      putS3Object(
        bucket,
        piSandboxHandoffObjectKey(args.runId, "session"),
        bytes,
        "application/x-ndjson",
        signal,
      ),
    );
    signal.throwIfAborted();
    await writeManifest(
      {
        ...shared,
        schemaVersion: 3,
        session: {
          sessionId: piSessionId,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          rawSize: bytes.length,
        },
      },
      signal,
    );
  },
);
