import { command } from "ccstate";
import type {
  integrationsTelegramContract as SourceIntegrationsTelegramContract,
  TelegramLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { infer as zInfer } from "zod";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { telegramClient$ } from "./telegram-client.ts";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { oauthBaseForNavigation$ } from "../fetch.ts";
import { resetSignal, withCleanup } from "../utils.ts";
import {
  openTelegramLoginTab,
  requestTelegramAuth,
} from "./telegram-login-popup.ts";
import { reloadTelegramBots$ } from "./telegram.ts";

type TelegramConnectionSource = NonNullable<
  zInfer<
    typeof SourceIntegrationsTelegramContract.getLinkStatus.query
  >["source"]
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

const resetAuthorization$ = resetSignal();
const resetLink$ = resetSignal();

export const linkTelegramAccount$ = command(
  async (
    { get, set },
    body: zInfer<typeof SourceIntegrationsTelegramContract.link.body>,
    parentSignal: AbortSignal,
  ) => {
    const signal = set(resetLink$, parentSignal);
    const owner = await get(telegramClient$);
    signal.throwIfAborted();
    owner.assertCurrent();
    const unsubscribe = owner.clerk.addListener(() => {
      if (!owner.isCurrent()) {
        set(resetLink$);
      }
    });
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    const result = await withCleanup(
      accept(
        owner.client.link({ headers: {}, body, fetchOptions: { signal } }),
        [200],
        signal,
      ),
      unsubscribe,
    );
    signal.throwIfAborted();
    owner.assertCurrent();
    set(reloadTelegramBots$);
    return result.body;
  },
);

const connectTelegramInTab$ = command(
  async (
    { get, set },
    {
      botId,
      tab,
      source,
      handOff,
    }: {
      botId: string;
      tab: Window;
      source: TelegramConnectionSource;
      handOff: () => void;
    },
    signal: AbortSignal,
  ) => {
    const owner = await get(telegramClient$);
    signal.throwIfAborted();
    owner.assertCurrent();
    const unsubscribe = owner.clerk.addListener(() => {
      if (!owner.isCurrent()) {
        set(resetAuthorization$);
      }
    });
    const connect = async () => {
      const { body: status } = await accept(
        owner.client.getLinkStatus({
          headers: {},
          query: {
            botId,
            origin: location.origin,
            source,
          },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      signal.throwIfAborted();
      owner.assertCurrent();
      if (tab.closed) {
        return null;
      }
      if (status.linked) {
        set(reloadTelegramBots$);
        const target = new URL(
          INTEGRATION_SETTINGS_PATHS.telegram,
          window.location.origin,
        );
        target.searchParams.set("bot", botId);
        handOff();
        tab.location.href = target.href;
        return null;
      }
      const loginBotId = status.installation?.loginBotId;
      if (
        !loginBotId ||
        status.installation?.domainConfigured === false ||
        status.readinessError
      ) {
        toast.error(telegramReadinessErrorMessage(status));
        tab.close();
        return null;
      }
      handOff();
      const operation = requestTelegramAuth(
        {
          tab,
          loginBotId,
          bot: botId,
          callbackBase: get(oauthBaseForNavigation$),
        },
        signal,
      );
      const bind = async () => {
        const auth = await operation.identity;
        signal.throwIfAborted();
        owner.assertCurrent();
        if (!auth) {
          await operation.finish("cancelled");
          return null;
        }
        const result = await set(
          linkTelegramAccount$,
          { telegramBotId: botId, telegramAuth: auth },
          signal,
        );
        signal.throwIfAborted();
        owner.assertCurrent();
        toast.success(
          i18n.t(($) => {
            return $.connectors.providerConnect.telegram.successTitle;
          }),
        );
        await operation.finish("linked");
        signal.throwIfAborted();
        owner.assertCurrent();
        return result;
      };
      // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
      return await withCleanup(bind(), operation.dispose);
    };
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    return await withCleanup(connect(), unsubscribe);
  },
);

export const authorizeTelegramBot$ = command(
  async (
    { set },
    botId: string,
    source: TelegramConnectionSource,
    parentSignal: AbortSignal,
  ) => {
    const signal = set(resetAuthorization$, parentSignal);
    signal.throwIfAborted();
    const tab = openTelegramLoginTab();
    let handedOff = false;
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    return await withCleanup(
      set(
        connectTelegramInTab$,
        {
          botId,
          tab,
          source,
          handOff: () => {
            handedOff = true;
          },
        },
        signal,
      ),
      () => {
        // Reading a navigated window's location would itself violate the origin
        // boundary. Track our reservation handoff without inspecting that page.
        if (!handedOff && !tab.closed) {
          tab.close();
        }
      },
    );
  },
);
