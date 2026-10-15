import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button, surfaceVariants } from "@okouai/ui";
import { CircleCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import {
  connectTeamsAccount$,
  teamsConnectPageState$,
  type TeamsConnectPageState,
} from "../../signals/okou-page/teams-connect-signals.ts";
import { teamsCompletionUrl } from "../../signals/okou-page/teams-connect-context.ts";
import { openFreshOAuth } from "../../lib/oauth-window.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import {
  CenterText,
  ConnectCheckingState,
  ConnectErrorAlert,
  ConnectSubmitButton,
  SettingsBackLink,
  connectErrorMessage,
} from "./connect-page-shell.tsx";
import { TeamsStatusRefresh } from "./teams-status-refresh.tsx";

type PageProps = { readonly page: TeamsConnectPageState };
type BindingProps = {
  readonly connecting: boolean;
  readonly onConnect: () => void;
};

export function TeamsConnectPage() {
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background p-4 pb-safe">
      <div
        className={surfaceVariants({
          className:
            "mx-auto my-4 flex w-full max-w-sm flex-col items-center gap-5 p-5 sm:p-8",
        })}
      >
        <PageContent />
      </div>
    </div>
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
      <TeamsStatusRefresh />
      <SettingsBackLink />
    </>
  );
}

function ConnectionResult({
  page,
  connecting,
  onConnect,
}: PageProps & BindingProps) {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const requestedName =
    params.get("teamsUserDisplayName") ?? params.get("displayName");
  return (
    <>
      {page.success ? (
        <CircleCheck size={40} className="text-emerald-500" />
      ) : (
        <img src={settingsIconAssetUrl("teams")} alt="" className="h-10 w-10" />
      )}
      <ConnectionHeading page={page} />
      <TargetNotice page={page} />
      {!page.success && requestedName && (
        <p className="text-sm text-muted-foreground">
          {t(
            ($) => {
              return $.connectors.providerConnect.teams.requestedAccount;
            },
            { name: requestedName },
          )}
        </p>
      )}
      <CurrentTeamsState page={page} />
      <PermissionActions page={page} />
      <BindingAndInstallActions
        page={page}
        connecting={connecting}
        onConnect={onConnect}
      />
      <AuthorizationHelp page={page} />
      <a
        href={page.returnUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-primary underline"
      >
        {t(($) => {
          return $.connectors.providerConnect.teams.open;
        })}
      </a>
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
              data.tenantId ??
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
    case "unknown": {
      return (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.providerConnect.teams.identityUnknown;
          })}
        </p>
      );
    }
    case "different": {
      return (
        <p role="status" className="text-sm text-muted-foreground">
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

function CurrentTeamsState({ page }: PageProps) {
  const { t } = useTranslation();
  const { data } = page;
  if (!page.connected && !data.linkedAccounts?.length && !data.tenantId) {
    return null;
  }
  return (
    <section className="w-full space-y-2 break-words text-sm">
      <h3 className="font-medium">
        {t(($) => {
          return $.connectors.providerConnect.teams.currentState;
        })}
      </h3>
      {data.tenantId && (
        <p>{[data.tenantName, data.tenantId].filter(Boolean).join(" · ")}</p>
      )}
      {data.teamId && (
        <p>{[data.teamName, data.teamId].filter(Boolean).join(" · ")}</p>
      )}
      {data.linkedAccounts?.map((account) => {
        return (
          <p
            key={`${account.tenantId}:${account.teamsUserId}:${account.teamsAadObjectId}`}
          >
            {[
              account.displayName,
              account.userPrincipalName,
              account.teamsUserId,
              account.teamsAadObjectId,
              account.tenantId,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        );
      })}
      {page.connected && !page.success && (
        <p>
          {t(($) => {
            return $.connectors.providerConnect.teams.existingConnection;
          })}
        </p>
      )}
    </section>
  );
}

function PermissionActions({ page }: PageProps) {
  const { t } = useTranslation();
  const { data } = page;
  if (!data.permissionMismatch) {
    return null;
  }
  return (
    <>
      <p role="status" className="text-sm text-muted-foreground">
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
  const oauthUrl = teamsCompletionUrl(data.connectUrl);
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
        <p role="status" className="text-sm text-muted-foreground">
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
          <p role="status" className="text-sm text-muted-foreground">
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
      className="text-sm text-primary underline"
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
