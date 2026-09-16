import { command } from "ccstate";
import { integrationsTelegramMessageContract } from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { snapshotIntegrationMessage$ } from "../services/integration-artifact-message.service";
import { sendMessage } from "../external/telegram-client";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../external/telegram-official";
import { telegramInstallation } from "../services/telegram-data.service";
import { telegramMessageSendFooterText } from "../services/telegram-footer.service";
import { buildTelegramResponse } from "../../lib/telegram-format";
import type { RouteEntry } from "../route-entry";

const botNotFound = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Telegram bot not found",
      code: "NOT_FOUND",
    }),
  }),
});

const sendMessageInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const orgId = auth.orgId;
  const authRunId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;

  const bodyResult = await get(
    bodyResultOf(integrationsTelegramMessageContract.sendMessage),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  let botToken: string | undefined;
  if (isOfficialTelegramBotId(body.botId)) {
    botToken = getOfficialTelegramBotConfig().botToken ?? undefined;
  } else {
    const installation = await get(
      telegramInstallation({ orgId, botId: body.botId }),
    );
    signal.throwIfAborted();
    botToken = installation?.botToken;
  }
  if (!botToken) {
    return botNotFound;
  }

  const footerText = await get(
    telegramMessageSendFooterText({
      authRunId,
      botId: body.botId,
    }),
  );
  signal.throwIfAborted();

  const outbound = integrationsTelegramMessageContract.sendMessage.body.parse({
    ...body,
    ...(await set(
      snapshotIntegrationMessage$,
      {
        content: { text: body.text },
      },
      signal,
    )),
  });
  signal.throwIfAborted();

  const text = buildTelegramResponse(outbound.text, undefined, footerText);

  const result = await sendMessage(botToken, body.chatId, text, {
    replyToMessageId: body.replyToMessageId,
    messageThreadId: body.messageThreadId,
  });
  signal.throwIfAborted();

  if (result.kind === "telegram-error") {
    const status = result.status >= 500 ? (502 as const) : (400 as const);
    const message = `Telegram API error: ${
      result.description ?? `HTTP ${result.status}`
    }`;
    return {
      status,
      body: { error: { message, code: "TELEGRAM_ERROR" } },
    };
  }

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      messageId: result.messageId,
      chatId: result.chatId,
    },
  };
});

const telegramWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "telegram:write",
} as const;

export const integrationsTelegramMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTelegramMessageContract.sendMessage,
    handler: authRoute(telegramWriteAuth, sendMessageInner$),
  },
];
