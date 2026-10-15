import { jsonParseOr } from "../utils.ts";

export interface TelegramAuthResult {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

function telegramMessage(data: unknown): Record<string, unknown> | null {
  let raw = data;
  // Telegram's native channel can encode its message as JSON. Bound decoding
  // of untrusted input; explicit protocol fields must never downgrade to v1.
  for (let depth = 0; depth < 2 && typeof raw === "string"; depth++) {
    raw = jsonParseOr<unknown>(raw, null);
  }
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function parseTelegramIdentity(data: unknown): TelegramAuthResult | null {
  const value =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (!value) {
    return null;
  }
  if (
    (typeof value.id !== "string" && typeof value.id !== "number") ||
    (typeof value.auth_date !== "string" && typeof value.auth_date !== "number")
  ) {
    return null;
  }
  const id = Number(value.id);
  const authDate = Number(value.auth_date);
  if (
    !/^[1-9]\d*$/.test(String(value.id)) ||
    !Number.isSafeInteger(id) ||
    !/^[1-9]\d*$/.test(String(value.auth_date)) ||
    !Number.isSafeInteger(authDate) ||
    typeof value.hash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.hash)
  ) {
    return null;
  }
  const optional = [
    "first_name",
    "last_name",
    "username",
    "photo_url",
  ] as const;
  if (
    optional.some((key) => {
      return value[key] !== undefined && typeof value[key] !== "string";
    })
  ) {
    return null;
  }
  return {
    id,
    auth_date: authDate,
    hash: value.hash,
    ...Object.fromEntries(
      optional
        .filter((key) => {
          return value[key] !== undefined;
        })
        .map((key) => {
          return [key, value[key]];
        }),
    ),
  };
}

interface TelegramDeliveryContext {
  callbackOrigin: string;
  nativeOrigin: string;
  operationId: string;
  bot: string;
  protocol2: boolean;
}

type TelegramDelivery =
  | { kind: "ready" | "result-ack" }
  | { kind: "v2-identity" | "legacy-identity"; auth: TelegramAuthResult }
  | { kind: "native-identity"; auth: TelegramAuthResult | null };

function parseV2Delivery(
  message: Record<string, unknown>,
  origin: string,
  context: TelegramDeliveryContext,
): TelegramDelivery | null {
  if (
    !context.protocol2 ||
    origin !== context.callbackOrigin ||
    message.protocol !== 2 ||
    message.operationId !== context.operationId ||
    message.bot !== context.bot
  ) {
    return null;
  }
  if (message.type === "telegram-auth-bridge-ready") {
    return { kind: "ready" };
  }
  if (message.type === "telegram-auth-ack" && message.stage === "result") {
    return { kind: "result-ack" };
  }
  if (message.type === "telegram-auth") {
    const auth = parseTelegramIdentity(message.data);
    return auth ? { kind: "v2-identity", auth } : null;
  }
  return null;
}

/** The caller first pins event.source to the operation's captured WindowProxy. */
export function parseTelegramDelivery(
  event: MessageEvent,
  context: TelegramDeliveryContext,
): TelegramDelivery | null {
  const message = telegramMessage(event.data);
  if (!message) {
    return null;
  }
  if ("protocol" in message || "operationId" in message || "bot" in message) {
    return parseV2Delivery(message, event.origin, context);
  }
  // New App can reach legacy readiness/callbacks during propagation or rollback.
  // Remove this branch only after those APIs are neither serving nor retained
  // for rollback; owning follow-up: #40196. Native Telegram cannot echo an
  // operation, so its exact window/origin and owner lifetime remain mandatory.
  if (
    event.origin === context.callbackOrigin &&
    message.type === "telegram-auth"
  ) {
    const auth = parseTelegramIdentity(message.data);
    return auth ? { kind: "legacy-identity", auth } : null;
  }
  if (
    event.origin === context.nativeOrigin &&
    message.event === "auth_result"
  ) {
    const auth = parseTelegramIdentity(message.result);
    return auth || message.result === false
      ? { kind: "native-identity", auth }
      : null;
  }
  return null;
}
