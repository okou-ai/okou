import crypto from "node:crypto";

import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { emailSuppressions } from "@okouai/db/schema/email-suppression";
import { userCache } from "@okouai/db/schema/user-cache";
import { users } from "@okouai/db/schema/user";
import { command } from "ccstate";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Resend } from "resend";
import { delay } from "signal-timers";
import { Webhook } from "svix";
import { z } from "zod";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";

import { apiBackendUrl } from "../../lib/api-backend-url";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { webUrl } from "../../lib/web-url";
import type { ClerkClient } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import type { Tx } from "../../lib/db-types";
import { renderOfficialAutomationResultEmail } from "./official-automation-result-email-renderer";
import {
  escapeEmailHtml,
  plainTextFromEmailHtml,
  renderEmailLayout,
} from "./email-layout";

type Transaction = Tx;

interface EmailOutboxDrainContext {
  readonly currentTimeMs: number;
}

interface EmailOutboxItemsContext extends EmailOutboxDrainContext {
  readonly itemIds: readonly string[];
}

const log = logger("EmailCommon");
const USER_CACHE_TTL_MS = 900_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const MAX_OUTBOX_BATCH_SIZE = 120;
const OUTBOX_DRAIN_DELAY_MS = 500;
// Email is single-branded even while the rest of the product retains the
// dual PublicBrand compatibility contract.
export const EMAIL_PUBLIC_BRAND = "okou" satisfies PublicBrand;

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
export const CREDIT_LOW_BALANCE_EMAIL_SUBJECT =
  "Your credit balance is running low";
export const OFFICIAL_AUTOMATION_RESULT_EMAIL_SUBJECT_MAX_CHARACTERS = 180;
export const OFFICIAL_AUTOMATION_RESULT_EMAIL_TITLE_MAX_CHARACTERS = 160;
export const OFFICIAL_AUTOMATION_RESULT_EMAIL_TEXT_MAX_CHARACTERS = 8000;
export const OFFICIAL_AUTOMATION_RESULT_EMAIL_TEXT_TRUNCATION_MARKER =
  "\n\n[Result truncated]";

function unicodeCharacterCount(value: string): number {
  return Array.from(value).length;
}

function boundedUnicodeString(maxCharacters: number) {
  return z
    .string()
    .min(1)
    .refine(
      (value) => {
        return unicodeCharacterCount(value) <= maxCharacters;
      },
      { message: `Must contain at most ${maxCharacters} Unicode characters` },
    );
}

const emailTemplateSchema = z.discriminatedUnion("template", [
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
  z
    .object({
      template: z.literal("official-automation-result"),
      props: z
        .object({
          title: boundedUnicodeString(
            OFFICIAL_AUTOMATION_RESULT_EMAIL_TITLE_MAX_CHARACTERS,
          ),
          resultText: boundedUnicodeString(
            OFFICIAL_AUTOMATION_RESULT_EMAIL_TEXT_MAX_CHARACTERS,
          ),
          runUrl: z.url().max(1024),
          manageUrl: z.url().max(1024),
        })
        .strict(),
    })
    .strict(),
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
});
type OutboxRow = z.output<typeof outboxRowSchema>;

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

function officialAutomationResultUnsubscribeUrl(
  headers: Readonly<Record<string, string>> | undefined,
): string {
  const listUnsubscribe = headers?.["List-Unsubscribe"];
  if (
    !listUnsubscribe ||
    !listUnsubscribe.startsWith("<") ||
    !listUnsubscribe.endsWith(">")
  ) {
    throw new Error(
      "Official Automation result email is missing its List-Unsubscribe URL",
    );
  }
  const oneClickUrl = new URL(listUnsubscribe.slice(1, -1));
  if (
    oneClickUrl.protocol !== "https:" ||
    !oneClickUrl.pathname.endsWith("/api/email/unsubscribe")
  ) {
    throw new Error(
      "Official Automation result email has an invalid List-Unsubscribe URL",
    );
  }
  const token = oneClickUrl.searchParams.get("token");
  if (!token) {
    throw new Error(
      "Official Automation result email is missing its unsubscribe token",
    );
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
  return `${PUBLIC_BRAND_PRESENTATION.assistantName} <okou@${getFromDomain()}>`;
}

export function buildTeamFromAddress(): string {
  return `${PUBLIC_BRAND_PRESENTATION.brandName} Team <support@${getFromDomain()}>`;
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
  readonly text: string;
}

function renderTemplate(
  template: EmailTemplate,
  headers: Readonly<Record<string, string>> | undefined,
): RenderedEmailTemplate {
  switch (template.template) {
    case "data-export-ready": {
      const title = "Your data export is ready";
      const html = renderEmailLayout({
        title,
        bodyHtml: `<h1 style="margin:0 0 24px;font-size:24px;line-height:1.3;letter-spacing:-0.025em">${title}</h1><p style="margin:0 0 20px">${template.props.artifactCount} artifacts. Expires ${escapeEmailHtml(template.props.expiresAt)}.</p>`,
        action: { label: "Download export", url: template.props.downloadUrl },
        footer: {
          text: `Sent by ${PUBLIC_BRAND_PRESENTATION.brandName}`,
          links: template.props.unsubscribeUrl
            ? [{ label: "Unsubscribe", url: template.props.unsubscribeUrl }]
            : [],
        },
      });
      return { html, text: plainTextFromEmailHtml(html) };
    }
    case "credit-low-balance": {
      const remainingCredits =
        template.props.remainingCredits.toLocaleString("en-US");
      const thresholdCredits =
        template.props.thresholdCredits.toLocaleString("en-US");
      const html = renderEmailLayout({
        title: CREDIT_LOW_BALANCE_EMAIL_SUBJECT,
        bodyHtml: `<h1 style="margin:0 0 24px;font-size:24px;line-height:1.3;letter-spacing:-0.025em">${CREDIT_LOW_BALANCE_EMAIL_SUBJECT}</h1><p style="margin:0 0 20px"><strong>${escapeEmailHtml(template.props.orgName)}</strong> has <strong>${escapeEmailHtml(remainingCredits)} credits</strong> remaining.</p><p style="margin:0 0 20px">This alert is sent when an org reaches ${escapeEmailHtml(thresholdCredits)} credits or less.</p>`,
        action: { label: "Manage billing", url: template.props.billingUrl },
        footer: {
          text: `Sent by ${PUBLIC_BRAND_PRESENTATION.brandName} Team`,
          links: template.props.unsubscribeUrl
            ? [{ label: "Unsubscribe", url: template.props.unsubscribeUrl }]
            : [],
        },
      });
      return { html, text: plainTextFromEmailHtml(html) };
    }
    case "official-automation-result": {
      const rendered = renderOfficialAutomationResultEmail(
        template.props,
        officialAutomationResultUnsubscribeUrl(headers),
      );
      if (rendered.fallback) {
        log.warn("Official Automation result email used fallback renderer", {
          reason: rendered.fallback.reason,
          attemptedHtmlBytes: rendered.fallback.attemptedHtmlBytes,
          fallbackHtmlBytes: rendered.fallback.fallbackHtmlBytes,
        });
      }
      return { html: rendered.html, text: rendered.text };
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
    case "official-automation-result": {
      return buildFromAddress();
    }
  }
}

async function sendEmailDirect(options: {
  readonly to: string | readonly string[];
  readonly subject: string;
  readonly template: EmailTemplate;
  readonly cc?: string | readonly string[];
  readonly replyTo?: string;
  readonly headers?: Record<string, string>;
}): Promise<
  | { readonly ok: true; readonly resendId: string }
  | { readonly ok: false; readonly error: string }
> {
  const resend = getResendClient();
  const rendered = renderTemplate(options.template, options.headers);
  const { data, error } = await resend.emails.send({
    from: fromAddressForTemplate(options.template),
    to: typeof options.to === "string" ? options.to : [...options.to],
    subject: options.subject,
    ...rendered,
    cc:
      options.cc === undefined
        ? undefined
        : typeof options.cc === "string"
          ? options.cc
          : [...options.cc],
    replyTo: options.replyTo,
    headers: options.headers,
  });

  if (error || !data) {
    return { ok: false, error: error?.message ?? "unknown" };
  }
  return { ok: true, resendId: data.id };
}

async function findSuppressedAddress(
  tx: Transaction,
  addresses: readonly string[],
): Promise<string | null> {
  if (addresses.length === 0) {
    return null;
  }
  const lowerAddresses = addresses.map((address) => {
    return address.toLowerCase();
  });
  const rows = await tx
    .select({ emailAddress: emailSuppressions.emailAddress })
    .from(emailSuppressions)
    .where(
      inArray(sql`lower(${emailSuppressions.emailAddress})`, lowerAddresses),
    )
    .limit(1);

  const matchedLower = rows[0]?.emailAddress.toLowerCase();
  if (!matchedLower) {
    return null;
  }
  return (
    addresses.find((address) => {
      return address.toLowerCase() === matchedLower;
    }) ?? matchedLower
  );
}

async function processOutboxItem(
  tx: Transaction,
  row: OutboxRow,
  currentTimeMs: number = now(),
): Promise<true> {
  const itemId = row.id;
  const attempts = row.attempts + 1;
  await tx
    .update(emailOutbox)
    .set({ status: "sending", attempts })
    .where(eq(emailOutbox.id, itemId));

  const toAddresses =
    typeof row.to_addresses === "string"
      ? [row.to_addresses]
      : row.to_addresses;
  const suppressedAddress = await findSuppressedAddress(tx, toAddresses);
  if (suppressedAddress) {
    await tx
      .update(emailOutbox)
      .set({
        status: "failed",
        lastError: `Recipient address suppressed (${suppressedAddress})`,
      })
      .where(eq(emailOutbox.id, itemId));
    return true;
  }

  const result = await sendEmailDirect({
    to: row.to_addresses,
    subject: row.subject,
    template: row.template,
    cc: row.cc_addresses ?? undefined,
    replyTo: row.reply_to ?? undefined,
    headers: row.headers ?? undefined,
  });

  if (!result.ok) {
    if (attempts < MAX_ATTEMPTS) {
      const backoffMs = BACKOFF_BASE_MS * 4 ** (attempts - 1);
      await tx
        .update(emailOutbox)
        .set({
          status: "pending",
          lastError: result.error,
          nextRetryAt: new Date(currentTimeMs + backoffMs),
        })
        .where(eq(emailOutbox.id, itemId));
    } else {
      await tx
        .update(emailOutbox)
        .set({ status: "failed", lastError: result.error })
        .where(eq(emailOutbox.id, itemId));
    }
    return true;
  }

  await tx
    .update(emailOutbox)
    .set({ status: "sent", resendId: result.resendId })
    .where(eq(emailOutbox.id, itemId));
  return true;
}

async function drainNextOutboxItem(
  db: Db,
  currentTimeMs: number,
  itemIds?: readonly string[],
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const currentTime = new Date(currentTimeMs);
    const [selectedRow] = await tx
      .select(outboxRowSelection())
      .from(emailOutbox)
      .where(
        and(
          itemIds === undefined
            ? undefined
            : inArray(emailOutbox.id, [...itemIds]),
          eq(emailOutbox.status, "pending"),
          or(
            isNull(emailOutbox.nextRetryAt),
            // Keep the Date schema-bound so Drizzle encodes its UTC wall-clock
            // value instead of letting node-postgres apply the process timezone.
            lte(emailOutbox.nextRetryAt, currentTime),
          ),
        ),
      )
      .orderBy(asc(emailOutbox.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    const row = selectedRow ? outboxRowSchema.parse(selectedRow) : undefined;
    return row ? await processOutboxItem(tx, row, currentTimeMs) : false;
  });
}

async function drainEmailOutboxBatch(
  db: Db,
  context: EmailOutboxDrainContext,
  signal: AbortSignal,
  itemIds?: readonly string[],
): Promise<number> {
  let processed = 0;

  for (let index = 0; index < MAX_OUTBOX_BATCH_SIZE; index++) {
    signal.throwIfAborted();
    const hadItem = await drainNextOutboxItem(
      db,
      context.currentTimeMs,
      itemIds,
    );
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
}

export const drainEmailOutboxBatch$ = command(
  async (
    { set },
    context: EmailOutboxDrainContext,
    signal: AbortSignal,
  ): Promise<number> => {
    return await drainEmailOutboxBatch(set(writeDb$), context, signal);
  },
);

export const drainEmailOutboxItems$ = command(
  async (
    { set },
    context: EmailOutboxItemsContext,
    signal: AbortSignal,
  ): Promise<number> => {
    return await drainEmailOutboxBatch(
      set(writeDb$),
      context,
      signal,
      context.itemIds,
    );
  },
);

async function cleanupExpiredEmailOutbox(
  db: Db,
  context: EmailOutboxDrainContext,
  signal: AbortSignal,
  itemIds?: readonly string[],
): Promise<number> {
  const cutoff = new Date(context.currentTimeMs - OUTBOX_TTL_MS);
  const deleted = await db
    .delete(emailOutbox)
    .where(
      and(
        itemIds === undefined
          ? undefined
          : inArray(emailOutbox.id, [...itemIds]),
        lt(emailOutbox.createdAt, cutoff),
        or(eq(emailOutbox.status, "pending"), eq(emailOutbox.status, "failed")),
      ),
    )
    .returning({ id: emailOutbox.id });
  signal.throwIfAborted();

  if (deleted.length > 0) {
    log.debug("Cleaned up expired email outbox items", {
      cleaned: deleted.length,
    });
  }
  return deleted.length;
}

export const cleanupExpiredEmailOutbox$ = command(
  async (
    { set },
    context: EmailOutboxDrainContext,
    signal: AbortSignal,
  ): Promise<number> => {
    return await cleanupExpiredEmailOutbox(set(writeDb$), context, signal);
  },
);

export const cleanupExpiredEmailOutboxItems$ = command(
  async (
    { set },
    context: EmailOutboxItemsContext,
    signal: AbortSignal,
  ): Promise<number> => {
    return await cleanupExpiredEmailOutbox(
      set(writeDb$),
      context,
      signal,
      context.itemIds,
    );
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

export async function getUserEmail(
  db: Db,
  clerk: ClerkClient,
  userId: string,
): Promise<string | null> {
  const [cached] = await db
    .select()
    .from(userCache)
    .where(eq(userCache.userId, userId))
    .limit(1);
  if (cached && now() - cached.cachedAt.getTime() < USER_CACHE_TTL_MS) {
    return cached.email;
  }

  const usersResponse = await clerk.users.getUserList({ userId: [userId] });
  const user = usersResponse.data[0];
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

  await db
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
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
        imageUrl: user.imageUrl ?? null,
        cachedAt: nowDate(),
      },
    });
  return email;
}

export async function getUserIdByEmail(
  db: Db,
  clerk: ClerkClient,
  email: string,
): Promise<string | null> {
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
        name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
        imageUrl: user.imageUrl ?? null,
        cachedAt: nowDate(),
      },
    });
  return user.id;
}

export async function unsubscribeUser(db: Db, userId: string): Promise<void> {
  await db
    .insert(users)
    .values({ id: userId, emailUnsubscribed: true })
    .onConflictDoUpdate({
      target: users.id,
      set: { emailUnsubscribed: true, updatedAt: nowDate() },
    });
}
