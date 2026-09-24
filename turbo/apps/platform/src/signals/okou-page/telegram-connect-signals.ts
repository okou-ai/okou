import { command, computed, state } from "ccstate";
import {
  integrationsTelegramContract,
  type TelegramLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";
import { setLoop } from "../utils.ts";
import { parseTelegramConnectParams } from "./telegram-connect-params.ts";
import {
  authorizeTelegramBot$,
  linkTelegramAccount$,
} from "./telegram-authorization.ts";

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

export const connectTelegramAccount$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const parsed = parseTelegramConnectParams(get(searchParams$));
    if (!parsed.ok) {
      return null;
    }
    const { params } = parsed;
    const result = params.connectSignature
      ? await set(
          linkTelegramAccount$,
          {
            telegramBotId: params.telegramBotId,
            connectSignature: params.connectSignature,
          },
          signal,
        )
      : await set(authorizeTelegramBot$, params.telegramBotId, signal);
    if (!result) {
      return null;
    }

    window.location.assign(
      `tg://resolve?domain=${result.botUsername.replace(/^@/, "")}`,
    );

    return result;
  },
);
