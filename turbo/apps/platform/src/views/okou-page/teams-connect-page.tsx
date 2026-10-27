import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button, buttonVariants, cn } from "@okouai/ui";
import { CircleCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import {
  connectTeamsAccount$,
  teamsConnectPageState$,
  type TeamsConnectPageState,
} from "../../signals/okou-page/teams-connect-signals.ts";
import { teamsConnectUrl } from "../../signals/okou-page/teams-connect-context.ts";
import { openFreshOAuth } from "../../lib/oauth-window.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import {
  CenterText,
  ConnectCheckingState,
  ConnectErrorAlert,
  ConnectSubmitButton,
  PageShell,
  SettingsBackLink,
  connectErrorMessage,
} from "./connect-page-shell.tsx";

type PageProps = { readonly page: TeamsConnectPageState };
type BindingProps = {
  readonly connecting: boolean;
  readonly onConnect: () => void;
};

export function TeamsConnectPage() {
  return (
    <PageShell>
      <PageContent />
    </PageShell>
  );
}

function PageContent() {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const status = useLoadable(teamsConnectPageState$);
  const [binding, connect] = useLoadableSet(connectTeamsAccount$);
  const signal = useGet(pageSignal$);
  const failure = t(($) => {
    return $.connectors.providerConnect.common.connectionFailed;
  });
  return (
    <>
      <ConnectErrorAlert error={params.get("error")} />
      <ConnectErrorAlert
        error={
          binding.state === "hasError"
            ? connectErrorMessage(binding.error, failure)
            : null
        }
      />
      {status.state === "hasData" ? (
        <ConnectionResult
          page={status.data}
          connecting={binding.state === "loading"}
          onConnect={() => {
            detach(connect(signal), Reason.DomCallback);
          }}
        />
      ) : status.state === "loading" ? (
        <ConnectCheckingState />
      ) : (
        <CenterText
          title={failure}
          body={t(($) => {
            return $.connectors.providerConnect.teams.statusFailed;
          })}
        />
      )}
      <div className="flex w-full flex-col gap-3">
        {status.state === "hasData" && (
          <a
            href={status.data.returnUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              buttonVariants({
                variant: status.data.success ? "default" : "outline",
              }),
              "w-full gap-2",
            )}
          >
            <img
              src={settingsIconAssetUrl("teams")}
              alt=""
              className="h-4 w-4"
            />
            {t(($) => {
              return $.connectors.providerConnect.teams.open;
            })}
          </a>
        )}
        <div className="flex justify-center">
          <SettingsBackLink />
        </div>
      </div>
    </>
  );
}

function ConnectionResult({
  page,
  connecting,
  onConnect,
}: PageProps & BindingProps) {
  return (
    <>
      {page.success ? (
        <CircleCheck size={40} className="text-emerald-500" />
      ) : (
        <img src={settingsIconAssetUrl("teams")} alt="" className="h-10 w-10" />
      )}
      <ConnectionHeading page={page} />
      <TargetNotice page={page} />
      <PermissionActions page={page} />
      <BindingAndInstallActions
        page={page}
        connecting={connecting}
        onConnect={onConnect}
      />
      <AuthorizationHelp page={page} />
    </>
  );
}

function ConnectionHeading({ page }: PageProps) {
  const { t } = useTranslation();
  const { data } = page;
  if (page.success) {
    const body = data.botName
      ? t(
          ($) => {
            return $.connectors.providerConnect.teams.successDescription;
          },
          {
            team:
              data.teamName ??
              data.tenantName ??
              t(($) => {
                return $.connectors.providerConnect.teams.providerName;
              }),
            botName: data.botName,
          },
        )
      : t(($) => {
          return $.connectors.providerConnect.teams.connectedDescription;
        });
    return (
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.teams.successTitle;
        })}
        body={body}
      />
    );
  }
  const pending = data.pendingInstallation === true && !data.isInstalled;
  return (
    <CenterText
      title={
        pending
          ? t(($) => {
              return $.connectors.providerConnect.teams.pendingTitle;
            })
          : t(($) => {
              return $.connectors.providerConnect.teams.connectTitle;
            })
      }
      body={
        pending
          ? t(($) => {
              return $.connectors.providerConnect.teams.pendingDescription;
            })
          : t(($) => {
              return $.connectors.providerConnect.teams.connectDescription;
            })
      }
    />
  );
}

function TargetNotice({ page }: PageProps) {
  const { t } = useTranslation();
  switch (page.target) {
    case "orgMismatch": {
      return (
        <ConnectErrorAlert
          error={t(($) => {
            return $.connectors.providerConnect.teams.orgMismatch;
          })}
        />
      );
    }
    case "invalid": {
      return (
        <ConnectErrorAlert
          error={t(($) => {
            return $.connectors.providerConnect.teams.invalidContext;
          })}
        />
      );
    }
    case "different": {
      return (
        <p role="status" className="text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.providerConnect.teams.identityMismatch;
          })}
        </p>
      );
    }
    case "none":
    case "match": {
      return null;
    }
  }
}

function PermissionActions({ page }: PageProps) {
  const { t } = useTranslation();
  const { data } = page;
  if (!data.permissionMismatch) {
    return null;
  }
  return (
    <>
      <p role="status" className="text-center text-sm text-muted-foreground">
        {t(($) => {
          return $.works.teams.permissionsUpdated;
        })}
      </p>
      {data.isAdmin && data.reinstallUrl && (
        <TeamsInstallLink url={data.reinstallUrl} reinstall />
      )}
    </>
  );
}

function BindingAndInstallActions({
  page,
  connecting,
  onConnect,
}: PageProps & BindingProps) {
  const { data } = page;
  const pending = data.pendingInstallation === true && !data.isInstalled;
  const installMatches = page.target === "none" || page.target === "match";
  return (
    <>
      {pending && installMatches && data.isAdmin && data.installUrl && (
        <TeamsInstallLink url={data.installUrl} />
      )}
      {!page.success && page.canBind && !pending && (
        <ConnectSubmitButton connecting={connecting} onConnect={onConnect} />
      )}
    </>
  );
}

function AuthorizationHelp({ page }: PageProps) {
  const { t } = useTranslation();
  const { data } = page;
  const pending = data.pendingInstallation === true && !data.isInstalled;
  const oauthUrl = teamsConnectUrl(data.connectUrl);
  const canAuthorize =
    !page.success &&
    (!pending || !data.installUrl) &&
    oauthUrl &&
    page.target !== "orgMismatch";
  return (
    <>
      {canAuthorize && (
        <Button
          className="w-full"
          onClick={() => {
            openFreshOAuth(oauthUrl);
          }}
        >
          {t(($) => {
            return $.connectors.providerConnect.teams.authorize;
          })}
        </Button>
      )}
      {!data.isInstalled && !data.isAdmin && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.works.teams.adminInstall;
          })}
        </p>
      )}
      {!page.success &&
        data.isAdmin &&
        !canAuthorize &&
        !page.canBind &&
        !data.installUrl && (
          <p
            role="status"
            className="text-center text-sm text-muted-foreground"
          >
            {t(($) => {
              return $.connectors.providerConnect.teams.unavailable;
            })}
          </p>
        )}
    </>
  );
}

function TeamsInstallLink({
  url,
  reinstall = false,
}: {
  readonly url: string;
  readonly reinstall?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(buttonVariants(), "w-full")}
    >
      {reinstall
        ? t(($) => {
            return $.connectors.providerConnect.teams.reinstall;
          })
        : t(($) => {
            return $.connectors.providerConnect.teams.install;
          })}
    </a>
  );
}
