import { command } from "ccstate";
import { createElement } from "react";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";

import { i18n } from "../../i18n/index.ts";
import { FeishuSettingsPage } from "../../views/okou-page/feishu-card.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import {
  featureSwitch$,
  initialFeatureSwitchHydration$,
} from "../external/feature-switch.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { updatePage$ } from "../react-router.ts";
import {
  feishuPlatform$,
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
      await get(initialFeatureSwitchHydration$);
      signal.throwIfAborted();
      const features = get(featureSwitch$);
      if (!features[FEISHU_PLATFORMS[platform].featureSwitch]) {
        set(detachedNavigateTo$, ROUTES.home, { replace: true });
        return;
      }
    }

    if (isAccountConnect) {
      await set(connectFeishuAccount$, signal);
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
