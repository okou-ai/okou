import { and, eq } from "drizzle-orm";
import {
  getFrameworkForType,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agents } from "@okouai/db/schema/agent";

import type { Db } from "../external/db";
import { resolveRunModelSelection } from "./run-model-selection.service";

const ORG_SENTINEL_USER_ID = "__org__";

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
  return agent?.displayName ?? agent?.name ?? undefined;
}

async function resolveOrgDefaultModelProviderSelectedModel(
  db: Db,
  orgId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({
      type: modelProviders.type,
      selectedModel: modelProviders.selectedModel,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.isDefault, true),
      ),
    );
  const row = rows.find((candidate) => {
    const parsed = modelProviderTypeSchema.safeParse(candidate.type);
    return parsed.success && getFrameworkForType(parsed.data) === "claude-code";
  });
  return row?.selectedModel ?? undefined;
}

async function resolveModelLabel(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly runId: string;
}): Promise<string | undefined> {
  const runModel = await resolveRunModelSelection(args.db, args.runId);
  const model =
    runModel?.selectedModel ??
    (await resolveOrgDefaultModelProviderSelectedModel(args.db, args.orgId));
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
      orgId: args.orgId,
      runId: args.runId,
    }),
  ]);
  signal.throwIfAborted();

  const parts: string[] = [];
  if (agentLabel) {
    parts.push(`Responded by ${agentLabel}`);
  }
  if (args.replyToMention) {
    parts.push(`Reply to ${args.replyToMention}`);
  }
  if (modelLabel) {
    parts.push(modelLabel);
  }

  return {
    footerText: parts.length > 0 ? parts.join(" · ") : undefined,
  };
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
  const parts: string[] = [];
  if (agentLabel) {
    parts.push(`Sent via ${agentLabel}`);
  }
  if (args.replyToMention) {
    parts.push(`Reply to ${args.replyToMention}`);
  }
  return {
    footerText: parts.length > 0 ? parts.join(" · ") : undefined,
  };
}
