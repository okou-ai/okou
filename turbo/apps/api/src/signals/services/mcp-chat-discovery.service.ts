import type {
  McpDiscoveryResult,
  McpListAgentsInput,
  McpListAgentsOutput,
  McpListModelsOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-discovery";
import { agentDisplayName } from "@okouai/core/brand-presentation";
import { agents } from "@okouai/db/schema/agent";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { safeJsonParse } from "../utils";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { listAvailableRunModelsWithDefault$ } from "./run-models.service";
interface Principal {
  readonly orgId: string;
  readonly userId: string;
}
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 16 * 1024;
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
    throw new Error("Discovery cursor exceeds its size limit.");
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
    // This transaction is only the scope of SET LOCAL for one bounded SELECT.
    const rows = await set(writeDb$).transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
        return await tx
          .select({
            agentId: agents.id,
            slug: agents.name,
            displayName: agents.displayName,
            defaultAgentId: orgMetadata.defaultAgentId,
            description: sql`left(${agents.description}, 500)`.mapWith(
              nullableDriverValueDecoder(agents.description),
            ),
            descriptionTruncated:
              sql`coalesce(length(${agents.description}) > 500, false)`.mapWith(
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
      },
      { accessMode: "read only" },
    );
    signal.throwIfAborted();
    const page: McpListAgentsOutput["agents"] = [];
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
      throw new Error("Agent metadata exceeds the response limit.");
    }
    const issuedAt = cursor?.issuedAt ?? now();
    return {
      kind: "ok",
      data: {
        agents: page,
        nextCursor:
          rows.length > page.length && last
            ? encodeAgentCursor({
                version: 1,
                operation: "list_agents",
                userId: principal.userId,
                orgId: principal.orgId,
                limit: input.limit,
                issuedAt,
                expiresAt: issuedAt + CURSOR_TTL_MS,
                agentId: last.agentId,
              })
            : null,
      },
    };
  },
);

/** Use the ordinary Web run model projection, not a second admission engine. */
export const listMcpModels$ = command(
  async (
    { get, set },
    principal: Principal,
    signal: AbortSignal,
  ): Promise<McpDiscoveryResult<McpListModelsOutput>> => {
    const [listing, preferences] = await Promise.all([
      set(listAvailableRunModelsWithDefault$, principal, signal),
      get(db$)
        .select({ model: orgMembersMetadata.selectedModel })
        .from(orgMembersMetadata)
        .where(
          and(
            eq(orgMembersMetadata.orgId, principal.orgId),
            eq(orgMembersMetadata.userId, principal.userId),
          ),
        )
        .limit(1),
    ]);
    signal.throwIfAborted();
    const models: McpListModelsOutput["models"] = listing.response.models.map(
      (runModel) => {
        return {
          id: runModel.model,
          name: runModel.modelLabel,
          selectable: true,
          availability: runModel.memberEffective.availability,
          reason: null,
        };
      },
    );
    const preferred = models.find((model) => {
      return model.id === preferences[0]?.model;
    });
    const systemDefault = models.find((model) => {
      return model.id === listing.systemDefaultModel;
    });
    return {
      kind: "ok",
      data: {
        models,
        defaultModel: preferred
          ? { model: preferred.id, source: "member_default" }
          : systemDefault
            ? { model: systemDefault.id, source: "org_default" }
            : { model: null, source: null },
        admission: "checked_on_send",
      },
    };
  },
);
