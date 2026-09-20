import { command } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";

import { writeDb$, type Db } from "../external/db";
import { publishBuiltinConnectorInvalidationAfterCommit } from "./connector-client-invalidation.service";
import { updateUserBuiltinConnectors } from "./user-connectors.service";

interface AuthorizableAgent {
  readonly id: string;
}

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

async function authorizableAgent(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<AuthorizableAgent | null> {
  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
    })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, args.orgId),
        eq(agents.id, args.agentId),
        or(eq(agents.visibility, "public"), eq(agents.owner, args.userId)),
      ),
    )
    .limit(1);
  return agent ?? null;
}

async function connectorAuthorizationTargetExists(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<boolean> {
  return (await authorizableAgent(db, args)) !== null;
}

export const validateConnectorAuthorizationTarget$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; message: string }
  > => {
    if (!args.agentId) {
      return { ok: true };
    }
    const exists = await connectorAuthorizationTargetExists(set(writeDb$), {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.agentId,
    });
    signal.throwIfAborted();
    return exists
      ? { ok: true }
      : { ok: false, message: agentNotFoundMessage(args.agentId) };
  },
);

async function resolveConnectorAuthorizationAgent(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string | null;
  },
): Promise<AuthorizableAgent | null> {
  let agentId = args.agentId;
  if (!agentId) {
    const [metadata] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    agentId = metadata?.defaultAgentId ?? null;
  }
  if (!agentId) {
    return null;
  }
  return await authorizableAgent(db, { ...args, agentId });
}

export const authorizeConnectedConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string | null;
      readonly connectorSlug: ConnectorSlug;
    },
    signal: AbortSignal,
  ): Promise<AuthorizeConnectedConnectorResult> => {
    const writeDb = set(writeDb$);
    const agent = await resolveConnectorAuthorizationAgent(writeDb, args);
    signal.throwIfAborted();
    if (!agent) {
      if (!args.agentId) {
        return { status: "noAgent" };
      }
      return {
        status: "agentNotFound",
        message: agentNotFoundMessage(args.agentId),
      };
    }

    const updated = await updateUserBuiltinConnectors(writeDb, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: agent.id,
      enabledConnectorSlugs: [args.connectorSlug],
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
        userId: args.userId,
        connectorSlug: args.connectorSlug,
      },
      signal,
    );
    return { status: "authorized", agentId: agent.id };
  },
);
