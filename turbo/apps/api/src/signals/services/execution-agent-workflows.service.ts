import { command } from "ccstate";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { workflows } from "@okouai/db/schema/workflow";
import { writeDb$ } from "../external/db";

export interface SelectedAgentWorkflow {
  readonly workflowId: string;
  readonly name: string;
  readonly officialDefinitionName: string | null;
}

/** Capture only explicit invocation identity; available-skill discovery stays live. */
export const captureInvokedWorkflow$ = command(
  async (
    { set },
    input: {
      readonly agentId: string | null;
      readonly orgId: string;
      readonly userId: string;
      readonly prompt: string;
    },
    signal: AbortSignal,
  ) => {
    const name = /^\/([a-z0-9][a-z0-9-]{0,62}[a-z0-9])(?:\s|$)/u.exec(
      input.prompt.trim(),
    )?.[1];
    if (
      input.agentId === null ||
      name === undefined ||
      SEED_SKILLS.includes(name)
    ) {
      return null;
    }
    const [workflow] = await set(writeDb$)
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, input.orgId),
          eq(workflows.agentId, input.agentId),
          eq(workflows.name, name),
          isNull(workflows.officialDefinitionName),
          or(
            eq(workflows.visibility, "public"),
            eq(workflows.ownerUserId, input.userId),
          ),
        ),
      )
      .orderBy(
        desc(eq(workflows.visibility, "private")),
        asc(workflows.createdAt),
        asc(workflows.id),
      )
      .limit(1);
    signal.throwIfAborted();
    return workflow?.id ?? null;
  },
);
