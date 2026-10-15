import { watchTelegramConnection$ } from "./telegram.ts";
import { refreshTelegramConnection$ } from "./telegram-connect-signals.ts";
import {
  detachedNavigateTo$,
  hash$,
  pathname$,
  searchParams$,
} from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { reloadOnboardingStatus$ } from "./onboarding.ts";
import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { TelegramConnectPage } from "../../views/okou-page/telegram-connect-page.tsx";

export const setupTelegramConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (
      get(pathname$).toLowerCase().replace(/\/$/, "") === ROUTES.telegramConnect
    ) {
      set(detachedNavigateTo$, ROUTES.settingsTelegram, {
        searchParams: get(searchParams$),
        hash: get(hash$),
        replace: true,
      });
      return;
    }
    const refreshSetup = () => {
      if (!document.hidden) {
        set(reloadOnboardingStatus$);
      }
    };
    window.addEventListener("focus", refreshSetup, { signal });
    document.addEventListener("visibilitychange", refreshSetup, { signal });
    set(watchTelegramConnection$, signal);
    set(refreshTelegramConnection$);
    set(updatePage$, createElement(TelegramConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerConnect.telegram.connectTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
