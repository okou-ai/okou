import { command, computed } from "ccstate";
import {
  integrationsTelegramContract,
  type TelegramLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";
import { parseTelegramConnectParams } from "./telegram-connect-params.ts";
import {
  authorizeTelegramBot$,
  linkTelegramAccount$,
} from "./telegram-authorization.ts";

export const telegramConnectLinkStatus$ = computed(
  async (get): Promise<TelegramLinkStatusResponse | null> => {
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
