import { command } from "ccstate";
import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { z } from "zod";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { oauthBaseForNavigation$ } from "../fetch.ts";
import { withCleanup } from "../utils.ts";
import {
  openTelegramLoginTab,
  requestTelegramAuth,
} from "./telegram-login-popup.ts";
import {
  closeTelegramAddDialogAfterRegistration$,
  registerTelegramBot$,
  reloadTelegramBots$,
} from "./telegram.ts";

export const linkTelegramAccount$ = command(
  async (
    { get, set },
    body: z.infer<typeof integrationsTelegramContract.link.body>,
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(integrationsTelegramContract);
    const result = await accept(
      client.link({ headers: {}, body, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    return result.body;
  },
);

const connectTelegramInTab$ = command(
  async ({ get, set }, botId: string, tab: Window, signal: AbortSignal) => {
    const client = get(apiClient$)(integrationsTelegramContract);
    const { body: status } = await accept(
      client.getLinkStatus({
        headers: {},
        query: { botId, origin: location.origin },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    if (tab.closed) {
      return null;
    }
    if (status.linked) {
      set(reloadTelegramBots$);
      toast.success(
        i18n.t(($) => {
          return $.connectors.providerConnect.telegram.alreadyTitle;
        }),
      );
      return null;
    }
    if (status.installation?.domainConfigured === false) {
      const message = i18n.t(($) => {
        return $.connectors.providerSettings.errors.telegramDomain;
      });
      toast.error(message);
      throw new Error(message);
    }
    const loginBotId = status.installation?.loginBotId;
    if (!loginBotId) {
      const message = i18n.t(($) => {
        return $.connectors.providerConnect.telegram.errorFallback;
      });
      toast.error(message);
      throw new Error(message);
    }
    const auth = await requestTelegramAuth(
      tab,
      loginBotId,
      get(oauthBaseForNavigation$),
      signal,
    );
    if (!auth) {
      return null;
    }
    const result = await set(
      linkTelegramAccount$,
      { telegramBotId: botId, telegramAuth: auth },
      signal,
    );
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerConnect.telegram.successTitle;
      }),
    );
    return result;
  },
);

export const authorizeTelegramBot$ = command(
  async ({ set }, botId: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const tab = openTelegramLoginTab();
    return await withCleanup(
      set(connectTelegramInTab$, botId, tab, signal),
      () => {
        tab.close();
      },
    );
  },
);

export const registerAndConnectTelegramBot$ = command(
  async (
    { set },
    input: { botToken: string; defaultAgentId?: string },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const tab = openTelegramLoginTab();
    await withCleanup(
      (async () => {
        const bot = await set(registerTelegramBot$, input, signal);
        set(closeTelegramAddDialogAfterRegistration$);
        await set(connectTelegramInTab$, bot.id, tab, signal);
      })(),
      () => {
        tab.close();
      },
    );
  },
);
