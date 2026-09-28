import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  integrationsTelegramContract,
  type TelegramBot,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { i18n } from "../../i18n/index.ts";

const internalReload$ = state(0);
const internalTelegramFailedAvatarKeys$ = state<Record<string, boolean>>({});
const internalTelegramSavingBotId$ = state<string | null>(null);
const internalTelegramUnlinkingBotId$ = state<string | null>(null);

export const telegramFailedAvatarKeys$ = computed((get) => {
  return get(internalTelegramFailedAvatarKeys$);
});

export const telegramSavingBotId$ = computed((get) => {
  return get(internalTelegramSavingBotId$);
});

export const telegramUnlinkingBotId$ = computed((get) => {
  return get(internalTelegramUnlinkingBotId$);
});

export const markTelegramAvatarFailed$ = command(
  ({ set }, avatarKey: string) => {
    set(internalTelegramFailedAvatarKeys$, (previous) => {
      return { ...previous, [avatarKey]: true };
    });
  },
);

export const setTelegramSavingBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramSavingBotId$, value);
  },
);

export const setTelegramUnlinkingBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramUnlinkingBotId$, value);
  },
);

export const resetTelegramSettingsUi$ = command(({ set }) => {
  set(internalTelegramSavingBotId$, null);
  set(internalTelegramUnlinkingBotId$, null);
});

export const telegramBots$ = computed(async (get): Promise<TelegramBot[]> => {
  get(internalReload$);
  const client = get(apiClient$)(integrationsTelegramContract);
  const result = await accept(client.list({ headers: {} }), [200]);
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

export const startTelegramSettingsRealtime$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyLoop$,
      {
        topic: "telegram:changed",
        loopCommand$: onTelegramChanged$,
      },
      signal,
    );
  },
);

export const updateTelegramBotAgent$ = command(
  async (
    { get, set },
    input:
      | { botId: string; defaultAgentId: string }
      | { botId: string; selectedAgentId: string | null },
    signal: AbortSignal,
  ) => {
    const toastId = toast.loading(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.telegramUpdatingAgent;
      }),
    );
    signal.addEventListener("abort", () => {
      return toast.dismiss(toastId);
    });
    const client = get(apiClient$)(integrationsTelegramContract);
    const result = await accept(
      client.updateBot({
        headers: {},
        params: { botId: input.botId },
        body:
          "selectedAgentId" in input
            ? { selectedAgentId: input.selectedAgentId }
            : { defaultAgentId: input.defaultAgentId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.telegramAgentUpdated;
      }),
      { id: toastId },
    );
    return result.body;
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
