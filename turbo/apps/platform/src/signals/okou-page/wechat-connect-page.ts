import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { WechatConnectPage } from "../../views/okou-page/wechat-connect-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { settle } from "../utils.ts";
import { initWechat$ } from "./wechat.ts";
import { wechatConnectPageStatus$ } from "./wechat-connect-signals.ts";

export const setupWechatConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(WechatConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.works.wechat.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
    // The card renders read failures; route setup must still finish.
    await settle(set(initWechat$, signal), signal);
    await settle(get(wechatConnectPageStatus$), signal);
  },
);
