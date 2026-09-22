import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { CircleCheck } from "lucide-react";
import { Button, BrandSlack } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { detach, Reason } from "../../signals/utils.ts";
import { searchParams$ } from "../../signals/route.ts";
import {
  effectiveError$,
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
      <PageContent />
    </PageShell>
  );
}

function PageContent() {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const workspaceId = params.get("w");
  const slackUserId = params.get("u");
  const callbackWorkspaceName = params.get("workspace");

  const effectiveError = useGet(effectiveError$);
  const statusLoadable = useLoadable(slackConnectStatus$);
  const status: PageStatus =
    effectiveError !== ""
      ? { kind: "error", message: effectiveError }
      : statusLoadable.state === "loading"
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
            : { kind: "connect" };

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
    "workspaceName" in status
      ? (status.workspaceName ?? callbackWorkspaceName)
      : callbackWorkspaceName;
  const pageSignal = useGet(pageSignal$);
  const handleConnect = (intent: "connect" | "switch") => {
    detach(connect(intent, pageSignal), Reason.DomCallback);
  };

  // Error state
  if (status.kind === "error") {
    return <ConnectErrorState message={status.message} />;
  }
  // Success state
  if (status.kind === "success") {
    return <SlackSuccessState workspaceName={workspaceName} />;
  }

  // Loading — checking login / connection status
  if (status.kind === "checking") {
    return <ConnectCheckingState />;
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
          handleConnect("switch");
        }}
      />
    );
  }

  // Connect confirmation (from Slack link with w + u params)
  if (workspaceId && slackUserId) {
    return (
      <>
        <BrandSlack size={40} className="" />
        <CenterText
          title={t(($) => {
            return $.connectors.providerConnect.slack.connectTitle;
          })}
          body={t(($) => {
            return $.connectors.providerConnect.slack.connectDescription;
          })}
        />
        <ConnectErrorAlert error={connectError} />
        <ConnectSubmitButton
          connecting={connectLoading}
          onConnect={() => {
            handleConnect("connect");
          }}
          spinnerClassName="animate-spin mr-2"
        />
        <SettingsBackLink />
      </>
    );
  }

  // No params — invalid access
  return (
    <ConnectInvalidLinkState
      description={t(($) => {
        return $.connectors.providerConnect.slack.invalidDescription;
      })}
    />
  );
}

function SlackSuccessState({
  workspaceName,
}: {
  workspaceName: string | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      <CircleCheck size={40} className="text-emerald-500" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.slack.successTitle;
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
        <Button
          size="default"
          className="w-full gap-2"
          onClick={() => {
            window.location.href = "slack://open";
          }}
        >
          <BrandSlack size={16} />
          {t(($) => {
            return $.connectors.providerConnect.slack.open;
          })}
        </Button>
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
