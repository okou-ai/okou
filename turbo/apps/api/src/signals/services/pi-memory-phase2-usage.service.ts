import {
  AGENT_EXECUTION_TIMEOUT_SECONDS,
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
} from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { and, eq, isNull, isNotNull, or } from "drizzle-orm";
import {
  PI_MEMORY_STAGE1_BUILT_IN_MODEL,
  PI_MEMORY_STAGE1_PERSONAL_MODEL,
} from "@okouai/pi-agent-runtime/api";

import type { Db } from "../external/db";
import { piMemoryPhase2MaintenanceCallbackPayloadSchema } from "./pi-memory-phase2-maintenance.service";

export const PI_MEMORY_PHASE2_BUILT_IN_MODEL = PI_MEMORY_STAGE1_BUILT_IN_MODEL;
export const PI_MEMORY_PHASE2_PERSONAL_MODEL = PI_MEMORY_STAGE1_PERSONAL_MODEL;

/**
 * Every model a private maintenance run may legitimately carry.
 *
 * Consolidation chooses a current owner route for each whole selection. Both
 * current and historical models remain recognizable to cleanup and settlement.
 */
export const PI_MEMORY_PHASE2_MODELS = [
  PI_MEMORY_PHASE2_BUILT_IN_MODEL,
  PI_MEMORY_PHASE2_PERSONAL_MODEL,
  // Immutable pre-retirement maintenance runs still drain and settle by their
  // captured model. This identifier is never selected for a new dispatch.
  "deepseek-v4.1-flash",
  "gpt-5.6-luna",
] as const;

/** The selected current route chooses the model; attempts never fall back. */
export function piMemoryPhase2Model(
  modelProvider: string,
): (typeof PI_MEMORY_PHASE2_MODELS)[number] {
  return modelProvider === "built-in"
    ? PI_MEMORY_PHASE2_BUILT_IN_MODEL
    : PI_MEMORY_PHASE2_PERSONAL_MODEL;
}

// A terminal callback can precede the runner's final proxy flush. Keep the
// private binding for a full runner lifetime plus finalization, including
// retained webhook retries, instead of the ordinary two-minute quiet window.
export const PI_MEMORY_PHASE2_USAGE_DRAIN_MS =
  AGENT_EXECUTION_TIMEOUT_SECONDS * 1000 + CANCELLATION_RECOVERY_STALE_AFTER_MS;

/** Immutable provider shape shared by candidate filtering and locked cleanup.
 * Historical built-in runs keep their supported null scope representation. */
export function piMemoryPhase2ProviderCondition() {
  return or(
    and(
      eq(agentRuns.modelProvider, "built-in"),
      isNull(agentRuns.modelProviderId),
      or(
        isNull(agentRuns.modelProviderCredentialScope),
        eq(agentRuns.modelProviderCredentialScope, "org"),
      ),
    ),
    and(
      isNotNull(agentRuns.modelProviderId),
      eq(agentRuns.modelProvider, "codex-oauth-token"),
      eq(agentRuns.modelProviderCredentialScope, "member"),
    ),
  );
}

/**
 * Identify private Phase 2 runs whose bindings must survive late proxy usage.
 * Use the dispatched immutable binding, not a mutable job lease:
 * failed/revoked attempts still cost.
 */
export async function loadPiMemoryPhase2UsageBinding(
  db: Pick<Db, "select">,
  scope: {
    readonly runId: string;
    readonly orgId: string;
    readonly userId: string;
  },
) {
  const [context] = await db
    .select({
      launchSnapshot: agentRuns.launchSnapshot,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRuns)
    .innerJoin(
      agentRunCallbacks,
      and(
        eq(agentRunCallbacks.runId, agentRuns.id),
        eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
      ),
    )
    .where(
      and(
        eq(agentRuns.id, scope.runId),
        eq(agentRuns.orgId, scope.orgId),
        eq(agentRuns.userId, scope.userId),
        eq(agentRuns.triggerSource, "agent"),
        isNull(agentRuns.chatThreadId),
        piMemoryPhase2ProviderCondition(),
      ),
    )
    .limit(1);
  const binding = piMemoryPhase2MaintenanceCallbackPayloadSchema.safeParse(
    context?.payload,
  );
  if (
    context?.launchSnapshot?.framework !== "pi" ||
    !binding.success ||
    binding.data.orgId !== scope.orgId ||
    binding.data.userId !== scope.userId
  ) {
    return undefined;
  }
  return binding.data;
}
