import { computed } from "ccstate";
import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agents } from "@okouai/db/schema/agent";
import { eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { db$ } from "../external/db";
import { tapError } from "../utils";

const attributionRun$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!("runId" in auth)) {
    return undefined;
  }
  const [row] = await get(db$)
    .select({
      sessionId: agentRuns.sessionId,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      selectedModel: agentRuns.selectedModel,
      codexServiceTier: agentRuns.codexServiceTier,
      triggerSource: agentRuns.triggerSource,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, auth.runId))
    .limit(1);
  return row;
});

const agentLabel$ = computed(async (get) => {
  const run = await get(attributionRun$);
  if (!run) {
    return undefined;
  }
  const [row] = await get(db$)
    .select({ displayName: agents.displayName, name: agents.name })
    .from(agentSessions)
    .innerJoin(agents, eq(agentSessions.agentId, agents.id))
    .where(eq(agentSessions.id, run.sessionId))
    .limit(1);
  return row ? (row.displayName ?? row.name) : undefined;
});

const modelLabel$ = computed(async (get) => {
  const run = await get(attributionRun$);
  if (!run || run.triggerSource === null || run.selectedModel === null) {
    return undefined;
  }
  // Preserve the existing attribution reader's historical tier normalization.
  return getRunModelDisplayName(
    run.selectedModel,
    run.codexServiceTier === "fast" ? "fast" : null,
  );
});

/** Request-owned reads share Slack's independently best-effort attribution. */
export const integrationMessageSendLabels$ = computed(async (get) => {
  const noop = (): void => {};
  const [run, agentLabel, modelLabel] = await Promise.all([
    tapError(get(attributionRun$), noop),
    tapError(get(agentLabel$), noop),
    tapError(get(modelLabel$), noop),
  ]);
  return {
    agentLabel,
    modelLabel,
    runOwner: run ? { orgId: run.orgId, userId: run.userId } : undefined,
  };
});

/** Format captured display data; the caller supplies its verified sender. */
export function discordMessageSendFooterText(args: {
  readonly agentLabel: string | undefined;
  readonly modelLabel: string | undefined;
  readonly discordUserId: string;
}) {
  if (!args.agentLabel && !args.modelLabel) {
    return undefined;
  }
  const parts: string[] = [];
  if (args.agentLabel) {
    parts.push(`Sent via ${args.agentLabel}`);
  }
  parts.push(`Triggered by <@${args.discordUserId}>`);
  if (args.modelLabel) {
    parts.push(args.modelLabel);
  }
  return parts.join(" · ");
}
