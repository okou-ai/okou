import { agents } from "@okouai/db/schema/agent";
import {
  getAgentPhoneConversationParticipants,
  isAgentPhoneApiError,
} from "../external/agentphone-client";
import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneMessageVisibility } from "@okouai/db/schema/agentphone-message-visibility";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { settle } from "../utils";

export type AgentPhoneChannel = "imessage" | "sms" | "mms";
export type AgentPhoneUserLink = typeof agentphoneUserLinks.$inferSelect;

/** AgentPhone requires to_number for every send. Group replies use the
 * provider's group id; a member's handle would create a separate DM. */
export function agentPhoneReplyDestination(target: {
  readonly isGroup: boolean;
  readonly groupId: string | null | undefined;
  readonly phoneHandle: string;
}): string {
  if (target.isGroup) {
    if (!target.groupId?.startsWith("grp_")) {
      throw new Error("AgentPhone group reply is missing a provider group id");
    }
    return target.groupId;
  }
  return target.phoneHandle;
}

const AGENTPHONE_EMAIL_HANDLE_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const AGENTPHONE_PHONE_HANDLE_PATTERN = /^\+[1-9]\d{7,14}$/u;

/** Handle that addresses the assistant in a group conversation. */
const AGENTPHONE_MENTION_PATTERN = /(^|\s)@okou\b/iu;
// Native iMessage mentions can arrive as display names without an at-sign or
// mention metadata. Treat only an opening name followed by a separator as an
// address, keeping embedded names, domains and longer names as group chatter.
const AGENTPHONE_OPENING_NAME_PATTERN = /^\s*okou(?=$|[\s,，:：!！?？])/iu;

/** Whether free-form message text addresses the assistant by handle or name. */
export function isAgentPhoneMentionText(value: string): boolean {
  return (
    AGENTPHONE_MENTION_PATTERN.test(value) ||
    AGENTPHONE_OPENING_NAME_PATTERN.test(value)
  );
}

export function isAgentPhoneChannel(value: string): value is AgentPhoneChannel {
  return value === "imessage" || value === "sms" || value === "mms";
}

export function normalizeAgentPhoneHandle(
  handle: string,
  channel: AgentPhoneChannel,
): string {
  const trimmed = handle.trim();
  if (channel === "imessage" && AGENTPHONE_EMAIL_HANDLE_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return trimmed.replace(/[^\d+]/gu, "");
}

/**
 * Channel implied by an already-normalized linked handle. Email handles only
 * exist on iMessage; phone numbers keep the SMS normalization.
 */
export function agentPhoneChannelForLinkedHandle(
  handle: string,
): AgentPhoneChannel {
  return AGENTPHONE_EMAIL_HANDLE_PATTERN.test(handle) ? "imessage" : "sms";
}

export function isValidAgentPhoneHandle(
  handle: string,
  channel: AgentPhoneChannel,
): boolean {
  if (channel === "imessage" && AGENTPHONE_EMAIL_HANDLE_PATTERN.test(handle)) {
    return true;
  }
  return AGENTPHONE_PHONE_HANDLE_PATTERN.test(handle);
}

export function describeAgentPhoneHandleShape(
  handle: string,
): "email" | "phone" | "other" {
  const trimmed = handle.trim();
  if (AGENTPHONE_EMAIL_HANDLE_PATTERN.test(trimmed)) {
    return "email";
  }
  if (/^\+?\d+$/u.test(trimmed)) {
    return "phone";
  }
  return "other";
}

export interface AgentPhoneMessageVisibilityRecipient {
  readonly orgId: string;
  readonly userId: string;
}

export const resolveAgentPhoneConversationVisibilityRecipients$ = command(
  async (
    { get },
    conversationId: string,
    asOf: Date,
    signal: AbortSignal,
  ): Promise<readonly AgentPhoneMessageVisibilityRecipient[]> => {
    const result = await settle(
      getAgentPhoneConversationParticipants({ conversationId }, signal),
      signal,
    );
    if (!result.ok) {
      if (
        isAgentPhoneApiError(result.error) ||
        result.error instanceof TypeError ||
        result.error instanceof SyntaxError
      ) {
        return [];
      }
      throw result.error;
    }
    const normalizedHandles = [
      ...new Set(
        result.value
          .map((handle) => {
            return normalizeAgentPhoneHandle(handle, "imessage");
          })
          .filter((handle) => {
            return isValidAgentPhoneHandle(handle, "imessage");
          }),
      ),
    ];
    if (normalizedHandles.length === 0) {
      return [];
    }

    const links = await get(db$)
      .select({
        orgId: agentphoneUserLinks.orgId,
        userId: agentphoneUserLinks.userId,
      })
      .from(agentphoneUserLinks)
      .where(
        and(
          inArray(agentphoneUserLinks.phoneHandle, normalizedHandles),
          lte(agentphoneUserLinks.createdAt, asOf),
        ),
      );

    signal.throwIfAborted();
    const recipients = [
      ...new Map(
        links.map((link) => {
          return [`${link.orgId}:${link.userId}`, link] as const;
        }),
      ).values(),
    ];
    return recipients;
  },
);

export async function touchAgentPhoneUserLink(
  db: Db,
  userLink: AgentPhoneUserLink,
  phoneHandle: string,
  channel: AgentPhoneChannel,
): Promise<AgentPhoneUserLink> {
  const normalized = normalizeAgentPhoneHandle(phoneHandle, channel);
  if (userLink.phoneHandle === normalized) {
    return userLink;
  }

  const [updated] = await db
    .update(agentphoneUserLinks)
    .set({
      phoneHandle: normalized,
      updatedAt: nowDate(),
    })
    .where(eq(agentphoneUserLinks.id, userLink.id))
    .returning();

  return updated ?? userLink;
}

export async function resolveAgentPhoneUserLink(
  db: Db,
  phoneHandle: string,
  channel: AgentPhoneChannel,
): Promise<AgentPhoneUserLink | null> {
  const normalized = normalizeAgentPhoneHandle(phoneHandle, channel);
  if (!normalized) {
    return null;
  }
  const [userLink] = await db
    .select()
    .from(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.phoneHandle, normalized))
    .limit(1);

  if (!userLink) {
    return null;
  }
  return touchAgentPhoneUserLink(db, userLink, normalized, channel);
}

// The provider has already sent this message. Finish archival once entered,
// even if the caller is cancelled while the database statement is in flight.
export const storeOutboundAgentPhoneMessage$ = command(
  async (
    { set },
    params: {
      readonly agentphoneMessageId: string;
      readonly conversationId: string | null;
      readonly groupId?: string | null;
      readonly agentphoneAgentId: string;
      readonly userLinkId?: string | null;
      readonly phoneHandle: string;
      readonly fromNumber: string;
      readonly toNumber: string;
      readonly body: string | undefined;
      readonly channel: string | null;
      readonly userChannel: AgentPhoneChannel;
      readonly mediaUrl?: string | null;
      readonly visibilityRecipients: readonly AgentPhoneMessageVisibilityRecipient[];
    },
  ): Promise<void> => {
    const isGroup = Boolean(params.groupId);
    const visibilityRecipients = params.visibilityRecipients;
    if (isGroup && visibilityRecipients.length === 0) {
      return;
    }
    const db = set(writeDb$);
    const insert = db
      .insert(agentphoneMessages)
      .values({
        agentphoneMessageId: params.agentphoneMessageId,
        conversationId: params.conversationId,
        groupId: params.groupId ?? null,
        agentphoneAgentId: params.agentphoneAgentId,
        agentphoneUserLinkId: params.userLinkId ?? null,
        phoneHandle: normalizeAgentPhoneHandle(
          params.phoneHandle,
          params.userChannel,
        ),
        fromNumber: normalizeAgentPhoneHandle(params.fromNumber, "sms"),
        toNumber: params.toNumber.startsWith("grp_")
          ? params.toNumber
          : normalizeAgentPhoneHandle(params.toNumber, params.userChannel),
        direction: "outbound",
        channel: params.channel ?? "unknown",
        body: params.body ?? null,
        mediaUrl: params.mediaUrl ?? null,
        isBot: true,
        receivedAt: nowDate(),
      })
      .onConflictDoNothing();
    if (!isGroup) {
      await insert;
      return;
    }

    const message = db
      .$with("inserted_message")
      .as(insert.returning({ id: agentphoneMessages.id }));
    const recipients = sql.join(
      visibilityRecipients.map((recipient) => {
        return sql`(${recipient.orgId}, ${recipient.userId})`;
      }),
      sql`, `,
    );
    // Only this statement's inserted message grants access. A duplicate provider
    // id produces no rows, and a visibility failure rolls back the message too.
    await db
      .with(message)
      .insert(agentphoneMessageVisibility)
      .select(
        sql`SELECT ${message.id}, recipient.org_id, recipient.user_id
        FROM ${message}
        CROSS JOIN (VALUES ${recipients}) AS recipient(org_id, user_id)`,
      )
      .onConflictDoNothing();
  },
);

export function markdownToImessagePlain(markdown: string): string {
  if (markdown.length === 0) {
    return markdown;
  }

  let text = markdown;
  text = text.replace(
    /```[^\n]*\n?([\s\S]*?)\n?```/g,
    (_match, content: string) => {
      return content;
    },
  );
  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_match, alt: string, url: string) => {
      const label = alt.trim();
      return label ? `${label}\n${url}` : url;
    },
  );
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_match, label: string, url: string) => {
      const trimmed = label.trim();
      if (!trimmed || trimmed === url) {
        return url;
      }
      return `${trimmed}\n${url}`;
    },
  );
  text = text.replace(/\*\*([^\n*]+)\*\*/g, "$1");
  text = text.replace(/__([^\n_]+)__/g, "$1");
  text = text.replace(/\*([^\n*]+)\*/g, "$1");
  text = text.replace(/(^|[^A-Za-z0-9_])_([^\n_]+)_(?![A-Za-z0-9_])/g, "$1$2");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/~~([^\n~]+)~~/g, "$1");
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/^(.+)\n[=-]{2,}[ \t]*$/gm, "$1");
  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1- ");
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function plainLabel(value: string | null | undefined): string | undefined {
  const label = value?.trim().replace(/\s+/gu, " ");
  return label || undefined;
}

function displayLabel(row: {
  readonly agentDisplayName: string | null;
  readonly agentName: string;
}): string {
  return plainLabel(row.agentDisplayName) ?? row.agentName;
}

async function resolveComposeLabel(
  db: ReadonlyDb,
  composeId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({
      agentDisplayName: agents.displayName,
      agentName: agents.name,
    })
    .from(agents)
    .where(eq(agents.id, composeId))
    .limit(1);
  return row ? displayLabel(row) : undefined;
}

export async function resolveOrgDefaultComposeId(
  db: ReadonlyDb,
  orgId: string,
): Promise<string | null> {
  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.defaultAgentId ?? null;
}

export async function resolveAgentPhoneReplyFooterText(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly composeId: string;
}): Promise<string | undefined> {
  const orgDefaultComposeId = await resolveOrgDefaultComposeId(
    args.db,
    args.orgId,
  );
  if (!orgDefaultComposeId || args.composeId === orgDefaultComposeId) {
    return undefined;
  }

  const label = await resolveComposeLabel(args.db, args.composeId);
  return label ? `Responded by ${label}` : undefined;
}
