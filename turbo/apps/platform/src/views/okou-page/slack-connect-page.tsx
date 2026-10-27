import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { CircleCheck } from "lucide-react";
import { BrandSlack, buttonVariants, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { detach, Reason } from "../../signals/utils.ts";
import {
  effectiveError$,
  slackReturnUrl$,
  slackConnectStatus$,
  type SlackConnectStatus,
  connectSlackAccount$,
} from "../../signals/okou-page/slack-connect-signals.ts";
import {
  CenterText,
  ConnectCheckingState,
  ConnectErrorAlert,
  connectErrorMessage,
  ConnectErrorState,
  ConnectInvalidLinkState,
  ConnectStatusMark,
  ConnectSubmitButton,
  PageShell,
  SettingsBackLink,
} from "./connect-page-shell.tsx";

type PageStatus =
  | SlackConnectStatus
  | { readonly kind: "checking" }
  | { readonly kind: "error"; readonly message: string };

export function SlackConnectPage() {
  return (
    <PageShell>
      <SlackAuthorizationError />
      <PageContent />
    </PageShell>
  );
}

function SlackAuthorizationError() {
  const { t } = useTranslation();
  const error = useGet(effectiveError$);
  if (error) {
    return (
      <ConnectErrorAlert
        error={
          error === "access_denied"
            ? t(($) => {
                return $.connectors.providerConnect.slack.authorizationFailed;
              })
            : error
        }
      />
    );
  }
  return null;
}

function PageContent() {
  const { t } = useTranslation();
  const statusLoadable = useLoadable(slackConnectStatus$);
  const status: PageStatus =
    statusLoadable.state === "loading"
      ? { kind: "checking" }
      : statusLoadable.state === "hasData"
        ? statusLoadable.data
        : statusLoadable.state === "hasError"
          ? {
              kind: "error",
              message: connectErrorMessage(
                statusLoadable.error,
                t(($) => {
                  return $.connectors.providerConnect.slack.errorFallback;
                }),
              ),
            }
          : { kind: "checking" };
  const [connectLoadable, connect] = useLoadableSet(connectSlackAccount$);
  const connectLoading = connectLoadable.state === "loading";
  const connectError =
    connectLoadable.state === "hasError"
      ? connectErrorMessage(
          connectLoadable.error,
          t(($) => {
            return $.connectors.providerConnect.slack.errorFallback;
          }),
        )
      : null;
  const workspaceName =
    "workspaceName" in status ? (status.workspaceName ?? null) : null;
  const pageSignal = useGet(pageSignal$);
  const handleConnect = (intent: "connect" | "switch") => {
    detach(connect(intent, pageSignal), Reason.DomCallback);
  };

  if (status.kind === "error") {
    return (
      <>
        <ConnectErrorState message={status.message} />
      </>
    );
  }
  if (status.kind === "checking") {
    return <ConnectCheckingState />;
  }
  if (status.kind === "overview") {
    return <SlackOverview status={status} />;
  }
  if (status.kind === "success") {
    return (
      <SlackSuccessState
        workspaceName={workspaceName}
        slackUserId={status.slackUserId}
      />
    );
  }
  if (status.kind === "slack_account_in_use") {
    return <SlackAccountInUseState />;
  }
  if (status.kind === "workspace_mismatch") {
    return <SlackWorkspaceMismatchState status={status} />;
  }
  if (status.kind === "slack_account_mismatch") {
    return (
      <SlackAccountMismatchState
        status={status}
        workspaceName={workspaceName}
        connectError={connectError}
        connecting={connectLoading}
        onSwitch={() => {
          return handleConnect("switch");
        }}
      />
    );
  }
  if (status.kind === "invalid") {
    return (
      <>
        <ConnectInvalidLinkState
          description={t(($) => {
            return $.connectors.providerConnect.slack.invalidDescription;
          })}
        />
      </>
    );
  }
  return (
    <>
      <BrandSlack size={40} />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.slack.connectTitle;
        })}
        body={
          workspaceName ??
          t(($) => {
            return $.connectors.providerConnect.slack.connectDescription;
          })
        }
      />
      <ConnectErrorAlert error={connectError} />
      <ConnectSubmitButton
        connecting={connectLoading}
        onConnect={() => {
          return handleConnect("connect");
        }}
        spinnerClassName="animate-spin mr-2"
      />
      <SettingsBackLink />
    </>
  );
}

function SlackOverview({
  status,
}: {
  status: Extract<SlackConnectStatus, { kind: "overview" }>;
}) {
  const { t } = useTranslation();
  const { data, authorizationUrl } = status;
  return (
    <>
      {data.isConnected ? (
        <SlackSuccessState workspaceName={data.workspaceName ?? null} />
      ) : (
        <>
          <BrandSlack size={40} />
          <CenterText
            title={t(($) => {
              return $.connectors.providerConnect.slack.connectTitle;
            })}
            body={t(($) => {
              return $.connectors.providerConnect.slack.connectDescription;
            })}
          />
        </>
      )}
      {authorizationUrl ? (
        <a href={authorizationUrl} className={cn(buttonVariants(), "w-full")}>
          {data.scopeMismatch && data.isAdmin
            ? t(($) => {
                return $.connectors.providerConnect.slack.reauthorize;
              })
            : data.connectUrl
              ? t(($) => {
                  return $.works.actions.connect;
                })
              : t(($) => {
                  return $.works.slack.install;
                })}
        </a>
      ) : !data.isConnected ? (
        <p className="text-sm text-muted-foreground">
          {data.isAdmin
            ? t(($) => {
                return $.connectors.providerConnect.slack.unavailable;
              })
            : t(($) => {
                return $.works.slack.adminInstall;
              })}
        </p>
      ) : null}
      {!data.isConnected && <SettingsBackLink />}
    </>
  );
}

function SlackSuccessState({
  workspaceName,
  slackUserId,
}: {
  workspaceName: string | null;
  slackUserId?: string;
}) {
  const { t } = useTranslation();
  const returnUrl = useGet(slackReturnUrl$);
  return (
    <>
      <CircleCheck size={40} className="text-emerald-500" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.slack.currentConnection;
        })}
        body={
          workspaceName
            ? t(
                ($) => {
                  return $.connectors.providerConnect.slack
                    .successDescriptionWorkspace;
                },
                { workspace: workspaceName },
              )
            : t(($) => {
                return $.connectors.providerConnect.slack.successDescription;
              })
        }
      />
      <div className="flex flex-col gap-3 w-full">
        <a
          href={slackUserId ? returnUrl : "slack://open"}
          className={cn(buttonVariants(), "w-full gap-2")}
        >
          <BrandSlack size={16} />
          {t(($) => {
            return $.connectors.providerConnect.slack.open;
          })}
        </a>
        <div className="flex justify-center">
          <SettingsBackLink />
        </div>
      </div>
    </>
  );
}

function SlackAccountInUseState() {
  const { t } = useTranslation();
  return (
    <>
      <ConnectStatusMark
        state="error"
        idle={<BrandSlack size={40} className="" />}
      />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.slack.accountInUseTitle;
        })}
        body={t(($) => {
          return $.connectors.providerConnect.slack.accountInUseDescription;
        })}
      />
      <SettingsBackLink />
    </>
  );
}

function SlackWorkspaceMismatchState({
  status,
}: {
  status: Extract<SlackConnectStatus, { readonly kind: "workspace_mismatch" }>;
}) {
  const { t } = useTranslation();
  return (
    <>
      <ConnectStatusMark
        state="error"
        idle={<BrandSlack size={40} className="" />}
      />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.slack.workspaceMismatchTitle;
        })}
        body={
          status.currentWorkspaceName
            ? t(
                ($) => {
                  return $.connectors.providerConnect.slack
                    .workspaceMismatchDescriptionNamed;
                },
                { workspace: status.currentWorkspaceName },
              )
            : t(($) => {
                return $.connectors.providerConnect.slack
                  .workspaceMismatchDescription;
              })
        }
      />
      <SettingsBackLink />
    </>
  );
}

function SlackAccountMismatchState({
  status,
  workspaceName,
  connectError,
  connecting,
  onSwitch,
}: {
  status: Extract<
    SlackConnectStatus,
    { readonly kind: "slack_account_mismatch" }
  >;
  workspaceName: string | null;
  connectError: string | null;
  connecting: boolean;
  onSwitch: () => void;
}) {
  const { t } = useTranslation();
  const accounts = {
    currentAccount: status.currentSlackUserId,
    requestedAccount: status.requestedSlackUserId,
  };
  return (
    <>
      <ConnectStatusMark
        state="warning"
        idle={<BrandSlack size={40} className="" />}
      />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.slack.accountMismatchTitle;
        })}
        body={
          workspaceName
            ? t(
                ($) => {
                  return $.connectors.providerConnect.slack
                    .accountMismatchDescriptionWorkspace;
                },
                { workspace: workspaceName, ...accounts },
              )
            : t(($) => {
                return $.connectors.providerConnect.slack
                  .accountMismatchDescription;
              }, accounts)
        }
      />
      <ConnectErrorAlert error={connectError} />
      <div className="flex w-full flex-col gap-3">
        <ConnectSubmitButton
          connecting={connecting}
          onConnect={onSwitch}
          label={t(
            ($) => {
              return $.connectors.providerConnect.slack.switchAccount;
            },
            { account: status.requestedSlackUserId },
          )}
          spinnerClassName="animate-spin mr-2"
        />
        <div className="flex justify-center">
          <SettingsBackLink
            label={t(
              ($) => {
                return $.connectors.providerConnect.slack.keepAccount;
              },
              { account: status.currentSlackUserId },
            )}
          />
        </div>
      </div>
    </>
  );
}
