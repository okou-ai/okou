import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";

import { db$ } from "../external/db";
import {
  runModelSelectionColumns,
  runModelSelectionCondition,
  runModelSelectionFromRow,
} from "./run-model-selection.service";

/** Names the responding agent only when it is not the org default. */
const resolveNonDefaultAgentLabel$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly composeId: string;
      readonly defaultAgentId?: string;
    },
  ): Promise<string | undefined> => {
    const db = get(db$);
    const defaultAgentId =
      args.defaultAgentId ??
      (
        await db
          .select({ defaultAgentId: orgMetadata.defaultAgentId })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, args.orgId))
          .limit(1)
      )[0]?.defaultAgentId;

    if (args.composeId === defaultAgentId) {
      return undefined;
    }

    const [agent] = await db
      .select({ displayName: agents.displayName, name: agents.name })
      .from(agents)
      .where(eq(agents.id, args.composeId))
      .limit(1);
    return agent?.displayName ?? agent?.name;
  },
);

const resolveModelLabel$ = command(
  async (
    { get },
    args: {
      readonly runId: string;
    },
  ): Promise<string | undefined> => {
    const db = get(db$);
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
  },
);

export const resolveIntegrationAgentResponsePresentation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly runId: string;
      readonly agentId: string;
      readonly defaultAgentId?: string;
      readonly replyToMention?: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly footerText: string | undefined;
  }> => {
    const [agentLabel, modelLabel] = await Promise.all([
      set(resolveNonDefaultAgentLabel$, {
        orgId: args.orgId,
        composeId: args.agentId,
        defaultAgentId: args.defaultAgentId,
      }),
      set(resolveModelLabel$, {
        runId: args.runId,
      }),
    ]);
    signal.throwIfAborted();

    return integrationAgentResponsePresentation({
      agentLabel,
      modelLabel,
      replyToMention: args.replyToMention,
    });
  },
);

/**
 * Admission failures have no run, so the footer names only the chat's agent
 * and the mentioned sender, like other integrations' admission notices.
 */
export const resolveIntegrationAdmissionFailurePresentation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly agentId: string;
      readonly replyToMention?: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly footerText: string | undefined;
  }> => {
    const agentLabel = await set(resolveNonDefaultAgentLabel$, {
      orgId: args.orgId,
      composeId: args.agentId,
    });
    signal.throwIfAborted();
    return integrationAdmissionFailurePresentation({
      agentLabel,
      replyToMention: args.replyToMention,
    });
  },
);

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
