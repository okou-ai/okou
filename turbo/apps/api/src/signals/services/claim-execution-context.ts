import {
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  claimCompatibleStoredExecutionContextSchema,
  claimPreparedExecutionContextSchema,
} from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { computed, type Computed } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { object } from "zod";
import { monotonicNow } from "../../lib/time";
import { db$ } from "../external/db";
import {
  DEFAULT_DISALLOWED_TOOLS,
  runPlatformEnvironment,
} from "./run-execution-defaults";

export type ClaimExecutionContextRun = Pick<
  typeof agentRuns.$inferSelect,
  "id" | "orgId" | "userId" | "agentId" | "chatThreadId" | "launchSnapshot"
>;

// Inspect source selection without deep-decoding the large context twice.
const claimContextSourcesSchema = object({
  cliAgentType: claimCompatibleStoredExecutionContextSchema.shape.cliAgentType,
  connectorRuntimeTargets:
    claimCompatibleStoredExecutionContextSchema.shape.connectorRuntimeTargets,
  piLaunchConfig:
    claimCompatibleStoredExecutionContextSchema.shape.piLaunchConfig,
  disallowedTools:
    claimCompatibleStoredExecutionContextSchema.shape.disallowedTools,
  userTimezone: claimCompatibleStoredExecutionContextSchema.shape.userTimezone,
  platformEnvironment:
    claimCompatibleStoredExecutionContextSchema.shape.platformEnvironment,
}).passthrough();

function registeredConnectorTargets(payload: unknown) {
  const parsed =
    agentRunConnectorDiagnosticRegistrationPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data.targets : undefined;
}

/** Resolve omitted duplicates from the admitted Run, before claiming it. */
export function createClaimExecutionContext(
  input$: Computed<
    Promise<{
      readonly run: ClaimExecutionContextRun;
      readonly executionContext: unknown;
    }>
  >,
) {
  const decoded$ = computed(async (get) => {
    const input = await get(input$);
    return {
      input,
      parsed: claimContextSourcesSchema.safeParse(input.executionContext),
    };
  });
  const sources$ = computed(async (get) => {
    const { input, parsed } = await get(decoded$);
    if (!parsed.success) {
      return undefined;
    }
    const needsTargets = parsed.data.connectorRuntimeTargets === undefined;
    const needsTimezone = parsed.data.userTimezone === undefined;
    if (!needsTargets && !needsTimezone) {
      return undefined;
    }
    const run = input.run;
    const [sources] = await get(db$)
      .select({
        registration: agentRunConnectorDiagnosticRegistrations.payload,
        timezone: orgMembersMetadata.timezone,
      })
      .from(agentRuns)
      .leftJoin(
        agentRunConnectorDiagnosticRegistrations,
        needsTargets
          ? eq(agentRunConnectorDiagnosticRegistrations.runId, agentRuns.id)
          : sql`false`,
      )
      .leftJoin(
        orgMembersMetadata,
        needsTimezone
          ? and(
              eq(orgMembersMetadata.orgId, agentRuns.orgId),
              eq(orgMembersMetadata.userId, agentRuns.userId),
            )
          : sql`false`,
      )
      .where(
        and(
          eq(agentRuns.id, run.id),
          eq(agentRuns.orgId, run.orgId),
          eq(agentRuns.userId, run.userId),
        ),
      );
    return sources;
  });
  return computed(async (get) => {
    const { input, parsed } = await get(decoded$);
    if (!parsed.success) {
      return { result: parsed, hydrationMs: undefined };
    }
    const context = parsed.data;
    const run = input.run;
    const needsFramework = context.cliAgentType === undefined;
    const needsTargets = context.connectorRuntimeTargets === undefined;
    const needsTimezone = context.userTimezone === undefined;
    const startedAt = monotonicNow();
    const sources = await get(sources$);
    // Full contexts can outlive deployment cutover in the queue. #46170 owns
    // compact writes and retirement of supplied-source branches after retained
    // full contexts and serving/draining/incompatible rollback writers are gone.
    const cliAgentType = context.cliAgentType ?? run.launchSnapshot?.framework;
    const connectorRuntimeTargets =
      context.connectorRuntimeTargets ??
      registeredConnectorTargets(sources?.registration);
    const piLaunchConfig =
      context.piLaunchConfig ??
      (cliAgentType === "pi" ? { schemaVersion: 2 as const } : undefined);
    const disallowedTools = context.disallowedTools ?? [
      ...DEFAULT_DISALLOWED_TOOLS,
    ];
    const userTimezone = context.userTimezone ?? sources?.timezone ?? undefined;
    const platformDefaults = runPlatformEnvironment(run);
    const needsPlatform = Object.keys(platformDefaults).some((key) => {
      return !Object.hasOwn(context.platformEnvironment, key);
    });
    const platformEnvironment = {
      ...platformDefaults,
      ...context.platformEnvironment,
    };
    const hydrationMs =
      needsFramework ||
      needsTargets ||
      needsTimezone ||
      needsPlatform ||
      context.disallowedTools === undefined ||
      context.piLaunchConfig !== piLaunchConfig
        ? monotonicNow() - startedAt
        : undefined;
    return {
      result: claimPreparedExecutionContextSchema.safeParse({
        ...context,
        cliAgentType,
        connectorRuntimeTargets,
        piLaunchConfig,
        disallowedTools,
        userTimezone,
        platformEnvironment,
      }),
      hydrationMs,
    };
  });
}
