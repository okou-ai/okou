import { useGet, useSet, useLastLoadable, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  AlertTriangle,
  CircleCheck,
  EllipsisVertical,
  Download,
  Settings,
} from "lucide-react";
import { surfaceVariants, Button } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { currentChatAgentDisplayName$ } from "../../signals/agent-chat.ts";
import { assistantName$, brandName$ } from "../../signals/branding.ts";
import {
  slackOrgData$,
  disconnectSlackOrg$,
  uninstallSlackOrg$,
  showUninstallDialog$,
  setShowUninstallDialog$,
} from "../../signals/okou-page/slack.ts";
import {
  disconnectTeamsOrg$,
  teamsOrgData$,
  showTeamsUninstallDialog$,
  setShowTeamsUninstallDialog$,
  uninstallTeamsOrg$,
} from "../../signals/okou-page/teams.ts";
import {
  connectGithubInstallation$,
  githubIntegrationData$,
} from "../../signals/okou-page/github.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { ROUTES } from "../../signals/route-paths.ts";
import { now } from "../../lib/time.ts";
import { AgentPhoneCard } from "./agentphone-card.tsx";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { FeishuCard } from "./feishu-card.tsx";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";

const slackIconImg = settingsIconAssetUrl("slack");
const teamsIconImg = settingsIconAssetUrl("teams");
const githubIconImg = settingsIconAssetUrl("github");
const telegramIconImg = settingsIconAssetUrl("telegram");

/** Append a cache-busting timestamp and forward ?prompt= so the OAuth flow can
 *  carry it through to the Slack DM greeting. */
function openFreshOAuth(url: string) {
  const fresh = new URL(url, window.location.origin);
  const prompt = new URLSearchParams(window.location.search).get("prompt");
  if (prompt) {
    fresh.searchParams.set("prompt", prompt);
  }
  fresh.searchParams.set("_t", String(now()));
  window.open(fresh.toString(), "_blank");
}

function ConnectedIndicator({
  testId,
  connectedDetail,
}: {
  testId: string;
  connectedDetail?: string | null;
}) {
  const { t } = useTranslation();

  return (
    <span
      data-testid={testId}
      className="inline-flex min-w-0 max-w-52 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
    >
      <CircleCheck className="h-3 w-3 text-green-600" />
      <span className="min-w-0 truncate" title={connectedDetail ?? ""}>
        {connectedDetail
          ? t(
              ($) => {
                return $.works.connectedWithDetail;
              },
              { detail: connectedDetail },
            )
          : t(($) => {
              return $.works.connected;
            })}
      </span>
    </span>
  );
}

function ProviderCardActions({
  isConnected,
  isInstalled,
  isAdmin,
  installUrl,
  connectUrl,
  connectedDetail,
  connectedTestId,
  installTestId,
  connectTestId,
  installLabel,
  moreOptionsLabel,
  disconnectLabel,
  uninstallLabel,
  onDisconnect,
  onUninstall,
  disconnecting,
}: {
  isConnected: boolean;
  isInstalled: boolean;
  isAdmin: boolean;
  installUrl: string | null | undefined;
  connectUrl: string | null | undefined;
  connectedDetail?: string | null;
  connectedTestId: string;
  installTestId: string;
  connectTestId?: string;
  installLabel: string;
  moreOptionsLabel: string;
  disconnectLabel: string;
  uninstallLabel: string;
  onDisconnect: () => void;
  onUninstall: () => void;
  disconnecting: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {isConnected ? (
        <ConnectedIndicator
          testId={connectedTestId}
          connectedDetail={connectedDetail}
        />
      ) : null}
      {!isInstalled && isAdmin && installUrl && (
        <Button
          data-testid={installTestId}
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={() => {
            return openFreshOAuth(installUrl);
          }}
        >
          <Download size={14} />
          {installLabel}
        </Button>
      )}
      {isInstalled && !isConnected && connectUrl && (
        <Button
          data-testid={connectTestId}
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          onClick={() => {
            return openFreshOAuth(connectUrl);
          }}
        >
          {t(($) => {
            return $.works.actions.connect;
          })}
        </Button>
      )}
      {isInstalled && (isConnected || isAdmin) && (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              showTooltip
              type="button"
              variant="quiet"
              size="icon-xs"
              className="shrink-0"
              aria-label={moreOptionsLabel}
            >
              <EllipsisVertical size={16} />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex flex-col gap-0.5 w-40 p-2"
          >
            {isConnected && (
              <button
                type="button"
                aria-label={disconnectLabel}
                disabled={disconnecting}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-state-hover hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
                onClick={onDisconnect}
              >
                {disconnecting
                  ? t(($) => {
                      return $.works.actions.disconnecting;
                    })
                  : t(($) => {
                      return $.works.actions.disconnect;
                    })}
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                aria-label={uninstallLabel}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left text-destructive hover:bg-state-hover hover:text-accent-foreground transition-colors"
                onClick={onUninstall}
              >
                {t(($) => {
                  return $.works.actions.uninstall;
                })}
              </button>
            )}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

function PermissionWarning({
  reinstallUrl,
  message,
}: {
  reinstallUrl: string | null | undefined;
  message: string;
}) {
  const { t } = useTranslation();
  if (!reinstallUrl) {
    return null;
  }

  return (
    <div className="flex items-center gap-3 border-t border-border/50 px-4 py-3">
      <AlertTriangle size={16} className="shrink-0 text-amber-500" />
      <span className="flex-1 text-sm text-amber-600 dark:text-amber-400">
        {message}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 text-xs"
        onClick={() => {
          return openFreshOAuth(reinstallUrl);
        }}
      >
        {t(($) => {
          return $.works.actions.updatePermissions;
        })}
      </Button>
    </div>
  );
}

function UninstallConfirmDialog({
  open,
  setOpen,
  uninstalling,
  uninstall,
  title,
  description,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  uninstalling: boolean;
  uninstall: () => Promise<unknown>;
  title: string;
  description: string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!uninstalling) {
          setOpen(v);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={uninstalling}
            onClick={() => {
              return setOpen(false);
            }}
          >
            {t(($) => {
              return $.works.actions.cancel;
            })}
          </Button>
          <Button
            variant="destructive"
            disabled={uninstalling}
            onClick={() => {
              detach(
                (async () => {
                  await uninstall();
                  setOpen(false);
                })(),
                Reason.DomCallback,
              );
            }}
          >
            {uninstalling
              ? t(($) => {
                  return $.works.actions.uninstalling;
                })
              : t(($) => {
                  return $.works.actions.uninstall;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SlackCard({ displayName }: { displayName: string }) {
  const { t } = useTranslation();
  // useLastLoadable keeps the prior resolved value during the polling refetch
  // so the card text doesn't flicker back to defaults on every poll cycle.
  const slackDataLoadable = useLastLoadable(slackOrgData$);
  const slackData =
    slackDataLoadable.state === "hasData" ? slackDataLoadable.data : null;
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectSlackOrg$);
  const disconnecting = disconnectLoadable.state === "loading";
  const [uninstallLoadable, uninstall] = useLoadableSet(uninstallSlackOrg$);
  const uninstalling = uninstallLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const showUninstallDialog = useGet(showUninstallDialog$);
  const setShowUninstallDialog = useSet(setShowUninstallDialog$);

  const isConnected = slackData?.isConnected ?? false;
  const isInstalled = slackData?.isInstalled ?? isConnected;
  const isAdmin = slackData?.isAdmin ?? false;
  const scopeMismatch = slackData?.scopeMismatch === true;
  const reinstallUrl = slackData?.reinstallUrl;

  return (
    <>
      <div
        data-slot="integration-card"
        className={surfaceVariants({ className: "flex flex-col" })}
      >
        <div className="flex items-center gap-4 p-4">
          <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden">
            <img src={slackIconImg} alt="" className="h-7 w-7 scale-[2.2]" />
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.works.slack.title;
              })}
            </div>
            <div className="text-sm text-muted-foreground">
              {!isInstalled && !isAdmin
                ? t(($) => {
                    return $.works.slack.adminInstall;
                  })
                : t(($) => {
                    return $.works.slack.description;
                  })}
            </div>
          </div>
          <ProviderCardActions
            isConnected={isConnected}
            isInstalled={isInstalled}
            isAdmin={isAdmin}
            installUrl={slackData?.installUrl}
            connectUrl={slackData?.connectUrl}
            connectedDetail={slackData?.workspaceName}
            connectedTestId="slack-connected-indicator"
            installTestId="slack-install-button"
            installLabel={t(($) => {
              return $.works.slack.install;
            })}
            moreOptionsLabel={t(($) => {
              return $.works.actions.moreOptions;
            })}
            disconnectLabel={t(($) => {
              return $.works.actions.disconnect;
            })}
            uninstallLabel={t(($) => {
              return $.works.actions.uninstall;
            })}
            disconnecting={disconnecting}
            onDisconnect={() => {
              return detach(disconnect(pageSignal), Reason.DomCallback);
            }}
            onUninstall={() => {
              return setShowUninstallDialog(true);
            }}
          />
        </div>

        <PermissionWarning
          reinstallUrl={scopeMismatch && isAdmin ? reinstallUrl : null}
          message={t(($) => {
            return $.works.slack.permissionsUpdated;
          })}
        />
      </div>

      <UninstallConfirmDialog
        open={showUninstallDialog}
        setOpen={setShowUninstallDialog}
        uninstalling={uninstalling}
        uninstall={() => {
          return uninstall(pageSignal);
        }}
        title={t(($) => {
          return $.works.slack.uninstallTitle;
        })}
        description={t(
          ($) => {
            return $.works.slack.uninstallDescription;
          },
          { displayName },
        )}
      />
    </>
  );
}

function teamsCardDescription(args: {
  isInstalled: boolean;
  isConnected: boolean;
  isAdmin: boolean;
}): string {
  if (!args.isInstalled && !args.isAdmin) {
    return i18n.t(($) => {
      return $.works.teams.adminInstall;
    });
  }
  if (!args.isInstalled && args.isAdmin) {
    return i18n.t(($) => {
      return $.works.teams.connectThenInstall;
    });
  }
  if (args.isInstalled && !args.isConnected) {
    return i18n.t(($) => {
      return $.works.teams.connectAccount;
    });
  }
  return i18n.t(($) => {
    return $.works.teams.description;
  });
}

function TeamsCard({ displayName }: { displayName: string }) {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const teamsDataLoadable = useLastLoadable(teamsOrgData$);
  const teamsData =
    teamsDataLoadable.state === "hasData" ? teamsDataLoadable.data : null;
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectTeamsOrg$);
  const disconnecting = disconnectLoadable.state === "loading";
  const [uninstallLoadable, uninstall] = useLoadableSet(uninstallTeamsOrg$);
  const uninstalling = uninstallLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const showUninstallDialog = useGet(showTeamsUninstallDialog$);
  const setShowUninstallDialog = useSet(setShowTeamsUninstallDialog$);

  const isConnected = teamsData?.isConnected ?? false;
  const isInstalled = teamsData?.isInstalled ?? false;
  const isAdmin = teamsData?.isAdmin ?? false;
  const connectedDetail = teamsData?.teamName ?? teamsData?.tenantName;
  const permissionMismatch = teamsData?.permissionMismatch === true;
  const description = teamsCardDescription({
    isInstalled,
    isConnected,
    isAdmin,
  });

  return (
    <>
      <div
        data-slot="integration-card"
        className={surfaceVariants({ className: "flex flex-col" })}
      >
        <div className="flex items-center gap-4 p-4">
          <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden">
            <img src={teamsIconImg} alt="" className="h-7 w-7" />
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.works.teams.title;
              })}
            </div>
            <div className="text-sm text-muted-foreground">{description}</div>
          </div>
          <ProviderCardActions
            isConnected={isConnected}
            isInstalled={isInstalled}
            isAdmin={isAdmin}
            installUrl={teamsData?.connectUrl ?? teamsData?.installUrl}
            connectUrl={teamsData?.connectUrl}
            connectedDetail={connectedDetail}
            connectedTestId="teams-connected-indicator"
            installTestId="teams-install-button"
            connectTestId="teams-connect-button"
            installLabel={t(($) => {
              return $.works.teams.install;
            })}
            moreOptionsLabel={t(($) => {
              return $.works.teams.moreOptions;
            })}
            disconnectLabel={t(($) => {
              return $.works.teams.disconnect;
            })}
            uninstallLabel={t(($) => {
              return $.works.teams.uninstall;
            })}
            disconnecting={disconnecting}
            onDisconnect={() => {
              return detach(disconnect(pageSignal), Reason.DomCallback);
            }}
            onUninstall={() => {
              return setShowUninstallDialog(true);
            }}
          />
        </div>

        <PermissionWarning
          reinstallUrl={
            isAdmin && permissionMismatch ? teamsData?.reinstallUrl : null
          }
          message={t(($) => {
            return $.works.teams.permissionsUpdated;
          })}
        />
      </div>

      <UninstallConfirmDialog
        open={showUninstallDialog}
        setOpen={setShowUninstallDialog}
        uninstalling={uninstalling}
        uninstall={() => {
          return uninstall(pageSignal);
        }}
        title={t(($) => {
          return $.works.teams.uninstallTitle;
        })}
        description={t(
          ($) => {
            return $.works.teams.uninstallDescription;
          },
          { brandName, displayName },
        )}
      />
    </>
  );
}

function GithubCard() {
  const { t } = useTranslation();
  const githubDataLoadable = useLastLoadable(githubIntegrationData$);
  const githubData =
    githubDataLoadable.state === "hasData" ? githubDataLoadable.data : null;
  const [connectLoadable, connect] = useLoadableSet(connectGithubInstallation$);
  const pageSignal = useGet(pageSignal$);
  const connecting = connectLoadable.state === "loading";
  const connectedUsername = githubData?.connectedGithubUsername?.trim();
  const connectedDetail = connectedUsername
    ? connectedUsername.startsWith("@")
      ? connectedUsername
      : `@${connectedUsername}`
    : null;
  const adminInstallRequired =
    githubData !== null && !githubData.isInstalled && !githubData.installUrl;

  return (
    <div
      data-slot="integration-card"
      data-testid="github-integration-card"
      className={surfaceVariants({ className: "flex flex-col" })}
    >
      <div className="flex items-center gap-4 p-4">
        <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden">
          <img src={githubIconImg} alt="" className="h-7 w-7" />
        </div>
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.works.github.title;
            })}
          </div>
          <div className="text-sm text-muted-foreground">
            {adminInstallRequired
              ? t(($) => {
                  return $.works.github.adminInstall;
                })
              : t(($) => {
                  return $.works.github.description;
                })}
          </div>
        </div>
        {githubData?.isConnected ? (
          <ConnectedIndicator
            testId="github-connected-indicator"
            connectedDetail={connectedDetail}
          />
        ) : null}
        {githubData && !githubData.isInstalled && githubData.installUrl ? (
          <Button
            asChild
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5 rounded-lg"
          >
            <a
              data-testid="github-install-button"
              href={githubData.installUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Download size={14} />
              {t(($) => {
                return $.works.github.install;
              })}
            </a>
          </Button>
        ) : null}
        {githubData?.isInstalled && !githubData.isConnected ? (
          <Button
            data-testid="github-connect-button"
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5 rounded-lg"
            disabled={connecting}
            onClick={() => {
              return detach(
                connect(githubData.connectUrl, pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            {t(($) => {
              return $.works.actions.connect;
            })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function TelegramCard() {
  const { t } = useTranslation();
  return (
    <Link
      pathname={ROUTES.settingsTelegram}
      data-slot="integration-card"
      className={surfaceVariants({
        className: "flex flex-col text-inherit no-underline",
      })}
      aria-label={t(($) => {
        return $.works.telegram.openSettings;
      })}
    >
      <div className="flex items-center gap-4 p-4">
        <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden">
          <img src={telegramIconImg} alt="" className="h-7 w-7" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-sm font-medium text-foreground">
              {t(($) => {
                return $.works.telegram.title;
              })}
            </div>
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {t(($) => {
              return $.works.telegram.description;
            })}
          </div>
        </div>
        <span className="shrink-0 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-secondary-foreground">
          <Settings size={14} />
          {t(($) => {
            return $.works.actions.manage;
          })}
        </span>
      </div>
    </Link>
  );
}

export function WorksPage() {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const features = useGet(featureSwitch$);
  const feishuEnabled = features[FeatureSwitchKey.FeishuIntegration] ?? false;
  const displayNameLoadable = useLoadable(currentChatAgentDisplayName$);
  const displayName =
    displayNameLoadable.state === "hasData"
      ? (displayNameLoadable.data ?? assistantName)
      : assistantName;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="hidden md:block shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="hidden md:block text-lg font-semibold tracking-tight text-foreground">
            {t(
              ($) => {
                return $.works.header.title;
              },
              { displayName },
            )}
          </h1>
          <p className="hidden md:block mt-0.5 text-sm text-muted-foreground">
            {t(
              ($) => {
                return $.works.header.description;
              },
              { displayName },
            )}
          </p>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-[max(2rem,var(--sab))]">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          <SlackCard displayName={displayName} />
          <TeamsCard displayName={displayName} />
          <GithubCard />
          {feishuEnabled ? <FeishuCard /> : null}
          {features[FeatureSwitchKey.LarkIntegration] ? (
            <FeishuCard platform="lark" />
          ) : null}
          <TelegramCard />
          {features[FeatureSwitchKey.AgentPhoneEntry] ? (
            <AgentPhoneCard />
          ) : null}
        </div>
      </main>
    </div>
  );
}
