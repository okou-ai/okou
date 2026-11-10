import { command } from "ccstate";
import {
  and,
  count,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  sql,
} from "drizzle-orm";
import { createHmac } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { disposableEmailBlocklistSet } from "disposable-email-domains-js";
import { emailChannelMessages } from "@okouai/db/schema/email-integration";
import { emailOutbox } from "@okouai/db/runtime/email-outbox";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import {
  clerk$,
  createClerkReadContext,
  isClerkEmailSignupRejected,
  isClerkResourceNotFound,
  isClerkUniqueIdentifierConflict,
  type ClerkUser,
} from "../external/clerk";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  EMAIL_SIGNUP_REQUEST_HEADER,
  enqueueEmailText$,
} from "./email-channel-delivery.service";
import { fetchUserProfileMap$ } from "./user-profile-directory.service";

type EmailMessage = typeof emailChannelMessages.$inferSelect;
const NAMESPACE = "105a832b-9db8-47a7-8d40-a3ff48a7bf7a";
const SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;
const SIGNUP_REPLY_PATTERN = /^[ \t\r\n]*CONFIRM[ \t]*(?:\r?\n|$)/iu;
const SIGNUP_REPLY_ADDRESS_PATTERN = /^okou\+confirm-[a-f0-9]{32}@okou\.io$/u;
const disposable = disposableEmailBlocklistSet();
const signupRequestId = sql`${emailOutbox.headers}->>${EMAIL_SIGNUP_REQUEST_HEADER}`;

function signupReplyAddress(message: EmailMessage): string {
  const token = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(
      `email-signup-reply:v1:${message.id}:${message.sender}:${message.createdAt.getTime()}`,
    )
    .digest("hex")
    .slice(0, 32);
  return `okou+confirm-${token}@okou.io`;
}

export function isEmailSignupReplyAddress(address: string): boolean {
  return SIGNUP_REPLY_ADDRESS_PATTERN.test(address);
}

function domainIsDisposable(domain: string): boolean {
  const labels = domain.split(".");
  return labels.some((_label, index) => {
    const parent = labels.slice(index).join(".");
    return disposable.has(parent);
  });
}

function matchesBlocklist(email: string, identifier: string): boolean {
  const pattern = identifier
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`)
    .replaceAll("*", ".*");
  return new RegExp(`^${pattern}$`, "u").test(email);
}

const signupAddressAllowed$ = command(
  async ({ get }, sender: string, signal: AbortSignal): Promise<boolean> => {
    const domain = sender.slice(sender.lastIndexOf("@") + 1);
    // This is a precheck, not a substitute for Clerk's creation-time restrictions.
    if (domainIsDisposable(domain)) {
      return false;
    }
    for (let offset = 0; ; offset += 500) {
      const page = await get(
        clerk$,
      ).blocklistIdentifiers.getBlocklistIdentifierList(
        { limit: 500, offset },
        undefined,
        signal,
      );
      signal.throwIfAborted();
      if (
        page.data.some(({ identifier }) => {
          return matchesBlocklist(sender, identifier);
        })
      ) {
        return false;
      }
      if (offset + page.data.length >= page.totalCount) {
        return true;
      }
      if (page.data.length === 0) {
        throw new Error("Clerk blocklist pagination is incomplete");
      }
    }
  },
);

const signupReply$ = command(
  async (
    { set },
    args: {
      readonly message: EmailMessage;
      readonly kind: string;
      readonly text: string;
      readonly signupRequestId?: string;
      readonly replyTo?: string;
    },
    signal: AbortSignal,
  ) => {
    const { message, kind, text, signupRequestId, replyTo } = args;
    const id = uuidv5(`${kind}:${message.id}`, NAMESPACE);
    await set(
      enqueueEmailText$,
      {
        id,
        to: message.sender,
        subject: /^re:/iu.test(message.subject)
          ? message.subject
          : `Re: ${message.subject}`,
        messageId: `<${id}@okou.io>`,
        inReplyTo: message.messageId,
        references: message.references,
        text,
        ...(signupRequestId ? { signupRequestId } : {}),
        ...(replyTo ? { replyTo } : {}),
      },
      signal,
    );
  },
);

const rejectSignupAddress$ = command(
  async ({ set }, message: EmailMessage, signal: AbortSignal) => {
    await set(
      signupReply$,
      {
        message,
        kind: "unsafe-address",
        text: "This email address did not pass our security checks. Please use a different email address to contact Okou.",
      },
      signal,
    );
  },
);

export const rejectUnsafeEmailSignup$ = command(
  async ({ set }, message: EmailMessage, signal: AbortSignal) => {
    if (await set(signupAddressAllowed$, message.sender, signal)) {
      return false;
    }
    await set(rejectSignupAddress$, message, signal);
    return true;
  },
);

export const sendEmailSignupConnectionConflict$ = command(
  async ({ set }, message: EmailMessage, signal: AbortSignal) => {
    await set(
      signupReply$,
      {
        message,
        kind: "connection-conflict",
        text: "This email address is already connected to another account or workspace. Disconnect it from its original workspace before connecting it here.",
      },
      signal,
    );
  },
);

export const sendEmailSignupConfirmation$ = command(
  async ({ set }, message: EmailMessage, signal: AbortSignal) => {
    if (message.createdAt.getTime() + SIGNUP_TTL_MS < now()) {
      return;
    }
    const db = set(writeDb$);
    const [senderCount] = await db
      .select({ value: count() })
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.toAddresses, message.sender),
          isNotNull(signupRequestId),
          gte(emailOutbox.createdAt, new Date(now() - SIGNUP_TTL_MS)),
        ),
      );
    signal.throwIfAborted();
    const [globalCount] = await db
      .select({ value: count() })
      .from(emailOutbox)
      .where(
        and(
          isNotNull(signupRequestId),
          gte(emailOutbox.createdAt, new Date(now() - 60 * 60 * 1000)),
        ),
      );
    signal.throwIfAborted();
    if (!senderCount || !globalCount) {
      throw new Error("Email signup admission counts are unavailable");
    }
    if (senderCount.value >= 3 || globalCount.value >= 100) {
      return;
    }
    await set(
      signupReply$,
      {
        message,
        kind: "signup-confirmation",
        signupRequestId: message.id,
        replyTo: signupReplyAddress(message),
        text: `Hi, I'm Okou. To create your account and workspace and continue your original request, reply to this email with this word on the first line (uppercase or lowercase):\n\nCONFIRM\n\nBy replying CONFIRM, you agree to the [Terms of Use](https://www.okou.ai/en/terms-of-use) and acknowledge the [Privacy Policy](https://www.okou.ai/en/privacy-policy). This confirmation expires in 24 hours and works only from this email address. Once confirmed, I'll continue your original request automatically.\n\nThis integration does not support HIPAA-regulated use. If you didn't request an account, ignore this email.`,
      },
      signal,
    );
  },
);

function hasVerifiedAddress(user: ClerkUser, sender: string): boolean {
  return (
    !user.banned &&
    user.emailAddresses.some((entry) => {
      return (
        entry.emailAddress.toLowerCase() === sender &&
        entry.verification?.status === "verified"
      );
    })
  );
}

const provisionEmailUser$ = command(
  async (
    { get },
    args: {
      readonly original: EmailMessage;
      readonly confirmation: EmailMessage;
    },
    signal: AbortSignal,
  ) => {
    const { original, confirmation } = args;
    const clerk = get(clerk$);
    const directory = await clerk.users.getUserList(
      { emailAddress: [original.sender], limit: 2 },
      undefined,
      signal,
    );
    signal.throwIfAborted();
    if (directory.data.length > 0) {
      return directory.data.length === 1 &&
        directory.data[0] &&
        hasVerifiedAddress(directory.data[0], original.sender)
        ? directory.data[0]
        : null;
    }
    const externalId = `email-signup:${uuidv5(original.sender, NAMESPACE)}`;
    const created = await settle(
      clerk.users.createUser({
        externalId,
        emailAddress: [original.sender],
        skipPasswordRequirement: true,
        legalAcceptedAt: confirmation.createdAt,
        privateMetadata: {
          emailSignup: {
            originalMessageId: original.id,
            confirmationMessageId: confirmation.id,
            termsUrl: "https://www.okou.ai/en/terms-of-use",
            privacyUrl: "https://www.okou.ai/en/privacy-policy",
            acceptedAt: confirmation.createdAt.toISOString(),
          },
        },
      }),
      signal,
    );
    if (created.ok) {
      if (!hasVerifiedAddress(created.value, original.sender)) {
        throw new Error("Clerk created an unavailable email signup identity");
      }
      return created.value;
    }
    if (isClerkEmailSignupRejected(created.error)) {
      return null;
    }
    if (!isClerkUniqueIdentifierConflict(created.error)) {
      throw created.error;
    }
    const recovered = await clerk.users.getUserList(
      { externalId: [externalId], limit: 2 },
      undefined,
      signal,
    );
    signal.throwIfAborted();
    if (
      recovered.data.length !== 1 ||
      !recovered.data[0] ||
      !hasVerifiedAddress(recovered.data[0], original.sender)
    ) {
      throw created.error;
    }
    return recovered.data[0];
  },
);

const provisionEmailOrganization$ = command(
  async ({ get }, userId: string, signal: AbortSignal) => {
    const clerk = get(clerk$);
    const memberships = await clerk.users.getOrganizationMembershipList(
      { userId, limit: 2 },
      undefined,
      signal,
    );
    signal.throwIfAborted();
    if (memberships.totalCount > 0) {
      return memberships.totalCount === 1
        ? (memberships.data[0]?.organization.id ?? null)
        : null;
    }
    const slug = `email-${uuidv5(userId, NAMESPACE)}`;
    const existing = await settle(
      clerk.organizations.getOrganization({ slug }, undefined, signal),
      signal,
    );
    if (existing.ok) {
      if (existing.value.createdBy !== userId) {
        throw new Error("Email signup organization belongs to another owner");
      }
      return existing.value.id;
    }
    if (!isClerkResourceNotFound(existing.error)) {
      throw existing.error;
    }
    // The unique slug recovers a committed create on a later webhook redelivery.
    // Do not automatically replay an uncertain provider mutation.
    const created = await clerk.organizations.createOrganization({
      name: "My workspace",
      slug,
      createdBy: userId,
    });
    signal.throwIfAborted();
    return created.id;
  },
);

const resolveEmailSignupConfirmation$ = command(
  async (
    { set },
    args: { readonly confirmation: EmailMessage; readonly replyTo: string },
    signal: AbortSignal,
  ) => {
    const { confirmation, replyTo } = args;
    const db = set(writeDb$);
    const [selected] = await db
      .select({
        message: getTableColumns(emailChannelMessages),
        issuedAt: emailOutbox.createdAt,
      })
      .from(emailOutbox)
      .innerJoin(
        emailChannelMessages,
        eq(signupRequestId, sql`${emailChannelMessages.id}::text`),
      )
      .where(
        and(
          eq(emailChannelMessages.sender, confirmation.sender),
          eq(emailChannelMessages.authenticated, true),
          eq(emailOutbox.toAddresses, confirmation.sender),
          eq(emailOutbox.replyTo, replyTo),
          inArray(emailOutbox.status, ["sent", "sending"]),
          gte(emailOutbox.createdAt, new Date(now() - SIGNUP_TTL_MS)),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!selected || selected.issuedAt.getTime() + SIGNUP_TTL_MS < now()) {
      await set(
        signupReply$,
        {
          message: confirmation,
          kind: "invalid-confirmation",
          text: "This confirmation is invalid or expired. Send your original request in a new email to receive a new confirmation email.",
        },
        signal,
      );
      return null;
    }
    const original = selected.message;
    // A consumed canonical input is the one-time-use receipt, including retries.
    if (
      original.routeId &&
      !original.text.trim() &&
      original.attachmentIds.length === 0
    ) {
      return null;
    }
    return original;
  },
);

export const confirmEmailSignup$ = command(
  async (
    { set },
    args: { readonly confirmation: EmailMessage; readonly replyTo: string },
    signal: AbortSignal,
  ) => {
    const { confirmation } = args;
    // Only the explicit first line is consent; quoted text is never accepted.
    if (!SIGNUP_REPLY_PATTERN.test(confirmation.text)) {
      return null;
    }
    const original = await set(resolveEmailSignupConfirmation$, args, signal);
    if (!original) {
      return null;
    }
    if (!(await set(signupAddressAllowed$, confirmation.sender, signal))) {
      await set(rejectSignupAddress$, confirmation, signal);
      return null;
    }
    const user = await set(
      provisionEmailUser$,
      { original, confirmation },
      signal,
    );
    if (!user) {
      await set(rejectSignupAddress$, confirmation, signal);
      return null;
    }
    // First-email execution may precede Clerk webhooks. Publish its authoritative
    // profile through the shared directory before capturing Run feature context.
    const profiles = await set(
      fetchUserProfileMap$,
      [user.id],
      createClerkReadContext(),
      signal,
    );
    if (!profiles.has(user.id)) {
      throw new Error("Email signup profile is temporarily unavailable");
    }
    const orgId = await set(provisionEmailOrganization$, user.id, signal);
    return { original, userId: user.id, orgId };
  },
);
