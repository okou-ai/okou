import type { TeamsConnectStatus } from "@okouai/api-contracts/contracts/teams-connect";
import type { Command } from "ccstate";
import { ProviderCardMenu } from "./components/provider-card-menu.tsx";
import { ConnectedIndicator } from "./components/connected-indicator.tsx";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLoadable,
  type Loadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { AlertTriangle, EllipsisVertical, Download } from "lucide-react";
import { surfaceVariants, Button, buttonVariants, cn } from "@okouai/ui";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/validators/integrations-telegram";
import type { TelegramBot } from "@okouai/api-contracts/contracts/integrations-telegram";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
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
import {
  disconnectTelegramAccount$,
  telegramBots$,
} from "../../signals/okou-page/telegram.ts";
import { authorizeTelegramBot$ } from "../../signals/okou-page/telegram-authorization.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { teamsEntryUrl } from "../../signals/okou-page/teams-connect-context.ts";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { openFreshOAuth } from "../../lib/oauth-window.ts";
import { WechatCard } from "./wechat-card.tsx";
import { WhatsappCard } from "./whatsapp-card.tsx";
import { AgentPhoneCard } from "./agentphone-card.tsx";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { FeishuCard } from "./feishu-card.tsx";
import type { DiscordOrgStatus } from "@okouai/api-contracts/contracts/integrations-discord";
import { DiscordMark } from "./components/discord-mark.tsx";
import {
  discordDescription,
  DiscordAuthorizationActions,
} from "./discord-authorization-actions.tsx";
import {
  discordOrgData$,
  disconnectDiscordOrg$,
  selectDiscordDmBinding$,
} from "../../signals/okou-page/discord.ts";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { connectDiscordFromWorks$ } from "../../signals/okou-page/discord-connect-signals.ts";

const slackIconImg = settingsIconAssetUrl("slack");
const teamsIconImg = settingsIconAssetUrl("teams");
const githubIconImg = settingsIconAssetUrl("github");
const telegramIconImg = settingsIconAssetUrl("telegram");

function ProviderCardActions({
  isConnected,
  independentIdentity = false,
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
  independentIdentity?: boolean;
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
      {(isInstalled || independentIdentity) && !isConnected && connectUrl && (
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
      {((isInstalled && (isConnected || isAdmin)) ||
        (independentIdentity && isConnected)) && (
        <ProviderCardMenu
          moreOptionsLabel={moreOptionsLabel}
          disconnectLabel={disconnectLabel}
          uninstallLabel={uninstallLabel}
          disconnecting={disconnecting}
          onDisconnect={isConnected ? onDisconnect : undefined}
          onUninstall={isAdmin && isInstalled ? onUninstall : undefined}
        />
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
  uninstall$,
  title,
  description,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  uninstall$: Command<Promise<unknown>, [AbortSignal]>;
  title: string;
  description: string;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [uninstallLoadable, uninstall] = useLoadableSet(uninstall$);
  const uninstalling = uninstallLoadable.state === "loading";
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
              detach(uninstall(pageSignal), Reason.DomCallback);
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
        uninstall$={uninstallSlackOrg$}
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

function DiscordDmSelection({
  data,
  saving,
  onSelect,
}: {
  data: DiscordOrgStatus;
  saving: boolean;
  onSelect: (connectionId: string) => void;
}) {
  const { t } = useTranslation();
  const items = data.dmBindings.map((binding) => {
    return {
      value: binding.connectionId,
      label: binding.workspaceName,
    };
  });
  return (
    <div className="flex flex-col gap-2 border-t border-border p-4">
      <label
        htmlFor="discord-workspace"
        className="text-sm font-medium text-foreground"
      >
        {t(($) => {
          return $.works.discord.defaultWorkspace;
        })}
      </label>
      <Select
        items={items}
        value={data.dmSelectionConnectionId}
        disabled={saving}
        onValueChange={(connectionId, details) => {
          if (
            connectionId === null ||
            !items.some((item) => {
              return item.value === connectionId;
            })
          ) {
            details.cancel();
            return;
          }
          if (connectionId !== data.dmSelectionConnectionId) {
            onSelect(connectionId);
          }
        }}
      >
        <SelectTrigger id="discord-workspace" variant="neutral">
          <SelectValue
            placeholder={t(($) => {
              return $.works.discord.chooseWorkspace;
            })}
          />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function DiscordCardDescription({ data }: { data: DiscordOrgStatus | null }) {
  const { t } = useTranslation();
  return (
    <p className="text-sm text-muted-foreground">
      {data
        ? discordDescription(data)
        : t(($) => {
            return $.works.discord.description;
          })}
    </p>
  );
}

function DiscordCard() {
  const { t } = useTranslation();
  const title = t(($) => {
    return $.works.discord.title;
  });
  const status = useLastLoadable(discordOrgData$);
  const [disconnectState, disconnect] = useLoadableSet(disconnectDiscordOrg$);
  const [installation, install] = useLoadableSet(connectDiscordFromWorks$);
  const [selectionState, selectBinding] = useLoadableSet(
    selectDiscordDmBinding$,
  );
  const pageSignal = useGet(pageSignal$);
  const data = status.state === "hasData" ? status.data : null;

  return (
    <>
      <section
        data-slot="integration-card"
        aria-label={title}
        className={surfaceVariants({ className: "flex flex-col" })}
      >
        <div className="flex items-center gap-4 p-4">
          <div className="shrink-0 text-foreground">
            <DiscordMark size={28} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="text-sm font-medium text-foreground">{title}</div>
            <DiscordCardDescription data={data} />
          </div>
          <DiscordAuthorizationActions
            data={data}
            disabled={disconnectState.state === "loading"}
          />
          {data?.isConnected ? (
            <>
              <ConnectedIndicator testId="discord-connected-indicator" />
              <ProviderCardMenu
                moreOptionsLabel={t(($) => {
                  return $.works.actions.moreOptions;
                })}
                disconnectLabel={t(($) => {
                  return $.works.discord.disconnect;
                })}
                disconnecting={disconnectState.state === "loading"}
                disabled={installation.state === "loading"}
                onDisconnect={() => {
                  detach(disconnect(pageSignal), Reason.DomCallback);
                }}
              >
                {data.isAvailable ? (
                  <button
                    type="button"
                    disabled={
                      disconnectState.state === "loading" ||
                      installation.state === "loading"
                    }
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-state-hover hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
                    onClick={() => {
                      detach(
                        install({ flow: "install" }, pageSignal),
                        Reason.DomCallback,
                      );
                    }}
                  >
                    {t(($) => {
                      return $.works.discord.addNewServer;
                    })}
                  </button>
                ) : null}
              </ProviderCardMenu>
            </>
          ) : null}
        </div>
        {data?.isConnected && data.dmBindings.length > 1 ? (
          <DiscordDmSelection
            data={data}
            saving={selectionState.state === "loading"}
            onSelect={(connectionId) => {
              detach(
                selectBinding(connectionId, pageSignal),
                Reason.DomCallback,
              );
            }}
          />
        ) : null}
      </section>
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

function teamsCardConnection(data: TeamsConnectStatus | null) {
  if (!data) {
    return {
      isConnected: false,
      isInstalled: false,
      isAdmin: false,
      connectedDetail: null,
      independentIdentity: false,
      descriptionInstalled: false,
      installUrl: null,
      connectUrl: null,
    };
  }
  const independentIdentity = data.workspaceIdentity === true;
  const isConnected =
    data.isConnected === true &&
    (data.workspaceIdentity === true ||
      (data.isInstalled && data.pendingInstallation !== true));
  const isInstalled = data.isInstalled;
  const isAdmin = data.isAdmin;
  const connectedDetail = independentIdentity
    ? (data.linkedAccounts[0]?.displayName ?? data.tenantName)
    : (data.teamName ?? data.tenantName);

  const entryUrl = teamsEntryUrl(data);
  return {
    isConnected,
    isInstalled,
    isAdmin,
    connectedDetail,
    independentIdentity: independentIdentity,
    descriptionInstalled: independentIdentity || isInstalled,
    installUrl: independentIdentity ? data.installUrl : entryUrl,
    connectUrl: independentIdentity ? data.connectUrl : entryUrl,
  };
}

function TeamsCard({ displayName }: { displayName: string }) {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const teamsDataLoadable = useLoadable(teamsOrgData$);
  const teamsData =
    teamsDataLoadable.state === "hasData" ? teamsDataLoadable.data : null;
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectTeamsOrg$);
  const disconnecting = disconnectLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const showUninstallDialog = useGet(showTeamsUninstallDialog$);
  const setShowUninstallDialog = useSet(setShowTeamsUninstallDialog$);

  const connection = teamsCardConnection(teamsData);
  const { isConnected, isInstalled, isAdmin, connectedDetail } = connection;
  const permissionMismatch = teamsData?.permissionMismatch === true;
  const description = teamsData
    ? teamsCardDescription({
        isInstalled: connection.descriptionInstalled,
        isConnected,
        isAdmin,
      })
    : teamsDataLoadable.state === "hasError"
      ? t(($) => {
          return $.connectors.providerConnect.teams.statusFailed;
        })
      : t(($) => {
          return $.connectors.providerConnect.common.checkingTitle;
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
            independentIdentity={connection.independentIdentity}
            isConnected={isConnected}
            isInstalled={isInstalled}
            isAdmin={isAdmin}
            installUrl={connection.installUrl}
            connectUrl={connection.connectUrl}
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
            isAdmin && permissionMismatch
              ? INTEGRATION_SETTINGS_PATHS.teams
              : null
          }
          message={t(($) => {
            return $.works.teams.permissionsUpdated;
          })}
        />
      </div>

      <UninstallConfirmDialog
        open={showUninstallDialog}
        setOpen={setShowUninstallDialog}
        uninstall$={uninstallTeamsOrg$}
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
          <a
            data-testid="github-install-button"
            href={githubData.installUrl}
            target="_blank"
            rel="noreferrer"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "h-8 shrink-0 gap-1.5 rounded-lg",
            )}
          >
            <Download size={14} />
            {t(($) => {
              return $.works.github.install;
            })}
          </a>
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

function TelegramConnectionFeedback({
  connected,
  connection,
}: {
  connected: boolean;
  connection: Loadable<unknown> | { state: "idle" };
}) {
  const { t } = useTranslation();
  if (
    connected ||
    !(
      connection.state === "hasError" ||
      (connection.state === "hasData" && !connection.data)
    )
  ) {
    return null;
  }
  return (
    <p role="status" className="px-4 pb-2 text-sm text-muted-foreground">
      {t(($) => {
        return $.connectors.providerConnect.telegram.interrupted;
      })}
    </p>
  );
}

function telegramConnectedDetail(bot: TelegramBot | undefined) {
  const connectedUser = bot?.connectedUser;
  const username = connectedUser?.telegramUsername?.trim().replace(/^@+/, "");
  return username
    ? `@${username}`
    : connectedUser?.telegramDisplayName?.trim() ||
        connectedUser?.telegramUserId;
}

function TelegramCard() {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const botsLoadable = useLoadable(telegramBots$);
  const bot =
    botsLoadable.state === "hasData"
      ? botsLoadable.data.find((entry) => {
          return entry.id === OFFICIAL_TELEGRAM_BOT_ID;
        })
      : undefined;
  const [connectLoadable, connect] = useLoadableSet(authorizeTelegramBot$);
  const [disconnectLoadable, disconnect] = useLoadableSet(
    disconnectTelegramAccount$,
  );
  const connecting = connectLoadable.state === "loading";
  const disconnecting = disconnectLoadable.state === "loading";
  const loading = botsLoadable.state === "loading";
  const configured = bot && bot.official?.configured !== false;
  const connectedDetail = telegramConnectedDetail(bot);

  return (
    <div
      data-slot="integration-card"
      className={surfaceVariants({ className: "flex flex-col" })}
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
          <div className="text-sm text-muted-foreground">
            {botsLoadable.state === "hasError"
              ? t(($) => {
                  return $.connectors.providerSettings.telegram.loadError;
                })
              : !loading && !configured
                ? t(($) => {
                    return $.connectors.providerSettings.telegram
                      .officialMissing;
                  })
                : t(($) => {
                    return $.works.telegram.description;
                  })}
          </div>
        </div>
        {bot?.isConnected ? (
          <>
            <ConnectedIndicator
              testId="telegram-connected-indicator"
              connectedDetail={connectedDetail}
            />
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    showTooltip
                    type="button"
                    variant="quiet"
                    size="icon-xs"
                    className="shrink-0"
                    aria-label={t(($) => {
                      return $.works.actions.moreOptions;
                    })}
                  >
                    <EllipsisVertical size={16} />
                  </Button>
                }
              />
              <PopoverContent
                align="end"
                className="flex w-40 flex-col gap-0.5 p-2"
              >
                <button
                  type="button"
                  disabled={disconnecting}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-state-hover hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => {
                    detach(
                      disconnect(OFFICIAL_TELEGRAM_BOT_ID, pageSignal),
                      Reason.DomCallback,
                    );
                  }}
                >
                  {disconnecting
                    ? t(($) => {
                        return $.works.actions.disconnecting;
                      })
                    : t(($) => {
                        return $.works.actions.disconnect;
                      })}
                </button>
              </PopoverContent>
            </Popover>
          </>
        ) : (
          <Button
            data-testid="telegram-connect-button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5 rounded-lg"
            disabled={loading || !configured || connecting}
            onClick={() => {
              detach(
                connect(OFFICIAL_TELEGRAM_BOT_ID, "works", pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            {t(($) => {
              return $.works.actions.connect;
            })}
          </Button>
        )}
      </div>
      <TelegramConnectionFeedback
        connected={bot?.isConnected === true}
        connection={connectLoadable}
      />
    </div>
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

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-safe-or-8">
        <div className="mx-auto max-w-[900px] flex flex-col gap-4">
          <SlackCard displayName={displayName} />
          <TeamsCard displayName={displayName} />
          <DiscordCard />
          <GithubCard />
          {feishuEnabled ? <FeishuCard /> : null}
          {features[FeatureSwitchKey.LarkIntegration] ? (
            <FeishuCard platform="lark" />
          ) : null}
          <TelegramCard />
          <AgentPhoneCard />
          {features[FeatureSwitchKey.WhatsappIntegration] ? (
            <WhatsappCard />
          ) : null}
          {features[FeatureSwitchKey.WechatIntegration] ? <WechatCard /> : null}
        </div>
      </main>
    </div>
  );
}
