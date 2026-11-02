import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { integrationsTelegramContract } from "@okouai/api-contracts/client/integrations-telegram";
import type { TelegramBot } from "@okouai/api-contracts/contracts/integrations-telegram";
import { apiClient$ } from "../api-client.ts";
import { telegramClient$ } from "./telegram-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { i18n } from "../../i18n/index.ts";

const internalReload$ = state(0);

export const telegramBots$ = computed(async (get): Promise<TelegramBot[]> => {
  get(internalReload$);
  const owner = await get(telegramClient$);
  const result = await accept(owner.client.list({ headers: {} }), [200]);
  owner.assertCurrent();
  return result.body.bots;
});

export const reloadTelegramBots$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

const onTelegramChanged$ = command(({ set }) => {
  set(reloadTelegramBots$);
  return false;
});

export const watchTelegramConnection$ = command(
  ({ set }, signal: AbortSignal) => {
    const refresh = () => {
      if (!document.hidden) {
        set(reloadTelegramBots$);
      }
    };
    window.addEventListener("focus", refresh, { signal });
    document.addEventListener("visibilitychange", refresh, { signal });
    set(
      setAblyLoop$,
      {
        topic: "telegram:changed",
        loopCommand$: onTelegramChanged$,
        options: {
          onSubscribed: () => {
            set(reloadTelegramBots$);
          },
        },
      },
      signal,
    );
  },
);

export const disconnectTelegramAccount$ = command(
  async ({ get, set }, botId: string, signal: AbortSignal): Promise<void> => {
    const client = get(apiClient$)(integrationsTelegramContract);
    await accept(
      client.unlink({
        headers: {},
        query: { botId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.telegramDisconnected;
      }),
    );
  },
);
