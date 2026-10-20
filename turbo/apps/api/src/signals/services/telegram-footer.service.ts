import { computed, type Computed } from "ccstate";
import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { eq } from "drizzle-orm";

import { db$, type ReadonlyDb } from "../external/db";
import { escapeHtml } from "../../lib/telegram-format";
import {
  runModelSelectionColumns,
  runModelSelectionCondition,
  runModelSelectionFromRow,
} from "./run-model-selection.service";

function displayLabel(row: {
  agentDisplayName: string | null;
  agentName: string;
}): string {
  const displayName = row.agentDisplayName?.trim();
  if (displayName) {
    return displayName;
  }
  return row.agentName;
}

export async function resolveTelegramAgentReplyFooterText(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly runId: string;
  readonly installationId: string;
  readonly agentId: string;
}): Promise<string | undefined> {
  // The official shared bot has no per-bot default agent, so replies never
  // carry a "Responded by" label; only the model label is shown.
  const db = args.db;
  const runId = args.runId;
  const runModel = await (async () => {
    const [row] = await db
      .select(runModelSelectionColumns())
      .from(agentRuns)
      .where(runModelSelectionCondition(runId))
      .limit(1);
    return runModelSelectionFromRow(row);
  })();
  const model = runModel?.selectedModel;
  const modelLabel = model
    ? getRunModelDisplayName(model, runModel?.codexServiceTier)
    : undefined;

  return modelLabel ? escapeHtml(modelLabel) : undefined;
}

/**
 * Resolve the attribution footer text appended to user-initiated Telegram messages.
 *
 * Preserves the legacy footer semantics for agent, automation,
 * and selected model labels. Returns undefined when authRunId is undefined
 * (auth source has no run context) or when none of the four data points are
 * available.
 */
export function telegramMessageSendFooterText(args: {
  readonly authRunId: string | undefined;
  readonly botId: string;
}): Computed<Promise<string | undefined>> {
  type ModelRead = ReturnType<typeof runModelSelectionFromRow>;

  return computed(async (get): Promise<string | undefined> => {
    if (!args.authRunId) {
      return undefined;
    }
    const db = get(db$);
    const runId = args.authRunId;

    const [agentLabel, runModel] = await Promise.all([
      (async (): Promise<string | undefined> => {
        const [row] = await db
          .select({
            agentDisplayName: agents.displayName,
            agentName: agents.name,
          })
          .from(agentRuns)
          .innerJoin(agents, eq(agentRuns.agentId, agents.id))
          .where(eq(agentRuns.id, runId))
          .limit(1);
        return row ? displayLabel(row) : undefined;
      })(),
      ((): Promise<ModelRead> => {
        const modelRunId = args.authRunId;
        return (async (): Promise<ModelRead> => {
          const [row] = await db
            .select(runModelSelectionColumns())
            .from(agentRuns)
            .where(runModelSelectionCondition(modelRunId))
            .limit(1);
          return runModelSelectionFromRow(row);
        })();
      })(),
    ]);

    const parts: string[] = [];
    if (agentLabel) {
      parts.push(`Sent via ${escapeHtml(agentLabel)}`);
    }
    const modelLabel = runModel?.selectedModel
      ? getRunModelDisplayName(
          runModel.selectedModel,
          runModel.codexServiceTier,
        )
      : undefined;
    if (modelLabel) {
      parts.push(escapeHtml(modelLabel));
    }

    return parts.length > 0 ? parts.join(" · ") : undefined;
  });
}
