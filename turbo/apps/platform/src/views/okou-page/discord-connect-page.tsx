import type { DiscordOrgStatus } from "@okouai/api-contracts/contracts/integrations-discord";
import { discordSnowflakeSchema } from "@okouai/api-contracts/validators/integrations-discord-read";
import { buttonVariants, cn } from "@okouai/ui";
import { useGet, useLastLoadable, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../lib/api-error.ts";
import {
  discordOrgData$,
  DiscordPopupBlockedError,
} from "../../signals/okou-page/discord.ts";
import { connectDiscordAccount$ } from "../../signals/okou-page/discord-connect-signals.ts";
import {
  discordApprovalAvailable$,
  discordApprovalRequest$,
  discordApprovalSucceeded$,
} from "../../signals/okou-page/discord-oauth-approval.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { pathname$, searchParams$ } from "../../signals/route.ts";
import { ROUTES } from "../../signals/route-paths.ts";
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
  const approvalAvailable = useGet(discordApprovalAvailable$);
  const approved = useGet(discordApprovalSucceeded$);
  if (approvalAvailable || approved) {
    return <DiscordApprovalState />;
  }
  return <DiscordConnectionState />;
}

function DiscordApprovalState() {
  const { t } = useTranslation();
  const request = useLoadable(discordApprovalRequest$);
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
        <SettingsBackLink />
      </>
    );
  }
  return (
    <>
      <ConnectCheckingState />
      <SettingsBackLink />
    </>
  );
}

function DiscordConnectionState() {
  const { t } = useTranslation();
  const status = useLastLoadable(discordOrgData$);
  const params = useGet(searchParams$);
  const guildId = params.get("guild_id");
  const failedAttempt =
    params.get("status") === "pending" || params.get("status") === "error";
  const installing = useGet(pathname$) === ROUTES.settingsDiscordInstall;
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
  const data = status.data;
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
  // An existing account connection does not prove this installation completed.
  if (data.isConnected && !installing && !failedAttempt) {
    return <DiscordSuccessState data={data} guildId={guildId} />;
  }
  return (
    <DiscordConnectionActions
      data={data}
      guildId={guildId}
      installing={installing}
      failedAttempt={failedAttempt}
    />
  );
}

function DiscordConnectionActions({
  data,
  guildId,
  installing,
  failedAttempt,
}: {
  data: DiscordOrgStatus;
  guildId: string | null;
  installing: boolean;
  failedAttempt: boolean;
}) {
  const { t } = useTranslation();
  const [authorization, connect] = useLoadableSet(connectDiscordAccount$);
  const pageSignal = useGet(pageSignal$);
  const connecting = authorization.state === "loading";
  const error =
    authorization.state === "hasError"
      ? authorization.error instanceof DiscordPopupBlockedError
        ? t(($) => {
            return $.works.discord.popupBlocked;
          })
        : authorization.error instanceof ApiError &&
            authorization.error.expected &&
            authorization.error.code === "DISCORD_OAUTH_APPROVAL_REQUIRED"
          ? t(($) => {
              return $.works.discord.cancelled;
            })
          : t(($) => {
              return $.works.discord.authorizationError;
            })
      : null;
  return (
    <>
      {failedAttempt ? (
        <DiscordAttemptFailure />
      ) : (
        <DiscordConnectIntro data={data} installing={installing} />
      )}
      <ConnectErrorAlert error={error} />
      {!failedAttempt &&
      authorization.state !== "hasError" &&
      (installing ? data.isAvailable : canAuthorizeDiscord(data)) ? (
        <ConnectSubmitButton
          connecting={connecting}
          spinnerClassName="animate-spin mr-2"
          label={
            installing
              ? t(($) => {
                  return $.works.discord.addNewServer;
                })
              : t(($) => {
                  return $.works.actions.connect;
                })
          }
          onConnect={() => {
            detach(
              connect(
                {
                  ...(guildId ? { guildId } : {}),
                  ...(installing ? { flow: "install" } : {}),
                },
                pageSignal,
              ),
              Reason.DomCallback,
            );
          }}
        />
      ) : null}
      <SettingsBackLink />
    </>
  );
}

function DiscordAttemptFailure() {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const code = params.get("discord_error");
  const message =
    params.get("status") === "pending"
      ? t(($) => {
          return $.works.discord.pendingConsent;
        })
      : code === "cancelled"
        ? t(($) => {
            return $.works.discord.cancelled;
          })
        : code === "invalid_state" || code === "invalid_authorization"
          ? t(($) => {
              return $.works.discord.invalidLink;
            })
          : code === "forbidden" ||
              code === "guild_unverified" ||
              code === "bot_missing"
            ? t(($) => {
                return $.works.discord.serverPermissionRequired;
              })
            : t(($) => {
                return $.works.discord.authorizationError;
              });
  return (
    <>
      <ConnectStatusMark state="error" idle={<DiscordMark size={40} />} />
      <div role="alert">
        <CenterText
          title={t(($) => {
            return $.connectors.providerConnect.common.connectionFailed;
          })}
          body={message}
        />
      </div>
    </>
  );
}

function DiscordConnectIntro({
  data,
  installing,
}: {
  data: DiscordOrgStatus;
  installing: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <ConnectStatusMark idle={<DiscordMark size={40} />} />
      <CenterText
        title={
          installing
            ? t(($) => {
                return $.works.discord.installTitle;
              })
            : t(($) => {
                return $.works.discord.connectTitle;
              })
        }
        body={
          data.isAvailable
            ? installing
              ? t(($) => {
                  return $.works.discord.installDescription;
                })
              : t(($) => {
                  return $.works.discord.connectDescription;
                })
            : discordDescription(data)
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
        <div className="flex justify-center">
          <SettingsBackLink />
        </div>
      </div>
    </>
  );
}
