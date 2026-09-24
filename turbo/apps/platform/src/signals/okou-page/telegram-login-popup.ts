import { i18n } from "../../i18n/index.ts";
import { createDeferredPromise, setLoop, withCleanup } from "../utils.ts";
import {
  parseTelegramPostMessage,
  type TelegramAuthResult,
} from "./telegram-auth-parser.ts";

const TELEGRAM_OAUTH_BASE_URL = "https://oauth.telegram.org/auth";
const TELEGRAM_AUTH_CALLBACK_SEGMENTS = [
  "api",
  "integrations",
  "telegram",
  "auth-callback",
] as const;

export function openTelegramLoginTab(): Window {
  // Reserve the tab during the click, before readiness checks or registration.
  // The existing callback needs opener to return the signed Telegram identity.
  const tab = window.open("about:blank", "_blank");
  if (!tab) {
    throw new Error(
      i18n.t(($) => {
        return $.connectors.connectDialog.errors.authorizationWindow;
      }),
    );
  }
  return tab;
}

export async function requestTelegramAuth(
  tab: Window,
  botId: string,
  callbackBase: string,
  signal: AbortSignal,
): Promise<TelegramAuthResult | null> {
  signal.throwIfAborted();
  if (tab.closed) {
    return null;
  }
  const callbackUrl = new URL(
    `/${TELEGRAM_AUTH_CALLBACK_SEGMENTS.join("/")}`,
    callbackBase,
  );
  callbackUrl.searchParams.set("targetOrigin", window.location.origin);

  const authUrl = new URL(TELEGRAM_OAUTH_BASE_URL);
  authUrl.searchParams.set("bot_id", botId);
  authUrl.searchParams.set("origin", window.location.origin);
  authUrl.searchParams.set("request_access", "write");
  authUrl.searchParams.set("return_to", callbackUrl.toString());

  const deferred = createDeferredPromise<TelegramAuthResult | null>(signal);
  const handleMessage = (event: MessageEvent) => {
    if (
      event.source !== tab ||
      (event.origin !== authUrl.origin &&
        event.origin !== callbackUrl.origin) ||
      deferred.settled()
    ) {
      return;
    }
    const auth = parseTelegramPostMessage(event.data);
    if (auth) {
      deferred.resolve(auth);
    }
  };

  window.addEventListener("message", handleMessage, { signal });
  tab.location.href = authUrl.toString();
  setLoop(
    () => {
      if (!deferred.settled() && tab.closed) {
        deferred.resolve(null);
      }
      return deferred.settled();
    },
    500,
    signal,
    { testIntervalMs: 10 },
  );

  return await withCleanup(deferred.promise, () => {
    window.removeEventListener("message", handleMessage);
  });
}
