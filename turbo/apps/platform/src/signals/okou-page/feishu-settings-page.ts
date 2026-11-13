import { command } from "ccstate";
import { createElement } from "react";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";

import { i18n } from "../../i18n/index.ts";
import {
  FeishuSettingsPage,
  FeishuSetupPage,
} from "../../views/okou-page/feishu-card.tsx";
import { FeishuConnectErrorPage } from "../../views/okou-page/feishu-connect-error-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { detachedNavigateTo$, pathParams$, searchParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { updatePage$ } from "../react-router.ts";
import {
  feishuPlatform$,
  feishuInstallations$,
  initializeFeishuSetup$,
  reloadFeishuInstallations$,
  resetFeishuSettingsUi$,
  showFeishuSettingsResult$,
  startFeishuSettingsRealtime$,
} from "./feishu.ts";
import {
  connectFeishuAccount$,
  hasFeishuConnectParams$,
} from "./feishu-connect-signals.ts";

export const setupFeishuSettingsPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const platform = get(feishuPlatform$);
    const isAccountConnect = get(hasFeishuConnectParams$);
    if (!isAccountConnect) {
      const features = get(featureSwitch$);
      if (!features[FEISHU_PLATFORMS[platform].featureSwitch]) {
        set(detachedNavigateTo$, ROUTES.home, { replace: true });
        return;
      }
    }

    if (isAccountConnect) {
      const result = await set(connectFeishuAccount$, signal);
      signal.throwIfAborted();
      if (result === "invalid_link") {
        set(updatePage$, createElement(FeishuConnectErrorPage));
        set(
          updateDocumentTitle$,
          i18n.t(($) => {
            return $.connectors.providerConnect[platform].connectTitle;
          }),
        );
        await set(hideAppSkeleton$, signal);
      }
      return;
    }

    set(resetFeishuSettingsUi$);
    set(reloadFeishuInstallations$);
    set(showFeishuSettingsResult$);
    set(updatePage$, createElement(FeishuSettingsPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerSettings[platform].documentTitle;
      }),
    );

    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(startFeishuSettingsRealtime$, signal),
    ]);
  },
);

export const setupFeishuSetupPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const platform = get(feishuPlatform$);
    if (!get(featureSwitch$)[FEISHU_PLATFORMS[platform].featureSwitch]) {
      set(detachedNavigateTo$, ROUTES.home, { replace: true });
      return;
    }

    set(resetFeishuSettingsUi$);
    signal.addEventListener(
      "abort",
      () => {
        set(resetFeishuSettingsUi$);
      },
      { once: true },
    );
    set(reloadFeishuInstallations$);
    set(updatePage$, createElement(FeishuSetupPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerSettings[platform].addDialogTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
    const installations = await get(feishuInstallations$);
    signal.throwIfAborted();
    const installationId = get(pathParams$)?.installationId;
    const appId = get(searchParams$).get("appId");
    const bot = installations.find((item) => {
      return installationId
        ? item.id === installationId
        : appId !== null && item.appId === appId;
    });
    if ((installationId || appId) && !bot) {
      set(
        detachedNavigateTo$,
        platform === "lark" ? ROUTES.settingsLark : ROUTES.settingsFeishu,
        { replace: true },
      );
      return;
    }
    set(initializeFeishuSetup$, {
      appId: bot?.appId ?? "",
      step: bot && !bot.setupCompleted ? "redirect" : "create",
      ...(bot ? { installationId: bot.id } : {}),
    });
    await set(startFeishuSettingsRealtime$, signal);
  },
);
