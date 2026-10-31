import { publishContentBundle$ } from "../services/content-bundle.service";
import { randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { enum as zodEnum, int, object, string } from "zod";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
  type AgentVisibility,
} from "@okouai/api-contracts/contracts/agents";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { randomAvatarUrl } from "@okouai/core/agent-avatar";
import { agentIdentityUpdateError } from "@okouai/core/agent-protection";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { nowDate, nowDateSql } from "../../lib/time";
import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { conflict, notFound } from "../../lib/error";
import { parseRawRows } from "../../lib/db-raw-rows";
import { requireAgentPermission } from "../../lib/require-agent-permission";
import { deleteAgentById$ } from "../services/agent-deletion.service";
import { publishVncLifecycleInvalidation$ } from "../services/remote-runtime-wakeup.service";
import {
  agentResponse,
  agentEnabledConnectorSlugsCondition,
  agentCustomConnectorGrantJoinCondition,
  agentCustomConnectorGrantsCondition,
  visibleAgentIdentityCondition,
  agentList,
  visibleJoinedAgentCondition,
  nonDefaultAgentCondition,
  publicAgentCountReadPlan,
} from "../services/agent-data.service";
import {
  connectorActionResolver,
  readConnectorResolver$,
} from "../services/connector-action-resolver.service";

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

function deferredAgentUpdateText(value: string | null) {
  // Admit text only for an eligible UPDATE, after its business checks.
  return value === null
    ? null
    : sql`convert_from(${sql.param(Buffer.from(value, "utf8"))}, 'UTF8')`;
}

function agentConfigurationUpdateValues(body: AgentUpdateBody) {
  return {
    updatedAt: nowDateSql(),
    ...(body.displayName !== undefined && {
      displayName: deferredAgentUpdateText(body.displayName),
    }),
    ...(body.description !== undefined && {
      description: deferredAgentUpdateText(body.description),
    }),
    ...(body.sound !== undefined && {
      sound: deferredAgentUpdateText(body.sound),
    }),
    ...(body.avatarUrl !== undefined && {
      avatarUrl: deferredAgentUpdateText(body.avatarUrl),
    }),
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

function agentMetadataUpdateRejection(
  existing: ExistingAgentForUpdate,
  member: AgentMember,
  updateBody: AgentUpdateBody,
) {
  const permissionError = requireAgentPermission(
    existing.owner,
    member,
    updateBody.avatarUrl === undefined
      ? "update agent profile"
      : "update agent avatar",
    { visibility: existing.visibility },
  );
  if (permissionError) {
    return permissionError;
  }

  const identityError = agentIdentityUpdateError(
    existing.id === existing.defaultAgentId,
    updateBody,
  );
  if (identityError) {
    return { status: 400 as const, body: { error: identityError } };
  }
  return null;
}

function agentConfigurationUpdateRejection(
  existing: ExistingAgentForUpdate & { readonly publicAgentCount: number },
  member: AgentMember,
  updateBody: AgentUpdateBody,
) {
  const permissionError = requireAgentConfigurationPermission(existing, member);
  if (permissionError) {
    return permissionError;
  }
  const identityError = agentIdentityUpdateError(
    existing.id === existing.defaultAgentId,
    updateBody,
  );
  if (identityError) {
    return { status: 400 as const, body: { error: identityError } };
  }
  const ownerError = visibilityOwnerError(
    existing,
    member,
    updateBody.visibility,
  );
  if (ownerError) {
    return ownerError;
  }
  if (
    updateBody.visibility === "public" &&
    existing.visibility !== "public" &&
    existing.publicAgentCount >= PUBLIC_AGENT_LIMIT
  ) {
    return publicAgentLimitError();
  }
  return null;
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
    instructionsBundle:
      sql`${sql.param(values.instructionsBundle, agents.instructionsBundle)}`
        .mapWith(nullableDriverValueDecoder(agents.instructionsBundle))
        .as("instructions_bundle"),
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
    const countPlan = publicAgentCountReadPlan(auth.orgId);
    const [publicAgentCount] = await writeDb
      .select(countPlan.selection)
      .from(agents)
      .where(countPlan.condition);
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
    instructionsBundle: await set(
      publishContentBundle$,
      [{ path: "instructions.md", content: Buffer.alloc(0) }],
      signal,
    ),
    ...metadata,
    createdAt,
    updatedAt: createdAt,
  };
  let blocked = false;
  if (visibility === "public") {
    const countPlan = publicAgentCountReadPlan(auth.orgId);
    const publicAgentCount = writeDb
      .select({ value: countPlan.selection.value.as("value") })
      .from(agents)
      .where(countPlan.condition)
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
  const agentScope = {
    orgId: auth.orgId,
    userId: auth.userId,
    agentId: params.id,
  };
  const [row] = await get(db$)
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
    .where(visibleAgentIdentityCondition(agentScope))
    .limit(1);
  const agent = row ? agentResponse(row) : null;
  if (!agent) {
    return agentNotFound(params.id);
  }
  return { status: 200 as const, body: agent };
});

const getAgentUserConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(userBuiltinConnectorsContract.get));
  const agentScope = {
    orgId: auth.orgId,
    userId: auth.userId,
    agentId: params.id,
  };
  const [visibleAgent] = await get(db$)
    .select({ id: agents.id })
    .from(agents)
    .where(visibleAgentIdentityCondition(agentScope))
    .limit(1);
  const exists = Boolean(visibleAgent);
  if (!exists) {
    return agentNotFound(params.id);
  }

  const connectorScope = {
    orgId: auth.orgId,
    userId: auth.userId,
    agentId: params.id,
  };
  const rows = await get(db$)
    .select({ connectorSlug: userBuiltinConnectors.connectorSlug })
    .from(userBuiltinConnectors)
    .where(agentEnabledConnectorSlugsCondition(connectorScope))
    .orderBy(asc(userBuiltinConnectors.connectorSlug));
  const enabledConnectorSlugs = rows.map((row) => {
    return connectorSlugSchema.parse(row.connectorSlug);
  });
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
  const agentScope = {
    orgId: auth.orgId,
    userId: auth.userId,
    agentId: params.id,
  };
  const [visibleAgent] = await get(db$)
    .select({ id: agents.id })
    .from(agents)
    .where(visibleAgentIdentityCondition(agentScope))
    .limit(1);
  const exists = Boolean(visibleAgent);
  if (!exists) {
    return agentNotFound(params.id);
  }

  const connectorScope = {
    orgId: auth.orgId,
    userId: auth.userId,
    agentId: params.id,
  };
  const rows = await get(db$)
    .select({
      customConnectorId: userCustomConnectors.customConnectorId,
      permissionNames: userCustomConnectors.permissionNames,
    })
    .from(userCustomConnectors)
    .innerJoin(orgCustomConnectors, agentCustomConnectorGrantJoinCondition())
    .where(agentCustomConnectorGrantsCondition(connectorScope))
    .orderBy(asc(userCustomConnectors.customConnectorId));
  const grants = rows.map((row) => {
    return {
      customConnectorId: row.customConnectorId,
      permissionNames: [...row.permissionNames],
    };
  });
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
  const updateBody = body.data;
  const countPlan = publicAgentCountReadPlan(auth.orgId);
  const publicAgentCount = writeDb
    .select(countPlan.selection)
    .from(agents)
    .where(countPlan.condition);
  // Retain the existing Agent row lock. Immutable default identity and the
  // documented soft public limit use this statement's snapshot.
  const locked = writeDb.$with("configuration_agent").as(
    writeDb
      .select({
        id: agents.id,
        owner: agents.owner,
        visibility: agents.visibility,
        defaultAgentId: orgMetadata.defaultAgentId,
        publicAgentCount: (updateBody.visibility === "public"
          ? sql`CASE WHEN ${and(eq(agents.visibility, "private"), eq(agents.owner, member.userId))} THEN (${publicAgentCount}) ELSE 0::bigint END`
          : sql`0::bigint`
        )
          .mapWith(pgInt8ToSafeIntegerDecoder)
          .as("public_agent_count"),
      })
      .from(agents)
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
      .where(and(eq(agents.orgId, auth.orgId), eq(agents.id, params.id)))
      .for("update", { of: agents }),
  );
  const updated = writeDb.$with("updated_configuration_agent").as(
    writeDb
      .update(agents)
      // The dependent locking CTE completes before this SQL clock is read.
      .set(agentConfigurationUpdateValues(updateBody))
      .from(locked)
      .where(
        and(
          eq(agents.orgId, auth.orgId),
          eq(agents.id, locked.id),
          agentIdentityUpdateError(true, updateBody)
            ? nonDefaultAgentCondition(auth.orgId)
            : undefined,
          or(
            eq(locked.owner, member.userId),
            member.role === "admin"
              ? eq(locked.visibility, "public")
              : undefined,
          ),
          updateBody.visibility === undefined
            ? undefined
            : eq(locked.owner, member.userId),
          updateBody.visibility === "public"
            ? or(
                eq(locked.visibility, "public"),
                lt(locked.publicAgentCount, PUBLIC_AGENT_LIMIT),
              )
            : undefined,
        ),
      )
      .returning({
        ...agentUpdateResponseSelection(),
        defaultAgentId: locked.defaultAgentId,
      }),
  );
  const [row] = await writeDb
    .with(locked, updated)
    .select({
      existing: {
        id: locked.id,
        owner: locked.owner,
        visibility: locked.visibility,
        defaultAgentId: locked.defaultAgentId,
        publicAgentCount: locked.publicAgentCount,
      },
      agent: {
        agentId: updated.agentId,
        defaultAgentId: updated.defaultAgentId,
        owner: updated.owner,
        displayName: updated.displayName,
        description: updated.description,
        sound: updated.sound,
        avatarUrl: updated.avatarUrl,
        visibility: updated.visibility,
      },
    })
    .from(locked)
    .leftJoin(updated, eq(updated.agentId, locked.id));
  signal.throwIfAborted();
  if (!row) {
    return agentNotFound(params.id);
  }
  const updateError = agentConfigurationUpdateRejection(
    row.existing,
    member,
    updateBody,
  );
  if (updateError) {
    return updateError;
  }
  if (!row.agent) {
    throw new Error(`Canonical Agent missing after update: ${params.id}`);
  }

  if (body.data.visibility === "private") {
    await set(
      publishVncLifecycleInvalidation$,
      {
        kind: "agent",
        orgId: auth.orgId,
        agentId: params.id,
        ownerId: row.agent.owner,
      },
      signal,
    );
  }

  return {
    status: 200 as const,
    body: agentResponse(row.agent),
  };
});

const updateAgentMetadataBody$ = bodyResultOf(
  agentsByIdContract.updateMetadata,
);

function encodeAgentMetadataText(value: string | null) {
  return value === null ? null : Buffer.from(value, "utf8").toString("base64");
}

function encodedAgentMetadataBody(body: AgentUpdateBody) {
  return Buffer.from(
    JSON.stringify({
      ...(body.displayName !== undefined && {
        displayName: encodeAgentMetadataText(body.displayName),
      }),
      ...(body.description !== undefined && {
        description: encodeAgentMetadataText(body.description),
      }),
      ...(body.sound !== undefined && {
        sound: encodeAgentMetadataText(body.sound),
      }),
      ...(body.avatarUrl !== undefined && {
        avatarUrl: encodeAgentMetadataText(body.avatarUrl),
      }),
    }),
    "utf8",
  );
}

const agentMetadataUpdateRow = object({
  existing: object({
    id: string(),
    owner: string(),
    visibility: zodEnum(["public", "private"]),
    defaultAgentId: string().nullable(),
    publicAgentCount: int(),
  }),
  agent: object({
    agentId: string(),
    defaultAgentId: string().nullable(),
    owner: string(),
    displayName: string().nullable(),
    description: string().nullable(),
    sound: string().nullable(),
    avatarUrl: string().nullable(),
    visibility: zodEnum(["public", "private"]),
  }).nullable(),
});

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

    const updateBody = body.data;
    const writeDb = set(writeDb$);
    // The VOLATILE routine retains fresh reads after the existing Agent lock,
    // including default publication by a supported outgoing writer.
    const [result] = parseRawRows(
      agentMetadataUpdateRow,
      await writeDb.execute(sql`SELECT * FROM public.update_agent_metadata(
        ${auth.orgId}::text, ${params.id}::uuid, ${member.userId}::text,
        ${member.role === "admin"}::boolean,
        ${agentIdentityUpdateError(true, updateBody) !== null}::boolean,
        ${updateBody.visibility ?? null}::text, ${PUBLIC_AGENT_LIMIT}::integer,
        ${sql.param(encodedAgentMetadataBody(updateBody))}::bytea,
        ${nowDateSql(sql`NULL::timestamp`)}
      )`),
    );
    signal.throwIfAborted();
    if (!result) {
      return agentNotFound(params.id);
    }
    const rejection = agentMetadataUpdateRejection(
      result.existing,
      member,
      updateBody,
    );
    if (rejection) {
      return rejection;
    }
    const ownerError = visibilityOwnerError(
      result.existing,
      member,
      updateBody.visibility,
    );
    if (ownerError) {
      return ownerError;
    }
    if (
      updateBody.visibility === "public" &&
      result.existing.visibility !== "public" &&
      result.existing.publicAgentCount >= PUBLIC_AGENT_LIMIT
    ) {
      return publicAgentLimitError();
    }
    if (!result.agent) {
      throw new Error(`Canonical Agent missing after update: ${params.id}`);
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

    const agentScope = {
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    };
    const [visibleAgent] = await get(db$)
      .select({ id: agents.id })
      .from(agents)
      .where(visibleAgentIdentityCondition(agentScope))
      .limit(1);
    signal.throwIfAborted();
    const exists = Boolean(visibleAgent);
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
      const resolver = await set(readConnectorResolver$, uniqueConnectorSlugs);
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
