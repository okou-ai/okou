import {
  integrationsAgentPhoneContract,
  type AgentPhoneGroupListResponse,
} from "@okouai/api-contracts/contracts/integrations-agentphone";
import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentPhoneMessageVisibleTo } from "../services/agentphone-message-access";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { command, computed } from "ccstate";
import { and, asc, desc, eq, gt, isNotNull, or } from "drizzle-orm";
import { object, string } from "zod";
import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import {
  getAgentPhoneGroupConversation,
  isAgentPhoneApiError,
} from "../external/agentphone-client";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { normalizeAgentPhoneHandle } from "../services/agentphone-shared.service";
import { safeJsonParse, settle } from "../utils";

const groupListCursorSchema = object({
  groupId: string().min(5).max(255).startsWith("grp_"),
  agentphoneAgentId: string().min(1).max(255),
});

const groupListCandidates$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(integrationsAgentPhoneContract.listGroups));
  const cursor = query.cursor
    ? groupListCursorSchema.safeParse(
        safeJsonParse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      )
    : undefined;
  if (cursor && !cursor.success) {
    return badRequestMessage("Invalid group list cursor");
  }

  const db = get(db$);
  const [link] = await db
    .select({ phoneHandle: agentphoneUserLinks.phoneHandle })
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.orgId, auth.orgId),
        eq(agentphoneUserLinks.userId, auth.userId),
      ),
    )
    .limit(1);
  if (!link) {
    return notFound(
      "Connect your phone in Works before listing iMessage groups",
    );
  }

  // History grants discover candidates; only the provider's current roster
  // establishes that the connected handle still belongs to each group.
  const rows = await db
    .selectDistinctOn(
      [agentphoneMessages.groupId, agentphoneMessages.agentphoneAgentId],
      {
        groupId: agentphoneMessages.groupId,
        conversationId: agentphoneMessages.conversationId,
        agentphoneAgentId: agentphoneMessages.agentphoneAgentId,
        receivedAt: agentphoneMessages.receivedAt,
      },
    )
    .from(agentphoneMessages)
    .where(
      and(
        agentPhoneMessageVisibleTo(auth),
        eq(agentphoneMessages.channel, "imessage"),
        isNotNull(agentphoneMessages.groupId),
        isNotNull(agentphoneMessages.conversationId),
        cursor?.success
          ? or(
              gt(agentphoneMessages.groupId, cursor.data.groupId),
              and(
                eq(agentphoneMessages.groupId, cursor.data.groupId),
                gt(
                  agentphoneMessages.agentphoneAgentId,
                  cursor.data.agentphoneAgentId,
                ),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(
      asc(agentphoneMessages.groupId),
      asc(agentphoneMessages.agentphoneAgentId),
      desc(agentphoneMessages.receivedAt),
      desc(agentphoneMessages.createdAt),
      desc(agentphoneMessages.id),
    )
    .limit(query.limit + 1);

  return {
    page: rows.slice(0, query.limit),
    hasMore: rows.length > query.limit,
    phoneHandle: normalizeAgentPhoneHandle(link.phoneHandle, "imessage"),
  };
});

const listGroups$ = command(async ({ get }, signal: AbortSignal) => {
  const candidates = await get(groupListCandidates$);
  signal.throwIfAborted();
  if ("status" in candidates) {
    return candidates;
  }
  const { page, phoneHandle, hasMore } = candidates;
  const groups: AgentPhoneGroupListResponse["groups"] = [];
  for (const candidate of page) {
    if (
      !candidate.groupId ||
      !candidate.conversationId ||
      !candidate.receivedAt
    ) {
      throw new Error(
        "Archived iMessage group is missing its identity or timestamp",
      );
    }
    const result = await settle(
      getAgentPhoneGroupConversation(
        { conversationId: candidate.conversationId },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      if (isAgentPhoneApiError(result.error)) {
        if (result.error.status === 404) {
          continue;
        }
        return {
          status: 502 as const,
          body: {
            error: {
              code: "AGENTPHONE_ERROR",
              message:
                "Unable to verify iMessage group membership. Try again later.",
            },
          },
        };
      }
      throw result.error;
    }
    const conversation = result.value;
    if (
      conversation.id !== candidate.conversationId ||
      !conversation.isGroup ||
      conversation.groupId !== candidate.groupId ||
      conversation.agentId !== candidate.agentphoneAgentId ||
      !conversation.participants.some((participant) => {
        return (
          normalizeAgentPhoneHandle(participant, "imessage") ===
          normalizeAgentPhoneHandle(conversation.phoneNumber, "imessage")
        );
      }) ||
      !conversation.participants.some((participant) => {
        return (
          normalizeAgentPhoneHandle(participant, "imessage") === phoneHandle
        );
      })
    ) {
      continue;
    }
    groups.push({
      groupId: candidate.groupId,
      conversationId: candidate.conversationId,
      groupName: conversation.groupName,
      agentphoneAgentId: candidate.agentphoneAgentId,
      lastMessageAt: candidate.receivedAt.toISOString(),
    });
  }

  const last = page.at(-1);
  return {
    status: 200 as const,
    body: {
      groups,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                groupId: last.groupId,
                agentphoneAgentId: last.agentphoneAgentId,
              }),
            ).toString("base64url")
          : null,
    },
  };
});

export const integrationsAgentPhoneGroupRoutes: readonly RouteEntry[] = [
  {
    route: integrationsAgentPhoneContract.listGroups,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "phone:read",
      },
      listGroups$,
    ),
  },
];
