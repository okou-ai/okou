import { useGet, useLoadable } from "ccstate-react";
import { Button, buttonVariants, cn } from "@okouai/ui";
import { CircleCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { searchParams$ } from "../../signals/route.ts";
import {
  teamsConnectPageState$,
  type TeamsConnectPageState,
} from "../../signals/okou-page/teams-connect-signals.ts";
import { teamsConnectUrl } from "../../signals/okou-page/teams-connect-context.ts";
import { openFreshOAuth } from "../../lib/oauth-window.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import {
  CenterText,
  ConnectCheckingState,
  ConnectErrorAlert,
  PageShell,
  SettingsBackLink,
} from "./connect-page-shell.tsx";

type PageProps = { readonly page: TeamsConnectPageState };
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
  const failure = t(($) => {
    return $.connectors.providerConnect.common.connectionFailed;
  });
  return (
    <>
      <ConnectErrorAlert error={params.get("error")} />
      {status.state === "hasData" ? (
        <ConnectionResult page={status.data} />
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
            href="https://teams.microsoft.com/"
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

function ConnectionResult({ page }: PageProps) {
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
      <InstallAction page={page} />
      <AuthorizationHelp page={page} />
    </>
  );
}

function ConnectionHeading({ page }: PageProps) {
  const { t } = useTranslation();
  const { data } = page;
  if (page.success) {
    return (
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.teams.successTitle;
        })}
        body={t(($) => {
          return $.connectors.providerConnect.teams.connectedDescription;
        })}
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

function InstallAction({ page }: PageProps) {
  const { data } = page;
  return !data.isInstalled && data.isAdmin && data.installUrl ? (
    <TeamsInstallLink url={data.installUrl} />
  ) : null;
}

function AuthorizationHelp({ page }: PageProps) {
  const { t } = useTranslation();
  const { data } = page;
  const oauthUrl = teamsConnectUrl(data.connectUrl);
  const canAuthorize = !page.success && oauthUrl;
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
      {!page.success && data.isAdmin && !canAuthorize && !data.installUrl && (
        <p role="status" className="text-center text-sm text-muted-foreground">
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
