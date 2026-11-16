import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { cronAggregateRunPhaseTimingsContract } from "@okouai/api-contracts/contracts/cron";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { object, string } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { runPhaseTimingRollupSchema } from "../../../lib/run-phase-timing-rollup";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { cronAggregateRunPhaseTimingsRoutes } from "../cron-aggregate-run-phase-timings";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";
import { completePublicClaudeRun } from "./helpers/public-native-run";

const context = testContext();
const CUTOFF = "2026-11-16T00:00:00.000Z";
const headers = Object.freeze({ authorization: "Bearer test-cron-secret" });
const PREFIX = "telemetry/run-phase-timings/v1/";

function client() {
  return setupApp({ context, routes: cronAggregateRunPhaseTimingsRoutes })(
    cronAggregateRunPhaseTimingsContract,
  );
}

function phaseSource(records: readonly unknown[]) {
  context.mocks.axiom.query.mockImplementation((apl: unknown) => {
    if (typeof apl !== "string") {
      throw new Error("Expected an APL query");
    }
    return Promise.resolve(
      apl.includes("summarize record_count")
        ? [{ record_count: records.length }]
        : records,
    );
  });
}

function objectStorage(conflict = false) {
  const objects = new Map<string, { body: string; etag: string }>();
  const writes: PutObjectCommand["input"][] = [];
  context.mocks.s3.send.mockImplementation((request: unknown) => {
    if (request instanceof GetObjectCommand) {
      const object = objects.get(
        `${request.input.Bucket}/${request.input.Key}`,
      );
      if (!object) {
        throw Object.assign(new Error("Missing object"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        });
      }
      return Promise.resolve({
        Body: Readable.from([Buffer.from(object.body)]),
        ContentLength: Buffer.byteLength(object.body),
        ETag: object.etag,
      });
    }
    if (request instanceof PutObjectCommand) {
      writes.push(request.input);
      const key = `${request.input.Bucket}/${request.input.Key}`;
      const existing = objects.get(key);
      if (
        conflict ||
        (request.input.IfNoneMatch === "*" && existing) ||
        (request.input.IfMatch !== undefined &&
          request.input.IfMatch !== existing?.etag)
      ) {
        throw Object.assign(new Error("Conditional write conflict"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        });
      }
      if (typeof request.input.Body !== "string") {
        throw new Error("Expected JSON object bytes");
      }
      const etag = `"revision-${writes.length}"`;
      objects.set(key, { body: request.input.Body, etag });
      return Promise.resolve({ ETag: etag });
    }
    throw new Error("Unexpected object-storage operation");
  });
  return { objects, writes };
}

async function completedRunMarks() {
  let clock = Date.parse("2026-11-14T16:00:00.000Z");
  const owned = await publicChatActor(context, {
    clockTime: () => {
      return clock;
    },
  });
  const runs = createRunsApi(context);
  const run = await owned.run(() => {
    return runs.createThreadRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Create the daily aggregation report",
      model: owned.model,
    });
  });
  const execution = await owned.executionInput(run.runId);
  clock += 10_000;
  await owned.run(() => {
    return completePublicClaudeRun(
      context,
      run,
      { authorization: `Bearer ${execution.sandboxToken}` },
      "Report delivered",
    );
  });
  const metadata = await owned.run(() => {
    return runs.readRun(owned.actor, run.runId);
  });
  if (!metadata.startedAt || !metadata.completedAt || !owned.actor.orgId) {
    throw new Error("Expected completed public Run clocks and ownership");
  }
  const base = {
    schema_version: 1,
    type: "run_phase_mark",
    run_id: run.runId,
    user_id: owned.actor.userId,
    org_id: owned.actor.orgId,
  };
  const started = Date.parse(metadata.startedAt);
  return [
    {
      ...base,
      _time: new Date(started + 1000).toISOString(),
      phase: "research-start",
    },
    {
      ...base,
      _time: new Date(started + 2000).toISOString(),
      phase: "generation-start",
      generation_kind: "report",
      research_skipped: false,
    },
  ];
}

describe("daily Run phase aggregation cron", () => {
  it("requires the operator cron secret before reading or publishing", async () => {
    const response = await accept(client().aggregate({ headers: {} }), [401]);
    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("persists only the two completed Beijing dates with conditional private JSON writes", async () => {
    mockNow(new Date(CUTOFF));
    phaseSource([]);
    const storage = objectStorage();
    const response = await accept(client().aggregate({ headers }), [200]);
    expect(response.body).toStrictEqual({
      success: true,
      days: [
        {
          date: "2026-11-14",
          objectKey: `${PREFIX}2026-11-14.json`,
          markedRuns: 0,
        },
        {
          date: "2026-11-15",
          objectKey: `${PREFIX}2026-11-15.json`,
          markedRuns: 0,
        },
      ],
    });
    expect(context.mocks.axiom.query).toHaveBeenCalledWith(
      expect.stringContaining('type == "run_phase_mark"'),
      expect.objectContaining({
        startTime: "2026-11-13T00:00:00.000Z",
        endTime: CUTOFF,
        format: "tabular",
        noCache: true,
      }),
    );
    expect(storage.writes).toHaveLength(2);
    for (const write of storage.writes) {
      expect(write).toMatchObject({
        Bucket: "test-user-storages",
        IfNoneMatch: "*",
        ContentType: "application/json",
      });
      const object = storage.objects.get(`${write.Bucket}/${write.Key}`);
      if (!object) {
        throw new Error("Expected durable daily object");
      }
      const rollup = runPhaseTimingRollupSchema.parse(JSON.parse(object.body));
      expect(rollup).toMatchObject({
        missingDateMeans: "gap-not-zero",
        source: {
          globalCoverage: "unknown",
          population: "phase-marked-runs",
          queryComplete: true,
        },
      });
      expect(rollup.groups[0]?.metrics.total).toMatchObject({
        count: 0,
        p50Ms: null,
        p90Ms: null,
        minMs: null,
        maxMs: null,
      });
    }
  });

  it("joins actual Run lifecycle metadata, remains idempotent, and preserves a stronger snapshot", async () => {
    const marks = await completedRunMarks();
    mockNow(new Date(CUTOFF));
    phaseSource(marks);
    const storage = objectStorage();
    const first = await accept(client().aggregate({ headers }), [200]);
    expect(first.body.days).toContainEqual({
      date: "2026-11-15",
      objectKey: `${PREFIX}2026-11-15.json`,
      markedRuns: 1,
    });
    const key = `test-user-storages/${PREFIX}2026-11-15.json`;
    const before = storage.objects.get(key);
    if (!before) {
      throw new Error("Missing marked Run partition");
    }
    const report = runPhaseTimingRollupSchema.parse(JSON.parse(before.body));
    const cohort = report.groups.find((entry) => {
      return entry.generationKind === "report" && entry.status === "completed";
    });
    expect(cohort).toMatchObject({
      runs: 1,
      metrics: {
        prepare: { count: 1, minMs: 1000 },
        research: { count: 1, minMs: 1000 },
        makingDelivery: { count: 1, minMs: 8000 },
        total: { count: 1, minMs: 10_000 },
      },
    });
    await accept(client().aggregate({ headers }), [200]);
    expect(storage.objects.get(key)?.body).toBe(before.body);
    expect(storage.writes.at(-1)?.IfMatch).toBe(before.etag);
    const writesBeforeLoss = storage.writes.filter((write) => {
      return write.Key === `${PREFIX}2026-11-15.json`;
    }).length;
    phaseSource([]);
    const lost = await accept(client().aggregate({ headers }), [200]);
    expect(lost.body.days).toContainEqual({
      date: "2026-11-15",
      objectKey: `${PREFIX}2026-11-15.json`,
      markedRuns: 1,
    });
    expect(
      storage.writes.filter((write) => {
        return write.Key === `${PREFIX}2026-11-15.json`;
      }),
    ).toHaveLength(writesBeforeLoss);
    expect(storage.objects.get(key)?.body).toBe(before.body);
  });

  it.each(["prior research", "tied skip"])(
    "retracts an earlier zero-research sample when new evidence proves %s conflicts",
    async (conflict) => {
      const [research, generation] = await completedRunMarks();
      if (!research || !generation) {
        throw new Error("Expected both phase marks");
      }
      const skipped = { ...generation, research_skipped: true };
      mockNow(new Date(CUTOFF));
      phaseSource([skipped]);
      const storage = objectStorage();
      await accept(client().aggregate({ headers }), [200]);
      const key = `test-user-storages/${PREFIX}2026-11-15.json`;
      const before = storage.objects.get(key);
      if (!before) {
        throw new Error("Missing initial skipped-research partition");
      }
      const initial = runPhaseTimingRollupSchema.parse(JSON.parse(before.body));
      expect(initial.counts.skippedResearchRuns).toBe(1);
      phaseSource([
        skipped,
        conflict === "prior research"
          ? research
          : { ...skipped, research_skipped: false },
      ]);
      await accept(client().aggregate({ headers }), [200]);
      const after = storage.objects.get(key);
      if (!after) {
        throw new Error("Missing corrected partition");
      }
      const corrected = runPhaseTimingRollupSchema.parse(
        JSON.parse(after.body),
      );
      expect(corrected.counts).toMatchObject({
        skippedResearchRuns: 0,
        conflictingMarks: 1,
      });
      const cohort = corrected.groups.find((entry) => {
        return (
          entry.generationKind === "report" && entry.status === "completed"
        );
      });
      expect(cohort?.metrics.research).toMatchObject({
        count: 0,
        p50Ms: null,
        p90Ms: null,
        invalid: 1,
        histogram: { zeroCount: 0, positiveBins: {} },
      });
      expect(storage.writes.at(-1)?.IfMatch).toBe(before.etag);
    },
  );

  it("does not write a fabricated zero snapshot after a failed or capped source query", async () => {
    mockNow(new Date(CUTOFF));
    const storage = objectStorage();
    context.mocks.axiom.query.mockRejectedValueOnce(
      new Error("Axiom unavailable"),
    );
    await accept(client().aggregate({ headers }), [500]);
    expect(storage.writes).toHaveLength(0);
    phaseSource(
      Array.from({ length: 10_000 }, () => {
        return {};
      }),
    );
    await accept(client().aggregate({ headers }), [500]);
    expect(storage.writes).toHaveLength(0);
  });

  it("rejects an unflagged provider cap or a changing source count", async () => {
    mockNow(new Date(CUTOFF));
    const storage = objectStorage();
    context.mocks.axiom.query
      .mockResolvedValueOnce([{ record_count: 2 }])
      .mockResolvedValueOnce([{}]);
    await accept(client().aggregate({ headers }), [500]);
    expect(storage.writes).toHaveLength(0);
  });

  it("reads complete count and raw results through the native Axiom transport", async () => {
    mockNow(new Date(CUTOFF));
    context.mocks.axiom.useRealQuery.mockReturnValue(true);
    const storage = objectStorage();
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/_apl",
        async ({ request }) => {
          const { apl } = object({ apl: string() }).parse(await request.json());
          return HttpResponse.json({
            status: { isPartial: false },
            tables: apl.includes("summarize record_count")
              ? [
                  {
                    fields: [{ name: "record_count", type: "integer" }],
                    columns: [[0]],
                  },
                ]
              : [],
          });
        },
      ),
    );
    await accept(client().aggregate({ headers }), [200]);
    expect(storage.writes).toHaveLength(2);
  });

  it.each([
    { label: "partial", status: { isPartial: true } },
    { label: "estimated", status: { isPartial: false, isEstimate: true } },
    { label: "unverified", status: {} },
  ])(
    "fails $label tabular queries before publishing any partition",
    async ({ status }) => {
      mockNow(new Date(CUTOFF));
      context.mocks.axiom.useRealQuery.mockReturnValue(true);
      const storage = objectStorage();
      server.use(
        http.post("https://api.axiom.co/v1/datasets/_apl", () => {
          return HttpResponse.json({ status, tables: [] });
        }),
      );
      await accept(client().aggregate({ headers }), [500]);
      expect(storage.writes).toHaveLength(0);
    },
  );

  it("does not retry an overlapping conditional object-write conflict", async () => {
    mockNow(new Date(CUTOFF));
    phaseSource([]);
    const storage = objectStorage(true);
    await accept(client().aggregate({ headers }), [500]);
    expect(storage.writes).toHaveLength(1);
    expect(storage.objects.size).toBe(0);
  });
});
