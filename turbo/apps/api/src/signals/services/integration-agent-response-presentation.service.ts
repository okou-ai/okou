import { eq } from "drizzle-orm";
import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";

import type { Db } from "../external/db";
import {
  runModelSelectionColumns,
  runModelSelectionCondition,
  runModelSelectionFromRow,
} from "./run-model-selection.service";

/** Names the responding agent only when it is not the org default. */
async function resolveNonDefaultAgentLabel(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly composeId: string;
  readonly defaultAgentId?: string;
}): Promise<string | undefined> {
  const defaultAgentId =
    args.defaultAgentId ??
    (
      await args.db
        .select({ defaultAgentId: orgMetadata.defaultAgentId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId))
        .limit(1)
    )[0]?.defaultAgentId;

  if (args.composeId === defaultAgentId) {
    return undefined;
  }

  const [agent] = await args.db
    .select({ displayName: agents.displayName, name: agents.name })
    .from(agents)
    .where(eq(agents.id, args.composeId))
    .limit(1);
  return agent?.displayName ?? agent?.name;
}

async function resolveModelLabel(args: {
  readonly db: Db;
  readonly runId: string;
}): Promise<string | undefined> {
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
  return model
    ? getRunModelDisplayName(model, runModel?.codexServiceTier)
    : undefined;
}

export async function resolveIntegrationAgentResponsePresentation(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly runId: string;
    readonly agentId: string;
    readonly defaultAgentId?: string;
    readonly replyToMention?: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly footerText: string | undefined;
}> {
  const [agentLabel, modelLabel] = await Promise.all([
    resolveNonDefaultAgentLabel({
      db: args.db,
      orgId: args.orgId,
      composeId: args.agentId,
      defaultAgentId: args.defaultAgentId,
    }),
    resolveModelLabel({
      db: args.db,
      runId: args.runId,
    }),
  ]);
  signal.throwIfAborted();

  return integrationAgentResponsePresentation({
    agentLabel,
    modelLabel,
    replyToMention: args.replyToMention,
  });
}

/**
 * Admission failures have no run, so the footer names only the chat's agent
 * and the mentioned sender, like other integrations' admission notices.
 */
export async function resolveIntegrationAdmissionFailurePresentation(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly agentId: string;
    readonly replyToMention?: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly footerText: string | undefined;
}> {
  const agentLabel = await resolveNonDefaultAgentLabel({
    db: args.db,
    orgId: args.orgId,
    composeId: args.agentId,
  });
  signal.throwIfAborted();
  return integrationAdmissionFailurePresentation({
    agentLabel,
    replyToMention: args.replyToMention,
  });
}

export function integrationAdmissionFailurePresentation(args: {
  readonly agentLabel: string | undefined;
  readonly replyToMention?: string;
}): { readonly footerText: string | undefined } {
  const parts: string[] = [];
  if (args.agentLabel) {
    parts.push(`Sent via ${args.agentLabel}`);
  }
  if (args.replyToMention) {
    parts.push(`Reply to ${args.replyToMention}`);
  }
  return {
    footerText: parts.length > 0 ? parts.join(" · ") : undefined,
  };
}

export function integrationAgentResponsePresentation(args: {
  readonly agentLabel: string | undefined;
  readonly modelLabel: string | undefined;
  readonly replyToMention?: string;
}): { readonly footerText: string | undefined } {
  const parts: string[] = [];
  if (args.agentLabel) {
    parts.push(`Responded by ${args.agentLabel}`);
  }
  if (args.replyToMention) {
    parts.push(`Reply to ${args.replyToMention}`);
  }
  if (args.modelLabel) {
    parts.push(args.modelLabel);
  }

  return {
    footerText: parts.length > 0 ? parts.join(" · ") : undefined,
  };
}
