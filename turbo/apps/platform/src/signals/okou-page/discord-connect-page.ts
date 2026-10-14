import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { DiscordConnectPage } from "../../views/okou-page/discord-connect-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathname$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { bestEffort } from "../utils.ts";
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
    // The view owns status loading and errors, so a failed read must not leave
    // its error state behind the bootstrap skeleton.
    await Promise.all([
      set(hideAppSkeleton$, signal),
      bestEffort(set(watchDiscordConnection$, signal), signal),
      set(approveDiscordAuthorization$, signal),
    ]);
  },
);
