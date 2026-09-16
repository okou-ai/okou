import { feishuRequestPlatform$ } from "../context/feishu-platform";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  integrationsFeishuMessageContract,
  integrationsLarkMessageContract,
} from "@okouai/api-contracts/contracts/integrations";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { snapshotIntegrationMessage$ } from "../services/integration-artifact-message.service";
import {
  FeishuApiError,
  replyWithFeishuMessage,
  sendFeishuMessage,
  type FeishuOutboundMessage,
} from "../external/feishu-client";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";

function apiError(
  status: 400 | 403 | 404 | 502,
  code: "BAD_REQUEST" | "FEISHU_ERROR" | "NOT_FOUND",
  message: string,
) {
  return {
    status,
    body: { error: { code, message } },
  } as const;
}

async function resolveFeishuMessageUser(
  args: {
    readonly db: Db;
    readonly installationId: string;
    readonly userId: string;
    readonly user: string | undefined;
    readonly platformName: string;
  },
  signal: AbortSignal,
) {
  if (args.user !== "me") {
    return args.user;
  }
  const [connection] = await args.db
    .select({ openId: feishuOrgConnections.feishuOpenId })
    .from(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.installationId, args.installationId),
        eq(feishuOrgConnections.userId, args.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return (
    connection?.openId ??
    apiError(
      404,
      "NOT_FOUND",
      `No ${args.platformName} connection found for the current user`,
    )
  );
}

const sendMessage$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsFeishuMessageContract.sendMessage),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;
  const platformName = FEISHU_PLATFORMS[get(feishuRequestPlatform$)].name;
  const db = set(writeDb$);
  const installations = await db
    .select({ id: feishuOrgInstallations.id })
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.orgId, auth.orgId),
        eq(feishuOrgInstallations.platform, get(feishuRequestPlatform$)),
        isNotNull(feishuOrgInstallations.setupCompletedAt),
        ...(body.installationId
          ? [eq(feishuOrgInstallations.id, body.installationId)]
          : []),
      ),
    )
    .limit(2);
  signal.throwIfAborted();
  const installation = installations[0];
  if (!installation) {
    return apiError(
      404,
      "NOT_FOUND",
      body.installationId
        ? `${platformName} installation not found`
        : `No ${platformName} installation found for this organization`,
    );
  }
  if (!body.installationId && installations.length > 1) {
    return apiError(
      400,
      "BAD_REQUEST",
      `Multiple ${platformName} installations are available. Specify installationId.`,
    );
  }

  const userOpenId = await resolveFeishuMessageUser(
    {
      db,
      installationId: installation.id,
      userId: auth.userId,
      user: body.user,
      platformName,
    },
    signal,
  );
  if (typeof userOpenId === "object") {
    return userOpenId;
  }

  const outbound = integrationsFeishuMessageContract.sendMessage.body.parse({
    ...body,
    ...(await set(
      snapshotIntegrationMessage$,
      {
        content: { text: body.text, card: body.card },
      },
      signal,
    )),
  });
  signal.throwIfAborted();

  const message: FeishuOutboundMessage = outbound.card
    ? { msgType: "interactive", content: outbound.card }
    : { msgType: "text", content: { text: outbound.text } };
  const receiveId = userOpenId ?? body.chat;
  let delivery: ReturnType<typeof sendFeishuMessage>;
  if (body.replyToMessageId) {
    delivery = replyWithFeishuMessage(
      {
        db,
        installationId: installation.id,
        messageId: body.replyToMessageId,
        message,
        replyInThread: body.replyInThread,
      },
      signal,
    );
  } else if (receiveId) {
    delivery = sendFeishuMessage(
      {
        db,
        installationId: installation.id,
        receiveIdType: userOpenId ? "open_id" : "chat_id",
        receiveId,
        message,
      },
      signal,
    );
  } else {
    return apiError(
      400,
      "BAD_REQUEST",
      `A ${platformName} message target is required`,
    );
  }
  const sent = await settle(delivery, signal);
  if (!sent.ok) {
    if (sent.error instanceof FeishuApiError) {
      return apiError(
        sent.error.routeStatus,
        "FEISHU_ERROR",
        `${platformName} API error: ${sent.error.message}`,
      );
    }
    throw sent.error;
  }
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      messageId: sent.value.messageId,
      chatId: sent.value.chatId,
    },
  };
});

export const integrationsFeishuMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsFeishuMessageContract.sendMessage,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "feishu:write",
      },
      sendMessage$,
    ),
  },
  {
    route: integrationsLarkMessageContract.sendMessage,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "lark:write",
      },
      sendMessage$,
    ),
  },
];
