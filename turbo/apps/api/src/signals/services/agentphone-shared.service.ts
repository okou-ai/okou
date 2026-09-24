import { agents } from "@okouai/db/schema/agent";
import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq } from "drizzle-orm";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";

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

export async function touchAgentPhoneUserLink(
  db: Db,
  userLink: AgentPhoneUserLink,
  phoneHandle: string,
  channel: AgentPhoneChannel,
  publicBrand?: PublicBrand,
): Promise<AgentPhoneUserLink> {
  const normalized = normalizeAgentPhoneHandle(phoneHandle, channel);
  if (
    userLink.phoneHandle === normalized &&
    (publicBrand === undefined || userLink.publicBrand === publicBrand)
  ) {
    return userLink;
  }

  const [updated] = await db
    .update(agentphoneUserLinks)
    .set({
      phoneHandle: normalized,
      ...(publicBrand ? { publicBrand } : {}),
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

export async function storeOutboundAgentPhoneMessage(
  db: Db,
  params: {
    readonly agentphoneMessageId: string;
    readonly conversationId: string | null;
    readonly agentphoneAgentId: string;
    readonly publicBrand: PublicBrand;
    readonly userLinkId: string;
    readonly phoneHandle: string;
    readonly fromNumber: string;
    readonly toNumber: string;
    readonly body: string | undefined;
    readonly channel: string | null;
    readonly userChannel: AgentPhoneChannel;
    readonly mediaUrl?: string | null;
  },
): Promise<void> {
  await db
    .insert(agentphoneMessages)
    .values({
      agentphoneMessageId: params.agentphoneMessageId,
      conversationId: params.conversationId,
      agentphoneAgentId: params.agentphoneAgentId,
      publicBrand: params.publicBrand,
      agentphoneUserLinkId: params.userLinkId,
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
    })
    .onConflictDoNothing();
}

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
