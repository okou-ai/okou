import { command, computed, state } from "ccstate";
import {
  integrationsTelegramContract,
  type TelegramLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { accept } from "../../lib/accept.ts";
import { capturePlausibleEvent } from "../../lib/plausible.ts";
import { apiClient$ } from "../api-client.ts";
import { oauthBaseForNavigation$ } from "../fetch.ts";
import { searchParams$ } from "../route.ts";
import { createDeferredPromise, setLoop } from "../utils.ts";
import {
  parseTelegramPostMessage,
  type TelegramAuthResult,
} from "./telegram-auth-parser.ts";
import { parseTelegramConnectParams } from "./telegram-connect-params.ts";
import { openTelegramLoginPopup } from "./telegram-login-popup.ts";

const internalTelegramConnectLinkStatusReload$ = state(0);

export const telegramConnectLinkStatus$ = computed(
  async (get): Promise<TelegramLinkStatusResponse | null> => {
    get(internalTelegramConnectLinkStatusReload$);
    const parsed = parseTelegramConnectParams(get(searchParams$));
    if (!parsed.ok) {
      return null;
    }

    const client = get(apiClient$)(integrationsTelegramContract);
    const result = await accept(
      client.getLinkStatus({
        headers: {},
        query: {
          botId: parsed.params.telegramBotId,
          origin: location.origin,
        },
      }),
      [200],
    );

    return result.body;
  },
);

const reloadTelegramConnectLinkStatus$ = command(({ set }) => {
  set(internalTelegramConnectLinkStatusReload$, (prev) => {
    return prev + 1;
  });
});

export const pollTelegramConnectDomainStatus$ = command(
  ({ get, set }, signal: AbortSignal) => {
    const parsed = parseTelegramConnectParams(get(searchParams$));
    if (!parsed.ok || parsed.params.connectSignature) {
      return;
    }

    let first = true;
    setLoop(
      async (loopSignal) => {
        if (first) {
          first = false;
        } else {
          set(reloadTelegramConnectLinkStatus$);
        }

        const status = await get(telegramConnectLinkStatus$);
        loopSignal.throwIfAborted();
        return (
          status === null ||
          status.linked ||
          status.installation?.domainConfigured !== false
        );
      },
      3000,
      signal,
    );
  },
);

function requestTelegramAuth(
  telegramBotId: string,
  apiBase: string,
  signal: AbortSignal,
): Promise<TelegramAuthResult> {
  signal.throwIfAborted();
  openTelegramLoginPopup(telegramBotId, apiBase);

  const deferred = createDeferredPromise<TelegramAuthResult>(signal);
  const cleanup = () => {
    window.removeEventListener("message", handleMessage);
    signal.removeEventListener("abort", cleanup);
  };
  const handleMessage = (event: MessageEvent) => {
    const auth = parseTelegramPostMessage(event.data);
    if (!auth || deferred.settled()) {
      return;
    }
    cleanup();
    deferred.resolve(auth);
  };

  window.addEventListener("message", handleMessage, { signal });
  signal.addEventListener("abort", cleanup, { once: true });
  return deferred.promise;
}

export const connectTelegramAccount$ = command(
  async ({ get }, signal: AbortSignal) => {
    const parsed = parseTelegramConnectParams(get(searchParams$));
    if (!parsed.ok) {
      return null;
    }
    const { params } = parsed;
    const client = get(apiClient$)(integrationsTelegramContract);
    const linkCredential = params.connectSignature
      ? { connectSignature: params.connectSignature }
      : await (async () => {
          const linkStatus = await get(telegramConnectLinkStatus$);
          signal.throwIfAborted();
          const telegramLoginBotId =
            linkStatus?.linked === false
              ? linkStatus.installation?.loginBotId
              : undefined;
          const oauthBase = await get(oauthBaseForNavigation$);
          signal.throwIfAborted();
          const telegramAuth = await requestTelegramAuth(
            telegramLoginBotId ?? params.telegramBotId,
            oauthBase,
            signal,
          );
          signal.throwIfAborted();
          return { telegramAuth };
        })();

    const result = await accept(
      client.link({
        headers: {},
        fetchOptions: { signal },
        body: {
          telegramBotId: params.telegramBotId,
          ...linkCredential,
        },
      }),
      [200],
    );
    signal.throwIfAborted();

    capturePlausibleEvent("telegram_connect", {
      props: {
        method: params.connectSignature
          ? "connect_signature"
          : "telegram_login",
      },
    });

    window.location.assign(
      `tg://resolve?domain=${result.body.botUsername.replace(/^@/, "")}`,
    );

    return result.body;
  },
);
