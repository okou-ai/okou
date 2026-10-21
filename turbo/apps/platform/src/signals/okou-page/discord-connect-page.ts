import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { DiscordConnectPage } from "../../views/okou-page/discord-connect-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathname$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { watchDiscordConnection$ } from "./discord.ts";
import {
  approveDiscordAuthorization$,
  ownDiscordApprovalRoute$,
} from "./discord-oauth-approval.ts";

export const setupDiscordConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(ownDiscordApprovalRoute$, signal);
    set(updatePage$, createElement(DiscordConnectPage));
    set(
      updateDocumentTitle$,
      get(pathname$) === ROUTES.settingsDiscordInstall
        ? i18n.t(($) => {
            return $.works.discord.installTitle;
          })
        : i18n.t(($) => {
            return $.works.discord.connectTitle;
          }),
    );
    await Promise.all([
      set(hideAppSkeleton$, signal),
      set(watchDiscordConnection$, signal),
      set(approveDiscordAuthorization$, signal),
    ]);
  },
);
