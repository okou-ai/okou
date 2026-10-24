import { createHash } from "node:crypto";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { explicitModelSettings } from "@okouai/core/auto-run-model";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  chatThreadEventSequences,
  chatThreadEvents,
} from "@okouai/db/schema/chat-thread-event";
import {
  discordChatIngress,
  type DiscordChatIngressStatus,
} from "@okouai/db/schema/discord-chat-ingress";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { discordGatewayReceipts } from "@okouai/db/schema/discord-gateway-receipt";
import { command } from "ccstate";
import {
  and,
  count,
  eq,
  ne,
  isNull,
  isNotNull,
  notExists,
  exists,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import {
  parseRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { writeDb$ } from "../external/db";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import type { DefaultModelFirstPin } from "./model-selection.service";
import {
  canonicalChatEventAppendCtes,
  type PreparedChatEventRow,
} from "./chat-event-append.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";

/** The existing claim transition gates every dependent failure publication. */
export function discordIngressFailureSql(args: {
  readonly ingressId: string;
  readonly claimToken: string;
  readonly values: Pick<
    typeof discordChatIngress.$inferSelect,
    "status" | "retryAt" | "lastErrorClass" | "lastError" | "updatedAt"
  >;
  readonly publication: {
    readonly event: PreparedChatEventRow;
    readonly route: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
    };
  } | null;
}): SQL {
  const { values, publication } = args;
  const claim = sql`UPDATE ${discordChatIngress}
    SET status = ${values.status}, claim_token = NULL, claimed_at = NULL,
      retry_at = ${sql.param(values.retryAt, discordChatIngress.retryAt)},
      last_error_class = ${values.lastErrorClass}, last_error = ${values.lastError},
      updated_at = ${sql.param(values.updatedAt, discordChatIngress.updatedAt)}
    WHERE ${and(
      eq(discordChatIngress.id, args.ingressId),
      eq(discordChatIngress.status, "processing"),
      eq(discordChatIngress.claimToken, args.claimToken),
    )}
    RETURNING id`;
  if (!publication) {
    return sql`WITH failure_claim AS (${claim})
      SELECT ${exists(sql`(SELECT 1 FROM failure_claim)`)} AS claimed,
        false AS inserted`;
  }
  const { route, event } = publication;
  const touchCondition = and(
    exists(sql`(SELECT 1 FROM inserted)`),
    eq(chatThreads.id, route.chatThreadId),
    isNotNull(chatThreads.agentId),
    eq(chatThreads.userId, route.userId),
    chatThreadOrganizationCondition(route.orgId),
  );
  return sql`WITH failure_claim AS (${claim}),
    ${canonicalChatEventAppendCtes(
      [event],
      "id",
      exists(sql`(SELECT 1 FROM failure_claim)`),
    )}, failure_touched AS (
      UPDATE ${chatThreads}
      SET last_message_at = GREATEST(${chatThreads.lastMessageAt}, ${event.createdAt.toISOString()}::timestamp)
      WHERE ${touchCondition}
      RETURNING id, user_id, agent_id, last_message_at
    ), failure_sort_reserved AS (
      -- A published error requires the authorized touch identity. Its missing
      -- scalar fails the existing user_id NOT NULL constraint, rolling back
      -- the claim and event just as the previous sort precondition did.
      INSERT INTO ${chatThreadEventSequences} (user_id, org_id, last_seq_id)
      SELECT (SELECT user_id FROM failure_touched), ${route.orgId}, 1
      WHERE ${exists(sql`(SELECT 1 FROM inserted)`)}
      ON CONFLICT (user_id, org_id) DO UPDATE
      SET last_seq_id = ${chatThreadEventSequences.lastSeqId} + 1
      RETURNING user_id, org_id, last_seq_id
    ), failure_sort_inserted AS (
      INSERT INTO ${chatThreadEvents}
        (id, user_id, org_id, seq_id, chat_thread_id, kind, agent_id,
         cloud_browser_enabled, created_at)
      SELECT ${event.id}::uuid, reserved.user_id, reserved.org_id,
        reserved.last_seq_id, touched.id, 'sort_touched', touched.agent_id,
        false, date_trunc('milliseconds', touched.last_message_at)
      FROM failure_sort_reserved AS reserved CROSS JOIN failure_touched AS touched
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    )
    SELECT ${exists(sql`(SELECT 1 FROM failure_claim)`)} AS claimed,
      ${exists(sql`(SELECT 1 FROM inserted)`)} AS inserted`;
}

interface DiscordChatThreadRouteKey {
  readonly connectionId: string;
  readonly channelId: string;
  readonly sessionKey: string;
  readonly userId: string;
}

export interface DiscordChatThreadRouteBinding extends DiscordChatThreadRouteKey {
  readonly id: string;
  readonly chatThreadId: string;
  readonly destinationChannelId: string | null;
}

export function discordChatThreadRouteWhere(key: DiscordChatThreadRouteKey) {
  return and(
    eq(discordChatThreadRoutes.connectionId, key.connectionId),
    key.sessionKey === INTEGRATION_DM_SESSION_KEY
      ? undefined
      : eq(discordChatThreadRoutes.channelId, key.channelId),
    eq(discordChatThreadRoutes.sessionKey, key.sessionKey),
    eq(discordChatThreadRoutes.userId, key.userId),
  );
}

export const findDiscordChatThreadRoute$ = command(
  async (
    { set },
    key: DiscordChatThreadRouteKey,
    signal: AbortSignal,
  ): Promise<DiscordChatThreadRouteBinding | undefined> => {
    const db = set(writeDb$);
    const [route] = await db
      .select({
        id: discordChatThreadRoutes.id,
        connectionId: discordChatThreadRoutes.connectionId,
        channelId: discordChatThreadRoutes.channelId,
        sessionKey: discordChatThreadRoutes.sessionKey,
        userId: discordChatThreadRoutes.userId,
        chatThreadId: discordChatThreadRoutes.chatThreadId,
        destinationChannelId: discordChatThreadRoutes.destinationChannelId,
      })
      .from(discordChatThreadRoutes)
      .where(discordChatThreadRouteWhere(key))
      .limit(1);
    signal.throwIfAborted();
    if (!route) {
      return undefined;
    }
    const channelId = key.channelId;
    if (
      route.sessionKey !== INTEGRATION_DM_SESSION_KEY ||
      (route.channelId === channelId &&
        (route.destinationChannelId === null ||
          route.destinationChannelId === channelId))
    ) {
      return route;
    }
    const [updated] = await db
      .update(discordChatThreadRoutes)
      .set({ channelId, destinationChannelId: channelId })
      .where(
        and(
          eq(discordChatThreadRoutes.id, route.id),
          discordChatThreadRouteWhere(route),
        ),
      )
      .returning({
        channelId: discordChatThreadRoutes.channelId,
        destinationChannelId: discordChatThreadRoutes.destinationChannelId,
      });
    signal.throwIfAborted();
    if (!updated) {
      throw new Error("Failed to update Discord DM route destination");
    }
    return { ...route, ...updated };
  },
);

interface CanonicalDiscordChatThreadRouteArgs extends DiscordChatThreadRouteKey {
  readonly orgId: string;
  readonly agentId: string;
  readonly currentTime: Date;
  readonly ingressId: string;
  readonly claimToken: string;
  readonly initialModel: DefaultModelFirstPin;
}

type RouteDefaults = {
  readonly modelSettings: ModelSettings;
  readonly cloudBrowserEnabled: boolean;
};

// PostgreSQL UUID text is canonical 8-4-4-4-12 hex; do not impose an RFC
// version/variant restriction stronger than the actual native uuid column.
const nativeUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const canonicalRouteRowSchema = z.strictObject({
  id: nativeUuidSchema,
  connectionId: nativeUuidSchema,
  channelId: z.string(),
  sessionKey: z.string(),
  userId: z.string(),
  chatThreadId: nativeUuidSchema,
  destinationChannelId: z.string().nullable(),
  createdAt: pgTimestampWithoutTimezoneToDateSchema,
});
const canonicalRouteResultSchema = z.discriminatedUnion("outcome", [
  canonicalRouteRowSchema.extend({ outcome: z.literal("route") }),
  z.strictObject({
    outcome: z.enum([
      "claim_missing",
      "assigned_missing",
      "dm_update_missing",
      "conflict",
      "winner_missing",
    ]),
    id: z.null(),
    connectionId: z.null(),
    channelId: z.null(),
    sessionKey: z.null(),
    userId: z.null(),
    chatThreadId: z.null(),
    destinationChannelId: z.null(),
    createdAt: z.null(),
  }),
]);

// Enforce the single-outcome boundary after runtime row decoding.
function canonicalRouteResult(
  rows: readonly z.output<typeof canonicalRouteResultSchema>[],
) {
  if (rows.length !== 1 || !rows[0]) {
    throw new Error("Expected one canonical Discord route outcome");
  }
  return rows[0];
}

// Creation values use the same column encoders and defaults as the existing owner.
function canonicalRouteCreationInput(
  args: CanonicalDiscordChatThreadRouteArgs,
  defaults: RouteDefaults,
): SQL {
  const t = chatThreads;
  const e = chatThreadEvents;
  return sql`, creation_input AS MATERIALIZED (
    SELECT ${sql.param(args.agentId, t.agentId)}::uuid AS agent_id,
      ${sql.param(args.initialModel.selectedModel, t.selectedModel)}::text AS selected_model,
      ${sql.param(args.initialModel.serviceTier === "priority" ? "fast" : null, t.codexServiceTier)}::text AS codex_service_tier,
      ${sql.param(explicitModelSettings(defaults.modelSettings), t.modelSettings)}::jsonb AS model_settings,
      ${sql.param(defaults.cloudBrowserEnabled, t.cloudBrowserEnabled)}::boolean AS cloud_browser_enabled,
      ${sql.param(args.currentTime, t.createdAt)}::timestamp AS current_time,
      ${sql.param(args.orgId, e.orgId)}::text AS org_id
  )`;
}

// Only actual route RETURNING can publish a thread, sequence and created event.
function canonicalRouteCreationWrites(): SQL {
  const r = discordChatThreadRoutes;
  const t = chatThreads;
  const q = chatThreadEventSequences;
  const e = chatThreadEvents;
  return sql`, candidate AS MATERIALIZED (
    SELECT gen_random_uuid() AS thread_id
    FROM claim
    WHERE ${isNull(sql`claim.route_id`)} AND ${notExists(sql`(SELECT 1 FROM selected_route)`)}
  ), inserted_route AS (
    INSERT INTO ${r} (connection_id, channel_id, session_key, user_id, chat_thread_id, created_at)
    SELECT input.connection_id, input.channel_id, input.session_key, input.user_id,
      candidate.thread_id, creation_input.current_time
    FROM candidate CROSS JOIN input CROSS JOIN creation_input
    ON CONFLICT (connection_id, channel_id, session_key, user_id) DO NOTHING
    RETURNING id, connection_id, channel_id, session_key, user_id, chat_thread_id,
      destination_channel_id, created_at
  ), inserted_thread AS (
    INSERT INTO ${t} (
      id, user_id, agent_id, selected_model, codex_service_tier, model_settings,
      cloud_browser_enabled, title, last_read_at, last_message_at, created_at, updated_at
    )
    SELECT inserted_route.chat_thread_id, inserted_route.user_id, creation_input.agent_id,
      creation_input.selected_model, creation_input.codex_service_tier, creation_input.model_settings,
      creation_input.cloud_browser_enabled, NULL, creation_input.current_time,
      creation_input.current_time, creation_input.current_time, creation_input.current_time
    FROM inserted_route CROSS JOIN creation_input
    RETURNING id, user_id, agent_id, title, selected_model, codex_service_tier,
      model_settings, cloud_browser_enabled, created_at
  ), reserved AS (
    INSERT INTO ${q} (user_id, org_id, last_seq_id)
    SELECT inserted_thread.user_id, creation_input.org_id, 1
    FROM inserted_thread CROSS JOIN creation_input
    ON CONFLICT (user_id, org_id) DO UPDATE
    SET last_seq_id = ${q.lastSeqId} + 1
    RETURNING last_seq_id
  ), created_event AS (
    INSERT INTO ${e} (
      user_id, org_id, seq_id, chat_thread_id, kind, agent_id, reassigned_agent_id,
      title, pin_order, muted, selected_model, model_settings, model_settings_patch,
      service_tier, computer_use_host_id, cloud_browser_enabled, created_at
    )
    SELECT inserted_thread.user_id, creation_input.org_id, reserved.last_seq_id,
      inserted_thread.id, 'created'::chat_thread_event_kind, inserted_thread.agent_id,
      NULL, inserted_thread.title, NULL, NULL, inserted_thread.selected_model,
      inserted_thread.model_settings, NULL,
      CASE WHEN ${eq(sql`inserted_thread.codex_service_tier`, sql`'fast'`)} THEN 'priority' ELSE NULL END,
      NULL, inserted_thread.cloud_browser_enabled, inserted_thread.created_at
    FROM inserted_thread CROSS JOIN reserved CROSS JOIN creation_input
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )`;
}

// Pure SQL preparation from ordinary values, never a handle-taking helper.
// "conflict" denotes ONLY the already-existing single fresh-winner continuation.
function canonicalRouteStatement(
  args: CanonicalDiscordChatThreadRouteArgs,
  defaults: RouteDefaults,
  phase: "initial" | "conflict",
): SQL {
  const r = discordChatThreadRoutes;
  const i = discordChatIngress;
  const initial = phase === "initial";
  // The two SQLs share this exact 8-parameter prefix, in the written order.
  const input = sql`input AS MATERIALIZED (
    SELECT ${sql.param(args.connectionId, r.connectionId)}::uuid AS connection_id,
      ${sql.param(args.channelId, r.channelId)}::text AS channel_id,
      ${sql.param(args.sessionKey, r.sessionKey)}::text AS session_key,
      ${sql.param(args.userId, r.userId)}::text AS user_id,
      ${sql.param(args.ingressId, i.id)}::uuid AS ingress_id,
      ${sql.param(args.claimToken, i.claimToken)}::uuid AS claim_token,
      ${sql.param(INTEGRATION_DM_SESSION_KEY, r.sessionKey)}::text AS dm_key,
      ${sql.param("processing", i.status)}::text AS processing_status
  )`;
  const creationInput = initial
    ? canonicalRouteCreationInput(args, defaults)
    : sql.empty();
  const creation = initial ? canonicalRouteCreationWrites() : sql.empty();
  const createdEffective = initial
    ? sql`
    SELECT inserted_route.*
    FROM inserted_route JOIN inserted_thread ON ${eq(sql`inserted_thread.id`, sql`inserted_route.chat_thread_id`)}
    CROSS JOIN (SELECT ${count()} AS n FROM created_event) AS event_exhausted
    UNION ALL`
    : sql.empty();
  const createdExhaustion = initial
    ? sql`,
      (SELECT ${count()} FROM candidate) AS candidate_n,
      (SELECT ${count()} FROM inserted_route) AS inserted_route_n,
      (SELECT ${count()} FROM inserted_thread) AS inserted_thread_n,
      (SELECT ${count()} FROM reserved) AS reserved_n,
      (SELECT ${count()} FROM created_event) AS created_event_n`
    : sql.empty();
  const noEffectiveOutcome = initial ? sql`'conflict'` : sql`'winner_missing'`;
  return sql`WITH ${input}${creationInput},
    claim AS MATERIALIZED (
      SELECT ${i.id} AS id, ${i.routeId} AS route_id
      FROM ${i} CROSS JOIN input
      WHERE ${eq(i.id, sql`input.ingress_id`)} AND ${eq(i.connectionId, sql`input.connection_id`)}
        AND ${eq(i.claimToken, sql`input.claim_token`)} AND ${eq(i.status, sql`input.processing_status`)}
      LIMIT 1 FOR UPDATE OF discord_chat_ingress
    ), selected_route AS MATERIALIZED (
      SELECT ${r.id} AS id, ${r.connectionId} AS connection_id, ${r.channelId} AS channel_id,
        ${r.sessionKey} AS session_key, ${r.userId} AS user_id,
        ${r.chatThreadId} AS chat_thread_id, ${r.destinationChannelId} AS destination_channel_id,
        ${r.createdAt} AS created_at,
        (${eq(r.sessionKey, sql`input.dm_key`)} AND
          (${ne(r.channelId, sql`input.channel_id`)} OR
            (${isNotNull(r.destinationChannelId)} AND ${ne(r.destinationChannelId, sql`input.channel_id`)}))) AS needs_dm
      FROM ${r} CROSS JOIN claim CROSS JOIN input
      WHERE ${eq(r.connectionId, sql`input.connection_id`)} AND ${eq(r.userId, sql`input.user_id`)}
        AND ((${isNotNull(sql`claim.route_id`)} AND ${eq(r.id, sql`claim.route_id`)})
          OR (${isNull(sql`claim.route_id`)} AND ${eq(r.sessionKey, sql`input.session_key`)}
            AND (${eq(sql`input.session_key`, sql`input.dm_key`)} OR ${eq(r.channelId, sql`input.channel_id`)})))
      LIMIT 1
    )${creation}, updated_route AS (
      UPDATE ${r}
      SET channel_id = input.channel_id, destination_channel_id = input.channel_id
      FROM selected_route CROSS JOIN claim CROSS JOIN input
      WHERE selected_route.needs_dm AND ${eq(r.id, sql`selected_route.id`)}
        AND ${eq(r.connectionId, sql`selected_route.connection_id`)}
        AND ${eq(r.sessionKey, sql`selected_route.session_key`)} AND ${eq(r.userId, sql`selected_route.user_id`)}
      RETURNING ${r.id} AS id, ${r.connectionId} AS connection_id, ${r.channelId} AS channel_id,
        ${r.sessionKey} AS session_key, ${r.userId} AS user_id,
        ${r.chatThreadId} AS chat_thread_id, ${r.destinationChannelId} AS destination_channel_id,
        ${r.createdAt} AS created_at
    ), effective_route AS MATERIALIZED (
      ${createdEffective}
      SELECT * FROM updated_route
      UNION ALL
      SELECT id, connection_id, channel_id, session_key, user_id, chat_thread_id,
        destination_channel_id, created_at
      FROM selected_route WHERE NOT needs_dm
    ), attached_ingress AS (
      UPDATE ${i} SET route_id = effective_route.id
      FROM claim CROSS JOIN effective_route
      WHERE ${isNull(sql`claim.route_id`)} AND ${eq(i.id, sql`claim.id`)}
      RETURNING ${i.id}
    ), exhausted AS MATERIALIZED (
      SELECT (SELECT ${count()} FROM claim) AS claim_n,
        (SELECT ${count()} FROM selected_route) AS selected_n,
        (SELECT ${count()} FROM updated_route) AS updated_n,
        (SELECT ${count()} FROM effective_route) AS effective_n,
        (SELECT ${count()} FROM attached_ingress) AS attached_n
        ${createdExhaustion}
    )
    SELECT CASE
      WHEN exhausted.claim_n = 0 THEN 'claim_missing'
      WHEN ${isNotNull(sql`claim.route_id`)} AND exhausted.selected_n = 0 THEN 'assigned_missing'
      WHEN selected_route.needs_dm AND exhausted.updated_n = 0 THEN 'dm_update_missing'
      WHEN exhausted.effective_n = 1 THEN 'route'
      ELSE ${noEffectiveOutcome}
    END AS outcome,
      effective_route.id AS "id", effective_route.connection_id AS "connectionId",
      effective_route.channel_id AS "channelId", effective_route.session_key AS "sessionKey",
      effective_route.user_id AS "userId", effective_route.chat_thread_id AS "chatThreadId",
      effective_route.destination_channel_id AS "destinationChannelId", effective_route.created_at AS "createdAt"
    FROM exhausted
    LEFT JOIN claim ON TRUE
    LEFT JOIN selected_route ON TRUE
    LEFT JOIN effective_route ON TRUE`;
}

export const ensureCanonicalDiscordChatThreadRoute$ = command(
  async (
    { set },
    args: CanonicalDiscordChatThreadRouteArgs,
    signal: AbortSignal,
  ): Promise<DiscordChatThreadRouteBinding | undefined> => {
    const db = set(writeDb$);
    const defaults = await set(loadNewChatThreadDefaults$, args, signal);
    signal.throwIfAborted();
    let result = canonicalRouteResult(
      parseRawRows(
        canonicalRouteResultSchema,
        await db.execute(canonicalRouteStatement(args, defaults, "initial")),
      ),
    );
    signal.throwIfAborted();
    if (result.outcome === "conflict") {
      // The completed preceding statement performed ZERO own durable mutations.
      // No loop/retry/fallback: the owner's one existing fresh-winner branch.
      signal.throwIfAborted();
      result = canonicalRouteResult(
        parseRawRows(
          canonicalRouteResultSchema,
          await db.execute(canonicalRouteStatement(args, defaults, "conflict")),
        ),
      );
      signal.throwIfAborted();
    }
    switch (result.outcome) {
      case "claim_missing": {
        return undefined;
      }
      case "assigned_missing": {
        throw new Error("Discord ingress has no assigned route");
      }
      case "dm_update_missing": {
        throw new Error("Failed to update Discord DM route destination");
      }
      case "winner_missing":
      case "conflict": {
        // "conflict" cannot be returned by phase 2; it maps to the same old error,
        // without a new read or mutation if an invalid future plan introduces it.
        throw new Error(
          "Failed to resolve Discord chat thread route after conflict",
        );
      }
      case "route": {
        const route = {
          id: result.id,
          connectionId: result.connectionId,
          channelId: result.channelId,
          sessionKey: result.sessionKey,
          userId: result.userId,
          chatThreadId: result.chatThreadId,
          destinationChannelId: result.destinationChannelId,
          createdAt: result.createdAt,
        };
        return route;
      }
    }
  },
);

interface DiscordChatIngressAdmission {
  readonly id: string;
  readonly inserted: boolean;
  readonly status: DiscordChatIngressStatus;
}

export function discordMessageReceiptDigest(
  applicationId: string,
  messageId: string,
) {
  return createHash("sha256")
    .update(JSON.stringify([applicationId, "MESSAGE_CREATE", messageId]))
    .digest("hex");
}

interface DiscordIngressAdmissionArgs {
  readonly applicationId: string;
  readonly connectionId: string;
  readonly messageId: string;
  readonly eventId: string;
  readonly payload: string;
  readonly currentTime: Date;
}

const discordIngressInsertResultSchema = z.discriminatedUnion("inserted", [
  z.object({
    inserted: z.literal(true),
    id: z.string().uuid(),
    connectionId: z.string().uuid(),
    status: z.enum([
      "pending",
      "processing",
      "retryable",
      "processed",
      "terminal",
    ]),
  }),
  z.object({
    inserted: z.literal(false),
    id: z.null(),
    connectionId: z.null(),
    status: z.null(),
  }),
]);

function discordIngressAdmissionSql(args: DiscordIngressAdmissionArgs) {
  const digest = discordMessageReceiptDigest(
    args.applicationId,
    args.messageId,
  );
  const currentTime = args.currentTime.toISOString();
  // Drizzle insert-select requires every table column. This partial-column
  // publication preserves database defaults and gates ingress on the receipt.
  return sql`WITH receipt AS (
    INSERT INTO ${discordGatewayReceipts} (event_digest, created_at)
    VALUES (${digest}, ${currentTime}::timestamp)
    ON CONFLICT DO NOTHING
    RETURNING event_digest
  ), inserted AS (
    INSERT INTO ${discordChatIngress}
      (connection_id, message_id, event_id, payload, status, created_at, updated_at)
    SELECT ${args.connectionId}::uuid, ${args.messageId}, ${args.eventId},
      ${args.payload}, 'pending', ${currentTime}::timestamp, ${currentTime}::timestamp
    FROM receipt
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id, connection_id, status
  )
  SELECT inserted.id IS NOT NULL AS inserted,
    inserted.id AS id, inserted.connection_id AS "connectionId", inserted.status AS status
  FROM receipt LEFT JOIN inserted ON TRUE`;
}

export const admitCanonicalDiscordChatEvent$ = command(
  async (
    { set },
    args: DiscordIngressAdmissionArgs,
    signal: AbortSignal,
  ): Promise<DiscordChatIngressAdmission | undefined> => {
    const db = set(writeDb$);
    // The existing fresh-winner read and ownership check must roll back the
    // permanent receipt if a message is missing or bound to another connection.
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0150; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // Identity-only receipts survive connection/chat deletion. A duplicate
      // receipt cannot publish another ingress, including after reconnection.
      const [result] = parseRawRows(
        discordIngressInsertResultSchema,
        await tx.execute(discordIngressAdmissionSql(args)),
      );
      signal.throwIfAborted();
      if (!result) {
        return undefined;
      }
      if (result.inserted) {
        return result;
      }

      const [existing] = await tx
        .select({
          id: discordChatIngress.id,
          connectionId: discordChatIngress.connectionId,
          status: discordChatIngress.status,
        })
        .from(discordChatIngress)
        .where(eq(discordChatIngress.messageId, args.messageId))
        .limit(1);
      signal.throwIfAborted();
      if (!existing) {
        throw new Error("Failed to resolve canonical Discord ingress event");
      }
      if (existing.connectionId !== args.connectionId) {
        throw new Error(
          "Discord message ID is already bound to another connection",
        );
      }
      return { ...existing, inserted: false };
    });
  },
);
