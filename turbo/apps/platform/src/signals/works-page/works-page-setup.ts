import { watchWhatsappConnection$ } from "../okou-page/whatsapp.ts";
import { initWechat$, wechatStatus$ } from "../okou-page/wechat.ts";
import { command } from "ccstate";
import { createElement } from "react";
import { toast } from "@okouai/ui/components/ui/sonner";
import { WorksPage } from "../../views/okou-page/works-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { withCleanup } from "../utils.ts";
import { initSlackOrg$, watchSlackConnection$ } from "../okou-page/slack.ts";
import { watchDiscordConnection$ } from "../okou-page/discord.ts";
import { ownDiscordApprovalRoute$ } from "../okou-page/discord-oauth-approval.ts";
import { watchTeamsConnection$ } from "../okou-page/teams.ts";
import { watchGithubIntegration$ } from "../okou-page/github.ts";
import {
  reloadTelegramBots$,
  watchTelegramConnection$,
} from "../okou-page/telegram.ts";
import {
  setAgentPhoneConnectDialogOpen$,
  watchAgentPhoneConnection$,
} from "../okou-page/agentphone.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import {
  replacePathSilently$,
  replaceSearchParams$,
  searchParams$,
} from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { setupDiscordConnectPage$ } from "../okou-page/discord-connect-page.ts";
import { discordConnectParams } from "../okou-page/discord-connect-params.ts";
import { i18n } from "../../i18n/index.ts";

const initWorksRedirect$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  const error = params.get("error");
  const feishuError = params.get("feishuError");
  const feishuConnected = params.get("feishu") === "connected";
  if (!error && !feishuError && !feishuConnected) {
    return;
  }
  if (error || feishuError) {
    toast.error(error ?? feishuError);
  } else if (feishuConnected) {
    toast.success(
      i18n.t(($) => {
        return $.works.feishuConnected;
      }),
    );
  }
  params.delete("error");
  params.delete("feishuError");
  params.delete("feishu");
  set(replaceSearchParams$, params);
});

export const setupWorksPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const discordStatus = get(searchParams$).get("discord");
    if (
      discordStatus === "pending" ||
      discordStatus === "error" ||
      discordStatus === "connected"
    ) {
      // OAuth callbacks land in the separate authorization tab. The original
      // Works tab has no callback marker and keeps its card in place.
      set(
        replacePathSilently$,
        ROUTES.settingsDiscord,
        undefined,
        discordConnectParams(get(searchParams$), "discord"),
      );
      await set(setupDiscordConnectPage$, signal);
      return;
    }
    set(ownDiscordApprovalRoute$, signal);
    set(setAgentPhoneConnectDialogOpen$, false);
    set(reloadTelegramBots$);
    set(initWechat$);
    set(updatePage$, createElement(WorksPage), "sidebar");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.works.documentTitle;
      }),
    );
    set(initWorksRedirect$);
    set(initSlackOrg$);

    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    await withCleanup(
      Promise.all([
        set(watchSlackConnection$, signal),
        set(watchTeamsConnection$, signal),
        set(watchDiscordConnection$, signal),
        get(wechatStatus$),
        set(watchGithubIntegration$, signal),
        set(watchTelegramConnection$, signal),
        set(watchAgentPhoneConnection$, signal),
        set(watchWhatsappConnection$, signal),
      ]),
      async () => {
        await set(hideAppSkeleton$, signal);
      },
    );
    signal.throwIfAborted();
  },
);
