import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { WechatConnectPage } from "../../views/okou-page/wechat-connect-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { initWechat$ } from "./wechat.ts";

export const setupWechatConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(initWechat$);
    set(updatePage$, createElement(WechatConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.works.wechat.title;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
