import { randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import { and, count, eq, lt, sql } from "drizzle-orm";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
  type AgentVisibility,
} from "@okouai/api-contracts/contracts/agents";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { randomAvatarUrl } from "@okouai/core/agent-avatar";
import { agentIdentityUpdateError } from "@okouai/core/agent-protection";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { nowDate } from "../../lib/time";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { conflict, notFound } from "../../lib/error";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { deleteAgentById$ } from "../services/agent-deletion.service";
import { publishVncLifecycleInvalidation$ } from "../services/remote-runtime-wakeup.service";
import {
  agentResponse,
  agentDetail,
  agentEnabledConnectorSlugs,
  agentCustomConnectorGrants,
  agentExists,
  agentList,
  visibleJoinedAgentCondition,
} from "../services/agent-data.service";
import { connectorActionResolver } from "../services/connector-action-resolver.service";

import {
  updateUserBuiltinConnectors$,
  updateUserCustomConnectors$,
} from "../services/user-connectors.service";
import type { RouteEntry } from "../route-entry";

// This is a soft limit: concurrent requests may both observe an available slot.
const PUBLIC_AGENT_LIMIT = 7;

interface AgentUpdateBody {
  readonly displayName?: string;
  readonly description?: string;
  readonly sound?: string;
  readonly avatarUrl?: string | null;
  readonly visibility?: AgentVisibility;
}

interface ExistingAgentVisibility {
  readonly owner: string;
  readonly visibility: AgentVisibility;
}

interface ExistingAgentForUpdate extends ExistingAgentVisibility {
  readonly id: string;
  readonly defaultAgentId: string | null;
}

interface AgentMember {
  readonly userId: string;
  readonly role: string;
}

function agentNotFound(agentId: string) {
  return notFound(`Agent not found: ${agentId}`);
}

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

function validationError(message: string) {
  return {
    status: 400 as const,
    body: { error: { message, code: "VALIDATION_ERROR" as const } },
  };
}

function publicAgentLimitError() {
  return conflict(
    "This organization has reached the maximum number of agents (7). Delete an existing agent before making this agent public.",
  );
}

function publicAgentCreateLimitError() {
  return conflict(
    "This organization has reached the maximum number of agents (7). Delete an existing agent before creating a new one.",
  );
}

function buildAgentUpsertConflictSet(body: AgentUpdateBody, updatedAt: Date) {
  return {
    updatedAt,
    ...(body.displayName !== undefined && { displayName: body.displayName }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.sound !== undefined && { sound: body.sound }),
    ...(body.avatarUrl !== undefined && { avatarUrl: body.avatarUrl }),
    ...(body.visibility !== undefined && { visibility: body.visibility }),
  };
}

function requireAgentConfigurationPermission(
  existing: ExistingAgentForUpdate,
  member: AgentMember,
) {
  return requireAgentPermission(
    existing.owner,
    member,
    "update agent configuration",
    { visibility: existing.visibility },
  );
}

function visibilityOwnerError(
  existing: ExistingAgentVisibility,
  member: AgentMember,
  requestedVisibility: AgentVisibility | undefined,
) {
  if (requestedVisibility === undefined || existing.owner === member.userId) {
    return null;
  }

  return forbidden("Only the agent owner can update agent visibility");
}

async function publicVisibilitySlotError(
  args: {
    readonly writeDb: Pick<Db, "select">;
    readonly orgId: string;
    readonly currentVisibility: AgentVisibility;
    readonly nextVisibility: AgentVisibility;
  },
  signal: AbortSignal,
) {
  if (args.nextVisibility !== "public" || args.currentVisibility === "public") {
    return null;
  }

  const [publicAgentCount] = await args.writeDb
    .select({ value: count() })
    .from(agents)
    .where(and(eq(agents.orgId, args.orgId), eq(agents.visibility, "public")));
  signal.throwIfAborted();

  return (publicAgentCount?.value ?? 0) >= PUBLIC_AGENT_LIMIT
    ? publicAgentLimitError()
    : null;
}

function validateAgentVisibilityUpdate(
  args: {
    readonly writeDb: Pick<Db, "select">;
    readonly orgId: string;
    readonly member: AgentMember;
    readonly existing: ExistingAgentVisibility;
    readonly requestedVisibility: AgentVisibility | undefined;
    readonly nextVisibility: AgentVisibility;
  },
  signal: AbortSignal,
) {
  const ownerError = visibilityOwnerError(
    args.existing,
    args.member,
    args.requestedVisibility,
  );
  if (ownerError) {
    return ownerError;
  }

  return publicVisibilitySlotError(
    {
      writeDb: args.writeDb,
      orgId: args.orgId,
      currentVisibility: args.existing.visibility,
      nextVisibility: args.nextVisibility,
    },
    signal,
  );
}

function agentUpdateResponseSelection() {
  return {
    agentId: agents.id,
    defaultAgentId: orgMetadata.defaultAgentId,
    owner: agents.owner,
    displayName: agents.displayName,
    description: agents.description,
    sound: agents.sound,
    avatarUrl: agents.avatarUrl,
    visibility: agents.visibility,
  };
}

function agentCreateSelection(values: typeof agents.$inferSelect) {
  // Defer text admission until the eligible INSERT row is projected. Binding
  // raw NUL text would reject before the public-count predicate can run.
  const displayName =
    values.displayName === null
      ? null
      : Buffer.from(
          pgTextDecoder.mapFromDriverValue(
            agents.displayName.mapToDriverValue(values.displayName),
          ),
          "utf8",
        );
  const description =
    values.description === null
      ? null
      : Buffer.from(
          pgTextDecoder.mapFromDriverValue(
            agents.description.mapToDriverValue(values.description),
          ),
          "utf8",
        );
  const sound =
    values.sound === null
      ? null
      : Buffer.from(
          pgTextDecoder.mapFromDriverValue(
            agents.sound.mapToDriverValue(values.sound),
          ),
          "utf8",
        );
  const avatarUrl =
    values.avatarUrl === null
      ? null
      : Buffer.from(
          pgTextDecoder.mapFromDriverValue(
            agents.avatarUrl.mapToDriverValue(values.avatarUrl),
          ),
          "utf8",
        );
  return {
    id: sql`${sql.param(values.id, agents.id)}`.mapWith(agents.id).as("id"),
    orgId: sql`${sql.param(values.orgId, agents.orgId)}`
      .mapWith(agents.orgId)
      .as("org_id"),
    owner: sql`${sql.param(values.owner, agents.owner)}`
      .mapWith(agents.owner)
      .as("owner"),
    name: sql`${sql.param(values.name, agents.name)}`
      .mapWith(agents.name)
      .as("name"),
    visibility: sql`${sql.param(values.visibility, agents.visibility)}`
      .mapWith(agents.visibility)
      .as("visibility"),
    displayName: sql`convert_from(${sql.param(displayName)}, 'UTF8')`
      .mapWith(nullableDriverValueDecoder(agents.displayName))
      .as("display_name"),
    description: sql`convert_from(${sql.param(description)}, 'UTF8')`
      .mapWith(nullableDriverValueDecoder(agents.description))
      .as("description"),
    instructions: sql`${sql.param(values.instructions, agents.instructions)}`
      .mapWith(agents.instructions)
      .as("instructions"),
    sound: sql`convert_from(${sql.param(sound)}, 'UTF8')`
      .mapWith(nullableDriverValueDecoder(agents.sound))
      .as("sound"),
    avatarUrl: sql`convert_from(${sql.param(avatarUrl)}, 'UTF8')`
      .mapWith(nullableDriverValueDecoder(agents.avatarUrl))
      .as("avatar_url"),
    createdAt: sql`${sql.param(values.createdAt, agents.createdAt)}`
      .mapWith(agents.createdAt)
      .as("created_at"),
    updatedAt: sql`${sql.param(values.updatedAt, agents.updatedAt)}`
      .mapWith(agents.updatedAt)
      .as("updated_at"),
  };
}

const createAgentBody$ = bodyResultOf(agentsMainContract.create);

const createAgentInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(createAgentBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const writeDb = set(writeDb$);
  const visibility = body.data.visibility ?? "private";

  if (visibility === "public") {
    const [publicAgentCount] = await writeDb
      .select({ value: count() })
      .from(agents)
      .where(
        and(eq(agents.orgId, auth.orgId), eq(agents.visibility, "public")),
      );
    signal.throwIfAborted();
    if ((publicAgentCount?.value ?? 0) >= PUBLIC_AGENT_LIMIT) {
      return publicAgentCreateLimitError();
    }
  }

  const agentId = randomUUID();
  const avatarUrl =
    body.data.avatarUrl === undefined ? randomAvatarUrl() : body.data.avatarUrl;

  const metadata = {
    displayName: body.data.displayName ?? null,
    description: body.data.description ?? null,
    sound: body.data.sound ?? null,
    avatarUrl,
    visibility,
  };

  // Public creation captures time before its combined count/write statement.
  const createdAt = nowDate();
  const values = {
    id: agentId,
    orgId: auth.orgId,
    owner: auth.userId,
    name: agentId,
    instructions: "",
    ...metadata,
    createdAt,
    updatedAt: createdAt,
  };
  let blocked = false;
  if (visibility === "public") {
    const publicAgentCount = writeDb
      .select({ value: count().as("value") })
      .from(agents)
      .where(and(eq(agents.orgId, auth.orgId), eq(agents.visibility, "public")))
      .as("public_agent_count");
    const inserted = await writeDb
      .insert(agents)
      .select(
        writeDb
          .select(agentCreateSelection(values))
          .from(publicAgentCount)
          .where(lt(publicAgentCount.value, PUBLIC_AGENT_LIMIT)),
      )
      .returning({ id: agents.id });
    signal.throwIfAborted();
    blocked = inserted.length === 0;
  } else {
    await writeDb.insert(agents).values(values);
  }
  signal.throwIfAborted();

  if (blocked) {
    return publicAgentCreateLimitError();
  }

  const [agent] = await writeDb
    .select({
      agentId: agents.id,
      defaultAgentId: orgMetadata.defaultAgentId,
      owner: agents.owner,
      displayName: agents.displayName,
      description: agents.description,
      sound: agents.sound,
      avatarUrl: agents.avatarUrl,
      visibility: agents.visibility,
    })
    .from(agents)
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
    .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, agentId)))
    .limit(1);
  signal.throwIfAborted();

  if (!agent) {
    throw new Error(`Created Agent not found: ${agentId}`);
  }

  return { status: 201 as const, body: agentResponse(agent) };
});

const agentListResponse$ = computed(
  async (
    get,
  ): Promise<{ readonly status: 200; readonly body: AgentResponse[] }> => {
    const auth = get(organizationAuthContext$);
    const agents = await get(agentList(auth.orgId, auth.userId));
    return { status: 200 as const, body: [...agents] };
  },
);

const getAgentInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(agentsByIdContract.get));
  const agent = await get(
    agentDetail({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  if (!agent) {
    return agentNotFound(params.id);
  }
  return { status: 200 as const, body: agent };
});

const getAgentUserConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(userBuiltinConnectorsContract.get));
  const exists = await get(
    agentExists({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  if (!exists) {
    return agentNotFound(params.id);
  }

  const enabledConnectorSlugs = await get(
    agentEnabledConnectorSlugs({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  const resolver = await get(connectorActionResolver(enabledConnectorSlugs));
  const availableEnabledConnectorSlugs: (typeof enabledConnectorSlugs)[number][] =
    [];
  for (const connectorSlug of enabledConnectorSlugs) {
    const resolved = await resolver.resolveSlug({
      connectorSlug,
      requireExecutable: true,
    });
    if (resolved.ok) {
      availableEnabledConnectorSlugs.push(connectorSlug);
    }
  }
  return {
    status: 200 as const,
    body: {
      enabledConnectorSlugs: availableEnabledConnectorSlugs,
    },
  };
});

const getAgentCustomConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(agentCustomConnectorsContract.get));
  const exists = await get(
    agentExists({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  if (!exists) {
    return agentNotFound(params.id);
  }

  const grants = await get(
    agentCustomConnectorGrants({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  return {
    status: 200 as const,
    body: {
      grants: [...grants],
    },
  };
});

const updateAgentCustomConnectorsBody$ = bodyResultOf(
  agentCustomConnectorsContract.update,
);

const updateAgentBody$ = bodyResultOf(agentsByIdContract.update);

const updateAgentInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const member = { userId: auth.userId, role: auth.orgRole ?? "member" };
  const params = get(pathParamsOf(agentsByIdContract.update));
  const body = await get(updateAgentBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const writeDb = set(writeDb$);
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0011; new non-billing transactions are prohibited.
  const result = await writeDb.transaction(async (tx) => {
    await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, params.id)))
      .for("update");

    const existingDb = tx;
    const existingOrgId = auth.orgId;
    const existingAgentId = params.id;
    const existing: ExistingAgentForUpdate | null = await (async () => {
      const rows = await existingDb
        .select({
          id: agents.id,
          owner: agents.owner,
          visibility: agents.visibility,
          defaultAgentId: orgMetadata.defaultAgentId,
        })
        .from(agents)
        .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
        .where(
          and(eq(agents.orgId, existingOrgId), eq(agents.id, existingAgentId)),
        )
        .limit(1);
      return rows[0] ?? null;
    })();
    if (!existing) {
      return { response: agentNotFound(params.id) };
    }
    const updateBody = body.data;

    const permissionError = requireAgentConfigurationPermission(
      existing,
      member,
    );
    if (permissionError) {
      return { response: permissionError };
    }

    const identityError = agentIdentityUpdateError(
      existing.id === existing.defaultAgentId,
      updateBody,
    );
    if (identityError) {
      return {
        response: { status: 400 as const, body: { error: identityError } },
      };
    }

    const nextVisibility = updateBody.visibility ?? existing.visibility;
    const visibilityError = await validateAgentVisibilityUpdate(
      {
        writeDb: tx,
        orgId: auth.orgId,
        member,
        existing,
        requestedVisibility: updateBody.visibility,
        nextVisibility,
      },
      signal,
    );
    if (visibilityError) {
      return { response: visibilityError };
    }

    await tx
      .update(agents)
      .set(buildAgentUpsertConflictSet(updateBody, nowDate()))
      .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, params.id)));
    const responseDb = tx;
    const responseOrgId = auth.orgId;
    const responseAgentId = params.id;
    const agent = await (async () => {
      const rows = await responseDb
        .select(agentUpdateResponseSelection())
        .from(agents)
        .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
        .where(
          and(eq(agents.orgId, responseOrgId), eq(agents.id, responseAgentId)),
        )
        .limit(1);
      return rows[0] ?? null;
    })();
    if (!agent) {
      throw new Error(`Canonical Agent missing after update: ${params.id}`);
    }
    return { agent };
  });
  signal.throwIfAborted();

  if ("response" in result) {
    return result.response;
  }

  if (body.data.visibility === "private") {
    await set(
      publishVncLifecycleInvalidation$,
      {
        kind: "agent",
        orgId: auth.orgId,
        agentId: params.id,
        ownerId: result.agent.owner,
      },
      signal,
    );
  }

  return {
    status: 200 as const,
    body: agentResponse(result.agent),
  };
});

const updateAgentMetadataBody$ = bodyResultOf(
  agentsByIdContract.updateMetadata,
);

const updateAgentMetadataInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = { userId: auth.userId, role: auth.orgRole ?? "member" };
    const params = get(pathParamsOf(agentsByIdContract.updateMetadata));
    const body = await get(updateAgentMetadataBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const writeDb = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0012; new non-billing transactions are prohibited.
    const result = await writeDb.transaction(async (tx) => {
      await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, params.id)))
        .for("update");

      const existingDb = tx;
      const existingOrgId = auth.orgId;
      const existingAgentId = params.id;
      const existing: ExistingAgentForUpdate | null = await (async () => {
        const rows = await existingDb
          .select({
            id: agents.id,
            owner: agents.owner,
            visibility: agents.visibility,
            defaultAgentId: orgMetadata.defaultAgentId,
          })
          .from(agents)
          .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
          .where(
            and(
              eq(agents.orgId, existingOrgId),
              eq(agents.id, existingAgentId),
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      })();
      if (!existing) {
        return { response: agentNotFound(params.id) };
      }
      const updateBody = body.data;

      const permissionError = requireAgentPermission(
        existing.owner,
        member,
        body.data.avatarUrl === undefined
          ? "update agent profile"
          : "update agent avatar",
        { visibility: existing.visibility },
      );
      if (permissionError) {
        return { response: permissionError };
      }

      const identityError = agentIdentityUpdateError(
        existing.id === existing.defaultAgentId,
        updateBody,
      );
      if (identityError) {
        return {
          response: { status: 400 as const, body: { error: identityError } },
        };
      }

      if (updateBody.visibility !== undefined) {
        const visibilityError = await validateAgentVisibilityUpdate(
          {
            writeDb: tx,
            orgId: auth.orgId,
            member,
            existing,
            requestedVisibility: updateBody.visibility,
            nextVisibility: updateBody.visibility,
          },
          signal,
        );
        if (visibilityError) {
          return { response: visibilityError };
        }
      }

      await tx
        .update(agents)
        .set(buildAgentUpsertConflictSet(updateBody, nowDate()))
        .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, params.id)));
      const responseDb = tx;
      const responseOrgId = auth.orgId;
      const responseAgentId = params.id;
      const agent = await (async () => {
        const rows = await responseDb
          .select(agentUpdateResponseSelection())
          .from(agents)
          .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
          .where(
            and(
              eq(agents.orgId, responseOrgId),
              eq(agents.id, responseAgentId),
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      })();
      if (!agent) {
        throw new Error(`Canonical Agent missing after update: ${params.id}`);
      }
      return { agent };
    });
    signal.throwIfAborted();

    if ("response" in result) {
      return result.response;
    }

    if (body.data.visibility === "private") {
      await set(
        publishVncLifecycleInvalidation$,
        {
          kind: "agent",
          orgId: auth.orgId,
          agentId: params.id,
          ownerId: result.agent.owner,
        },
        signal,
      );
    }

    return {
      status: 200 as const,
      body: agentResponse(result.agent),
    };
  },
);

const initialDeleteAgent$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(agentsByIdContract.delete));
  const db = get(db$);
  const [agent] = await db
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, params.id)))
    .limit(1);
  return agent;
});

const deleteAgentInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const member = { userId: auth.userId, role: auth.orgRole ?? "member" };
  const params = get(pathParamsOf(agentsByIdContract.delete));

  const agent = await get(initialDeleteAgent$);
  signal.throwIfAborted();

  if (!agent) {
    return agentNotFound(params.id);
  }

  const permissionError = requireAgentPermission(
    agent.owner,
    member,
    "delete agent",
    { visibility: agent.visibility },
  );
  if (permissionError) {
    return permissionError;
  }

  const result = await set(
    deleteAgentById$,
    { agentId: agent.id, orgId: auth.orgId, member },
    signal,
  );
  signal.throwIfAborted();

  if (result) {
    return result;
  }

  return { status: 204 as const, body: undefined };
});

const updateAgentCustomConnectorsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(agentCustomConnectorsContract.update));
    const body = await get(updateAgentCustomConnectorsBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const exists = await get(
      agentExists({
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: params.id,
      }),
    );
    signal.throwIfAborted();
    if (!exists) {
      return agentNotFound(params.id);
    }

    const operation = body.data.operation ?? "replace";

    const updated = await set(updateUserCustomConnectors$, {
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
      grants: body.data.grants,
      permissionIntent: "exact",
      operation,
    });
    signal.throwIfAborted();
    if (updated.status === "agentNotFound") {
      return agentNotFound(params.id);
    }
    if (updated.status === "customConnectorsNotFound") {
      return {
        status: 400 as const,
        body: {
          error: {
            message: `Unknown custom connector ids: ${updated.missingIds.join(", ")}`,
            code: "VALIDATION_ERROR",
          },
        },
      };
    }
    if (updated.status === "customConnectorPermissionSelectionRequired") {
      return validationError(
        `Permission selection is required for custom connector ids: ${updated.connectorIds.join(", ")}`,
      );
    }
    if (updated.status === "invalidCustomConnectorPermissions") {
      return validationError(updated.message);
    }

    await publishUserSignal([auth.userId], "composerAgentConnectorsChanged", {
      agentId: params.id,
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        grants: [...updated.grants],
      },
    };
  },
);

const updateAgentUserConnectorsBody$ = bodyResultOf(
  userBuiltinConnectorsContract.update,
);

const updateAgentUserConnectorsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(userBuiltinConnectorsContract.update));
    const body = await get(updateAgentUserConnectorsBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const writeDb = set(writeDb$);
    const [agent] = await writeDb
      .select({
        id: agents.id,
      })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, auth.orgId),
          eq(agents.id, params.id),
          visibleJoinedAgentCondition(auth.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!agent) {
      return agentNotFound(params.id);
    }

    const uniqueConnectorSlugs = Array.from(
      new Set(body.data.enabledConnectorSlugs),
    );
    const operation = body.data.operation ?? "replace";
    if (operation !== "remove") {
      // Agent connector selection is persisted execution configuration, not a
      // discovery surface. Validate that each connector can execute, but do
      // not consult feature switches or authored visibility: rollout changes
      // must not invalidate direct API updates or an existing agent config.
      const resolver = await get(connectorActionResolver(uniqueConnectorSlugs));
      signal.throwIfAborted();
      const resolved = await resolver.resolveSlugs({
        connectorSlugs: uniqueConnectorSlugs,
        requireExecutable: true,
      });
      signal.throwIfAborted();
      if (!resolved.ok) {
        return validationError(
          `Invalid connector slugs: ${resolved.connectorSlug}`,
        );
      }
    }

    const updated = await set(updateUserBuiltinConnectors$, {
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
      enabledConnectorSlugs: uniqueConnectorSlugs,
      operation,
    });
    signal.throwIfAborted();
    if (updated.status === "agentNotFound") {
      return agentNotFound(params.id);
    }

    const enabledConnectorSlugs = [...updated.enabledConnectorSlugs];
    await publishUserSignal([auth.userId], "composerAgentConnectorsChanged", {
      agentId: params.id,
    });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        enabledConnectorSlugs,
      },
    };
  },
);

const agentReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const agentWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

const agentDeleteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:delete",
} as const;

export const agentsRoutes: readonly RouteEntry[] = [
  {
    route: agentsMainContract.create,
    handler: authRoute(agentWriteAuth, createAgentInner$),
  },
  {
    route: agentsMainContract.list,
    handler: authRoute(
      { ...agentReadAuth, oauthScope: "okou:chat:read" },
      agentListResponse$,
    ),
  },
  {
    route: agentsByIdContract.get,
    handler: authRoute(agentReadAuth, getAgentInner$),
  },
  {
    route: agentsByIdContract.update,
    handler: authRoute(agentWriteAuth, updateAgentInner$),
  },
  {
    route: agentsByIdContract.updateMetadata,
    handler: authRoute(agentWriteAuth, updateAgentMetadataInner$),
  },
  {
    route: agentsByIdContract.delete,
    handler: authRoute(agentDeleteAuth, deleteAgentInner$),
  },
  {
    route: userBuiltinConnectorsContract.get,
    handler: authRoute(agentReadAuth, getAgentUserConnectorsInner$),
  },
  {
    route: agentCustomConnectorsContract.get,
    handler: authRoute(agentReadAuth, getAgentCustomConnectorsInner$),
  },
  {
    route: agentCustomConnectorsContract.update,
    handler: authRoute(agentReadAuth, updateAgentCustomConnectorsInner$),
  },
  {
    route: userBuiltinConnectorsContract.update,
    handler: authRoute(agentReadAuth, updateAgentUserConnectorsInner$),
  },
];
