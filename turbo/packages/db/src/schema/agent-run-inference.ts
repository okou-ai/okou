import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  check,
  index,
} from "drizzle-orm/pg-core";
import { conversations } from "./conversation";
import { agentRuns } from "./agent-run-session-conversation";
import type { PiInferencePhase } from "@okouai/api-contracts/contracts/pi-inference-lifecycle";
import type {
  PiInferenceInput,
  PiInferencePublication,
  PiSandboxContinuation,
} from "../jsonb-contracts/agent-run-inference";

/** Sparse, default-off execution owner. Run columns remain identity/billing authority. */
export const agentRunInference = pgTable(
  "agent_run_inference",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    sourceConversationId: uuid("source_conversation_id").references(
      () => {
        return conversations.id;
      },
      { onDelete: "restrict" },
    ),
    input: jsonb("input").$type<PiInferenceInput>().notNull(),
    phase: text("phase").$type<PiInferencePhase>().notNull(),
    ownerEpoch: integer("owner_epoch").notNull(),
    deadlineAt: timestamp("deadline_at").notNull(),
    activationReady: boolean("activation_ready").notNull().default(false),
    providerAttemptId: uuid("provider_attempt_id").notNull(),
    providerAttemptState: text("provider_attempt_state")
      .$type<"not-started" | "may-have-started" | "settled">()
      .notNull(),
    publication: jsonb("publication").$type<PiInferencePublication>(),
    publishedSequence: integer("published_sequence"),
    usageSettled: boolean("usage_settled").notNull().default(false),
  },
  (t) => {
    return [
      check("agent_run_inference_epoch_check", sql`${t.ownerEpoch} >= 1`),
      check(
        "agent_run_inference_phase_check",
        sql`${t.phase} IN ('admitted', 'ready', 'provider', 'publishing', 'sandbox_waiting', 'sandbox_preparing', 'sandbox_ready', 'sandbox_running', 'terminal')`,
      ),
      check(
        "agent_run_inference_attempt_check",
        sql`${t.providerAttemptState} IN ('not-started', 'may-have-started', 'settled') AND (${t.phase} <> 'provider' OR (${t.activationReady} AND ${t.providerAttemptState} = 'may-have-started')) AND (${t.providerAttemptState} <> 'settled' OR ${t.publication} IS NOT NULL) AND (${t.phase} <> 'publishing' OR ${t.providerAttemptState} = 'settled')`,
      ),
      check(
        "agent_run_inference_input_check",
        sql`jsonb_typeof(${t.input}) = 'object' AND ${t.input} ?& ARRAY['schemaVersion', 'inputEventId', 'inputGeneration', 'configurationHash', 'contextHash', 'h0', 'deferredSecrets'] AND ${t.input}->'schemaVersion' = '1'::jsonb`,
      ),
      check(
        "agent_run_inference_sequence_check",
        sql`${t.publishedSequence} >= 0`,
      ),
      index("agent_run_inference_source_idx").on(t.sourceConversationId),
      index("agent_run_inference_deadline_idx").on(
        t.phase,
        t.deadlineAt,
        t.runId,
      ),
    ];
  },
);

/** The intent is the outbox; legacy agent_run_queue never owns this work. */
export const agentRunSandboxIntent = pgTable(
  "agent_run_sandbox_intent",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRunInference.runId;
        },
        { onDelete: "cascade" },
      ),
    generation: integer("generation").notNull(),
    continuation: jsonb("continuation")
      .$type<PiSandboxContinuation>()
      .notNull(),
    state: text("state")
      .$type<
        | "waiting"
        | "preparing"
        | "ready"
        | "claimed"
        | "cancelled"
        | "expired"
        | "settled"
      >()
      .notNull(),
    enqueuedAt: timestamp("enqueued_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    ownerEpoch: integer("owner_epoch").notNull(),
    attemptDeadlineAt: timestamp("attempt_deadline_at"),
    attempts: integer("attempts").notNull().default(0),
    notifiedAt: timestamp("notified_at"),
  },
  (t) => {
    return [
      check(
        "agent_run_sandbox_intent_epoch_check",
        sql`${t.generation} >= 1 AND ${t.ownerEpoch} >= 1 AND ${t.attempts} >= 0`,
      ),
      check(
        "agent_run_sandbox_intent_state_check",
        sql`${t.state} IN ('waiting', 'preparing', 'ready', 'claimed', 'cancelled', 'expired', 'settled')`,
      ),
      check(
        "agent_run_sandbox_intent_expiry_check",
        sql`${t.expiresAt} > ${t.enqueuedAt} AND ${t.expiresAt} <= ${t.enqueuedAt} + interval '2 hours'`,
      ),
      index("agent_run_sandbox_intent_queue_idx").on(
        t.state,
        t.enqueuedAt,
        t.runId,
      ),
      index("agent_run_sandbox_intent_attempt_idx").on(
        t.state,
        t.attemptDeadlineAt,
        t.runId,
      ),
      index("agent_run_sandbox_intent_expiry_idx").on(
        t.state,
        t.expiresAt,
        t.runId,
      ),
    ];
  },
);

/** RESTRICT prevents any parent erasure from silently freeing uncertain capacity. */
export const agentRunSandboxLease = pgTable(
  "agent_run_sandbox_lease",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRunSandboxIntent.runId;
        },
        { onDelete: "restrict" },
      ),
    state: text("state")
      .$type<
        | "reserved"
        | "preparing"
        | "ready"
        | "claimed"
        | "releasing"
        | "released"
      >()
      .notNull(),
    ownerEpoch: integer("owner_epoch").notNull(),
    deadlineAt: timestamp("deadline_at").notNull(),
    runnerId: uuid("runner_id"),
    releaseEvidence: text("release_evidence"),
  },
  (t) => {
    return [
      check("agent_run_sandbox_lease_epoch_check", sql`${t.ownerEpoch} >= 1`),
      check(
        "agent_run_sandbox_lease_state_check",
        sql`${t.state} IN ('reserved', 'preparing', 'ready', 'claimed', 'releasing', 'released') AND (${t.state} <> 'claimed' OR ${t.runnerId} IS NOT NULL)`,
      ),
      check(
        "agent_run_sandbox_lease_release_check",
        sql`(${t.state} = 'released' AND ${t.releaseEvidence} IS NOT NULL AND length(${t.releaseEvidence}) > 0) OR (${t.state} <> 'released' AND ${t.releaseEvidence} IS NULL)`,
      ),
      index("agent_run_sandbox_lease_deadline_idx").on(
        t.state,
        t.deadlineAt,
        t.runId,
      ),
    ];
  },
);
