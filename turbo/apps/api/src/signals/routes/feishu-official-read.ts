import { command, computed } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { array, boolean, number, object, string } from "zod";
import { feishuOfficialReadContract } from "@okouai/api-contracts/contracts/feishu-official-read";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { notFound, resourceUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import {
  FeishuApiError,
  feishuMessageHistoryUrl,
  parseFeishuMessageHistoryResponse,
  resolveFeishuRequestCredentials$,
  feishuTokenUpdateValues,
  readFeishuResponseJson,
} from "../external/feishu-client";
import type { RouteEntry } from "../route-entry";
import { buildFeishuChatOpenUrl } from "../services/feishu-config";
import { feishuConnectStatus } from "../services/feishu-connect.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import {
  FeishuConversationAccessDeniedError,
  requireFeishuConversationAccess$,
} from "../services/feishu-conversation-access.service";
import { settle } from "../utils";

const pageSchema = object({
  code: number(),
  msg: string().optional(),
  data: object({ has_more: boolean(), page_token: string().optional() }),
});
const chatsSchema = object({
  data: object({
    items: array(object({ chat_id: string(), name: string() })).default([]),
  }),
});
const installation$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (
    !isFeatureEnabled(
      FeatureSwitchKey.FeishuOfficialBot,
      await get(userFeatureSwitchContext(auth.orgId, auth.userId)),
    )
  ) {
    return resourceUnavailable("Okou Official Feishu bot is not enabled");
  }
  const status = await get(
    feishuConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: false,
      installationType: "official",
    }),
  );
  if (!status.isConnected) {
    return notFound(
      "Connect your Feishu account to Okou Official in Settings > Feishu before reading group chats.",
    );
  }
  const [installation] = await get(db$)
    .select()
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.orgId, auth.orgId),
        eq(feishuOrgInstallations.installationType, "official"),
        eq(feishuOrgInstallations.platform, "feishu"),
        isNotNull(feishuOrgInstallations.setupCompletedAt),
      ),
    )
    .limit(1);
  return installation ?? notFound("Okou Official Feishu bot is unavailable");
});
const credentials$ = command(async ({ get, set }, signal: AbortSignal) => {
  const installation = await get(installation$);
  signal.throwIfAborted();
  if ("status" in installation) {
    return installation;
  }
  const credentials = await set(
    resolveFeishuRequestCredentials$,
    installation,
    signal,
  );
  if (credentials.refreshedToken) {
    await set(writeDb$)
      .update(feishuOrgInstallations)
      .set(feishuTokenUpdateValues(credentials.refreshedToken))
      .where(eq(feishuOrgInstallations.id, installation.id));
    signal.throwIfAborted();
  }
  return { installationId: installation.id, token: credentials.context.token };
});
function readError(error: unknown) {
  if (!(error instanceof FeishuApiError)) {
    throw error;
  }
  return {
    status: error.routeStatus,
    body: { error: { code: "FEISHU_ERROR", message: error.message } },
  };
}
const listChats$ = command(async ({ get, set }, signal: AbortSignal) => {
  const credentials = await set(credentials$, signal);
  if ("status" in credentials) {
    return credentials;
  }
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(feishuOfficialReadContract.listChats));
  const url = new URL("https://open.feishu.cn/open-apis/im/v1/chats");
  url.searchParams.set("page_size", String(query.limit));
  if (query.cursor) {
    url.searchParams.set("page_token", query.cursor);
  }
  const body = await readFeishuResponseJson(
    fetch(url, {
      headers: { authorization: `Bearer ${credentials.token}` },
      signal,
    }),
    "Feishu",
  );
  signal.throwIfAborted();
  const response = object({ code: number() }).parse(body);
  if (response.code !== 0) {
    return readError(
      new FeishuApiError(
        "Could not list Feishu group chats. Check the Official bot's permissions.",
        403,
      ),
    );
  }
  const page = pageSchema.parse(body);
  const candidates = chatsSchema.parse(body).data.items;
  const chats: { id: string; name: string; chatUrl: string }[] = [];
  for (const chat of candidates) {
    const access = await settle(
      set(
        requireFeishuConversationAccess$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          installationId: credentials.installationId,
          chat: chat.chat_id,
          write: false,
        },
        signal,
      ),
      signal,
    );
    if (!access.ok) {
      if (access.error instanceof FeishuConversationAccessDeniedError) {
        continue;
      }
      return readError(access.error);
    }
    chats.push({
      id: chat.chat_id,
      name: chat.name,
      chatUrl: buildFeishuChatOpenUrl(chat.chat_id),
    });
  }
  return {
    status: 200 as const,
    body: {
      installationId: credentials.installationId,
      chats,
      hasMore: page.data.has_more,
      nextCursor: page.data.page_token || null,
    },
  };
});
const history$ = command(async ({ get, set }, signal: AbortSignal) => {
  const credentials = await set(credentials$, signal);
  if ("status" in credentials) {
    return credentials;
  }
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(feishuOfficialReadContract.history));
  const access = await settle(
    set(
      requireFeishuConversationAccess$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        installationId: credentials.installationId,
        chat: query.chat,
        write: false,
      },
      signal,
    ),
    signal,
  );
  if (!access.ok) {
    return readError(access.error);
  }
  const url = feishuMessageHistoryUrl("https://open.feishu.cn", {
    containerType: "chat",
    containerId: query.chat,
    pageSize: query.limit,
  });
  if (query.cursor) {
    url.searchParams.set("page_token", query.cursor);
  }
  if (query.startTime) {
    url.searchParams.set("start_time", query.startTime);
  }
  if (query.endTime) {
    url.searchParams.set("end_time", query.endTime);
  }
  const requested = await settle(
    readFeishuResponseJson(
      fetch(url, {
        headers: { authorization: `Bearer ${credentials.token}` },
        signal,
      }),
      "Feishu",
    ),
    signal,
  );
  if (!requested.ok) {
    return readError(requested.error);
  }
  const messages = parseFeishuMessageHistoryResponse(requested.value, "Feishu");
  const page = pageSchema.parse(requested.value);
  return {
    status: 200 as const,
    body: {
      installationId: credentials.installationId,
      chat: query.chat,
      chatUrl: buildFeishuChatOpenUrl(query.chat),
      messages: [...messages],
      hasMore: page.data.has_more,
      nextCursor: page.data.page_token || null,
    },
  };
});
const readAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "feishu:read",
} as const;
export const feishuOfficialReadRoutes: readonly RouteEntry[] = [
  {
    route: feishuOfficialReadContract.listChats,
    handler: authRoute(readAuth, listChats$),
  },
  {
    route: feishuOfficialReadContract.history,
    handler: authRoute(readAuth, history$),
  },
];
