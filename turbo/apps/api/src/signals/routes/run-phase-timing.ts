import {
  runGenerationKindSchema,
  runPhaseTimingContract,
  type RunPhaseMark,
  type RunPhaseMarkResult,
} from "@okouai/api-contracts/contracts/run-phase-timing";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunPhaseTimings as timing } from "@okouai/db/schema/agent-run-phase-timing";
import { command, computed } from "ccstate";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { apiStartTime$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { createUserFeatureSwitchContext } from "../services/feature-switches.service";

const identity$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return Promise.resolve({ orgId: auth.orgId, userId: auth.userId });
});
const features$ = createUserFeatureSwitchContext(identity$);
const markBody$ = bodyResultOf(runPhaseTimingContract.mark);

interface CurrentTiming {
  readonly status: string;
  readonly timing: typeof timing.$inferSelect | null;
}

function ignoredReason(
  mark: RunPhaseMark,
  current: CurrentTiming | undefined,
): RunPhaseMarkResult["reason"] {
  if (current?.status !== "running") {
    return "run-not-running";
  }
  if (mark.phase === "research-start" && current.timing?.generationStartedAt) {
    return "generation-already-started";
  }
  if (
    mark.phase === "generation-start" &&
    mark.skipResearch &&
    current.timing?.researchStartedAt
  ) {
    return "research-already-started";
  }
  return "out-of-order";
}

function phaseMarkReceipt(
  mark: RunPhaseMark,
  current: CurrentTiming | undefined,
  written: boolean,
): RunPhaseMarkResult {
  const existing = current?.timing;
  const alreadyMarked =
    mark.phase === "research-start"
      ? existing?.researchStartedAt
      : existing?.generationStartedAt;
  return {
    schemaVersion: 1,
    status: written ? "recorded" : alreadyMarked ? "duplicate" : "ignored",
    reason: written || alreadyMarked ? null : ignoredReason(mark, current),
    timing: existing
      ? {
          researchStartedAt: existing.researchStartedAt?.toISOString() ?? null,
          generationStartedAt:
            existing.generationStartedAt?.toISOString() ?? null,
          researchSkipped: existing.researchSkipped,
          generationKind: runGenerationKindSchema
            .nullable()
            .parse(existing.generationKind),
        }
      : null,
  };
}

const mark$ = command(async ({ get, set }, signal: AbortSignal) => {
  const acceptedAt = new Date(get(apiStartTime$));
  set(setResHeader$, "Cache-Control", "no-store");
  if (
    !isFeatureEnabled(
      FeatureSwitchKey.ArtifactGenerationTiming,
      await get(features$),
    )
  ) {
    return notFound("Run phase timing is unavailable");
  }
  const body = await get(markBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("Phase marks require Run authentication");
  }
  const mark = body.data;
  const research = mark.phase === "research-start";
  const skip = !research && mark.skipResearch;
  const owner = and(
    eq(agentRuns.id, auth.runId),
    eq(agentRuns.userId, auth.userId),
    eq(agentRuns.orgId, auth.orgId),
  );
  const db = set(writeDb$);
  // Eligibility and first-write-wins are evaluated by one statement. No Run
  // lifecycle write, transaction, or coordination lock is needed for telemetry.
  const [written] = await db
    .insert(timing)
    .select((qb) => {
      return qb
        .select({
          runId: agentRuns.id,
          schemaVersion: sql`1`
            .mapWith(timing.schemaVersion)
            .as("schema_version"),
          researchStartedAt:
            sql`${research ? acceptedAt.toISOString() : null}::timestamp`
              .mapWith(nullableDriverValueDecoder(timing.researchStartedAt))
              .as("research_started_at"),
          generationStartedAt:
            sql`${research ? null : acceptedAt.toISOString()}::timestamp`
              .mapWith(nullableDriverValueDecoder(timing.generationStartedAt))
              .as("generation_started_at"),
          researchSkipped: sql`${skip}::boolean`
            .mapWith(timing.researchSkipped)
            .as("research_skipped"),
          generationKind: sql`${research ? null : mark.kind}::text`
            .mapWith(nullableDriverValueDecoder(timing.generationKind))
            .as("generation_kind"),
        })
        .from(agentRuns)
        .where(and(owner, eq(agentRuns.status, "running")));
    })
    .onConflictDoUpdate({
      target: timing.runId,
      set: research
        ? { researchStartedAt: acceptedAt }
        : {
            generationStartedAt: acceptedAt,
            generationKind: mark.kind,
            researchSkipped: skip,
          },
      setWhere: research
        ? and(
            isNull(timing.researchStartedAt),
            isNull(timing.generationStartedAt),
          )
        : and(
            isNull(timing.generationStartedAt),
            skip
              ? isNull(timing.researchStartedAt)
              : or(
                  isNull(timing.researchStartedAt),
                  lte(timing.researchStartedAt, acceptedAt),
                ),
          ),
    })
    .returning();
  signal.throwIfAborted();
  // A concurrent winner can be invisible to the INSERT snapshot. A fresh read
  // returns its original receipt without retrying or mutating that boundary.
  const current = written
    ? { status: "running", timing: written }
    : (
        await db
          .select({ status: agentRuns.status, timing })
          .from(agentRuns)
          .leftJoin(timing, eq(agentRuns.id, timing.runId))
          .where(owner)
          .limit(1)
      )[0];
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: phaseMarkReceipt(mark, current, Boolean(written)),
  };
});

export const runPhaseTimingRoutes: readonly RouteEntry[] = [
  {
    route: runPhaseTimingContract.mark,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "run-timing:write",
      },
      mark$,
    ),
  },
];
