import { command } from "ccstate";
import { and, eq, lt } from "drizzle-orm";
import {
  enum as zEnum,
  literal,
  object,
  string,
  unknown as zUnknown,
} from "zod";
import { larkOfficialEventsContract } from "@okouai/api-contracts/contracts/lark-official";
import { larkOfficialAppTickets } from "@okouai/db/schema/lark-official-app-ticket";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { larkOfficialApp } from "../../lib/lark-official-app";
import {
  decryptFeishuEventPayload,
  verifyFeishuEventSignature,
} from "../../lib/feishu-event-security";
import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { safeJsonParse, safeSync } from "../utils";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import {
  feishuInstallationConfigFromSecrets,
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
} from "../services/feishu-config";
import { handleFeishuEventsForConfig$ } from "../services/feishu-webhooks.service";

const encryptedSchema = object({ encrypt: string().min(1) });
const challengeSchema = object({
  type: literal("url_verification"),
  token: string(),
  challenge: string(),
});
const ticketSchema = object({
  ts: string().regex(/^\d+(?:\.\d+)?$/u),
  token: string(),
  event: object({
    type: literal("app_ticket"),
    app_id: string(),
    app_ticket: string().min(1),
  }),
});
const lifecycleSchema = object({
  ts: string().regex(/^\d+(?:\.\d+)?$/u),
  token: string(),
  event: object({
    type: zEnum(["app_status_change", "app_uninstalled", "app_open"]),
    app_id: string(),
    tenant_key: string().min(1),
    status: zEnum([
      "start_by_tenant",
      "stop_by_tenant",
      "stop_by_platform",
    ]).optional(),
  }),
});
const envelopeSchema = object({
  schema: literal("2.0"),
  header: object({
    app_id: string(),
    tenant_key: string().min(1),
    token: string(),
  }),
  event: zUnknown(),
});
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const handleOfficialV1Event$ = command(
  async (
    { set },
    config: NonNullable<ReturnType<typeof larkOfficialApp>>,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<Response | null> => {
    const db = set(writeDb$);
    const ticket = ticketSchema.safeParse(payload);
    if (ticket.success) {
      if (
        ticket.data.token !== config.verificationToken ||
        ticket.data.event.app_id !== config.appId
      ) {
        return json({ error: "Invalid Lark token" }, 401);
      }
      const eventTimestamp = Math.floor(Number(ticket.data.ts) * 1000);
      if (!Number.isSafeInteger(eventTimestamp)) {
        return json({ error: "Invalid Lark event timestamp" }, 400);
      }
      const encryptedTicket = await encryptPersistentSecretValue(
        ticket.data.event.app_ticket,
        {},
        signal,
      );
      signal.throwIfAborted();
      const values = {
        appId: config.appId,
        encryptedTicket,
        eventTimestamp,
        updatedAt: nowDate(),
      };
      await db
        .insert(larkOfficialAppTickets)
        .values(values)
        .onConflictDoUpdate({
          target: larkOfficialAppTickets.appId,
          set: values,
          setWhere: lt(larkOfficialAppTickets.eventTimestamp, eventTimestamp),
        });
      signal.throwIfAborted();
      return json({});
    }
    const lifecycle = lifecycleSchema.safeParse(payload);
    if (lifecycle.success) {
      const event = lifecycle.data.event;
      if (
        lifecycle.data.token !== config.verificationToken ||
        event.app_id !== config.appId
      ) {
        return json({ error: "Invalid Lark token" }, 401);
      }
      if (event.type === "app_status_change" && !event.status) {
        return json({ error: "Missing Lark application status" }, 400);
      }
      const eventTimestamp = Math.floor(Number(lifecycle.data.ts) * 1000);
      if (!Number.isSafeInteger(eventTimestamp)) {
        return json({ error: "Invalid Lark event timestamp" }, 400);
      }
      const active =
        event.type === "app_open" || event.status === "start_by_tenant";
      await db
        .update(feishuOrgInstallations)
        .set({
          setupCompletedAt: active ? nowDate() : null,
          encryptedTenantAccessToken: null,
          tenantAccessTokenExpiresAt: null,
          officialEventTimestamp: eventTimestamp,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(feishuOrgInstallations.installationType, "official"),
            eq(feishuOrgInstallations.appId, config.appId),
            eq(feishuOrgInstallations.feishuTenantKey, event.tenant_key),
            lt(feishuOrgInstallations.officialEventTimestamp, eventTimestamp),
          ),
        );
      signal.throwIfAborted();
      return json({});
    }
    return null;
  },
);

const dispatchOfficialEvent$ = command(
  async (
    { set },
    config: NonNullable<ReturnType<typeof larkOfficialApp>>,
    tenantKey: string,
    signal: AbortSignal,
  ): Promise<Response> => {
    const db = set(writeDb$);
    const [installation] = await db
      .select()
      .from(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.installationType, "official"),
          eq(feishuOrgInstallations.platform, "lark"),
          eq(feishuOrgInstallations.appId, config.appId),
          eq(feishuOrgInstallations.feishuTenantKey, tenantKey),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    // Events before the first account Connect have no workspace owner yet.
    if (!installation?.setupCompletedAt) {
      return json({});
    }
    const availability = feishuInstallationAvailabilityReadPlan(installation);
    const enabled =
      availability.kind === "resolved"
        ? availability.enabled
        : feishuInstallationEnabledFromRows(
            availability.scope,
            await db
              .select(availability.columns)
              .from(userFeatureSwitches)
              .where(availability.condition),
          );
    signal.throwIfAborted();
    if (!enabled) {
      return json({});
    }
    return set(
      handleFeishuEventsForConfig$,
      feishuInstallationConfigFromSecrets(installation, [
        config.appSecret,
        config.verificationToken,
        config.encryptKey,
      ]),
      signal,
    );
  },
);

const events$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const config = larkOfficialApp();
    if (!config) {
      return json(
        { error: "Official Lark application is not configured" },
        503,
      );
    }
    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();
    const outer = safeJsonParse(rawBody);
    const encrypted = encryptedSchema.safeParse(outer);
    const decoded = encrypted.success
      ? safeSync(() => {
          return decryptFeishuEventPayload(
            encrypted.data.encrypt,
            config.encryptKey,
          );
        })
      : { ok: outer };
    if ("error" in decoded) {
      return json({ error: "Invalid Lark payload" }, 400);
    }
    const challenge = challengeSchema.safeParse(decoded.ok);
    if (challenge.success) {
      return challenge.data.token === config.verificationToken
        ? json({ challenge: challenge.data.challenge })
        : json({ error: "Invalid Lark token" }, 401);
    }
    // Official events always require encrypted, signed delivery, including v1 tickets.
    if (
      !encrypted.success ||
      !verifyFeishuEventSignature({
        rawBody,
        encryptKey: config.encryptKey,
        timestamp: request.header("x-lark-request-timestamp"),
        nonce: request.header("x-lark-request-nonce"),
        signature: request.header("x-lark-signature"),
      })
    ) {
      return json({ error: "Invalid Lark signature" }, 401);
    }
    const v1 = await set(handleOfficialV1Event$, config, decoded.ok, signal);
    if (v1) {
      return v1;
    }
    const envelope = envelopeSchema.safeParse(decoded.ok);
    if (!envelope.success) {
      return json({ error: "Invalid Lark event" }, 400);
    }
    if (
      envelope.data.header.app_id !== config.appId ||
      envelope.data.header.token !== config.verificationToken
    ) {
      return json({ error: "Invalid Lark token" }, 401);
    }
    return set(
      dispatchOfficialEvent$,
      config,
      envelope.data.header.tenant_key,
      signal,
    );
  },
);

export const larkOfficialEventsRoutes: readonly RouteEntry[] = [
  { route: larkOfficialEventsContract.post, handler: events$ },
];
