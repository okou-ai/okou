import { computed } from "ccstate";
import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agents } from "@okouai/db/schema/agent";
import { eq } from "drizzle-orm";

import { db$, type ReadonlyDb } from "../external/db";
import { tapError } from "../utils";
import { resolveRunModelSelection } from "./run-model-selection.service";

async function resolveAgentLabel(db: ReadonlyDb, runId: string) {
  const [row] = await db
    .select({ displayName: agents.displayName, name: agents.name })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row ? (row.displayName ?? row.name) : undefined;
}

async function resolveModelLabel(db: ReadonlyDb, runId: string) {
  const row = await resolveRunModelSelection(db, runId);
  return row?.selectedModel
    ? getRunModelDisplayName(row.selectedModel, row.codexServiceTier)
    : undefined;
}

/** Native sends share Slack's independently best-effort attribution lookups. */
export function integrationMessageSendLabels(args: {
  readonly authRunId: string | undefined;
}) {
  return computed(async (get) => {
    if (!args.authRunId) {
      return { agentLabel: undefined, modelLabel: undefined };
    }
    const db = get(db$);
    const noop = (): void => {};
    const [agentLabel, modelLabel] = await Promise.all([
      tapError(resolveAgentLabel(db, args.authRunId), noop),
      tapError(resolveModelLabel(db, args.authRunId), noop),
    ]);
    return { agentLabel, modelLabel };
  });
}

export function discordMessageSendFooterText(args: {
  readonly authRunId: string | undefined;
  readonly discordUserId: string;
}) {
  return computed(async (get) => {
    const { agentLabel, modelLabel } = await get(
      integrationMessageSendLabels(args),
    );
    if (!agentLabel && !modelLabel) {
      return undefined;
    }
    const parts: string[] = [];
    if (agentLabel) {
      parts.push(`Sent via ${agentLabel}`);
    }
    parts.push(`Triggered by <@${args.discordUserId}>`);
    if (modelLabel) {
      parts.push(modelLabel);
    }
    return parts.join(" · ");
  });
}
