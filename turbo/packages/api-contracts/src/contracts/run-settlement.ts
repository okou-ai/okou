import {
  array,
  coerce,
  enum as zEnum,
  iso,
  literal,
  number,
  object,
  string,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const runSettlementBlockerSchema = zEnum([
  "execution_not_terminal",
  "completion_time_missing",
  "active_run_present",
  "cancellation_recovery_pending",
  "runner_job_present",
  "chat_terminal_evidence_unavailable",
  "chat_callback_identity_unavailable",
  "completion_output_missing",
  "billing_lifecycle_unavailable",
  "usage_pending",
  "router_settlement_unverified",
  "callback_pending",
  "callback_recoverable_failure",
  "callback_outcome_unknown",
]);

const auditQuerySchema = object({
  limit: coerce.number().int().min(1).max(100).default(100),
  afterRunId: string().uuid().optional(),
  createdBefore: iso.datetime().optional(),
});

const auditResponseSchema = object({
  // A page observes one database statement, not a registration fence or proof
  // that all post-settlement business dependencies are ready for deletion.
  assessment: literal("observed_state_only"),
  scope: literal("thread_runs"),
  createdBefore: iso.datetime(),
  scannedRuns: number().int().nonnegative(),
  observedCompleteRuns: number().int().nonnegative(),
  blockedRuns: number().int().nonnegative(),
  blockers: array(
    object({
      reason: runSettlementBlockerSchema,
      runs: number().int().positive(),
    }),
  ),
  callbacks: object({
    delivered: number().int().nonnegative(),
    policyFinished: number().int().nonnegative(),
    pending: number().int().nonnegative(),
    recoverableFailure: number().int().nonnegative(),
    unknown: number().int().nonnegative(),
  }),
  nextAfterRunId: string().uuid().nullable(),
});

/** On-demand operator inspection; deliberately absent from cron schedules. */
export const cronAuditRunSettlementContract = c.router({
  audit: {
    method: "GET",
    path: "/api/cron/audit-run-settlement",
    headers: authHeadersSchema,
    query: auditQuerySchema,
    responses: {
      200: auditResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary:
      "Inspect bounded Run settlement facts without changing execution or recovery",
  },
});

export type RunSettlementAuditQuery = zInfer<typeof auditQuerySchema>;
export type RunSettlementAuditResponse = zInfer<typeof auditResponseSchema>;
export type RunSettlementBlocker = zInfer<typeof runSettlementBlockerSchema>;
