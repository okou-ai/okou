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
import { agentDisplayName } from "@okouai/core/brand-presentation";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { awaitWithSignal, safeJsonParse, settle } from "../utils";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { resolveBuiltInModelRuntimeRoute$ } from "./built-in-model-runtime-route.service";
import {
  loadModelRouteSources$,
  resolveEffectivePolicyRoute,
  type MemberModelRouteContext,
  type ResolvedModelFirstPolicyRoute,
} from "./effective-model-route.service";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { shouldReplaceExistingDefaultForPlan } from "./model-policy.service";
import {
  orgPlanCapabilitiesFromRow,
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

function discoveryBudget(signal: AbortSignal) {
  signal.throwIfAborted();
  const deadline = performance.now() + READ_TIMEOUT_MS;
  const operationSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(READ_TIMEOUT_MS),
  ]);
  return {
    deadline,
    operationSignal,
    check: () => {
      operationSignal.throwIfAborted();
      if (performance.now() >= deadline) {
        throw new DiscoveryUnavailable(
          "Discovery exceeded its 15-second read budget. Retry later.",
        );
      }
    },
  };
}

function discoveryQueryTimeoutSql(deadline: number) {
  const milliseconds = Math.max(
    1,
    Math.min(3000, Math.floor(deadline - performance.now())),
  );
  return sql`SELECT set_config('statement_timeout', ${`${milliseconds.toString()}ms`}, true)`;
}

function discoveryResult<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): McpDiscoveryResult<T> {
  if (!result.ok) {
    return {
      kind: "unavailable",
      message:
        result.error instanceof DiscoveryUnavailable
          ? result.error.message
          : "Discovery is temporarily unavailable. Retry later.",
    };
  }
  if (
    Buffer.byteLength(JSON.stringify(result.value), "utf8") > MAX_RESPONSE_BYTES
  ) {
    return {
      kind: "unavailable",
      message: "Discovery exceeded its response limit. Request fewer results.",
    };
  }
  return { kind: "ok", data: result.value };
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

const prepareMcpAgentDiscovery$ = command(
  async (
    { set },
    principal: Principal,
    input: McpListAgentsInput,
    cursor: AgentCursor | null,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const budget = discoveryBudget(signal);
    const rows = await db.transaction(
      async (tx) => {
        budget.check();
        await tx.execute(discoveryQueryTimeoutSql(budget.deadline));
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
        return rows;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    signal.throwIfAborted();
    return discoveryAgentPage(rows, principal, input, cursor);
  },
);

interface DiscoveryAgentRow {
  readonly agentId: string;
  readonly slug: string;
  readonly displayName: string | null;
  readonly defaultAgentId: string | null;
  readonly description: string | null;
  readonly descriptionTruncated: boolean;
}

function discoveryAgentPage(
  rows: readonly DiscoveryAgentRow[],
  principal: Principal,
  input: McpListAgentsInput,
  cursor: AgentCursor | null,
): McpListAgentsOutput {
  const page: McpListAgentsOutput["agents"] = [];
  // Reserve a complete cursor plus envelope so larger descriptions shorten a
  // page without truncating identities or preventing forward progress.
  let bytes = 4200;
  for (const row of rows.slice(0, input.limit)) {
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
}

export const listMcpAgents$ = command(
  async (
    { set },
    principal: Principal,
    input: McpListAgentsInput,
    signal: AbortSignal,
  ): Promise<McpDiscoveryResult<McpListAgentsOutput>> => {
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
    const budget = discoveryBudget(signal);
    const result = await settle(
      awaitWithSignal(
        set(
          prepareMcpAgentDiscovery$,
          principal,
          input,
          cursor,
          budget.operationSignal,
        ),
        budget.operationSignal,
      ),
      signal,
    );
    return discoveryResult(result);
  },
);

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

const readMcpModelSnapshot$ = command(
  async ({ set }, principal: Principal, signal: AbortSignal) => {
    const db = set(writeDb$);
    const budget = discoveryBudget(signal);
    return await db.transaction(
      async (tx) => {
        budget.check();
        await tx.execute(discoveryQueryTimeoutSql(budget.deadline));
        const [entitlement] = await tx
          .select({
            planKey: orgPlanEntitlements.planKey,
            status: orgPlanEntitlements.status,
            baseConcurrencyLimit: orgPlanEntitlements.baseConcurrencyLimit,
            canBuyConcurrency: orgPlanEntitlements.canBuyConcurrency,
            canBuyCredits: orgPlanEntitlements.canBuyCredits,
            showUsagePack: orgPlanEntitlements.showUsagePack,
            autoRechargeAllowed: orgPlanEntitlements.autoRechargeAllowed,
            supportByok: orgPlanEntitlements.supportByok,
            restrictedBuiltInModels:
              orgPlanEntitlements.restrictedBuiltInModels,
            videoGenerationAllowed: orgPlanEntitlements.videoGenerationAllowed,
            workflowWebhookAutomationAllowed:
              orgPlanEntitlements.workflowWebhookTriggerAllowed,
            audioLifetimeLimit: orgPlanEntitlements.audioLifetimeLimit,
            audioDailyRateLimit: orgPlanEntitlements.audioDailyRateLimit,
            audioDailyDurationSeconds:
              orgPlanEntitlements.audioDailyDurationSeconds,
          })
          .from(orgPlanEntitlements)
          .where(eq(orgPlanEntitlements.orgId, principal.orgId))
          .limit(1);
        budget.check();
        const capabilities = entitlement
          ? orgPlanCapabilitiesFromRow(entitlement, principal.orgId)
          : null;
        if (!entitlement) {
          await tx.execute(discoveryQueryTimeoutSql(budget.deadline));
          const [org] = await tx
            .select({ id: orgMetadata.orgId })
            .from(orgMetadata)
            .where(eq(orgMetadata.orgId, principal.orgId))
            .limit(1);
          budget.check();
          if (org) {
            throw new Error(
              `Missing org plan entitlement for ${principal.orgId}`,
            );
          }
        }
        await tx.execute(discoveryQueryTimeoutSql(budget.deadline));
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
              eq(orgModelPolicies.orgId, principal.orgId),
              inArray(orgModelPolicies.model, [...ACTIVE_RUN_MODELS]),
            ),
          )
          .limit(ACTIVE_RUN_MODELS.length);
        budget.check();
        await tx.execute(discoveryQueryTimeoutSql(budget.deadline));
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
        budget.check();
        return { capabilities, policies, preference };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  },
);

const prepareMcpModelDiscovery$ = command(
  async (
    { set },
    principal: Principal,
    signal: AbortSignal,
  ): Promise<McpListModelsOutput> => {
    const budget = discoveryBudget(signal);
    const { capabilities, policies, preference } = await set(
      readMcpModelSnapshot$,
      principal,
      signal,
    );
    // Discovery never repairs a lazy policy. Sending a message owns admission.
    const routeCapabilities =
      capabilities?.status === "active"
        ? capabilities
        : { restrictedBuiltInModels: false, supportByok: true };
    if (policies.length === 0) {
      throw new DiscoveryUnavailable(
        "No active model policies are configured for this organization. Open model settings before creating a conversation.",
      );
    }
    if (
      shouldReplaceExistingDefaultForPlan(
        policies.find((policy) => {
          return policy.isDefault;
        }),
        routeCapabilities,
      )
    ) {
      throw new DiscoveryUnavailable(
        "Model policies need to be synchronized with the current organization plan. Open model settings, then retry discovery.",
      );
    }
    const sources = await set(
      loadModelRouteSources$,
      principal.orgId,
      principal.userId,
      policies.map((policy) => {
        return policy.model;
      }),
      signal,
    );
    const featureSwitchContext = await set(
      loadUserFeatureSwitchContext$,
      principal.orgId,
      principal.userId,
      signal,
    );
    const subscriptions = sources.member.subscriptions;
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
      const route = resolveEffectivePolicyRoute({
        sources,
        policy,
        capabilities: routeCapabilities,
      });
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
        const runtime = await set(
          resolveBuiltInModelRuntimeRoute$,
          model,
          featureSwitchContext,
          signal,
        );
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

export const listMcpModels$ = command(
  async (
    { set },
    principal: Principal,
    signal: AbortSignal,
  ): Promise<McpDiscoveryResult<McpListModelsOutput>> => {
    const budget = discoveryBudget(signal);
    const result = await settle(
      awaitWithSignal(
        set(prepareMcpModelDiscovery$, principal, budget.operationSignal),
        budget.operationSignal,
      ),
      signal,
    );
    return discoveryResult(result);
  },
);
