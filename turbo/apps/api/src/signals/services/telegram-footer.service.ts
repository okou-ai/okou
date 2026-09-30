import { computed, type Computed } from "ccstate";
import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { eq } from "drizzle-orm";

import { db$, type ReadonlyDb } from "../external/db";
import { escapeHtml } from "../../lib/telegram-format";
import { resolveRunModelSelection } from "./run-model-selection.service";

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

async function resolveAgentReplyModelLabel(args: {
  readonly db: ReadonlyDb;
  readonly runId: string;
}): Promise<string | undefined> {
  const runModel = await resolveRunModelSelection(args.db, args.runId);
  const model = runModel?.selectedModel;

  return model
    ? escapeHtml(getRunModelDisplayName(model, runModel?.codexServiceTier))
    : undefined;
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
  return await resolveAgentReplyModelLabel({
    db: args.db,
    runId: args.runId,
  });
}

async function resolveRunAgentLabel(
  db: ReadonlyDb,
  runId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({
      agentDisplayName: agents.displayName,
      agentName: agents.name,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row ? displayLabel(row) : undefined;
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
  return computed(async (get): Promise<string | undefined> => {
    if (!args.authRunId) {
      return undefined;
    }
    const db = get(db$);

    const [agentLabel, runModel] = await Promise.all([
      resolveRunAgentLabel(db, args.authRunId),
      resolveRunModelSelection(db, args.authRunId),
    ]);

    const parts: string[] = [];
    if (agentLabel) {
      parts.push(`Sent via ${escapeHtml(agentLabel)}`);
    }
    if (runModel?.selectedModel) {
      parts.push(
        escapeHtml(
          getRunModelDisplayName(
            runModel.selectedModel,
            runModel.codexServiceTier,
          ),
        ),
      );
    }

    return parts.length > 0 ? parts.join(" · ") : undefined;
  });
}
