import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { now } from "../../lib/time.ts";
import { createDeferredPromise, setLoop } from "../utils.ts";
import {
  parseTelegramDelivery,
  type TelegramAuthResult,
} from "./telegram-auth-parser.ts";

const TELEGRAM_OAUTH_BASE_URL = "https://oauth.telegram.org/auth";
type TelegramAuthOutcome = "linked" | "cancelled";

export function openTelegramLoginTab(): Window {
  const tab = window.open("about:blank", "_blank");
  if (!tab) {
    const message = i18n.t(($) => {
      return $.connectors.connectDialog.errors.authorizationWindow;
    });
    toast.error(message);
    throw new Error(message);
  }
  return tab;
}

interface TelegramLoginOptions {
  tab: Window;
  loginBotId: string;
  bot: string;
  callbackBase: string;
}

function telegramAuthUrls(options: TelegramLoginOptions, operationId: string) {
  const callbackUrl = new URL(
    "/api/integrations/telegram/auth-callback",
    options.callbackBase,
  );
  callbackUrl.searchParams.set("targetOrigin", window.location.origin);
  callbackUrl.searchParams.set("callbackProtocol", "2");
  callbackUrl.searchParams.set("operationId", operationId);
  callbackUrl.searchParams.set("bot", options.bot);
  const authUrl = new URL(TELEGRAM_OAUTH_BASE_URL);
  authUrl.searchParams.set("bot_id", options.loginBotId);
  authUrl.searchParams.set("origin", window.location.origin);
  authUrl.searchParams.set("request_access", "write");
  authUrl.searchParams.set("return_to", callbackUrl.toString());
  return { callbackUrl, authUrl };
}

function watchTelegramTab(
  {
    tab,
    expiresAt,
    isDisposed,
    interrupt,
    deliver,
  }: {
    tab: Window;
    expiresAt: number;
    isDisposed: () => boolean;
    interrupt: () => void;
    deliver: () => void;
  },
  signal: AbortSignal,
) {
  setLoop(
    () => {
      if (isDisposed()) {
        return true;
      }
      if (tab.closed || now() >= expiresAt) {
        interrupt();
        return true;
      }
      deliver();
      return false;
    },
    500,
    signal,
    { testIntervalMs: 10 },
  );
}

function telegramSender(
  tab: Window,
  origin: string,
  operationId: string,
  bot: string,
) {
  return (type: string, extra: Record<string, string> = {}) => {
    if (!tab.closed) {
      tab.postMessage(
        { type, protocol: 2, operationId, bot, ...extra },
        origin,
      );
    }
  };
}

/** One captured WindowProxy, through identity, binding and terminal delivery. */
export function requestTelegramAuth(
  options: TelegramLoginOptions,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { tab, bot } = options;
  const operationId = crypto.randomUUID();
  const { callbackUrl, authUrl } = telegramAuthUrls(options, operationId);
  const identity = createDeferredPromise<TelegramAuthResult | null>(signal);
  const completed = createDeferredPromise<void>(signal);
  const expiresAt = now() + 120_000;
  let ready = false;
  let callbackIdentity = false;
  let terminal: TelegramAuthOutcome | null = null;
  let disposed = false;
  const send = telegramSender(tab, callbackUrl.origin, operationId, bot);
  const dispose = () => {
    disposed = true;
    window.removeEventListener("message", receive);
    signal.removeEventListener("abort", interrupt);
    if (!identity.settled()) {
      identity.resolve(null);
    }
    if (!completed.settled()) {
      completed.resolve();
    }
  };
  const deliver = () => {
    if (ready) {
      if (terminal) {
        send("telegram-auth-result", { status: terminal });
      } else if (!callbackIdentity) {
        send("telegram-auth-ready");
      }
    }
  };
  const interrupt = () => {
    // Aborting transport cannot establish whether an in-flight POST committed.
    if (ready && !callbackIdentity) {
      send("telegram-auth-result", { status: "interrupted" });
    }
    dispose();
  };
  function receive(event: MessageEvent) {
    if (disposed || event.source !== tab) {
      return;
    }
    if (now() >= expiresAt) {
      interrupt();
      return;
    }
    const message = parseTelegramDelivery(event, {
      callbackOrigin: callbackUrl.origin,
      nativeOrigin: authUrl.origin,
      operationId,
      bot,
    });
    if (!message) {
      return;
    }
    if (message.kind === "ready") {
      if (!ready) {
        ready = true;
        deliver();
      } else if (terminal) {
        send("telegram-auth-result", { status: terminal });
      }
      // The callback echoes bridge-ready when it receives ready. Retries
      // belong to the bounded loop, never to that echoed message.
    } else if (message.kind === "v2-identity" && ready) {
      callbackIdentity = true;
      send("telegram-auth-ack", { stage: "identity" });
      if (!identity.settled()) {
        identity.resolve(message.auth);
      }
      if (terminal) {
        deliver();
      }
    } else if (message.kind === "result-ack" && terminal) {
      dispose();
    } else if (message.kind === "native-identity") {
      if (!identity.settled()) {
        identity.resolve(message.auth);
      }
    }
  }

  window.addEventListener("message", receive);
  signal.addEventListener("abort", interrupt, { once: true });
  tab.location.href = authUrl.toString();
  watchTelegramTab(
    {
      tab,
      expiresAt,
      isDisposed: () => {
        return disposed;
      },
      interrupt,
      deliver,
    },
    signal,
  );

  return {
    identity: identity.promise,
    finish: async (status: TelegramAuthOutcome) => {
      if (disposed) {
        return;
      }
      terminal = status;
      if (tab.closed) {
        dispose();
      } else {
        deliver();
      }
      await completed.promise;
    },
    dispose,
  };
}
