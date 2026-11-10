import {
  storedExecutionContextSchema,
  claimPreparedExecutionContextSchema,
} from "@okouai/api-contracts/contracts/runners";
import type { agentRuns } from "@okouai/db/runtime/agent-run";
import { computed, type Computed } from "ccstate";
import { monotonicNow } from "../../lib/time";
import { settle } from "../utils";
import { ExecutionStorageUnavailableError } from "./execution-storage.service";
import {
  ClaimRuntimeUnavailableError,
  createClaimRuntimeContext,
} from "./claim-runtime-context";

export type ClaimExecutionContextRun = Pick<
  typeof agentRuns.$inferSelect,
  | "id"
  | "orgId"
  | "userId"
  | "agentId"
  | "chatThreadId"
  | "launchSnapshot"
  | "vars"
  | "storageMounts"
  | "modelProvider"
  | "modelProviderId"
  | "modelProviderCredentialScope"
  | "modelProviderAccountIdentity"
  | "selectedModel"
  | "modelRuntimeProvider"
  | "modelRuntimeModel"
  | "builtInModelKeyId"
  | "modelUsageProvider"
  | "modelLongContextMinTotalInputTokens"
  | "reasoningEffort"
  | "codexServiceTier"
  | "officialWorkflowProvenance"
>;

/** Read minimum queue intent, then assemble the Run from its authoritative sources. */
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
      parsed: storedExecutionContextSchema.safeParse(input.executionContext),
    };
  });
  const runtimeInput$ = computed(async (get) => {
    const { input, parsed } = await get(decoded$);
    if (!parsed.success) {
      throw new Error("Runtime sources require valid Claim inputs");
    }
    return { run: input.run, context: parsed.data };
  });
  const runtime$ = createClaimRuntimeContext(runtimeInput$);
  return computed(async (get) => {
    const { parsed } = await get(decoded$);
    if (!parsed.success) {
      return {
        status: "ready" as const,
        result: parsed,
        hydrationMs: undefined,
        secrets: null,
        storageCacheWrites: [],
      };
    }
    const startedAt = monotonicNow();
    const runtime = await settle(get(runtime$));
    if (!runtime.ok) {
      if (
        runtime.error instanceof ClaimRuntimeUnavailableError ||
        runtime.error instanceof ExecutionStorageUnavailableError
      ) {
        return { status: "unavailable" as const };
      }
      throw runtime.error;
    }
    return {
      status: "ready" as const,
      result: claimPreparedExecutionContextSchema.safeParse(
        runtime.value.context,
      ),
      hydrationMs: monotonicNow() - startedAt,
      secrets: runtime.value.secrets,
      storageCacheWrites: runtime.value.storageCacheWrites,
    };
  });
}
