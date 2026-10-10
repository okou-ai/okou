import { command } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";

import { db$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { publishBuiltinConnectorInvalidationAfterCommit } from "./connector-client-invalidation.service";
import { updateUserBuiltinConnectors$ } from "./user-connectors.service";

type AuthorizeConnectedConnectorResult =
  | { readonly status: "authorized"; readonly agentId: string }
  | { readonly status: "noAgent" }
  | { readonly status: "agentNotFound"; readonly message: string };

function agentNotFoundMessage(agentId: string | null): string {
  return agentId ? `Agent not found: ${agentId}` : "Default agent not found";
}

export function connectorAgentAuthorizationRequested(args: {
  readonly agentId?: string | null;
  readonly authorizeAgent?: boolean;
}): boolean {
  return (
    args.authorizeAgent === true ||
    (args.agentId !== null && args.agentId !== undefined)
  );
}

export const validateConnectorAuthorizationTarget$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; message: string }
  > => {
    const { orgId, userId, agentId } = args;
    if (!agentId) {
      return { ok: true };
    }
    const [agent] = await get(db$)
      .select({
        id: agents.id,
        name: agents.name,
      })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          eq(agents.id, agentId),
          or(eq(agents.visibility, "public"), eq(agents.owner, userId)),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return agent
      ? { ok: true }
      : { ok: false, message: agentNotFoundMessage(agentId) };
  },
);

export const authorizeConnectedConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string | null;
      readonly connectorSlug: ConnectorSlug;
    },
    signal: AbortSignal,
  ): Promise<AuthorizeConnectedConnectorResult> => {
    const { orgId, userId, agentId: requestedAgentId, connectorSlug } = args;
    let agentId = requestedAgentId;
    if (!agentId) {
      const [metadata] = await get(db$)
        .select({ defaultAgentId: orgMetadata.defaultAgentId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      signal.throwIfAborted();
      agentId = metadata?.defaultAgentId ?? null;
    }
    if (!agentId) {
      return { status: "noAgent" };
    }

    const [agent] = await get(db$)
      .select({
        id: agents.id,
        name: agents.name,
      })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          eq(agents.id, agentId),
          or(eq(agents.visibility, "public"), eq(agents.owner, userId)),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      if (!requestedAgentId) {
        return { status: "noAgent" };
      }
      return {
        status: "agentNotFound",
        message: agentNotFoundMessage(requestedAgentId),
      };
    }

    const updated = await set(updateUserBuiltinConnectors$, {
      orgId,
      userId,
      agentId: agent.id,
      enabledConnectorSlugs: [connectorSlug],
      operation: "add",
    });
    signal.throwIfAborted();
    if (updated.status === "agentNotFound") {
      return {
        status: "agentNotFound",
        message: agentNotFoundMessage(agent.id),
      };
    }

    await publishBuiltinConnectorInvalidationAfterCommit(
      {
        userId,
        connectorSlug,
      },
      signal,
    );
    await publishUserSignal([userId], "composerAgentConnectorsChanged", {
      agentId: agent.id,
    });
    signal.throwIfAborted();
    return { status: "authorized", agentId: agent.id };
  },
);
