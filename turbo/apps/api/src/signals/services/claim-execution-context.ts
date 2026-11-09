import {
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  claimCompatibleStoredExecutionContextSchema,
  claimPreparedExecutionContextSchema,
} from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { object } from "zod";
import { monotonicNow } from "../../lib/time";
import { db$ } from "../external/db";

// Inspect source selection without deep-decoding the large context twice.
const claimContextSourcesSchema = object({
  cliAgentType: claimCompatibleStoredExecutionContextSchema.shape.cliAgentType,
  connectorRuntimeTargets:
    claimCompatibleStoredExecutionContextSchema.shape.connectorRuntimeTargets,
  piLaunchConfig:
    claimCompatibleStoredExecutionContextSchema.shape.piLaunchConfig,
}).passthrough();

/** Resolve omitted duplicates from the admitted Run, before claiming it. */
export function createClaimExecutionContext(
  input$: Computed<
    Promise<{
      readonly runId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly executionContext: unknown;
    }>
  >,
) {
  return computed(async (get) => {
    const input = await get(input$);
    const parsed = claimContextSourcesSchema.safeParse(input.executionContext);
    if (!parsed.success) {
      return { result: parsed, hydrationMs: undefined };
    }
    const context = parsed.data;
    const needsFramework = context.cliAgentType === undefined;
    const needsTargets = context.connectorRuntimeTargets === undefined;
    const startedAt = monotonicNow();
    const [runs, registrations] = await Promise.all([
      needsFramework
        ? get(db$)
            .select({ launchSnapshot: agentRuns.launchSnapshot })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.id, input.runId),
                eq(agentRuns.orgId, input.orgId),
                eq(agentRuns.userId, input.userId),
              ),
            )
        : undefined,
      needsTargets
        ? get(db$)
            .select({
              payload: agentRunConnectorDiagnosticRegistrations.payload,
            })
            .from(agentRunConnectorDiagnosticRegistrations)
            .where(
              eq(agentRunConnectorDiagnosticRegistrations.runId, input.runId),
            )
        : undefined,
    ]);
    const run = runs?.[0];
    const registration = registrations?.[0];
    // Full contexts can outlive deployment cutover in the queue. #46170 owns
    // compact writes and retirement of supplied-source branches after retained
    // full contexts and serving/draining/incompatible rollback writers are gone.
    const cliAgentType = context.cliAgentType ?? run?.launchSnapshot?.framework;
    const targets = needsTargets
      ? agentRunConnectorDiagnosticRegistrationPayloadSchema.safeParse(
          registration?.payload,
        )
      : undefined;
    const connectorRuntimeTargets =
      context.connectorRuntimeTargets ??
      (targets?.success ? targets.data.targets : undefined);
    const piLaunchConfig =
      context.piLaunchConfig ??
      (cliAgentType === "pi" ? { schemaVersion: 2 as const } : undefined);
    const hydrationMs =
      needsFramework ||
      needsTargets ||
      context.piLaunchConfig !== piLaunchConfig
        ? monotonicNow() - startedAt
        : undefined;
    return {
      result: claimPreparedExecutionContextSchema.safeParse({
        ...context,
        cliAgentType,
        connectorRuntimeTargets,
        piLaunchConfig,
      }),
      hydrationMs,
    };
  });
}
