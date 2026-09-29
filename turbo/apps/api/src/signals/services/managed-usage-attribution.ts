import { agentRuns } from "@okouai/db/runtime/agent-run";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { and, eq, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgTextDecoder } from "../../lib/db-structured-result";
import {
  managedValues,
  type ManagedUsageRecordArgs,
} from "./managed-usage-record";

export interface BillingRun {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly startedAt: string;
  readonly triggerSource: string | null;
  readonly threadId: string | null;
}

export interface BillingAttribution {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly startedAt: string;
}

export function managedBillingRunQuery(runId: string | undefined) {
  return new QueryBuilder()
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      startedAt: sql`${agentRuns.createdAt}::text`
        .mapWith(pgTextDecoder)
        .as("started_at"),
      triggerSource: agentRuns.triggerSource,
      threadId: agentRuns.chatThreadId,
    })
    .from(agentRuns)
    .where(runId ? eq(agentRuns.id, runId) : sql`false`)
    .for("key share")
    .as("managed_billing_run");
}

export function managedAttributionQuery(runId: string | undefined) {
  return new QueryBuilder()
    .select({
      runId: billingRunAttribution.runId,
      orgId: billingRunAttribution.orgId,
      userId: billingRunAttribution.userId,
      // The original timestamp must not lose sub-millisecond precision.
      startedAt: sql`${billingRunAttribution.runStartedAt}::text`
        .mapWith(pgTextDecoder)
        .as("started_at"),
    })
    .from(billingRunAttribution)
    .where(runId ? eq(billingRunAttribution.runId, runId) : sql`false`)
    .for("update")
    .as("managed_billing_attribution");
}

function billingSource(triggerSource: string | null): string {
  switch (triggerSource) {
    case "web": {
      return "chat";
    }
    case "automation-schedule":
    case "automation-event":
    case "goal": {
      return "automation";
    }
    case "slack":
    case "discord":
    case "teams":
    case "telegram":
    case "email":
    case "agentphone":
    case "github":
    case "agent": {
      return triggerSource;
    }
    default: {
      return "other";
    }
  }
}

export function managedAttributionWrite(
  args: Pick<ManagedUsageRecordArgs, "actor">,
  run: BillingRun,
) {
  if (
    run.id !== args.actor.runId ||
    run.orgId !== args.actor.orgId ||
    run.userId !== args.actor.userId
  ) {
    throw new Error("Managed usage Run ownership does not match");
  }
  return billingRunAttributionWrite(run);
}

export function billingRunAttributionWrite(run: BillingRun) {
  const source = billingSource(run.triggerSource);
  const startedAt = sql`${run.startedAt}::timestamp`;
  return {
    values: {
      runId: run.id,
      orgId: run.orgId,
      userId: run.userId,
      runStartedAt: startedAt,
      source,
      threadId: run.threadId,
      threadContext: run.threadId === null ? "threadless" : "thread",
    },
    conflict: {
      target: billingRunAttribution.runId,
      // A live Run may have lost its thread through ON DELETE SET NULL.
      // Fill only an unknown grouping identity; never rewrite captured history.
      set: {
        runId: run.id,
        threadId: sql`CASE WHEN ${billingRunAttribution.threadContext} = 'unknown' THEN ${run.threadId}::uuid ELSE ${billingRunAttribution.threadId} END`,
        threadContext: sql`CASE WHEN ${billingRunAttribution.threadContext} = 'unknown' THEN ${run.threadId === null ? "threadless" : "thread"} ELSE ${billingRunAttribution.threadContext} END`,
      },
      setWhere: and(
        eq(billingRunAttribution.orgId, run.orgId),
        eq(billingRunAttribution.userId, run.userId),
        eq(billingRunAttribution.runStartedAt, startedAt),
        eq(billingRunAttribution.source, source),
      ),
    },
  };
}

function usageRunOwned(
  actor: ManagedUsageRecordArgs["actor"],
  run: BillingRun | undefined,
): run is BillingRun {
  return (
    run?.id === actor.runId &&
    run?.orgId === actor.orgId &&
    run?.userId === actor.userId
  );
}

export function attributedUsageIdentity(
  args: Pick<ManagedUsageRecordArgs, "actor">,
  run: BillingRun | undefined,
  attribution: BillingAttribution | undefined,
) {
  const ownedRun = usageRunOwned(args.actor, run) ? run : undefined;
  if (run && !ownedRun && !attribution) {
    throw new Error("Managed usage Run ownership does not match");
  }
  if (
    attribution &&
    (attribution.runId !== args.actor.runId ||
      attribution.orgId !== args.actor.orgId ||
      attribution.userId !== args.actor.userId)
  ) {
    throw new Error(
      "Managed usage billing attribution ownership does not match",
    );
  }
  return {
    // Historical attribution remains authoritative independently of the live
    // Run. Retain a live FK only for the same billed owner, as before capture.
    runId: ownedRun?.id ?? null,
    billingRunId: args.actor.runId ?? null,
    billingContext: attribution
      ? "run"
      : args.actor.runId
        ? "missing_run"
        : "runless",
    billingAnchorAt: attribution
      ? sql`${attribution.startedAt}::timestamp`
      : args.actor.runId
        ? null
        : sql`now()`,
    createdAt: sql`now()`,
  };
}

export function attributedManagedValues(
  args: ManagedUsageRecordArgs,
  run: BillingRun | undefined,
  attribution: BillingAttribution | undefined,
) {
  return {
    ...managedValues(args, run),
    ...attributedUsageIdentity(args, run, attribution),
  };
}
