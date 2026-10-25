import crypto from "node:crypto";
import { debugMorningBriefEmailTemplateSchema } from "../../lib/debug-morning-brief-email";

import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import { mailNotifications } from "@okouai/db/schema/mail-notification";
import {
  notifyMailSubjectSchema,
  notifyMailTextSchema,
} from "@okouai/api-contracts/contracts/notifications";
import {
  renderAgentMorningBriefEmail,
  renderAgentNotificationEmail,
} from "../../lib/agent-notification-email-renderer";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";
import { userCache } from "@okouai/db/schema/user-cache";
import { users } from "@okouai/db/schema/user";
import { command, type Write } from "ccstate";
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { Resend } from "resend";
import { delay } from "signal-timers";
import { Webhook } from "svix";
import * as z from "zod";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";

import { apiBackendUrl } from "../../lib/api-backend-url";
import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";
import {
  pgTextDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { webUrl } from "../../lib/web-url";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { db$, writeDb$ } from "../external/db";
import { renderCreditLowBalanceEmail } from "./credit-low-balance-email-renderer";
import { renderDataExportReadyEmail } from "./data-export-ready-email-renderer";

interface EmailOutboxDrainContext {
  readonly currentTimeMs: number;
}

const log = logger("EmailCommon");
const USER_CACHE_TTL_MS = 900_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const MAX_OUTBOX_BATCH_SIZE = 10;
const OUTBOX_DRAIN_DELAY_MS = 500;
// Namespaced so the provider key cannot collide with another Okou producer's
// idempotency key. Resend accepts 1-256 characters.
const PROVIDER_IDEMPOTENCY_KEY_PREFIX = "okou-email-outbox/v1/";
// A prepared item is owned until this lease expires. A worker that dies between
// the provider request and its completion write leaves the row in `sending`;
// after the lease, another drain replays the same committed request.
const OUTBOX_SEND_LEASE_MS = 60_000;

// Inter-send pacing for Resend rate limits. Overridable so environments
// without a real provider (tests drain a shared outbox backlog) can disable
// the pacing instead of widening timeouts around it.
function outboxDrainDelayMs(): number {
  const configured = optionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS");
  if (configured === undefined) {
    return OUTBOX_DRAIN_DELAY_MS;
  }
  const parsed = Number.parseInt(configured, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : OUTBOX_DRAIN_DELAY_MS;
}
const OUTBOX_TTL_MS = 15 * 60 * 1000;
// Preparation admits a row against its deadline; the provider boundary rechecks
// the same deadline. The two outcomes are distinct because only the second one
// can follow a committed request and key.
const OUTBOX_EXPIRED_BEFORE_DELIVERY_ERROR =
  "Email outbox item expired before delivery";
const OUTBOX_EXPIRED_BEFORE_PROVIDER_ERROR =
  "Email outbox item expired before contacting the provider";
export const CREDIT_LOW_BALANCE_EMAIL_SUBJECT =
  "Your credit balance is running low";

const emailTemplateSchema = z.discriminatedUnion("template", [
  debugMorningBriefEmailTemplateSchema,
  z
    .object({
      template: z.literal("agent-morning-brief"),
      props: z
        .object({
          subject: notifyMailSubjectSchema,
          text: notifyMailTextSchema,
          runUrl: z.url().max(1024),
          manageUrl: z.url().max(1024),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      template: z.literal("agent-notification"),
      props: z
        .object({
          subject: notifyMailSubjectSchema,
          text: notifyMailTextSchema,
          runUrl: z.url().max(1024),
        })
        .strict(),
    })
    .strict(),
  z.object({
    template: z.literal("data-export-ready"),
    props: z.object({
      downloadUrl: z.string(),
      expiresAt: z.string(),
      artifactCount: z.number(),
      unsubscribeUrl: z.string().optional(),
    }),
  }),
  z.object({
    template: z.literal("credit-low-balance"),
    props: z.object({
      orgName: z.string(),
      remainingCredits: z.number(),
      thresholdCredits: z.number(),
      billingUrl: z.string(),
      unsubscribeUrl: z.string().optional(),
    }),
  }),
]);

export type EmailTemplate = z.output<typeof emailTemplateSchema>;

const emailAddressesSchema = z.union([z.string(), z.array(z.string())]);
const outboxRowSchema = z.object({
  id: z.string(),
  to_addresses: emailAddressesSchema,
  cc_addresses: emailAddressesSchema.nullable(),
  subject: z.string(),
  reply_to: z.string().nullable(),
  headers: z.record(z.string(), z.string()).nullable(),
  template: emailTemplateSchema,
  attempts: z.int(),
  created_at: z.date(),
  provider_idempotency_key: z.string().nullable(),
  provider_request: z.unknown(),
});
type OutboxRow = z.output<typeof outboxRowSchema>;

// The exact provider request replayed by every attempt of one outbox row. It is
// stored verbatim, so an added optional field must stay optional here for rows
// committed by an older deployment.
const providerRequestSchema = z
  .object({
    from: z.string(),
    to: emailAddressesSchema,
    cc: emailAddressesSchema.optional(),
    subject: z.string(),
    replyTo: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    html: z.string(),
    text: z.string().optional(),
  })
  .strict();
type ProviderRequest = z.output<typeof providerRequestSchema>;

function outboxRowSelection() {
  return {
    id: emailOutbox.id,
    to_addresses: emailOutbox.toAddresses,
    cc_addresses: emailOutbox.ccAddresses,
    subject: emailOutbox.subject,
    reply_to: emailOutbox.replyTo,
    headers: emailOutbox.headers,
    template: emailOutbox.template,
    attempts: emailOutbox.attempts,
    created_at: emailOutbox.createdAt,
    provider_idempotency_key: emailOutbox.providerIdempotencyKey,
    provider_request: emailOutbox.providerRequest,
  };
}

function getResendClient(): Resend {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  return new Resend(apiKey);
}

function apiUrl(): string {
  return apiBackendUrl() ?? webUrl();
}

function appUrl(): string {
  return env("APP_URL");
}

function notificationEmailUnsubscribeUrl(
  headers: Readonly<Record<string, string>> | undefined,
): string {
  const listUnsubscribe = headers?.["List-Unsubscribe"];
  if (
    !listUnsubscribe ||
    !listUnsubscribe.startsWith("<") ||
    !listUnsubscribe.endsWith(">")
  ) {
    throw new Error("Notification email is missing its List-Unsubscribe URL");
  }
  const oneClickUrl = new URL(listUnsubscribe.slice(1, -1));
  if (
    oneClickUrl.protocol !== "https:" ||
    !oneClickUrl.pathname.endsWith("/api/email/unsubscribe")
  ) {
    throw new Error("Notification email has an invalid List-Unsubscribe URL");
  }
  const token = oneClickUrl.searchParams.get("token");
  if (!token) {
    throw new Error("Notification email is missing its unsubscribe token");
  }

  const unsubscribeUrl = new URL(`${appUrl()}/email/unsubscribe`);
  unsubscribeUrl.searchParams.set("token", token);
  return unsubscribeUrl.toString();
}

function getFromDomain(): string {
  const domain = env("RESEND_FROM_DOMAIN");
  if (!domain) {
    throw new Error("RESEND_FROM_DOMAIN is not configured");
  }
  return domain;
}

export function buildFromAddress(): string {
  return `${BRAND_PRESENTATION.assistantName} <okou@${getFromDomain()}>`;
}

export function buildTeamFromAddress(): string {
  return `${BRAND_PRESENTATION.brandName} Team <support@${getFromDomain()}>`;
}

function generateUnsubscribeToken(userId: string): string {
  const hmac = crypto
    .createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`unsubscribe:${userId}`)
    .digest("hex")
    .slice(0, 32);
  return `${userId}.${hmac}`;
}

export function buildUnsubscribeUrl(userId: string): string {
  return `${appUrl()}/email/unsubscribe?token=${generateUnsubscribeToken(
    userId,
  )}`;
}

export function buildOneClickUnsubscribeUrl(userId: string): string {
  return `${apiUrl()}/api/email/unsubscribe?token=${generateUnsubscribeToken(
    userId,
  )}`;
}

export function buildUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

interface RenderedEmailTemplate {
  readonly html: string;
  readonly text?: string;
}

function renderTemplate(
  template: EmailTemplate,
  headers: Readonly<Record<string, string>> | undefined,
): RenderedEmailTemplate {
  switch (template.template) {
    case "debug-morning-brief":
    case "agent-morning-brief": {
      return renderAgentMorningBriefEmail(
        template.props,
        notificationEmailUnsubscribeUrl(headers),
      );
    }
    case "agent-notification": {
      return renderAgentNotificationEmail(
        template.props,
        notificationEmailUnsubscribeUrl(headers),
      );
    }
    case "data-export-ready": {
      return renderDataExportReadyEmail(template.props);
    }
    case "credit-low-balance": {
      return renderCreditLowBalanceEmail({
        ...template.props,
        title: CREDIT_LOW_BALANCE_EMAIL_SUBJECT,
        websiteUrl: webUrl(),
      });
    }
  }
}

function fromAddressForTemplate(template: EmailTemplate): string {
  // Resolve the sender at delivery so legacy or malformed outbox snapshots
  // cannot bypass the user-facing email brand policy.
  switch (template.template) {
    case "credit-low-balance": {
      return buildTeamFromAddress();
    }
    case "data-export-ready":
    case "debug-morning-brief":
    case "agent-morning-brief":
    case "agent-notification": {
      return buildFromAddress();
    }
  }
}

function providerIdempotencyKey(outboxId: string): string {
  return `${PROVIDER_IDEMPOTENCY_KEY_PREFIX}${outboxId}`;
}

function buildProviderRequest(row: OutboxRow): ProviderRequest {
  const headers = row.headers ?? undefined;
  const rendered = renderTemplate(row.template, headers);
  return {
    from: fromAddressForTemplate(row.template),
    to: row.to_addresses,
    ...(row.cc_addresses === null ? {} : { cc: row.cc_addresses }),
    subject: row.subject,
    ...(row.reply_to === null ? {} : { replyTo: row.reply_to }),
    ...(headers === undefined ? {} : { headers }),
    html: rendered.html,
    ...(rendered.text === undefined ? {} : { text: rendered.text }),
  };
}

type ProviderSendOutcome =
  // The provider owns exactly one email for this key, either from this request
  // or replayed from the accepted original.
  | { readonly kind: "sent"; readonly resendId: string }
  // Transient, and safe to replay under the same key.
  | { readonly kind: "retry"; readonly error: string }
  // The key is already bound to a different payload. Re-keying would send a
  // second email for the same row, so stop here and keep the failure visible.
  | { readonly kind: "conflict"; readonly error: string };

type OutboxAttemptOutcome =
  | ProviderSendOutcome
  // The row reached its own deadline while this attempt was preparing, so the
  // attempt resolved locally and never reached the provider.
  | { readonly kind: "expired" };

async function sendProviderRequest(
  request: ProviderRequest,
  idempotencyKey: string,
): Promise<ProviderSendOutcome> {
  const resend = getResendClient();
  const { data, error } = await resend.emails.send(
    {
      from: request.from,
      to: typeof request.to === "string" ? request.to : [...request.to],
      subject: request.subject,
      html: request.html,
      ...(request.text === undefined ? {} : { text: request.text }),
      ...(request.cc === undefined
        ? {}
        : {
            cc: typeof request.cc === "string" ? request.cc : [...request.cc],
          }),
      ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
      ...(request.headers === undefined ? {} : { headers: request.headers }),
    },
    { idempotencyKey },
  );

  if (error || !data) {
    const message = error?.message ?? "unknown";
    if (
      error?.name === "invalid_idempotent_request" ||
      error?.name === "invalid_idempotency_key"
    ) {
      return { kind: "conflict", error: `${error.name}: ${message}` };
    }
    return { kind: "retry", error: message };
  }
  return { kind: "sent", resendId: data.id };
}

function suppressionAddressCondition(addresses: readonly string[]) {
  return inArray(
    sql`lower(${emailSuppressions.emailAddress})`,
    addresses.map((address) => {
      return address.toLowerCase();
    }),
  );
}

function matchedSuppressedAddress(
  addresses: readonly string[],
  matchedLower: string | undefined,
): string | null {
  if (!matchedLower) {
    return null;
  }
  return (
    addresses.find((address) => {
      return address.toLowerCase() === matchedLower;
    }) ?? matchedLower
  );
}

interface PreparedOutboxItem {
  readonly id: string;
  readonly attempts: number;
  readonly idempotencyKey: string;
  readonly request: ProviderRequest;
  // The row's own deadline, carried from its persisted creation time so the
  // send boundary rechecks the original lifetime instead of this claim's.
  readonly expiresAtMs: number;
  readonly preparedAtMs: number;
}

type PrepareOutcome =
  | { readonly kind: "empty" }
  // Resolved without contacting the provider: expired, out of attempts, or
  // suppressed.
  | { readonly kind: "resolved" }
  | { readonly kind: "prepared"; readonly item: PreparedOutboxItem };

function outboxAdmissionError(
  expiresAtMs: number,
  currentTimeMs: number,
  attempts: number,
  hasCommittedRequest: boolean,
) {
  if (expiresAtMs <= currentTimeMs) {
    return {
      message: OUTBOX_EXPIRED_BEFORE_DELIVERY_ERROR,
      reason: "expired" as const,
    };
  }
  if (attempts > MAX_ATTEMPTS) {
    return {
      message: hasCommittedRequest
        ? "Email outbox item exhausted its delivery attempts with an unresolved provider send"
        : "Email outbox item exhausted its delivery attempts",
      reason: "delivery-failed" as const,
    };
  }
  return null;
}

function notificationIsUnsubscribed(
  template: EmailTemplate,
  notification: { readonly unsubscribed: boolean | null } | undefined,
): boolean {
  if (
    template.template !== "agent-notification" &&
    template.template !== "agent-morning-brief" &&
    template.template !== "debug-morning-brief"
  ) {
    return false;
  }
  if (!notification || notification.unsubscribed === null) {
    throw new Error(
      "Agent notification outbox is missing its receipt or user preference row",
    );
  }
  return notification.unsubscribed;
}

interface OutboxRejection {
  readonly message: string;
  readonly status: "failed" | "skipped";
  readonly reason:
    "expired" | "delivery-failed" | "unsubscribed" | "suppressed";
}

interface OutboxPreparation {
  readonly values: Pick<
    typeof emailOutbox.$inferInsert,
    | "status"
    | "lastError"
    | "attempts"
    | "providerRequest"
    | "providerIdempotencyKey"
    | "nextRetryAt"
  >;
  readonly outcome: Exclude<PrepareOutcome, { readonly kind: "empty" }>;
}

function outboxPreparation(
  row: OutboxRow,
  preparedAtMs: number,
  rejection: OutboxRejection | null,
): OutboxPreparation {
  if (rejection) {
    return {
      values: { status: "failed", lastError: rejection.message },
      outcome: { kind: "resolved" },
    };
  }
  // A retry replays the committed payload and key, including after an
  // unresolved provider acceptance. Rendering never changes that identity.
  const request =
    row.provider_request !== null && row.provider_request !== undefined
      ? providerRequestSchema.parse(row.provider_request)
      : buildProviderRequest(row);
  const idempotencyKey =
    row.provider_idempotency_key ?? providerIdempotencyKey(row.id);
  const attempts = row.attempts + 1;
  return {
    values: {
      status: "sending",
      attempts,
      providerRequest: request,
      providerIdempotencyKey: idempotencyKey,
      nextRetryAt: new Date(preparedAtMs + OUTBOX_SEND_LEASE_MS),
    },
    outcome: {
      kind: "prepared",
      item: {
        id: row.id,
        attempts,
        idempotencyKey,
        request,
        expiresAtMs: row.created_at.getTime() + OUTBOX_TTL_MS,
        preparedAtMs,
      },
    },
  };
}

/** Prepare before the conditional claim; only the committed winner may send.
 * A concurrent mutation rejects this attempt without publishing a receipt or
 * contacting the provider. The existing next drain can select another item.
 */
async function prepareNextOutboxItem(
  { set }: Parameters<Write<Promise<PrepareOutcome>, [number]>>[0],
  currentTimeMs: number,
): Promise<PrepareOutcome> {
  const db = set(writeDb$);
  const [selectedRow] = await db
    .select({
      ...outboxRowSelection(),
      rowVersion: sql`${emailOutbox}.xmin::text`.mapWith(pgTextDecoder),
    })
    .from(emailOutbox)
    .where(
      and(
        // A sending row remains owned until its existing recovery lease ends.
        inArray(emailOutbox.status, ["pending", "sending"]),
        or(
          isNull(emailOutbox.nextRetryAt),
          // Keep Date encoding bound to the timestamp column.
          lte(emailOutbox.nextRetryAt, new Date(currentTimeMs)),
        ),
      ),
    )
    .orderBy(asc(emailOutbox.createdAt))
    .limit(1);
  if (!selectedRow) {
    return { kind: "empty" };
  }
  const row = outboxRowSchema.parse(selectedRow);
  const preparedAtMs = now();
  const admissionError = outboxAdmissionError(
    row.created_at.getTime() + OUTBOX_TTL_MS,
    preparedAtMs,
    row.attempts + 1,
    row.provider_request !== null && row.provider_request !== undefined,
  );
  let rejection: OutboxRejection | null = admissionError
    ? { ...admissionError, status: "failed" }
    : null;
  if (!rejection) {
    const [notification] = await db
      .select({ unsubscribed: users.emailUnsubscribed })
      .from(mailNotifications)
      .leftJoin(users, eq(users.id, mailNotifications.userId))
      .where(eq(mailNotifications.outboxId, row.id))
      .limit(1);
    if (notificationIsUnsubscribed(row.template, notification)) {
      rejection = {
        message: "Recipient unsubscribed",
        status: "skipped",
        reason: "unsubscribed",
      };
    }
  }
  if (!rejection) {
    const toAddresses =
      typeof row.to_addresses === "string"
        ? [row.to_addresses]
        : row.to_addresses;
    const suppressedRows =
      toAddresses.length === 0
        ? []
        : await db
            .select({ emailAddress: emailSuppressions.emailAddress })
            .from(emailSuppressions)
            .where(suppressionAddressCondition(toAddresses))
            .limit(1);
    const suppressedAddress = matchedSuppressedAddress(
      toAddresses,
      suppressedRows[0]?.emailAddress.toLowerCase(),
    );
    if (suppressedAddress) {
      rejection = {
        message: `Recipient address suppressed (${suppressedAddress})`,
        status: "skipped",
        reason: "suppressed",
      };
    }
  }
  const preparation = outboxPreparation(row, preparedAtMs, rejection);
  const claimed = db.$with("claimed_email_outbox").as(
    db
      .update(emailOutbox)
      .set(preparation.values)
      .where(
        and(
          eq(emailOutbox.id, row.id),
          eq(sql`${emailOutbox}.xmin::text`, selectedRow.rowVersion),
        ),
      )
      .returning({ id: emailOutbox.id }),
  );
  const receipt = rejection
    ? db.$with("rejected_email_notification").as(
        db
          .update(mailNotifications)
          .set({ status: rejection.status, reason: rejection.reason })
          .where(
            inArray(
              mailNotifications.outboxId,
              db.select({ id: claimed.id }).from(claimed),
            ),
          )
          .returning({ id: mailNotifications.id }),
      )
    : null;
  const [committed] = await db
    .with(claimed, ...(receipt ? [receipt] : []))
    .select({ id: claimed.id })
    .from(claimed);
  return committed ? preparation.outcome : { kind: "empty" };
}

const prepareNextOutboxItem$ = command(prepareNextOutboxItem);

const completeOutboxItem$ = command(
  async (
    { set },
    item: PreparedOutboxItem,
    outcome: OutboxAttemptOutcome,
  ): Promise<void> => {
    const db = set(writeDb$);
    const completion =
      outcome.kind === "sent"
        ? {
            status: "sent" as const,
            resendId: outcome.resendId,
            lastError: null,
            nextRetryAt: null,
            // A delivered row is retained past the outbox TTL, so drop the
            // rendered message once nothing can replay it. The key stays for
            // reconciliation against the provider.
            providerRequest: null,
          }
        : outcome.kind === "expired"
          ? {
              // This attempt sent nothing, so the committed request and key stay
              // on the row: an earlier attempt may still be unresolved at the
              // provider, and that ambiguity is the only evidence of it.
              status: "failed" as const,
              lastError: OUTBOX_EXPIRED_BEFORE_PROVIDER_ERROR,
              nextRetryAt: null,
            }
          : outcome.kind === "retry" && item.attempts < MAX_ATTEMPTS
            ? {
                status: "pending" as const,
                lastError: outcome.error,
                nextRetryAt: new Date(
                  item.preparedAtMs +
                    BACKOFF_BASE_MS * 4 ** (item.attempts - 1),
                ),
              }
            : {
                status: "failed" as const,
                lastError: outcome.error,
                nextRetryAt: null,
              };

    const completedOutbox = db.$with("completed_email_outbox").as(
      db
        .update(emailOutbox)
        .set(completion)
        .where(
          and(
            eq(emailOutbox.id, item.id),
            // A lost completion is recovered by a later attempt. Never overwrite
            // whatever that attempt has already decided.
            eq(emailOutbox.status, "sending"),
            eq(emailOutbox.attempts, item.attempts),
          ),
        )
        .returning({ id: emailOutbox.id }),
    );
    let completedRows: { id: string }[];
    if (completion.status === "pending") {
      completedRows = await db
        .with(completedOutbox)
        .select({ id: completedOutbox.id })
        .from(completedOutbox);
    } else {
      const completedReceipts = db.$with("completed_mail_notifications").as(
        db
          .update(mailNotifications)
          .set({
            status: completion.status,
            reason:
              completion.status === "sent"
                ? null
                : outcome.kind === "expired"
                  ? "expired"
                  : "delivery-failed",
          })
          .where(
            and(
              inArray(
                mailNotifications.outboxId,
                db.select({ id: completedOutbox.id }).from(completedOutbox),
              ),
              // Finish the outbox winner before taking receipt row locks,
              // matching expiry cleanup order.
              gte(db.select({ count: count() }).from(completedOutbox), 0),
            ),
          )
          .returning({ id: mailNotifications.id }),
      );
      completedRows = await db
        .with(completedOutbox, completedReceipts)
        .select({ id: completedOutbox.id })
        .from(completedOutbox)
        // Exhaust receipt RETURNING before returning the actual outbox
        // winner. A missing receipt remains a successful completion.
        .where(gte(db.select({ count: count() }).from(completedReceipts), 0));
    }
    const [completed] = completedRows;

    if (!completed) {
      log.warn("Email outbox completion lost its claim", {
        itemId: item.id,
        attempts: item.attempts,
        outcome: outcome.kind,
      });
    }
  },
);

const drainNextOutboxItem$ = command(
  async ({ set }, currentTimeMs: number): Promise<boolean> => {
    const prepared = await set(prepareNextOutboxItem$, currentTimeMs);
    if (prepared.kind === "empty") {
      return false;
    }
    if (prepared.kind === "resolved") {
      return true;
    }

    // Preparation admitted this row, then spent real time on the suppression
    // lookup, the claim update and its commit. This is the last point at which no
    // email exists yet, so the original deadline is rechecked against a fresh
    // clock here rather than trusting the sample preparation started with.
    if (now() >= prepared.item.expiresAtMs) {
      await set(completeOutboxItem$, prepared.item, { kind: "expired" });
      return true;
    }

    const outcome = await sendProviderRequest(
      prepared.item.request,
      prepared.item.idempotencyKey,
    );
    await set(completeOutboxItem$, prepared.item, outcome);
    return true;
  },
);

export const drainEmailOutboxBatch$ = command(
  async (
    { set },
    context: EmailOutboxDrainContext,
    signal: AbortSignal,
  ): Promise<number> => {
    let processed = 0;

    for (let index = 0; index < MAX_OUTBOX_BATCH_SIZE; index++) {
      signal.throwIfAborted();
      const hadItem = await set(drainNextOutboxItem$, context.currentTimeMs);
      signal.throwIfAborted();
      if (!hadItem) {
        break;
      }

      processed++;
      if (index < MAX_OUTBOX_BATCH_SIZE - 1) {
        const delayMs = outboxDrainDelayMs();
        if (delayMs > 0) {
          await delay(delayMs, { signal });
        }
      }
    }

    if (processed > 0) {
      log.debug("Drained emails from outbox", { processed });
    }
    return processed;
  },
);

export const cleanupExpiredEmailOutbox$ = command(
  async (
    { set },
    context: EmailOutboxDrainContext,
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const cutoff = new Date(context.currentTimeMs - OUTBOX_TTL_MS);
    const expiredOutbox = db.$with("expired_email_outbox").as(
      db
        .delete(emailOutbox)
        .where(
          and(
            lt(emailOutbox.createdAt, cutoff),
            or(
              eq(emailOutbox.status, "pending"),
              eq(emailOutbox.status, "failed"),
            ),
          ),
        )
        .returning({ id: emailOutbox.id }),
    );
    const expiredReceipts = db.$with("expired_mail_notifications").as(
      db
        .update(mailNotifications)
        .set({ status: "failed", reason: "expired" })
        .where(
          and(
            eq(mailNotifications.status, "queued"),
            inArray(
              mailNotifications.outboxId,
              db.select({ id: expiredOutbox.id }).from(expiredOutbox),
            ),
            // Exhaust the outbox DELETE before locking receipts, matching
            // completion order rather than relying on CTE order.
            gte(db.select({ count: count() }).from(expiredOutbox), 0),
          ),
        )
        .returning({ id: mailNotifications.id }),
    );
    const [deleted] = await db
      .with(expiredOutbox, expiredReceipts)
      .select({
        cleaned: count().mapWith(
          zodDriverValueDecoder(
            pgInt8ToSafeIntegerSchema.pipe(z.number().nonnegative()),
          ),
        ),
      })
      .from(expiredOutbox);
    // SQL has committed; cancellation stops the caller's remaining work.
    signal.throwIfAborted();
    if (!deleted) {
      throw new Error("Expired email outbox count missing");
    }
    if (deleted.cleaned > 0) {
      log.debug("Cleaned up expired email outbox items", {
        cleaned: deleted.cleaned,
      });
    }
    return deleted.cleaned;
  },
);

export function getSvixHeaders(headers: Headers): {
  readonly "svix-id": string;
  readonly "svix-timestamp": string;
  readonly "svix-signature": string;
} | null {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signature = headers.get("svix-signature");
  return id && timestamp && signature
    ? {
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": signature,
      }
    : null;
}

export function verifyResendWebhook(
  payload: string,
  headers: {
    readonly "svix-id": string;
    readonly "svix-timestamp": string;
    readonly "svix-signature": string;
  },
): unknown {
  const secret = env("RESEND_WEBHOOK_SECRET");
  if (!secret) {
    throw new Error("RESEND_WEBHOOK_SECRET is not configured");
  }
  new Webhook(secret).verify(payload, headers);
  return JSON.parse(payload);
}

export const getUserEmail$ = command(
  async (
    { get, set },
    userId: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = get(db$);
    const [cached] = await db
      .select()
      .from(userCache)
      .where(eq(userCache.userId, userId))
      .limit(1);
    signal.throwIfAborted();
    if (cached && now() - cached.cachedAt.getTime() < USER_CACHE_TTL_MS) {
      return cached.email;
    }

    const user = await findClerkUser(get(clerk$), userId, signal);
    signal.throwIfAborted();
    if (!user) {
      return null;
    }
    const email =
      user?.emailAddresses.find((entry) => {
        return entry.id === user.primaryEmailAddressId;
      })?.emailAddress ?? user?.emailAddresses[0]?.emailAddress;
    if (!email) {
      return null;
    }

    await set(writeDb$)
      .insert(userCache)
      .values({
        userId,
        email,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
        imageUrl: user.imageUrl ?? null,
        cachedAt: nowDate(),
      })
      .onConflictDoUpdate({
        target: userCache.userId,
        set: {
          email,
          name:
            [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
          imageUrl: user.imageUrl ?? null,
          cachedAt: nowDate(),
        },
      });
    signal.throwIfAborted();
    return email;
  },
);

export const getUserIdByEmail$ = command(
  async ({ get, set }, email: string): Promise<string | null> => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    const [cached] = await db
      .select()
      .from(userCache)
      .where(eq(userCache.email, email))
      .limit(1);
    if (cached && now() - cached.cachedAt.getTime() < USER_CACHE_TTL_MS) {
      return cached.userId;
    }

    const usersResponse = await clerk.users.getUserList({
      emailAddress: [email],
    });
    const user = usersResponse.data[0];
    if (!user) {
      return null;
    }
    const resolvedEmail =
      user.emailAddresses.find((entry) => {
        return entry.id === user.primaryEmailAddressId;
      })?.emailAddress ??
      user.emailAddresses[0]?.emailAddress ??
      email;

    await db
      .insert(userCache)
      .values({
        userId: user.id,
        email: resolvedEmail,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
        imageUrl: user.imageUrl ?? null,
        cachedAt: nowDate(),
      })
      .onConflictDoUpdate({
        target: userCache.userId,
        set: {
          email: resolvedEmail,
          name:
            [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
          imageUrl: user.imageUrl ?? null,
          cachedAt: nowDate(),
        },
      });
    return user.id;
  },
);

export const unsubscribeUser$ = command(
  async ({ set }, userId: string): Promise<void> => {
    const db = set(writeDb$);
    await db
      .insert(users)
      .values({ id: userId, emailUnsubscribed: true })
      .onConflictDoUpdate({
        target: users.id,
        set: { emailUnsubscribed: true, updatedAt: nowDate() },
      });
  },
);
