import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  integrationsTelegramBotListContract,
  integrationsTelegramMessageContract,
  integrationsTelegramUploadCompleteContract,
  integrationsTelegramUploadInitContract,
  type ListTelegramBotsResponse,
  type SendTelegramMessageBody,
  type SendTelegramMessageResponse,
  type TelegramUploadCompleteBody,
  type TelegramUploadCompleteResponse,
  type TelegramUploadInitBody,
  type TelegramUploadInitResponse,
} from "@okouai/api-contracts/contracts/integrations";
import {
  ApiRequestError,
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";
import { headersWithCliClientHeaders } from "../client-headers";

interface DownloadTelegramFileResult {
  path: string;
  mimetype: string;
  size: number;
}

export async function listTelegramBots(): Promise<ListTelegramBotsResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsTelegramBotListContract, config);

  const result = await client.listBots({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list Telegram bots");
}

export async function sendTelegramMessage(
  body: SendTelegramMessageBody,
): Promise<SendTelegramMessageResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsTelegramMessageContract, config);

  const result = await client.sendMessage({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to send Telegram message");
}

export async function initTelegramFileUpload(
  body: TelegramUploadInitBody,
): Promise<TelegramUploadInitResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsTelegramUploadInitContract, config);

  const result = await client.init({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to initialize Telegram file upload");
}

export async function completeTelegramFileUpload(
  body: TelegramUploadCompleteBody,
): Promise<TelegramUploadCompleteResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsTelegramUploadCompleteContract, config);

  const result = await client.complete({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to complete Telegram file upload");
}

/**
 * Download a Telegram file to a local path, streaming the response body to disk.
 * Uses the bot token on the server side; the CLI authenticates via OKOU_TOKEN.
 */
export async function downloadTelegramFile(
  fileId: string,
  botId: string,
  outPath: string,
): Promise<DownloadTelegramFileResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const url = new URL("/api/integrations/telegram/download-file", baseUrl);
  url.searchParams.set("file_id", fileId);
  url.searchParams.set("bot_id", botId);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const response = await fetch(url, {
    headers: headersWithCliClientHeaders(headers),
  });

  if (!response.ok) {
    let message = `Failed to download Telegram file (HTTP ${response.status})`;
    let code = "UNKNOWN";
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // keep generic message when the body is not JSON
    }
    throw new ApiRequestError(message, code, response.status);
  }

  if (!response.body) {
    throw new ApiRequestError(
      "Telegram download response has no body",
      "EMPTY_BODY",
      502,
    );
  }

  const mimetype =
    response.headers.get("x-file-mimetype") ??
    response.headers.get("content-type") ??
    "application/octet-stream";

  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(outPath),
  );

  const contentLengthHeader = response.headers.get("content-length");
  const size = contentLengthHeader ? Number(contentLengthHeader) : 0;

  return { path: outPath, mimetype, size };
}
