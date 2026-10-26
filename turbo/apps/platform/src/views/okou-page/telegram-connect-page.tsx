import type {
  TelegramBot,
  TelegramLinkStatusResponse,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { useGet, useLoadable, type Loadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { BrandTelegram, buttonVariants, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { onboardingStatus$ } from "../../signals/okou-page/onboarding.ts";
import {
  connectTelegramAccount$,
  telegramConnectLinkStatus$,
} from "../../signals/okou-page/telegram-connect-signals.ts";
import { parseTelegramConnectParams } from "../../signals/okou-page/telegram-connect-params.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { telegramReadinessErrorMessage } from "../../signals/okou-page/telegram-authorization.ts";
import {
  CenterText,
  ConnectErrorAlert,
  ConnectStatusMark,
  ConnectSubmitButton,
  PageShell,
  SettingsBackLink,
  connectErrorMessage,
  type MarkState,
} from "./connect-page-shell.tsx";

function TelegramMark({ state }: { state?: MarkState }) {
  return (
    <ConnectStatusMark
      state={state}
      idle={
        <img
          src={settingsIconAssetUrl("telegram")}
          alt=""
          className="h-12 w-12"
        />
      }
    />
  );
}

function TelegramLink({ username }: { username: string | undefined | null }) {
  const { t } = useTranslation();
  if (!username) {
    return null;
  }
  return (
    <a
      className={cn(buttonVariants(), "w-full gap-2")}
      href={`https://t.me/${encodeURIComponent(username.replace(/^@/, ""))}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      <BrandTelegram size={16} />
      {t(($) => {
        return $.connectors.providerConnect.telegram.open;
      })}
    </a>
  );
}

type TelegramConnection =
  | Loadable<{
      telegramUserId: string;
      botUsername: string;
    } | null>
  | { state: "idle" };

function ConnectedTelegram({
  status,
  bot,
  target,
  connection,
}: {
  status: Extract<TelegramLinkStatusResponse, { linked: true }>;
  bot: TelegramBot | undefined;
  target: string | undefined;
  connection: TelegramConnection;
}) {
  const { t } = useTranslation();

  const mismatch = Boolean(target && target !== status.telegramUserId);
  const identity =
    bot?.connectedUser?.telegramUserId === status.telegramUserId
      ? bot.connectedUser
      : null;
  const label = identity?.telegramUsername
    ? `@${identity.telegramUsername.replace(/^@/, "")}`
    : identity?.telegramDisplayName || status.telegramUserId;
  const success =
    connection.state === "hasData" &&
    connection.data?.telegramUserId === status.telegramUserId;
  return (
    <PageShell>
      <TelegramMark state={mismatch ? "error" : "success"} />
      <CenterText
        title={
          mismatch
            ? t(($) => {
                return $.connectors.providerConnect.telegram.conflictTitle;
              })
            : success
              ? t(($) => {
                  return $.connectors.providerConnect.telegram.successTitle;
                })
              : t(($) => {
                  return $.connectors.providerConnect.telegram.alreadyTitle;
                })
        }
        body={
          mismatch
            ? t(
                ($) => {
                  return $.connectors.providerConnect.telegram
                    .conflictDescription;
                },
                { current: label, requested: target },
              )
            : t(($) => {
                return $.connectors.providerConnect.telegram.successDescription;
              })
        }
      />
      <div className="flex w-full flex-col gap-3">
        {mismatch ? (
          <a
            href={ROUTES.works}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "outline" }), "w-full")}
          >
            {t(($) => {
              return $.connectors.providerConnect.telegram.manageConnection;
            })}
          </a>
        ) : (
          <TelegramLink username={status.botUsername ?? bot?.username} />
        )}
        <div className="flex justify-center">
          <SettingsBackLink />
        </div>
      </div>
    </PageShell>
  );
}

function TelegramSetupRequired({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();

  return (
    <PageShell>
      <TelegramMark />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.telegram.setupTitle;
        })}
        body={
          isAdmin
            ? t(($) => {
                return $.connectors.providerConnect.telegram.setupDescription;
              })
            : t(($) => {
                return $.connectors.providerConnect.telegram
                  .setupMemberDescription;
              })
        }
      />
      {isAdmin ? (
        <a
          href={ROUTES.onboarding}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants(), "w-full")}
        >
          {t(($) => {
            return $.connectors.providerConnect.telegram.openSetup;
          })}
        </a>
      ) : null}
      <SettingsBackLink />
    </PageShell>
  );
}

function TelegramConnectForm({
  connection,
  signed,
  botUsername,
  onConnect,
}: {
  connection: TelegramConnection;
  signed: boolean;
  botUsername: string | undefined | null;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  const connecting = connection.state === "loading";
  const error =
    connection.state === "hasError"
      ? connectErrorMessage(
          connection.error,
          t(($) => {
            return $.connectors.providerConnect.telegram.errorFallback;
          }),
        )
      : null;
  const interrupted = connection.state === "hasData" && !connection.data;
  return (
    <PageShell>
      <TelegramMark />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.telegram.connectTitle;
        })}
        body={t(($) => {
          return $.connectors.providerConnect.telegram.connectDescription;
        })}
      />
      <ConnectErrorAlert error={error} />
      {interrupted ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.providerConnect.telegram.interrupted;
          })}
        </p>
      ) : null}
      <ConnectSubmitButton
        connecting={connecting}
        onConnect={onConnect}
        label={
          signed
            ? undefined
            : t(($) => {
                return $.connectors.providerConnect.telegram.continue;
              })
        }
      />
      {error ? <TelegramLink username={botUsername} /> : null}
      <SettingsBackLink />
    </PageShell>
  );
}

function TelegramNotReady({
  status,
  bot,
}: {
  status: Extract<TelegramLinkStatusResponse, { linked: false }>;
  bot: TelegramBot | undefined;
}) {
  const { t } = useTranslation();
  return (
    <PageShell>
      <TelegramMark state="error" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.common.connectionFailed;
        })}
        body={telegramReadinessErrorMessage(status)}
      />
      <TelegramLink
        username={status.installation?.botUsername ?? bot?.username}
      />
      <SettingsBackLink />
    </PageShell>
  );
}

export function TelegramConnectPage() {
  const { t } = useTranslation();
  const parsed = parseTelegramConnectParams(useGet(searchParams$));
  const statusLoadable = useLoadable(telegramConnectLinkStatus$);
  const setupLoadable = useLoadable(onboardingStatus$);
  const [connection, connect] = useLoadableSet(connectTelegramAccount$);
  const signal = useGet(pageSignal$);

  if (!parsed.ok) {
    return (
      <PageShell>
        <TelegramMark state="error" />
        <CenterText title={parsed.error.title} body={parsed.error.message} />
        <SettingsBackLink />
      </PageShell>
    );
  }
  if (statusLoadable.state === "loading" || setupLoadable.state === "loading") {
    return (
      <PageShell>
        <TelegramMark state="loading" />
        <CenterText
          title={t(($) => {
            return $.connectors.providerConnect.telegram
              .checkingConnectionTitle;
          })}
          body={t(($) => {
            return $.connectors.providerConnect.telegram
              .checkingConnectionDescription;
          })}
        />
      </PageShell>
    );
  }
  if (
    statusLoadable.state === "hasError" ||
    setupLoadable.state === "hasError" ||
    !statusLoadable.data
  ) {
    return (
      <PageShell>
        <TelegramMark state="error" />
        <CenterText
          title={t(($) => {
            return $.connectors.providerConnect.common.connectionFailed;
          })}
          body={t(($) => {
            return $.connectors.providerSettings.telegram.loadError;
          })}
        />
        <SettingsBackLink />
      </PageShell>
    );
  }
  const { status, bot } = statusLoadable.data;
  const target = parsed.params.connectSignature?.telegramUserId;
  if (status.linked) {
    return (
      <ConnectedTelegram
        status={status}
        bot={bot}
        target={target}
        connection={connection}
      />
    );
  }
  const setup = setupLoadable.data;
  if (!setup.hasOrg || !setup.hasDefaultAgent) {
    return <TelegramSetupRequired isAdmin={setup.isAdmin} />;
  }
  if (
    !parsed.params.connectSignature &&
    (!status.installation?.loginBotId ||
      status.installation.domainConfigured === false ||
      status.readinessError)
  ) {
    return <TelegramNotReady status={status} bot={bot} />;
  }
  return (
    <TelegramConnectForm
      connection={connection}
      signed={Boolean(parsed.params.connectSignature)}
      botUsername={status.installation?.botUsername ?? bot?.username}
      onConnect={() => {
        detach(connect(signal), Reason.DomCallback);
      }}
    />
  );
}
