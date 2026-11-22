import { ensureLegacyDefaultAgentProfile$ } from "../services/legacy-default-agent-profile.service";
import { DEFAULT_AGENT_NAME } from "../services/default-agent-profile";
import { publishContentBundle$ } from "../services/content-bundle.service";
import { randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import { and, eq, lt, ne, or, sql } from "drizzle-orm";
import { enum as zodEnum, int, object, string } from "zod";
import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
  type AgentVisibility,
} from "@okouai/api-contracts/contracts/agents";
import { randomAvatarUrl } from "@okouai/core/agent-avatar";
import { agentIdentityUpdateError } from "@okouai/core/agent-protection";
import { legacyAgentApiProfiles } from "@okouai/db/schema/legacy-agent-api-profile";

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
import {
  agentResponse,
  defaultProfileId,
  visibleAgentIdentityCondition,
  agentList,
  publicAgentCountReadPlan,
} from "../services/agent-data.service";
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

function agentCreateSelection(
  values: typeof legacyAgentApiProfiles.$inferSelect,
) {
  // Defer text admission until the eligible INSERT row is projected. Binding
  // raw NUL text would reject before the public-count predicate can run.
  const displayName =
    values.displayName === null
      ? null
      : Buffer.from(
          pgTextDecoder.mapFromDriverValue(
            legacyAgentApiProfiles.displayName.mapToDriverValue(
              values.displayName,
            ),
          ),
          "utf8",
        );
  const description =
    values.description === null
      ? null
      : Buffer.from(
          pgTextDecoder.mapFromDriverValue(
            legacyAgentApiProfiles.description.mapToDriverValue(
              values.description,
            ),
          ),
          "utf8",
        );
  const sound =
    values.sound === null
      ? null
      : Buffer.from(
          pgTextDecoder.mapFromDriverValue(
            legacyAgentApiProfiles.sound.mapToDriverValue(values.sound),
          ),
          "utf8",
        );
  const avatarUrl =
    values.avatarUrl === null
      ? null
      : Buffer.from(
          pgTextDecoder.mapFromDriverValue(
            legacyAgentApiProfiles.avatarUrl.mapToDriverValue(values.avatarUrl),
          ),
          "utf8",
        );
  return {
    id: sql`${sql.param(values.id, legacyAgentApiProfiles.id)}`
      .mapWith(legacyAgentApiProfiles.id)
      .as("id"),
    orgId: sql`${sql.param(values.orgId, legacyAgentApiProfiles.orgId)}`
      .mapWith(legacyAgentApiProfiles.orgId)
      .as("org_id"),
    owner: sql`${sql.param(values.owner, legacyAgentApiProfiles.owner)}`
      .mapWith(legacyAgentApiProfiles.owner)
      .as("owner"),
    name: sql`${sql.param(values.name, legacyAgentApiProfiles.name)}`
      .mapWith(legacyAgentApiProfiles.name)
      .as("name"),
    visibility:
      sql`${sql.param(values.visibility, legacyAgentApiProfiles.visibility)}`
        .mapWith(legacyAgentApiProfiles.visibility)
        .as("visibility"),
    displayName: sql`convert_from(${sql.param(displayName)}, 'UTF8')`
      .mapWith(nullableDriverValueDecoder(legacyAgentApiProfiles.displayName))
      .as("display_name"),
    description: sql`convert_from(${sql.param(description)}, 'UTF8')`
      .mapWith(nullableDriverValueDecoder(legacyAgentApiProfiles.description))
      .as("description"),
    instructions:
      sql`${sql.param(values.instructions, legacyAgentApiProfiles.instructions)}`
        .mapWith(legacyAgentApiProfiles.instructions)
        .as("instructions"),
    instructionsBundle:
      sql`${sql.param(values.instructionsBundle, legacyAgentApiProfiles.instructionsBundle)}`
        .mapWith(
          nullableDriverValueDecoder(legacyAgentApiProfiles.instructionsBundle),
        )
        .as("instructions_bundle"),
    sound: sql`convert_from(${sql.param(sound)}, 'UTF8')`
      .mapWith(nullableDriverValueDecoder(legacyAgentApiProfiles.sound))
      .as("sound"),
    avatarUrl: sql`convert_from(${sql.param(avatarUrl)}, 'UTF8')`
      .mapWith(nullableDriverValueDecoder(legacyAgentApiProfiles.avatarUrl))
      .as("avatar_url"),
    updatedAt:
      sql`${sql.param(values.updatedAt, legacyAgentApiProfiles.updatedAt)}`
        .mapWith(legacyAgentApiProfiles.updatedAt)
        .as("updated_at"),
  };
}

const createAgentBody$ = bodyResultOf(agentsMainContract.create);

function createdAgentSelection() {
  return {
    agentId: legacyAgentApiProfiles.id,
    defaultAgentId: defaultProfileId.as("default_executor_id"),
    owner: legacyAgentApiProfiles.owner,
    displayName: legacyAgentApiProfiles.displayName,
    description: legacyAgentApiProfiles.description,
    sound: legacyAgentApiProfiles.sound,
    avatarUrl: legacyAgentApiProfiles.avatarUrl,
    visibility: legacyAgentApiProfiles.visibility,
  };
}

const committedClientAgent$ = computed(async (get) => {
  const body = await get(createAgentBody$);
  if (!body.ok || body.data.clientAgentId === undefined) {
    return undefined;
  }
  const auth = get(organizationAuthContext$);
  const [agent] = await get(db$)
    .select(createdAgentSelection())
    .from(legacyAgentApiProfiles)
    .where(
      and(
        eq(legacyAgentApiProfiles.id, body.data.clientAgentId),
        eq(legacyAgentApiProfiles.orgId, auth.orgId),
        eq(legacyAgentApiProfiles.owner, auth.userId),
      ),
    )
    .limit(1);
  return agent ? agentResponse(agent) : undefined;
});

const createAgentInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(createAgentBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  await set(ensureLegacyDefaultAgentProfile$, auth.orgId, signal);
  const committed = await get(committedClientAgent$);
  signal.throwIfAborted();
  if (committed) {
    return { status: 201 as const, body: committed };
  }

  const writeDb = set(writeDb$);
  const visibility = body.data.visibility ?? "private";

  // A client-identified replay may commit after the read above. Let its
  // conditional insert and final read resolve that race, even at the limit.
  if (visibility === "public" && body.data.clientAgentId === undefined) {
    const countPlan = publicAgentCountReadPlan(auth.orgId);
    const [publicAgentCount] = await writeDb
      .select(countPlan.selection)
      .from(legacyAgentApiProfiles)
      .where(countPlan.condition);
    signal.throwIfAborted();
    if ((publicAgentCount?.value ?? 0) >= PUBLIC_AGENT_LIMIT) {
      return publicAgentCreateLimitError();
    }
  }

  const agentId = body.data.clientAgentId ?? randomUUID();
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
    updatedAt: createdAt,
  };
  let blocked = false;
  // The final scoped read resolves concurrent replays of a client identity.
  if (visibility === "public") {
    const countPlan = publicAgentCountReadPlan(auth.orgId);
    const publicAgentCount = writeDb
      .select({ value: countPlan.selection.value.as("value") })
      .from(legacyAgentApiProfiles)
      .where(countPlan.condition)
      .as("public_agent_count");
    const inserted = await writeDb
      .insert(legacyAgentApiProfiles)
      .select(
        writeDb
          .select(agentCreateSelection(values))
          .from(publicAgentCount)
          .where(lt(publicAgentCount.value, PUBLIC_AGENT_LIMIT)),
      )
      .onConflictDoNothing()
      .returning({ id: legacyAgentApiProfiles.id });
    signal.throwIfAborted();
    blocked = inserted.length === 0;
  } else {
    await writeDb
      .insert(legacyAgentApiProfiles)
      .values(values)
      .onConflictDoNothing();
  }
  signal.throwIfAborted();

  const [agent] = await writeDb
    .select(createdAgentSelection())
    .from(legacyAgentApiProfiles)
    .where(
      and(
        eq(legacyAgentApiProfiles.orgId, auth.orgId),
        eq(legacyAgentApiProfiles.owner, auth.userId),
        eq(legacyAgentApiProfiles.id, agentId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (!agent) {
    if (body.data.clientAgentId !== undefined) {
      // A conflicting identity must not disclose another owner's Agent.
      return conflict(
        "Cannot create an agent with this identity or visibility",
      );
    }
    if (blocked) {
      return publicAgentCreateLimitError();
    }
    throw new Error(`Created Agent not found: ${agentId}`);
  }

  return { status: 201 as const, body: agentResponse(agent) };
});

const agentListResponse$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<{ readonly status: 200; readonly body: AgentResponse[] }> => {
    const auth = get(organizationAuthContext$);
    await set(ensureLegacyDefaultAgentProfile$, auth.orgId, signal);
    signal.throwIfAborted();
    const agents = await get(agentList(auth.orgId, auth.userId));
    signal.throwIfAborted();
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
      agentId: legacyAgentApiProfiles.id,
      defaultAgentId: defaultProfileId.as("default_executor_id"),
      owner: legacyAgentApiProfiles.owner,
      displayName: legacyAgentApiProfiles.displayName,
      description: legacyAgentApiProfiles.description,
      sound: legacyAgentApiProfiles.sound,
      avatarUrl: legacyAgentApiProfiles.avatarUrl,
      visibility: legacyAgentApiProfiles.visibility,
    })
    .from(legacyAgentApiProfiles)
    .where(visibleAgentIdentityCondition(agentScope))
    .limit(1);
  const agent = row ? agentResponse(row) : null;
  if (!agent) {
    return agentNotFound(params.id);
  }
  return { status: 200 as const, body: agent };
});

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
    .from(legacyAgentApiProfiles)
    .where(countPlan.condition);
  // Retain the existing Agent row lock. Immutable default identity and the
  // documented soft public limit use this statement's snapshot.
  const locked = writeDb.$with("configuration_agent").as(
    writeDb
      .select({
        id: legacyAgentApiProfiles.id,
        owner: legacyAgentApiProfiles.owner,
        visibility: legacyAgentApiProfiles.visibility,
        defaultAgentId: defaultProfileId.as("default_executor_id"),
        publicAgentCount: (updateBody.visibility === "public"
          ? sql`CASE WHEN ${and(eq(legacyAgentApiProfiles.visibility, "private"), eq(legacyAgentApiProfiles.owner, member.userId))} THEN (${publicAgentCount}) ELSE 0::bigint END`
          : sql`0::bigint`
        )
          .mapWith(pgInt8ToSafeIntegerDecoder)
          .as("public_agent_count"),
      })
      .from(legacyAgentApiProfiles)
      .where(
        and(
          eq(legacyAgentApiProfiles.orgId, auth.orgId),
          eq(legacyAgentApiProfiles.id, params.id),
        ),
      )
      .for("update", { of: legacyAgentApiProfiles }),
  );
  const updated = writeDb.$with("updated_configuration_agent").as(
    writeDb
      .update(legacyAgentApiProfiles)
      // The dependent locking CTE completes before this SQL clock is read.
      .set(agentConfigurationUpdateValues(updateBody))
      .from(locked)
      .where(
        and(
          eq(legacyAgentApiProfiles.orgId, auth.orgId),
          eq(legacyAgentApiProfiles.id, locked.id),
          agentIdentityUpdateError(true, updateBody)
            ? or(
                ne(legacyAgentApiProfiles.name, DEFAULT_AGENT_NAME),
                ne(legacyAgentApiProfiles.visibility, "public"),
              )
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
        agentId: legacyAgentApiProfiles.id,
        owner: legacyAgentApiProfiles.owner,
        displayName: legacyAgentApiProfiles.displayName,
        description: legacyAgentApiProfiles.description,
        sound: legacyAgentApiProfiles.sound,
        avatarUrl: legacyAgentApiProfiles.avatarUrl,
        visibility: legacyAgentApiProfiles.visibility,
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

  return {
    status: 200 as const,
    body: agentResponse({
      ...row.agent,
      defaultAgentId: row.existing.defaultAgentId,
    }),
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
      await writeDb.execute(sql`SELECT * FROM public.update_legacy_agent_api_metadata(
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

    return {
      status: 200 as const,
      body: agentResponse(result.agent),
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
];
