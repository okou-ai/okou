import { command, computed, type Computed } from "ccstate";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agentDeletionError } from "@okouai/core/agent-protection";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import type { Tx } from "../../lib/db-types";
import { env } from "../../lib/env";
import { conflict } from "../../lib/error";
import { isLockNotAvailable } from "../../lib/pg-errors";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { settle } from "../utils";
import { lockCanonicalAgentMutation } from "./agent-mutation-lock.service";
import { removeAgentInstructionsStorageInTransaction } from "./agent-instructions-storage-transaction.service";
import { reconcileAutomationEventWatches } from "./automation-event-watch-lifecycle.service";
import { purgeDeletedStoragePrefix$ } from "./storage-prefix-purge.service";
import {
  deleteRunConversations,
  logCommittedConversationDeletion,
  releaseDeletedConversationReferences,
} from "./conversation-history-deletion.service";

export function agentExistsInOrg(args: {
  readonly orgId: string;
  readonly agentId: string;
}): Computed<Promise<boolean>> {
  return computed(async (get): Promise<boolean> => {
    const [row] = await get(db$)
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, args.orgId), eq(agents.id, args.agentId)))
      .limit(1);

    return Boolean(row);
  });
}

const DELETE_AGENT_LOCK_TIMEOUT = "100ms";

interface DeleteAgentArgs {
  readonly agentId: string;
  readonly orgId: string;
  readonly member: { readonly userId: string; readonly role: string };
}

async function lockAgentLifecycleForDeletion(tx: Tx, args: DeleteAgentArgs) {
  await lockCanonicalAgentMutation(tx, args.agentId);

  const [agent] = await tx
    .select({
      id: agents.id,
      name: agents.name,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(and(eq(agents.id, args.agentId), eq(agents.orgId, args.orgId)))
    .for("update", { noWait: true })
    .limit(1);

  if (!agent) {
    return { kind: "missing" as const };
  }

  const permissionError = requireAgentPermission(
    agent.owner,
    args.member,
    "delete agent",
    { visibility: agent.visibility },
  );
  if (permissionError) {
    return { kind: "forbidden" as const, response: permissionError };
  }

  const [org] = await tx
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId));
  const identityError = agentDeletionError(agent.id === org?.defaultAgentId);
  if (identityError) {
    return {
      kind: "forbidden" as const,
      response: { status: 400 as const, body: { error: identityError } },
    };
  }

  const sessions = await tx
    .select({ id: agentSessions.id, orgId: agentSessions.orgId })
    .from(agentSessions)
    .where(eq(agentSessions.agentId, args.agentId))
    .orderBy(asc(agentSessions.id))
    .for("update", { noWait: true });

  if (
    sessions.some((session) => {
      return session.orgId !== args.orgId;
    })
  ) {
    return { kind: "ownership-conflict" as const };
  }

  const runs =
    sessions.length === 0
      ? []
      : await tx
          .select({
            id: agentRuns.id,
            orgId: agentRuns.orgId,
            status: agentRuns.status,
          })
          .from(agentRuns)
          .where(
            inArray(
              agentRuns.sessionId,
              tx
                .select({ id: agentSessions.id })
                .from(agentSessions)
                .where(eq(agentSessions.agentId, args.agentId)),
            ),
          )
          .orderBy(asc(agentRuns.id))
          .for("update", { noWait: true });

  if (
    runs.some((run) => {
      return run.orgId !== args.orgId;
    })
  ) {
    return { kind: "ownership-conflict" as const };
  }

  if (
    runs.some((run) => {
      return run.status === "pending" || run.status === "running";
    })
  ) {
    return { kind: "active-run" as const };
  }

  return {
    kind: "ready" as const,
    agentName: agent.name,
    runIds: runs.map((run) => {
      return run.id;
    }),
  };
}

async function deleteAgentInTransaction(tx: Tx, args: DeleteAgentArgs) {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${DELETE_AGENT_LOCK_TIMEOUT}, true)`,
  );

  const lifecycle = await lockAgentLifecycleForDeletion(tx, args);
  if (lifecycle.kind !== "ready") {
    return lifecycle;
  }

  const automations = await tx
    .select({
      orgId: workflowAutomations.orgId,
      ownerUserId: workflowAutomations.ownerUserId,
      eventType: workflowAutomations.eventType,
      eventConfig: workflowAutomations.eventConfig,
      eventConnectorId: workflowAutomations.eventConnectorId,
    })
    .from(workflowAutomations)
    .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
    .where(
      and(eq(workflows.orgId, args.orgId), eq(workflows.agentId, args.agentId)),
    );

  const removed = await deleteRunConversations(tx, lifecycle.runIds);

  await tx
    .delete(agents)
    .where(and(eq(agents.id, args.agentId), eq(agents.orgId, args.orgId)));

  const s3Prefix = await removeAgentInstructionsStorageInTransaction(tx, {
    orgId: args.orgId,
    agentName: lifecycle.agentName,
  });

  return {
    kind: "deleted" as const,
    s3Prefix,
    automations,
    conversationDeletion: await releaseDeletedConversationReferences(
      tx,
      removed,
    ),
  };
}

export const deleteAgentById$ = command(
  async ({ set }, args: DeleteAgentArgs, signal: AbortSignal) => {
    const writeDb = set(writeDb$);

    const transaction = await settle(
      writeDb.transaction(async (tx) => {
        return await deleteAgentInTransaction(tx, args);
      }),
      signal,
    );
    if (!transaction.ok) {
      if (isLockNotAvailable(transaction.error)) {
        return conflict("Cannot delete agent right now; retry shortly");
      }
      throw transaction.error;
    }
    const result = transaction.value;
    if (result.kind === "deleted") {
      logCommittedConversationDeletion("agent", result.conversationDeletion);
    }
    signal.throwIfAborted();

    if (result.kind === "ownership-conflict") {
      return conflict(
        "Cannot delete agent because its lifecycle ownership is inconsistent",
      );
    }

    if (result.kind === "active-run") {
      return conflict("Cannot delete agent: agent is currently running");
    }

    if (result.kind === "forbidden") {
      return result.response;
    }

    if (result.kind === "missing") {
      return undefined;
    }

    await reconcileAutomationEventWatches(
      {
        db: writeDb,
        automations: result.automations,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.s3Prefix) {
      await set(
        purgeDeletedStoragePrefix$,
        {
          bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
          s3Prefix: result.s3Prefix,
        },
        signal,
      );
    }

    return undefined;
  },
);
