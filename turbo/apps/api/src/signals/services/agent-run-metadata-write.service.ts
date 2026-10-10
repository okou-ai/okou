import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import type { SQL } from "drizzle-orm";

import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { INITIAL_AUTONOMY_BUDGET } from "./autonomy-budget.constants";

type StoredRunMetadataValues = Pick<
  typeof agentRuns.$inferSelect,
  | "triggerSource"
  | "autonomyBudget"
  | "workflowAutomationId"
  | "modelProvider"
  | "modelProviderId"
  | "modelProviderCredentialScope"
  | "selectedModel"
  | "modelRuntimeProvider"
  | "modelRuntimeModel"
  | "modelUsageProvider"
  | "modelLongContextMinTotalInputTokens"
  | "builtInModelKeyId"
  | "reasoningEffort"
  | "codexServiceTier"
  | "selectedImageModel"
  | "chatThreadId"
  | "apiStartedAt"
  | "firstAssistantEventAcknowledgedAt"
  | "summary"
  | "triggerBrief"
>;

export type RunMetadataValues = Readonly<
  Omit<StoredRunMetadataValues, "triggerSource" | "autonomyBudget"> & {
    readonly triggerSource: NonNullable<
      StoredRunMetadataValues["triggerSource"]
    >;
    readonly autonomyBudget: NonNullable<
      StoredRunMetadataValues["autonomyBudget"]
    >;
  }
>;

type RunMetadataInput = Readonly<
  Pick<RunMetadataValues, "triggerSource"> &
    Partial<Omit<RunMetadataValues, "triggerSource">>
>;

type RunMetadataPatch = {
  [Key in keyof RunMetadataValues]: Readonly<
    Pick<RunMetadataValues, Key> & Partial<RunMetadataValues>
  >;
}[keyof RunMetadataValues];

interface RunMetadataWriteArgs {
  readonly patch: RunMetadataPatch;
  readonly where: SQL;
}

interface RunMetadataRow {
  readonly id: string;
  readonly apiStartedAt: Date | null;
}

function normalizeRunModelMetadata(
  input: RunMetadataInput,
): Pick<
  RunMetadataValues,
  | "modelProvider"
  | "modelProviderId"
  | "modelProviderCredentialScope"
  | "selectedModel"
  | "modelRuntimeProvider"
  | "modelRuntimeModel"
  | "modelUsageProvider"
  | "modelLongContextMinTotalInputTokens"
  | "builtInModelKeyId"
  | "reasoningEffort"
  | "codexServiceTier"
> {
  return {
    modelProvider: isBuiltInModelProviderType(input.modelProvider)
      ? "built-in"
      : (input.modelProvider ?? null),
    modelProviderId: input.modelProviderId ?? null,
    modelProviderCredentialScope: input.modelProviderCredentialScope ?? null,
    selectedModel: input.selectedModel ?? null,
    modelRuntimeProvider: input.modelRuntimeProvider ?? null,
    modelRuntimeModel: input.modelRuntimeModel ?? null,
    modelUsageProvider: input.modelUsageProvider ?? null,
    modelLongContextMinTotalInputTokens:
      input.modelLongContextMinTotalInputTokens ?? null,
    builtInModelKeyId: input.builtInModelKeyId ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    codexServiceTier: input.codexServiceTier ?? null,
  };
}

export function normalizeRunMetadata(
  input: RunMetadataInput,
): RunMetadataValues {
  return {
    triggerSource: input.triggerSource,
    autonomyBudget: input.autonomyBudget ?? INITIAL_AUTONOMY_BUDGET,
    workflowAutomationId: input.workflowAutomationId ?? null,
    ...normalizeRunModelMetadata(input),
    selectedImageModel: input.selectedImageModel ?? null,
    chatThreadId: input.chatThreadId ?? null,
    apiStartedAt: input.apiStartedAt ?? null,
    firstAssistantEventAcknowledgedAt:
      input.firstAssistantEventAcknowledgedAt ?? null,
    summary: input.summary ?? null,
    triggerBrief: input.triggerBrief ?? null,
  };
}

// Owners with an existing write boundary execute this value plan themselves;
// it contains no executor and does not open another connection or transaction.
export function runMetadataWritePlan(args: RunMetadataWriteArgs) {
  return {
    patch: args.patch,
    where: args.where,
    returning: { id: agentRuns.id, apiStartedAt: agentRuns.apiStartedAt },
  };
}

export const writeRunMetadata$ = command(
  async (
    { set },
    args: RunMetadataWriteArgs,
    signal: AbortSignal,
  ): Promise<readonly RunMetadataRow[]> => {
    signal.throwIfAborted();
    const plan = runMetadataWritePlan(args);
    const rows = await set(writeDb$)
      .update(agentRuns)
      .set(plan.patch)
      .where(plan.where)
      .returning(plan.returning);
    signal.throwIfAborted();
    return rows;
  },
);
