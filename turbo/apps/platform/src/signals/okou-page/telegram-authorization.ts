import { command } from "ccstate";
import {
  integrationsTelegramContract,
  type TelegramLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
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
import { reloadTelegramBots$ } from "./telegram.ts";

type TelegramConnectionSource = NonNullable<
  z.infer<typeof integrationsTelegramContract.getLinkStatus.query>["source"]
>;

export function telegramReadinessErrorMessage(
  status: Extract<TelegramLinkStatusResponse, { linked: false }>,
): string {
  // Status-only and older API responses can omit readinessError. Keep the field
  // checks until unavailable replies always carry a reason and older APIs are
  // neither serving nor retained for rollback (#39897).
  const reason =
    status.readinessError ??
    (!status.installation?.loginBotId
      ? "bot_not_configured"
      : "domain_not_verified");
  if (reason === "domain_check_failed") {
    return i18n.t(($) => {
      return $.connectors.providerConnect.telegram.connectionCheckFailed;
    });
  }
  if (reason === "bot_not_configured") {
    return i18n.t(($) => {
      return $.connectors.providerConnect.telegram.botNotConfigured;
    });
  }
  return i18n.t(($) => {
    return $.connectors.providerConnect.telegram.domainNotVerified;
  });
}

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
  async (
    { get, set },
    botId: string,
    tab: Window,
    source: TelegramConnectionSource,
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(integrationsTelegramContract);
    const { body: status } = await accept(
      client.getLinkStatus({
        headers: {},
        query: { botId, origin: location.origin, source },
        fetchOptions: { signal },
      }),
      [200],
      signal,
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
    const loginBotId = status.installation?.loginBotId;
    if (
      !loginBotId ||
      status.installation?.domainConfigured === false ||
      status.readinessError
    ) {
      toast.error(telegramReadinessErrorMessage(status));
      return null;
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
  async (
    { set },
    botId: string,
    source: TelegramConnectionSource,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const tab = openTelegramLoginTab();
    return await withCleanup(
      set(connectTelegramInTab$, botId, tab, source, signal),
      () => {
        tab.close();
      },
    );
  },
);
