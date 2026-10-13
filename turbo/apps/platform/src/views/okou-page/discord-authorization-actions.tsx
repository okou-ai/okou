import type { DiscordOrgStatus } from "@okouai/api-contracts/contracts/integrations-discord";
import { Button } from "@okouai/ui";
import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  discordAuthorizationFailed$,
  DiscordPopupBlockedError,
} from "../../signals/okou-page/discord.ts";
import { connectDiscordAccount$ } from "../../signals/okou-page/discord-connect-signals.ts";
import {
  discordApprovalAvailable$,
  discordApprovalSucceeded$,
} from "../../signals/okou-page/discord-oauth-approval.ts";

export function discordDescription(data: DiscordOrgStatus): string {
  if (!data.isAvailable && data.isInstalled) {
    return i18n.t(($) => {
      return $.works.discord.suspended;
    });
  }
  if (!data.isAvailable) {
    return i18n.t(($) => {
      return $.works.discord.unconfigured;
    });
  }
  if (!data.isInstalled) {
    return data.isAdmin
      ? i18n.t(($) => {
          return $.works.discord.adminSetup;
        })
      : i18n.t(($) => {
          return $.works.discord.memberSetup;
        });
  }
  if (!data.isConnected) {
    return i18n.t(($) => {
      return $.works.discord.accountSetup;
    });
  }
  return i18n.t(($) => {
    return $.works.discord.description;
  });
}

export function canAuthorizeDiscord(data: DiscordOrgStatus): boolean {
  return (
    data.isAvailable &&
    ((!data.isInstalled && data.isAdmin) ||
      (data.isInstalled && !data.isConnected))
  );
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
    connectDiscordAccount$,
  );
  const authorizationFailed = useGet(discordAuthorizationFailed$);
  const approvalAvailable = useGet(discordApprovalAvailable$);
  const approvalSucceeded = useGet(discordApprovalSucceeded$);
  const pageSignal = useGet(pageSignal$);
  if (approvalAvailable || approvalSucceeded) {
    return null;
  }
  const canAuthorize = data && canAuthorizeDiscord(data);
  if (
    !canAuthorize &&
    authorizationState.state !== "loading" &&
    authorizationState.state !== "hasError" &&
    !authorizationFailed
  ) {
    return null;
  }

  return (
    <div className="flex max-w-64 flex-col items-end gap-2">
      {canAuthorize ? (
        <Button
          data-testid={
            data.isInstalled
              ? "discord-connect-button"
              : "discord-install-button"
          }
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          disabled={disabled || authorizationState.state === "loading"}
          onClick={() => {
            detach(
              authorize(
                data.isInstalled ? "connect" : "install",
                data.guildId,
                pageSignal,
              ),
              Reason.DomCallback,
            );
          }}
        >
          {!data.isInstalled && <Download size={14} />}
          {authorizationState.state === "loading"
            ? t(($) => {
                return $.works.discord.authorizing;
              })
            : authorizationState.state === "hasError"
              ? t(($) => {
                  return $.works.discord.retry;
                })
              : data.isInstalled
                ? t(($) => {
                    return $.works.actions.connect;
                  })
                : t(($) => {
                    return $.works.discord.install;
                  })}
        </Button>
      ) : null}
      {authorizationState.state === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.works.discord.browserConsent;
          })}
        </p>
      ) : null}
      {authorizationState.state === "hasError" || authorizationFailed ? (
        <p role="alert" className="text-sm text-destructive">
          {authorizationState.state === "hasError" &&
          authorizationState.error instanceof DiscordPopupBlockedError
            ? t(($) => {
                return $.works.discord.popupBlocked;
              })
            : t(($) => {
                return $.works.discord.authorizationError;
              })}
        </p>
      ) : null}
    </div>
  );
}
