import { createHash } from "node:crypto";
import { command } from "ccstate";
import { and, desc, eq, gte, lt, ne } from "drizzle-orm";
import {
  integrationsWechatMessagesContract as contract,
  type WechatReceipt,
} from "@okouai/api-contracts/contracts/integrations-wechat-messages";
import { wechatConnections, wechatMessages } from "@okouai/db/schema/wechat";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  wechatEnabled$,
  loadWechatWorkspace$,
} from "../services/wechat-config";
import { requireWechatConnection$ } from "../services/wechat-access.service";
import { sendArchivedWechatText$ } from "../services/wechat-message-send.service";
import { integrationMessageSendLabels$ } from "../services/integration-message-context.service";
import { notFound, resourceUnavailable } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

const channels$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(wechatEnabled$, auth.orgId, auth.userId, signal))) {
    return resourceUnavailable(
      "WeChat is not available for this workspace member.",
    );
  }
  const channels = await set(writeDb$)
    .select({
      id: wechatConnections.id,
      status: wechatConnections.status,
      accountId: wechatConnections.senderId,
      workspaceId: wechatConnections.orgId,
    })
    .from(wechatConnections)
    .where(
      and(
        eq(wechatConnections.orgId, auth.orgId),
        eq(wechatConnections.userId, auth.userId),
      ),
    );
  signal.throwIfAborted();
  if (
    !channels.some((channel) => {
      return channel.status !== "disconnected";
    })
  ) {
    return { status: 200, body: { channels: [] } } as const;
  }
  const workspace = await set(loadWechatWorkspace$, auth.orgId, signal);
  if (!workspace) {
    return notFound("This workspace is unavailable.");
  }
  return {
    status: 200,
    body: {
      channels: channels.flatMap((channel) => {
        if (channel.status === "disconnected") {
          return [];
        }
        return [
          {
            id: channel.id,
            binding: {
              workspace: {
                id: channel.workspaceId,
                name: workspace.name,
              },
              accountId: channel.accountId,
            },
            status: channel.status,
            name: "Your WeChat direct conversation",
          },
        ];
      }),
    },
  } as const;
});

const history$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(contract.history));
  const access = await set(
    requireWechatConnection$,
    { ...auth, channelId: query.channelId },
    signal,
  );
  if (access.kind === "denied") {
    return access.response;
  }
  const db = set(writeDb$);
  let before: bigint | undefined;
  if (query.before !== undefined) {
    const [cursor] = await db
      .select({ sequence: wechatMessages.sequence })
      .from(wechatMessages)
      .where(
        and(
          eq(wechatMessages.id, query.before),
          eq(wechatMessages.connectionId, query.channelId),
          eq(wechatMessages.generation, access.connection.generation),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!cursor) {
      return notFound(
        "This history cursor is unavailable in the requested conversation.",
      );
    }
    before = cursor.sequence;
  }
  const rows = await db
    .select({
      id: wechatMessages.id,
      providerMessageId: wechatMessages.providerMessageId,
      direction: wechatMessages.direction,
      status: wechatMessages.status,
      content: wechatMessages.content,
      quotedText: wechatMessages.quotedText,
      attachments: wechatMessages.attachments,
      createdAt: wechatMessages.createdAt,
    })
    .from(wechatMessages)
    .innerJoin(
      wechatConnections,
      eq(wechatConnections.id, wechatMessages.connectionId),
    )
    .where(
      and(
        eq(wechatMessages.connectionId, query.channelId),
        eq(wechatMessages.generation, wechatConnections.generation),
        eq(wechatConnections.userId, auth.userId),
        eq(wechatConnections.orgId, auth.orgId),
        ne(wechatConnections.status, "disconnected"),
        before === undefined ? undefined : lt(wechatMessages.sequence, before),
        query.oldest
          ? gte(wechatMessages.createdAt, new Date(query.oldest))
          : undefined,
        query.latest
          ? lt(wechatMessages.createdAt, new Date(query.latest))
          : undefined,
      ),
    )
    .orderBy(desc(wechatMessages.sequence))
    .limit(query.limit + 1);
  signal.throwIfAborted();
  const messages = rows.slice(0, query.limit).map(({ createdAt, ...row }) => {
    return {
      ...row,
      timestamp: createdAt.toISOString(),
    };
  });
  return {
    status: 200,
    body: {
      channelId: query.channelId,
      messages,
      nextBefore: rows.length > query.limit ? messages.at(-1)!.id : null,
      historyScope: "okou_received_and_sent",
    },
  } as const;
});

const send$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const parsed = await get(bodyResultOf(contract.sendMessage));
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const body = parsed.data;
  const labels = await get(integrationMessageSendLabels$);
  signal.throwIfAborted();
  const footer = [
    labels.agentLabel ? `Sent via ${labels.agentLabel}` : undefined,
    labels.modelLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  const text = footer ? `${body.text}\n\n${footer}` : body.text;
  const requestHash = createHash("sha256").update(text).digest("hex");
  const points = Array.from(text);
  const messages: WechatReceipt[] = [];
  for (let offset = 0; offset < points.length; offset += 2000) {
    const result = await set(
      sendArchivedWechatText$,
      {
        ...auth,
        channelId: body.channelId,
        operationId: body.operationId,
        index: offset / 2000,
        text: points.slice(offset, offset + 2000).join(""),
        requestHash,
      },
      signal,
    );
    if (result.kind === "denied") {
      return {
        ...result.response,
        body: {
          error: { ...result.response.body.error, deliveredMessages: messages },
        },
      };
    }
    messages.push(result.message);
  }
  return {
    status: 200,
    body: { operationId: body.operationId, messages },
  } as const;
});

const readAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "wechat:read",
} as const;
export const integrationsWechatMessagesRoutes: readonly RouteEntry[] = [
  { route: contract.listChannels, handler: authRoute(readAuth, channels$) },
  { route: contract.history, handler: authRoute(readAuth, history$) },
  {
    route: contract.sendMessage,
    handler: authRoute(
      { ...readAuth, requiredCapability: "wechat:write" },
      send$,
    ),
  },
];
