import { computed } from "ccstate";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { db$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { tapError } from "../utils";

const attributionRun$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (!("runId" in auth)) {
    return undefined;
  }
  const [row] = await get(db$)
    .select({
      agentId: agentRuns.agentId,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, auth.runId))
    .limit(1);
  return row;
});

const agentLabel$ = computed(async (get) => {
  const run = await get(attributionRun$);
  if (!run?.agentId) {
    return undefined;
  }
  const [row] = await get(db$)
    .select({ displayName: agents.displayName, name: agents.name })
    .from(agents)
    .where(eq(agents.id, run.agentId))
    .limit(1);
  return (
    (row?.displayName ?? row?.name)?.trim().replace(/\s+/gu, " ") || undefined
  );
});

const userLabel$ = computed(async (get) => {
  const run = await get(attributionRun$);
  if (!run) {
    return undefined;
  }
  const user = await findClerkUser(get(clerk$), run.userId);
  return (
    [user?.firstName, user?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim()
      .replace(/\s+/gu, " ") || undefined
  );
});

/** Request-owned reads share Slack's independently best-effort attribution. */
export const integrationMessageSendLabels$ = computed(async (get) => {
  const noop = (): void => {};
  const [run, agentLabel] = await Promise.all([
    tapError(get(attributionRun$), noop),
    tapError(get(agentLabel$), noop),
  ]);
  return {
    agentLabel,
    runOwner: run ? { orgId: run.orgId, userId: run.userId } : undefined,
  };
});

/** Native mentions already name the sender; resolve a profile only when needed. */
export const integrationMessageSendUserLabel$ = computed(async (get) => {
  const noop = (): void => {};
  return await tapError(get(userLabel$), noop);
});

/** Platform callers escape display labels and supply a verified native mention. */
export function integrationMessageSendFooterText(args: {
  readonly agentLabel: string | undefined;
  readonly userLabel: string | undefined;
}) {
  const parts: string[] = [];
  if (args.agentLabel) {
    parts.push(`Sent via ${args.agentLabel}`);
  }
  if (args.userLabel) {
    parts.push(`Triggered by ${args.userLabel}`);
  }
  return parts.length ? parts.join(" · ") : undefined;
}

export const integrationMessageSendFooterText$ = computed(async (get) => {
  const [labels, userLabel] = await Promise.all([
    get(integrationMessageSendLabels$),
    get(integrationMessageSendUserLabel$),
  ]);
  return integrationMessageSendFooterText({ ...labels, userLabel });
});
