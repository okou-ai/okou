import type { DiscordOrgStatus } from "@okouai/api-contracts/contracts/integrations-discord";
import { discordSnowflakeSchema } from "@okouai/api-contracts/contracts/integrations-discord-read";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { buttonVariants, cn } from "@okouai/ui";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  discordOrgData$,
  DiscordPopupBlockedError,
} from "../../signals/okou-page/discord.ts";
import { connectDiscordAccount$ } from "../../signals/okou-page/discord-connect-signals.ts";
import {
  approveDiscordAuthorization$,
  discordApprovalAvailable$,
  discordApprovalRequest$,
  discordApprovalSucceeded$,
} from "../../signals/okou-page/discord-oauth-approval.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { searchParams$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { DiscordMark } from "./components/discord-mark.tsx";
import {
  CenterText,
  ConnectCheckingState,
  ConnectErrorAlert,
  connectErrorMessage,
  ConnectErrorState,
  ConnectStatusMark,
  ConnectSubmitButton,
  PageShell,
  SettingsBackLink,
} from "./connect-page-shell.tsx";
import {
  canAuthorizeDiscord,
  discordDescription,
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
  const params = useGet(searchParams$);
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.DiscordIntegration];
  const approvalAvailable = useGet(discordApprovalAvailable$);
  const approved = useGet(discordApprovalSucceeded$);
  if (enabled && (approvalAvailable || approved)) {
    return <DiscordApprovalState />;
  }
  const callbackStatus = params.get("status");
  if (enabled && (callbackStatus === "error" || callbackStatus === "pending")) {
    return (
      <ConnectErrorState
        message={
          callbackStatus === "error"
            ? t(($) => {
                return $.works.discord.authorizationError;
              })
            : t(($) => {
                return $.works.discord.pendingConsent;
              })
        }
      />
    );
  }
  return <DiscordConnectionState />;
}

function DiscordApprovalState() {
  const { t } = useTranslation();
  const request = useLoadable(discordApprovalRequest$);
  const approve = useSet(approveDiscordAuthorization$);
  const pageSignal = useGet(pageSignal$);
  const failed = request.state === "hasError";
  if (failed) {
    return (
      <>
        <ConnectStatusMark state="error" idle={<DiscordMark size={40} />} />
        <div role="alert">
          <CenterText
            title={t(($) => {
              return $.connectors.providerConnect.common.connectionFailed;
            })}
            body={t(($) => {
              return $.works.discord.approvalFailed;
            })}
          />
        </div>
        <ConnectSubmitButton
          connecting={false}
          label={t(($) => {
            return $.works.discord.retry;
          })}
          onConnect={() => {
            detach(approve(pageSignal), Reason.DomCallback);
          }}
        />
        <SettingsBackLink />
      </>
    );
  }
  return (
    <>
      <ConnectStatusMark state="loading" idle={<DiscordMark size={40} />} />
      <CenterText
        title={t(($) => {
          return $.works.discord.connectingTitle;
        })}
        body={t(($) => {
          return $.connectors.providerConnect.common.verifying;
        })}
      />
      <SettingsBackLink />
    </>
  );
}

function DiscordConnectionState() {
  const { t } = useTranslation();
  const status = useLastLoadable(discordOrgData$);
  const guildId = useGet(searchParams$).get("guild_id");
  const [authorization, connect] = useLoadableSet(connectDiscordAccount$);
  const pageSignal = useGet(pageSignal$);
  const connecting = authorization.state === "loading";
  const error =
    authorization.state === "hasError"
      ? authorization.error instanceof DiscordPopupBlockedError
        ? t(($) => {
            return $.works.discord.popupBlocked;
          })
        : t(($) => {
            return $.works.discord.authorizationError;
          })
      : null;
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
  if (guildId !== null && !discordSnowflakeSchema.safeParse(guildId).success) {
    return (
      <ConnectErrorState
        message={t(($) => {
          return $.works.discord.invalidLink;
        })}
      />
    );
  }
  // A callback URL is presentation metadata, not evidence of a connection.
  if (data?.isConnected) {
    return <DiscordSuccessState data={data} guildId={guildId} />;
  }
  return (
    <>
      <DiscordConnectIntro data={data} connecting={connecting} />
      <ConnectErrorAlert error={error} />
      {data && canAuthorizeDiscord(data) ? (
        <ConnectSubmitButton
          connecting={connecting}
          spinnerClassName="animate-spin mr-2"
          label={
            error
              ? t(($) => {
                  return $.works.discord.retry;
                })
              : t(($) => {
                  return $.works.actions.connect;
                })
          }
          onConnect={() => {
            detach(connect(guildId, pageSignal), Reason.DomCallback);
          }}
        />
      ) : null}
      <SettingsBackLink />
    </>
  );
}

function DiscordConnectIntro({
  data,
  connecting,
}: {
  data: DiscordOrgStatus | null;
  connecting: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <ConnectStatusMark idle={<DiscordMark size={40} />} />
      <CenterText
        title={t(($) => {
          return $.works.discord.connectTitle;
        })}
        body={
          connecting ? (
            <span role="status">
              {t(($) => {
                return $.works.discord.browserConsent;
              })}
            </span>
          ) : data?.isAvailable ? (
            t(($) => {
              return $.works.discord.connectDescription;
            })
          ) : data ? (
            discordDescription(data)
          ) : (
            t(($) => {
              return $.works.discord.unconfigured;
            })
          )
        }
      />
    </>
  );
}

function DiscordSuccessState({
  data,
  guildId,
}: {
  data: DiscordOrgStatus;
  guildId: string | null;
}) {
  const { t } = useTranslation();
  const destination = `channels/${discordSnowflakeSchema.parse(guildId ?? data.guildId)}`;
  return (
    <>
      <ConnectStatusMark state="success" idle={<DiscordMark size={40} />} />
      <CenterText
        title={t(($) => {
          return $.works.discord.connectedTitle;
        })}
        body={t(($) => {
          return $.works.discord.description;
        })}
      />
      <div className="flex w-full flex-col gap-3">
        <a
          href={`discord://-/${destination}`}
          className={cn(buttonVariants({ size: "default" }), "w-full gap-2")}
        >
          <DiscordMark size={16} />
          {t(($) => {
            return $.works.discord.open;
          })}
        </a>
        <a
          href={`https://discord.com/${destination}`}
          target="_blank"
          rel="noreferrer"
          className="text-center text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {t(($) => {
            return $.works.discord.openInBrowser;
          })}
        </a>
        <div className="flex justify-center">
          <SettingsBackLink />
        </div>
      </div>
    </>
  );
}
