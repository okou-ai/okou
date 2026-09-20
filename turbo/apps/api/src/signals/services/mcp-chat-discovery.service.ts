import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  McpDiscoveryResult,
  McpListAgentsInput,
  McpListAgentsOutput,
  McpListModelsOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-discovery";
import {
  ACTIVE_RUN_MODELS,
  getCanonicalModelDisplayName,
  isBuiltInModelProviderType,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { agentDisplayName } from "@okouai/core/public-brand";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import type { Tx } from "../../lib/db-types";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import type { Db } from "../external/db";
import { awaitWithSignal, safeJsonParse, settle } from "../utils";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { resolveBuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import {
  loadMemberModelRouteContext,
  loadPersonalModelRouteSubscriptions,
  resolveEffectivePolicyRoute,
  type MemberModelRouteContext,
  type ResolvedModelFirstPolicyRoute,
} from "./effective-model-route.service";
import { shouldReplaceExistingDefaultForPlan } from "./model-policy.service";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { checkOrgPlanRunAdmission } from "./run-admission.service";

interface Principal {
  readonly orgId: string;
  readonly userId: string;
}

const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const READ_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
// PostgreSQL counts code points; 500 fit the 1,000 UTF-16-unit contract.
const DESCRIPTION_CHARACTER_LIMIT = 500;

class DiscoveryUnavailable extends Error {}

interface ReadBudget {
  readonly check: () => void;
  readonly beforeQuery: (tx: Tx) => Promise<void>;
}

async function discoveryRead<T>(
  db: Db,
  signal: AbortSignal,
  read: (tx: Tx, budget: ReadBudget) => Promise<T>,
): Promise<McpDiscoveryResult<T>> {
  signal.throwIfAborted();
  const deadline = performance.now() + READ_TIMEOUT_MS;
  const operationSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(READ_TIMEOUT_MS),
  ]);
  const check = () => {
    operationSignal.throwIfAborted();
    if (performance.now() >= deadline) {
      throw new DiscoveryUnavailable(
        "Discovery exceeded its 15-second read budget. Retry later.",
      );
    }
  };
  const budget: ReadBudget = {
    check,
    beforeQuery: async (tx) => {
      check();
      const milliseconds = Math.max(
        1,
        Math.min(3000, Math.floor(deadline - performance.now())),
      );
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${`${milliseconds.toString()}ms`}, true)`,
      );
      check();
    },
  };
  // A pool wait or HTTP disconnect bounds the response. The transaction remains
  // observed and releases its client after the bounded read phase settles.
  const result = await settle(
    awaitWithSignal(
      db.transaction(
        async (tx) => {
          await budget.beforeQuery(tx);
          const data = await read(tx, budget);
          check();
          if (
            Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_RESPONSE_BYTES
          ) {
            throw new DiscoveryUnavailable(
              "Discovery exceeded its response limit. Request fewer results.",
            );
          }
          return data;
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      ),
      operationSignal,
    ),
    signal,
  );
  return result.ok
    ? { kind: "ok", data: result.value }
    : {
        kind: "unavailable",
        message:
          result.error instanceof DiscoveryUnavailable
            ? result.error.message
            : "Discovery is temporarily unavailable. Retry later.",
      };
}

const agentCursorSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("list_agents"),
  userId: z.string(),
  orgId: z.string(),
  limit: z.number().int().min(1).max(50),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  agentId: z.uuid(),
});
type AgentCursor = z.infer<typeof agentCursorSchema>;

function signAgentCursor(payload: string): Buffer {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update("mcp:list_agents:v1\n")
    .update(payload)
    .digest();
}

function encodeAgentCursor(cursor: AgentCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString(
    "base64url",
  );
  const token = `${payload}.${signAgentCursor(payload).toString("base64url")}`;
  if (token.length > 4096) {
    throw new DiscoveryUnavailable("Discovery cursor exceeds its size limit.");
  }
  return token;
}

function decodeAgentCursor(
  token: string,
  principal: Principal,
  limit: number,
): AgentCursor | null {
  const [payload, signature, extra] = token.split(".");
  if (
    !payload ||
    !signature ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/u.test(payload) ||
    !/^[A-Za-z0-9_-]+$/u.test(signature)
  ) {
    return null;
  }
  const actual = Buffer.from(signature, "base64url");
  const expected = signAgentCursor(payload);
  if (
    actual.toString("base64url") !== signature ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return null;
  }
  const parsed = agentCursorSchema.safeParse(
    safeJsonParse(Buffer.from(payload, "base64url").toString("utf8")),
  );
  if (!parsed.success) {
    return null;
  }
  const cursor = parsed.data;
  return cursor.userId === principal.userId &&
    cursor.orgId === principal.orgId &&
    cursor.limit === limit &&
    cursor.issuedAt <= now() &&
    cursor.expiresAt > now() &&
    cursor.expiresAt - cursor.issuedAt === CURSOR_TTL_MS
    ? cursor
    : null;
}

export async function listMcpAgents(
  db: Db,
  principal: Principal,
  input: McpListAgentsInput,
  signal: AbortSignal,
): Promise<McpDiscoveryResult<McpListAgentsOutput>> {
  const cursor = input.cursor
    ? decodeAgentCursor(input.cursor, principal, input.limit)
    : null;
  if (input.cursor && !cursor) {
    return {
      kind: "invalid_cursor",
      message:
        "The Agent cursor is invalid, expired, or belongs to another user, organization or limit. Restart without cursor.",
    };
  }
  return await discoveryRead(
    db,
    signal,
    async (tx, budget): Promise<McpListAgentsOutput> => {
      const rows = await tx
        .select({
          agentId: agents.id,
          slug: agents.name,
          displayName: agents.displayName,
          defaultAgentId: orgMetadata.defaultAgentId,
          description:
            sql`left(${agents.description}, ${DESCRIPTION_CHARACTER_LIMIT})`.mapWith(
              nullableDriverValueDecoder(agents.description),
            ),
          descriptionTruncated:
            sql`coalesce(length(${agents.description}) > ${DESCRIPTION_CHARACTER_LIMIT}, false)`.mapWith(
              pgBooleanDecoder,
            ),
        })
        .from(agents)
        .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
        .where(
          and(
            eq(agents.orgId, principal.orgId),
            visibleJoinedAgentCondition(principal.userId),
            cursor ? gt(agents.id, cursor.agentId) : undefined,
          ),
        )
        .orderBy(asc(agents.id))
        .limit(input.limit + 1);
      budget.check();
      const page: McpListAgentsOutput["agents"] = [];
      // Reserve a complete cursor plus envelope so larger descriptions shorten a
      // page without truncating identities or preventing forward progress.
      let bytes = 4200;
      for (const row of rows.slice(0, input.limit)) {
        budget.check();
        const agent = {
          agentId: row.agentId,
          name: agentDisplayName(row) ?? row.slug,
          description: row.description,
          descriptionTruncated: row.descriptionTruncated,
          isDefault: row.agentId === row.defaultAgentId,
        };
        const size = Buffer.byteLength(JSON.stringify(agent), "utf8") + 1;
        if (bytes + size > MAX_RESPONSE_BYTES) {
          break;
        }
        page.push(agent);
        bytes += size;
      }
      const last = page.at(-1);
      if (rows.length > 0 && !last) {
        throw new DiscoveryUnavailable(
          "Agent metadata exceeds the response limit.",
        );
      }
      const issuedAt = cursor?.issuedAt ?? now();
      return {
        agents: page,
        nextCursor:
          rows.length > page.length && last
            ? encodeAgentCursor({
                version: 1,
                operation: "list_agents",
                orgId: principal.orgId,
                userId: principal.userId,
                limit: input.limit,
                issuedAt,
                expiresAt: issuedAt + CURSOR_TTL_MS,
                agentId: last.agentId,
              })
            : null,
      };
    },
  );
}

function personalConnectionState(
  route: ResolvedModelFirstPolicyRoute,
  subscriptions: MemberModelRouteContext["subscriptions"],
): ResolvedModelFirstPolicyRoute["personalConnectionState"] {
  if (
    route.modelProviderCredentialScope !== "member" ||
    route.personalConnectionState !== undefined
  ) {
    return route.personalConnectionState;
  }
  const subscription = subscriptions.find((candidate) => {
    return candidate.type === route.modelProviderType;
  });
  if (!subscription) {
    return "unavailable";
  }
  return subscription.needsReconnect
    ? "reconnect_required"
    : "capture_required";
}

function describeModelAvailability(params: {
  readonly model: SupportedRunModel;
  readonly defaultProviderType: string;
  readonly route: ResolvedModelFirstPolicyRoute | null;
  readonly capabilities: OrgPlanCapabilities | null;
  readonly subscriptions: MemberModelRouteContext["subscriptions"];
}): McpListModelsOutput["models"][number] {
  const { model, route } = params;
  const entry: McpListModelsOutput["models"][number] = {
    id: model,
    name: getCanonicalModelDisplayName(model),
    selectable: route !== null,
    availability: "available",
    reason: null,
  };
  const connectionState = route
    ? personalConnectionState(route, params.subscriptions)
    : undefined;
  if (
    checkOrgPlanRunAdmission({
      capabilities: params.capabilities,
      selectedModel: model,
      modelProviderType: route?.modelProviderType ?? params.defaultProviderType,
    })
  ) {
    entry.availability = "plan_restricted";
    entry.reason =
      "The current organization plan does not allow execution with this model. Review plan settings before sending.";
  } else if (!route) {
    entry.availability = "unavailable";
    entry.reason =
      "The configured model route is unavailable. Ask an organization admin to update model settings.";
  } else if (connectionState === "reconnect_required") {
    entry.availability = "reconnect_required";
    entry.reason =
      "Reconnect your personal model subscription before sending a message.";
  } else if (connectionState === "unavailable") {
    entry.availability = "connection_required";
    entry.reason =
      "Connect your personal model subscription before sending a message.";
  }
  return entry;
}

async function loadDiscoveryModelPolicies(
  tx: Tx,
  orgId: string,
  capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >,
) {
  const policies = await tx
    .select({
      model: orgModelPolicies.model,
      isDefault: orgModelPolicies.isDefault,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
      modelProviderSurfaceId: orgModelPolicies.modelProviderSurfaceId,
    })
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        inArray(orgModelPolicies.model, [...ACTIVE_RUN_MODELS]),
      ),
    )
    .limit(ACTIVE_RUN_MODELS.length);
  if (policies.length === 0) {
    throw new DiscoveryUnavailable(
      "No active model policies are configured for this organization. Open model settings before creating a conversation.",
    );
  }
  // Selection repairs defaults after plan changes. A read must not describe
  // the pre-repair routes as if they were the configuration selection uses.
  if (
    shouldReplaceExistingDefaultForPlan(
      policies.find((policy) => {
        return policy.isDefault;
      }),
      capabilities,
    )
  ) {
    throw new DiscoveryUnavailable(
      "Model policies need to be synchronized with the current organization plan. Open model settings, then retry discovery.",
    );
  }
  return policies;
}

export async function listMcpModels(
  db: Db,
  principal: Principal,
  signal: AbortSignal,
): Promise<McpDiscoveryResult<McpListModelsOutput>> {
  return await discoveryRead(
    db,
    signal,
    async (tx, budget): Promise<McpListModelsOutput> => {
      const capabilities = await loadOrgPlanCapabilities(tx, principal.orgId);
      // Match canonical pin selection: a suspended plan may retain configurable
      // pins. Availability separately reports the current execution restriction.
      const routeCapabilities =
        capabilities?.status === "active"
          ? capabilities
          : { restrictedBuiltInModels: false, supportByok: true };
      await budget.beforeQuery(tx);
      const policies = await loadDiscoveryModelPolicies(
        tx,
        principal.orgId,
        routeCapabilities,
      );
      await budget.beforeQuery(tx);
      const [preference] = await tx
        .select({ model: orgMembersMetadata.selectedModel })
        .from(orgMembersMetadata)
        .where(
          and(
            eq(orgMembersMetadata.orgId, principal.orgId),
            eq(orgMembersMetadata.userId, principal.userId),
          ),
        )
        .limit(1);
      await budget.beforeQuery(tx);
      const member = await loadMemberModelRouteContext(
        tx,
        principal.orgId,
        principal.userId,
      );
      // Explicit member policies still need connection metadata when personal
      // priority is disabled. Keep this separate from route selection.
      const needsPersonalMetadata =
        !member.priorityEnabled &&
        policies.some((policy) => {
          return policy.credentialScope === "member";
        });
      if (needsPersonalMetadata) {
        await budget.beforeQuery(tx);
      }
      const subscriptions = needsPersonalMetadata
        ? await loadPersonalModelRouteSubscriptions(
            tx,
            principal.orgId,
            principal.userId,
          )
        : member.subscriptions;
      budget.check();
      const models: McpListModelsOutput["models"] = [];
      const policiesByModel = new Map(
        policies.map((policy) => {
          return [policy.model, policy];
        }),
      );
      for (const model of ACTIVE_RUN_MODELS) {
        const policy = policiesByModel.get(model);
        if (!policy) {
          continue;
        }
        await budget.beforeQuery(tx);
        const route = await resolveEffectivePolicyRoute({
          db: tx,
          orgId: principal.orgId,
          policy,
          member,
          capabilities: routeCapabilities,
        });
        budget.check();
        const entry = describeModelAvailability({
          model,
          defaultProviderType: policy.defaultProviderType,
          route,
          capabilities,
          subscriptions,
        });
        if (
          entry.availability === "available" &&
          route &&
          isBuiltInModelProviderType(route.modelProviderType)
        ) {
          await budget.beforeQuery(tx);
          const runtime = await resolveBuiltInModelRuntimeRoute(tx, model);
          budget.check();
          if (!runtime) {
            entry.availability = "unavailable";
            entry.reason =
              "The built-in model is temporarily unavailable. Retry later or select another model.";
          }
        }
        models.push(entry);
      }
      const preferred = models.find((model) => {
        return model.id === preference?.model && model.selectable;
      });
      const workspaceDefault = models.find((model) => {
        return policiesByModel.get(model.id)?.isDefault && model.selectable;
      });
      return {
        models,
        defaultModel: preferred
          ? { model: preferred.id, source: "member_default" }
          : workspaceDefault
            ? { model: workspaceDefault.id, source: "org_default" }
            : { model: null, source: null },
        admission: "checked_on_send",
      };
    },
  );
}
