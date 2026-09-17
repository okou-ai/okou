import { optionalEnv } from "../../lib/env";

const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org/bot";

interface TelegramApiErrorPayload {
  readonly ok: false;
  readonly description: string;
  readonly error_code?: number;
}

function isTelegramApiErrorPayload(
  value: unknown,
): value is TelegramApiErrorPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as TelegramApiErrorPayload).ok === false
  );
}

interface TelegramApiErrorShape {
  readonly status: number;
  readonly description: string | undefined;
}

class TelegramApiError extends Error implements TelegramApiErrorShape {
  readonly status: number;
  readonly description: string | undefined;

  constructor(status: number, statusText: string, description?: string) {
    super(
      description
        ? `Telegram API error: ${status} ${description}`
        : `Telegram API error: ${status} ${statusText}`,
    );
    this.name = "TelegramApiError";
    this.status = status;
    this.description = description;
  }
}

export function isTelegramApiError(
  value: unknown,
): value is Error & TelegramApiErrorShape {
  return value instanceof TelegramApiError;
}

function resolveTelegramApiBase(): string {
  const telegramApiUrl = optionalEnv("TELEGRAM_API_URL");
  if (telegramApiUrl) {
    return telegramApiUrl;
  }

  return DEFAULT_TELEGRAM_API_BASE;
}

function buildTelegramApiUrl(token: string, method: string): string {
  return `${resolveTelegramApiBase()}${token}/${method}`;
}

function buildTelegramApiHeaders(): Record<string, string> {
  return { "Content-Type": "application/json" };
}

async function callTelegramApi<T>(
  token: string,
  method: string,
  params?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const url = buildTelegramApiUrl(token, method);
  const response = await fetch(
    `${url}${params ? `?${new URLSearchParams(params).toString()}` : ""}`,
    { signal },
  );

  const data: unknown = await response.json();

  const errorPayload = isTelegramApiErrorPayload(data) ? data : null;

  if (!response.ok || errorPayload) {
    throw new TelegramApiError(
      errorPayload?.error_code ?? response.status,
      response.statusText,
      errorPayload?.description,
    );
  }

  return data as T;
}

interface TelegramBotInfo {
  readonly id: number;
  readonly username: string;
  readonly first_name: string;
  readonly can_read_all_group_messages?: boolean;
}

export async function getMe(token: string): Promise<TelegramBotInfo> {
  const result = await callTelegramApi<{
    readonly ok: true;
    readonly result: TelegramBotInfo;
  }>(token, "getMe");
  return result.result;
}

interface TelegramFile {
  readonly file_id: string;
  readonly file_path?: string;
  readonly file_size?: number;
}

export async function getFile(
  token: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<TelegramFile> {
  const result = await callTelegramApi<{
    readonly ok: true;
    readonly result: TelegramFile;
  }>(token, "getFile", { file_id: fileId }, signal);
  return result.result;
}

export function buildFileDownloadUrl(token: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

export async function deleteWebhook(token: string): Promise<void> {
  const response = await fetch(buildTelegramApiUrl(token, "deleteWebhook"), {
    method: "POST",
    headers: buildTelegramApiHeaders(),
  });

  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }

  const data: unknown = await response.json();
  if (isTelegramApiErrorPayload(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
}

export async function setWebhook(
  token: string,
  url: string,
  secretToken: string,
): Promise<void> {
  const response = await fetch(buildTelegramApiUrl(token, "setWebhook"), {
    method: "POST",
    headers: buildTelegramApiHeaders(),
    body: JSON.stringify({
      url,
      secret_token: secretToken,
      allowed_updates: ["message"],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }

  const data: unknown = await response.json();
  if (isTelegramApiErrorPayload(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
}

export async function setMyCommands(
  token: string,
  commands: readonly {
    readonly command: string;
    readonly description: string;
  }[],
): Promise<void> {
  const response = await fetch(buildTelegramApiUrl(token, "setMyCommands"), {
    method: "POST",
    headers: buildTelegramApiHeaders(),
    body: JSON.stringify({ commands }),
  });

  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }

  const data: unknown = await response.json();
  if (isTelegramApiErrorPayload(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
}

export interface TelegramUserProfilePhoto {
  readonly file_id: string;
  readonly file_unique_id?: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

export async function getUserProfilePhotos(
  token: string,
  userId: string | number,
  limit: number,
): Promise<readonly (readonly TelegramUserProfilePhoto[])[]> {
  const result = await callTelegramApi<{
    readonly ok: true;
    readonly result: {
      readonly total_count: number;
      readonly photos: readonly (readonly TelegramUserProfilePhoto[])[];
    };
  }>(token, "getUserProfilePhotos", {
    user_id: String(userId),
    limit: String(limit),
  });
  return result.result.photos;
}

/**
 * Send a chat action (e.g. typing indicator) to a Telegram chat.
 *
 * Uses POST with a JSON body to match how the Telegram Bot API is invoked
 * for state-changing methods. Response failures throw — callers that want
 * best-effort behaviour wrap the call themselves.
 */
export async function sendChatAction(
  token: string,
  chatId: string,
  action: string,
): Promise<void> {
  const response = await fetch(buildTelegramApiUrl(token, "sendChatAction"), {
    method: "POST",
    headers: buildTelegramApiHeaders(),
    body: JSON.stringify({ chat_id: chatId, action }),
  });
  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }
  const data: unknown = await response.json();
  if (isTelegramApiErrorPayload(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
}

/**
 * Delete a Telegram message.
 *
 * Response failures throw; callers that want best-effort cleanup should use
 * settle around this function.
 */
export async function deleteMessage(
  token: string,
  chatId: string,
  messageId: number,
): Promise<void> {
  const response = await fetch(buildTelegramApiUrl(token, "deleteMessage"), {
    method: "POST",
    headers: buildTelegramApiHeaders(),
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  if (!response.ok) {
    throw new Error(
      `Telegram API error: ${response.status} ${response.statusText}`,
    );
  }
  const data: unknown = await response.json();
  if (isTelegramApiErrorPayload(data)) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
}

export type SendTelegramMessageResult =
  | {
      readonly kind: "ok";
      readonly messageId: number;
      readonly chatId: string;
    }
  | {
      readonly kind: "telegram-error";
      readonly status: number;
      readonly description: string | undefined;
    };

export interface TelegramReplyMarkup {
  readonly inline_keyboard: readonly (readonly {
    readonly text: string;
    readonly url: string;
  }[])[];
}

interface TelegramSentMessage {
  readonly message_id: number;
  readonly chat: { readonly id: number };
}

/**
 * Send a Telegram message using the bot API and surface upstream HTTP status
 * via a result-union. Callers map status >= 500 to 502 and status < 500 to 400
 * (Telegram client error). No exceptions are thrown for HTTP failures so
 * handlers can stay free of try/catch (per project policy).
 */
export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
  options: {
    readonly replyToMessageId?: number;
    readonly messageThreadId?: number;
    readonly replyMarkup?: TelegramReplyMarkup;
  } = {},
): Promise<SendTelegramMessageResult> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (options.replyToMessageId !== undefined) {
    payload.reply_parameters = { message_id: options.replyToMessageId };
  }
  if (options.messageThreadId !== undefined) {
    payload.message_thread_id = options.messageThreadId;
  }
  if (options.replyMarkup !== undefined) {
    payload.reply_markup = options.replyMarkup;
  }

  const response = await fetch(buildTelegramApiUrl(token, "sendMessage"), {
    method: "POST",
    headers: buildTelegramApiHeaders(),
    body: JSON.stringify(payload),
  });

  const data: unknown = await response.json();

  if (!response.ok) {
    const description =
      data && typeof data === "object" && "description" in data
        ? typeof (data as { description: unknown }).description === "string"
          ? ((data as { description: string }).description as string)
          : undefined
        : undefined;
    return {
      kind: "telegram-error",
      status: response.status,
      description,
    };
  }

  if (isTelegramApiErrorPayload(data)) {
    return {
      kind: "telegram-error",
      status: response.status,
      description: data.description,
    };
  }

  const success = data as {
    readonly ok: true;
    readonly result: TelegramSentMessage;
  };
  return {
    kind: "ok",
    messageId: success.result.message_id,
    chatId: String(success.result.chat.id),
  };
}

export interface TelegramDocument {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
}

interface TelegramSentDocumentMessage {
  readonly message_id: number;
  readonly chat: { readonly id: number };
  readonly document?: TelegramDocument;
}

export type SendTelegramDocumentResult =
  | {
      readonly kind: "ok";
      readonly messageId: number;
      readonly chatId: string;
      readonly document: TelegramDocument | undefined;
    }
  | {
      readonly kind: "telegram-error";
      readonly status: number;
      readonly description: string | undefined;
    };

/**
 * Send a Telegram document using the bot API and surface upstream HTTP status
 * via a result-union. Callers map status >= 500 to 502 and status < 500 to 400
 * (Telegram client error). No exceptions are thrown for HTTP failures so
 * handlers can stay free of try/catch (per project policy).
 */
export async function sendDocument(
  token: string,
  chatId: string,
  document: string,
  options: {
    readonly caption?: string;
    readonly messageThreadId?: number;
  } = {},
): Promise<SendTelegramDocumentResult> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    document,
  };
  if (options.caption !== undefined) {
    payload.caption = options.caption;
  }
  if (options.messageThreadId !== undefined) {
    payload.message_thread_id = options.messageThreadId;
  }

  const response = await fetch(buildTelegramApiUrl(token, "sendDocument"), {
    method: "POST",
    headers: buildTelegramApiHeaders(),
    body: JSON.stringify(payload),
  });

  const data: unknown = await response.json();

  if (!response.ok) {
    const description =
      data && typeof data === "object" && "description" in data
        ? typeof (data as { description: unknown }).description === "string"
          ? ((data as { description: string }).description as string)
          : undefined
        : undefined;
    return {
      kind: "telegram-error",
      status: response.status,
      description,
    };
  }

  if (isTelegramApiErrorPayload(data)) {
    return {
      kind: "telegram-error",
      status: response.status,
      description: data.description,
    };
  }

  const success = data as {
    readonly ok: true;
    readonly result: TelegramSentDocumentMessage;
  };
  return {
    kind: "ok",
    messageId: success.result.message_id,
    chatId: String(success.result.chat.id),
    document: success.result.document,
  };
}
