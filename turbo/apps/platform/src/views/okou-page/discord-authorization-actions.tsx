import type { DiscordOrgStatus } from "@okouai/api-contracts/contracts/integrations-discord";
import { Button } from "@okouai/ui";
import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { connectDiscordFromWorks$ } from "../../signals/okou-page/discord-connect-signals.ts";

export function discordDescription(data: DiscordOrgStatus): string {
  if (!data.isAvailable && data.isConnected) {
    return i18n.t(($) => {
      return $.works.discord.suspended;
    });
  }
  if (!data.isAvailable) {
    return i18n.t(($) => {
      return $.works.discord.unconfigured;
    });
  }
  return i18n.t(($) => {
    return $.works.discord.description;
  });
}

export function canAuthorizeDiscord(data: DiscordOrgStatus): boolean {
  return data.isAvailable && !data.isConnected;
}

export function DiscordAuthorizationActions({
  data,
  disabled,
}: {
  data: DiscordOrgStatus | null;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [authorizationState, authorize] = useLoadableSet(
    connectDiscordFromWorks$,
  );
  const pageSignal = useGet(pageSignal$);
  if (!data || !canAuthorizeDiscord(data)) {
    return null;
  }

  return (
    <Button
      data-testid="discord-connect-button"
      variant="outline"
      size="sm"
      className="h-8 shrink-0 gap-1.5 rounded-lg"
      disabled={disabled || authorizationState.state === "loading"}
      onClick={() => {
        detach(authorize(pageSignal), Reason.DomCallback);
      }}
    >
      {t(($) => {
        return $.works.actions.connect;
      })}
    </Button>
  );
}
