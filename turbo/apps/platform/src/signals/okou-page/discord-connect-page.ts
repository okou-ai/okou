import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { DiscordConnectPage } from "../../views/okou-page/discord-connect-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { watchDiscordConnection$ } from "./discord.ts";

export const setupDiscordConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(DiscordConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.works.discord.connectTitle;
      }),
    );
    await set(watchDiscordConnection$, signal);
    signal.throwIfAborted();
    await set(hideAppSkeleton$, signal);
  },
);
