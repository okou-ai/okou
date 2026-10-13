import { discordSnowflakeSchema } from "@okouai/api-contracts/contracts/integrations-discord-read";
import { useGet, useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { discordOrgData$ } from "../../signals/okou-page/discord.ts";
import { searchParams$ } from "../../signals/route.ts";
import { DiscordMark } from "./components/discord-mark.tsx";
import {
  CenterText,
  ConnectCheckingState,
  connectErrorMessage,
  ConnectErrorState,
  ConnectStatusMark,
  PageShell,
  SettingsBackLink,
} from "./connect-page-shell.tsx";
import {
  discordDescription,
  DiscordAuthorizationActions,
} from "./discord-authorization-actions.tsx";

export function DiscordConnectPage() {
  return (
    <PageShell>
      <PageContent />
    </PageShell>
  );
}

function PageContent() {
  const { t } = useTranslation();
  const status = useLoadable(discordOrgData$);
  const guildId = useGet(searchParams$).get("guild_id");
  if (status.state === "loading") {
    return <ConnectCheckingState />;
  }
  if (status.state === "hasError") {
    return (
      <ConnectErrorState
        message={connectErrorMessage(
          status.error,
          t(($) => {
            return $.works.discord.authorizationError;
          }),
        )}
      />
    );
  }
  const data = status.state === "hasData" ? status.data : null;
  if (
    guildId !== null &&
    (!discordSnowflakeSchema.safeParse(guildId).success ||
      (data?.isInstalled && data.guildId !== guildId))
  ) {
    return (
      <ConnectErrorState
        message={t(($) => {
          return $.works.discord.workspaceMismatch;
        })}
      />
    );
  }
  return (
    <>
      <ConnectStatusMark
        state={data?.isConnected ? "success" : "idle"}
        idle={<DiscordMark size={40} />}
      />
      <CenterText
        title={
          data?.isConnected
            ? t(($) => {
                return $.works.discord.connectedTitle;
              })
            : t(($) => {
                return $.works.discord.connectTitle;
              })
        }
        body={
          data
            ? discordDescription(data)
            : t(($) => {
                return $.works.discord.unconfigured;
              })
        }
      />
      <DiscordAuthorizationActions
        data={data}
        disabled={false}
        {...(guildId ? { guildId } : {})}
      />
      <SettingsBackLink />
    </>
  );
}
