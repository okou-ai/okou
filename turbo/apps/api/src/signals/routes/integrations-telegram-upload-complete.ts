import { command, computed, type Computed } from "ccstate";
import {
  integrationsTelegramUploadCompleteContract,
  type TelegramUploadCompleteBody,
} from "@okouai/api-contracts/contracts/integrations";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  sendDocument,
  type SendTelegramDocumentResult,
} from "../external/telegram-client";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../external/telegram-official";
import {
  materializeUploadedArtifact$,
  uploadedArtifactFetchUrl,
} from "../services/uploaded-artifact.service";
import { recordTelegramUploadedFile$ } from "../services/run-uploaded-files.service";
import { telegramInstallation } from "../services/telegram-data.service";
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

const uploadedFileNotFound = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Uploaded file not found",
      code: "NOT_FOUND",
    }),
  }),
});

const organizationContextRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Organization context is required",
      code: "FORBIDDEN",
    }),
  }),
});

function buildMetadata(args: {
  readonly body: TelegramUploadCompleteBody;
  readonly s3Key: string;
  readonly sourceUrl: string;
  readonly telegramMessageId: number;
  readonly telegramFileId: string | undefined;
}): Record<string, unknown> {
  const { body, s3Key, sourceUrl, telegramMessageId, telegramFileId } = args;
  return {
    botId: body.botId,
    chatId: body.chatId,
    uploadId: body.uploadId,
    s3Key,
    sourceUrl,
    ...(body.caption ? { caption: body.caption } : {}),
    ...(body.messageThreadId ? { messageThreadId: body.messageThreadId } : {}),
    telegramMessage: {
      id: telegramMessageId,
      ...(telegramFileId ? { fileId: telegramFileId } : {}),
    },
  };
}

function resolveBotToken(args: {
  readonly orgId: string;
  readonly botId: string;
}): Computed<Promise<string | undefined>> {
  return computed(async (get): Promise<string | undefined> => {
    if (isOfficialTelegramBotId(args.botId)) {
      return getOfficialTelegramBotConfig().botToken ?? undefined;
    }
    const installation = await get(telegramInstallation(args));
    return installation?.botToken;
  });
}

function telegramErrorResponse(
  result: Extract<SendTelegramDocumentResult, { kind: "telegram-error" }>,
) {
  const status = result.status >= 500 ? (502 as const) : (400 as const);
  const message = `Telegram API error: ${
    result.description ?? `HTTP ${result.status}`
  }`;
  return {
    status,
    body: { error: { message, code: "TELEGRAM_ERROR" } },
  };
}

const completeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return organizationContextRequired;
  }
  const orgId = auth.orgId;
  const userId = auth.userId;
  const runId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;

  const bodyResult = await get(
    bodyResultOf(integrationsTelegramUploadCompleteContract.complete),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const botToken = await get(resolveBotToken({ orgId, botId: body.botId }));
  signal.throwIfAborted();
  if (!botToken) {
    return botNotFound;
  }

  const s3Object = await set(
    materializeUploadedArtifact$,
    { userId, orgId, id: body.uploadId },
    signal,
  );
  if (!s3Object) {
    return uploadedFileNotFound;
  }
  const filename = s3Object.filename;
  const fileUrl = s3Object.url;

  const fetchUrl = await get(uploadedArtifactFetchUrl(s3Object));
  signal.throwIfAborted();
  const result = await sendDocument(botToken, body.chatId, fetchUrl, {
    caption: body.caption,
    messageThreadId: body.messageThreadId,
  });
  signal.throwIfAborted();
  if (result.kind === "telegram-error") {
    return telegramErrorResponse(result);
  }

  const document = result.document;
  const mimetype =
    document?.mime_type ?? body.contentType ?? s3Object.contentType;
  const size = document?.file_size ?? s3Object.size;
  const fileId = document?.file_id;
  const responseFilename = document?.file_name ?? filename;
  const externalId = fileId ?? `${body.chatId}:${result.messageId}`;

  await set(
    recordTelegramUploadedFile$,
    {
      runId,
      externalId,
      userId,
      orgId,
      filename: responseFilename,
      contentType: mimetype,
      sizeBytes: size,
      url: fileUrl,
      publicBrand: s3Object.publicBrand,
      metadata: buildMetadata({
        body,
        s3Key: s3Object.key,
        sourceUrl: fileUrl,
        telegramMessageId: result.messageId,
        telegramFileId: fileId,
      }),
    },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      messageId: result.messageId,
      chatId: result.chatId,
      fileId,
      filename: responseFilename,
      mimetype,
      size,
      url: fileUrl,
    },
  };
});

const telegramWriteAuth = {
  requiredCapability: "telegram:write",
} as const;

export const integrationsTelegramUploadCompleteRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTelegramUploadCompleteContract.complete,
    handler: authRoute(telegramWriteAuth, completeInner$),
  },
];
