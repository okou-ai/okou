import { agentRuns } from "@okouai/db/runtime/agent-run";
import { command } from "ccstate";
import { inArray } from "drizzle-orm";
import { number, object, tuple } from "zod";

import { env } from "../../lib/env";
import {
  runPhaseTimingRollupSchema,
  type RunPhaseTimingMetadata,
  type RunPhaseTimingRollup,
  type RunPhaseTimingSourceWindow,
} from "../../lib/run-phase-timing-rollup";
import { getDatasetName, queryAxiom$ } from "../external/axiom";
import { db$ } from "../external/db";
import {
  isS3NotFoundError,
  putS3Object$,
  readS3ObjectWithEtag$,
} from "../external/s3";
import { settle } from "../utils";

const MAX_RAW_RECORDS = 10_000;
const METADATA_BATCH_SIZE = 500;
const MAX_DAILY_BYTES = 8 * 1024 * 1024;
const OBJECT_PREFIX = "telemetry/run-phase-timings/v1/";

export function runPhaseTimingRollupObjectKey(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error("Invalid rollup partition date");
  }
  return `${OBJECT_PREFIX}${date}.json`;
}

/** Raw observations are bounded independently of the number of matching Runs. */
export const readRunPhaseTimingMarks$ = command(
  async (
    { set },
    window: RunPhaseTimingSourceWindow,
    signal: AbortSignal,
  ): Promise<{
    readonly dataset: string;
    readonly records: readonly unknown[];
  }> => {
    const dataset = getDatasetName("web-logs");
    const source = `['${dataset}']\n| where type == "run_phase_mark"`;
    const options = {
      startTime: window.startTime,
      endTime: window.endTime,
      noCache: true,
      format: "tabular" as const,
    };
    const [summary] = tuple([
      object({
        record_count: number().int().nonnegative().lt(MAX_RAW_RECORDS),
      }),
    ]).parse(
      await set(
        queryAxiom$,
        { apl: `${source}\n| summarize record_count = count()`, options },
        signal,
      ),
    );
    signal.throwIfAborted();
    const records = await set(
      queryAxiom$,
      {
        apl: `${source}\n| order by _time asc\n| limit ${MAX_RAW_RECORDS + 1}`,
        options,
      },
      signal,
    );
    signal.throwIfAborted();
    // An unflagged provider cap or a source changing between reads is not a
    // complete snapshot. Fail closed rather than persist invented coverage.
    if (records.length !== summary.record_count) {
      throw new Error("Axiom phase records do not match the source count");
    }
    return { dataset, records };
  },
);

/** Only identities observed in the phase stream can enter this population. */
export const readRunPhaseTimingMetadata$ = command(
  async (
    { get },
    runIds: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly RunPhaseTimingMetadata[]> => {
    if (runIds.length >= MAX_RAW_RECORDS) {
      throw new Error("Phase metadata population is too large");
    }
    const db = get(db$);
    const runs: RunPhaseTimingMetadata[] = [];
    for (
      let offset = 0;
      offset < runIds.length;
      offset += METADATA_BATCH_SIZE
    ) {
      signal.throwIfAborted();
      const rows = await db
        .select({
          id: agentRuns.id,
          userId: agentRuns.userId,
          orgId: agentRuns.orgId,
          status: agentRuns.status,
          startedAt: agentRuns.startedAt,
          completedAt: agentRuns.completedAt,
        })
        .from(agentRuns)
        .where(
          inArray(
            agentRuns.id,
            runIds.slice(offset, offset + METADATA_BATCH_SIZE),
          ),
        );
      signal.throwIfAborted();
      runs.push(
        ...rows.map((row) => {
          return {
            ...row,
            startedAt: row.startedAt?.toISOString() ?? null,
            completedAt: row.completedAt?.toISOString() ?? null,
          };
        }),
      );
    }
    return runs;
  },
);

export const readRunPhaseTimingRollup$ = command(
  async (
    { set },
    date: string,
    signal: AbortSignal,
  ): Promise<{
    readonly rollup: RunPhaseTimingRollup;
    readonly etag: string;
  } | null> => {
    const read = await settle(
      set(
        readS3ObjectWithEtag$,
        {
          bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
          key: runPhaseTimingRollupObjectKey(date),
          maxBytes: MAX_DAILY_BYTES,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!read.ok) {
      if (isS3NotFoundError(read.error)) {
        return null;
      }
      throw read.error;
    }
    return {
      rollup: runPhaseTimingRollupSchema.parse(
        JSON.parse(read.value.buffer.toString("utf8")),
      ),
      etag: read.value.etag,
    };
  },
);

/** A precondition conflict fails this invocation; it is never automatically retried. */
export const writeRunPhaseTimingRollup$ = command(
  async (
    { set },
    args: {
      readonly rollup: RunPhaseTimingRollup;
      readonly etag: string | null;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const rollup = runPhaseTimingRollupSchema.parse(args.rollup);
    const body = JSON.stringify(rollup);
    if (Buffer.byteLength(body) > MAX_DAILY_BYTES) {
      throw new Error("Phase rollup exceeds its object size bound");
    }
    const key = runPhaseTimingRollupObjectKey(rollup.date);
    await set(
      putS3Object$,
      {
        bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
        key,
        body,
        contentType: "application/json",
        ...(args.etag === null
          ? { ifNoneMatch: "*" as const }
          : { ifMatch: args.etag }),
      },
      signal,
    );
    signal.throwIfAborted();
    return key;
  },
);
