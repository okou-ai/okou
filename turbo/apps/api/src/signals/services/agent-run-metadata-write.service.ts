import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import type { SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";

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
  | "builtInModelKeyId"
  | "reasoningEffort"
  | "codexServiceTier"
  | "selectedVideoModel"
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
    autonomyBudget: input.autonomyBudget ?? 10,
    workflowAutomationId: input.workflowAutomationId ?? null,
    ...normalizeRunModelMetadata(input),
    selectedVideoModel: input.selectedVideoModel ?? null,
    selectedImageModel: input.selectedImageModel ?? null,
    chatThreadId: input.chatThreadId ?? null,
    apiStartedAt: input.apiStartedAt ?? null,
    firstAssistantEventAcknowledgedAt:
      input.firstAssistantEventAcknowledgedAt ?? null,
    summary: input.summary ?? null,
    triggerBrief: input.triggerBrief ?? null,
  };
}

export async function writeRunMetadataInTransaction(
  tx: Pick<Tx, "update">,
  args: RunMetadataWriteArgs,
): Promise<readonly RunMetadataRow[]> {
  return await tx
    .update(agentRuns)
    .set(args.patch)
    .where(args.where)
    .returning({ id: agentRuns.id, apiStartedAt: agentRuns.apiStartedAt });
}

export function writeRunMetadata(
  db: Db,
  args: RunMetadataWriteArgs,
): Promise<readonly RunMetadataRow[]> {
  return db.transaction(async (tx) => {
    return await writeRunMetadataInTransaction(tx, args);
  });
}
