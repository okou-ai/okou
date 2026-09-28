import { cn } from "@okouai/ui/lib/utils";
import { surfaceVariants } from "@okouai/ui";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  AlertTriangle,
  ArrowLeft,
  CircleCheck,
  EllipsisVertical,
  Bot,
} from "lucide-react";
import {
  type TelegramBot,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { Button, buttonVariants } from "@okouai/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import { brandName$ } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { apiBase$ } from "../../signals/fetch.ts";
import { authorizeTelegramBot$ } from "../../signals/okou-page/telegram-authorization.ts";
import {
  defaultAgentId$,
  defaultAgentName$,
  sortedAgents$,
} from "../../signals/agent.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  disconnectTelegramAccount$,
  markTelegramAvatarFailed$,
  setTelegramSavingBotId$,
  setTelegramUnlinkingBotId$,
  telegramBots$,
  telegramFailedAvatarKeys$,
  telegramSavingBotId$,
  telegramUnlinkingBotId$,
  updateTelegramBotAgent$,
} from "../../signals/okou-page/telegram.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
} from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { useTranslation } from "react-i18next";

const telegramIconImg = settingsIconAssetUrl("telegram");

interface DefaultAgentLabel {
  agentId: string | null;
  displayName: string | null;
}

type TelegramAgentOption = Pick<AgentResponse, "agentId" | "displayName">;

function isOfficialTelegramBot(bot: TelegramBot): boolean {
  return bot.kind === "official" || bot.id === OFFICIAL_TELEGRAM_BOT_ID;
}

function agentLabel(
  agent: TelegramAgentOption,
  defaultAgent: DefaultAgentLabel,
) {
  if (agent.agentId === defaultAgent.agentId && defaultAgent.displayName) {
    return defaultAgent.displayName;
  }
  return agent.displayName ?? agent.agentId;
}

function buildBotAgentOptions(
  bot: TelegramBot,
  agents: AgentResponse[],
  defaultAgent: DefaultAgentLabel,
) {
  if (
    !bot.agent ||
    agents.some((agent) => {
      return agent.agentId === bot.agent?.id;
    })
  ) {
    return agents;
  }

  return [
    ...agents,
    {
      agentId: bot.agent.id,
      displayName:
        bot.agent.id === defaultAgent.agentId && defaultAgent.displayName
          ? defaultAgent.displayName
          : bot.agent.name,
    },
  ];
}

function TelegramSettingsSkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="telegram-settings-loading"
    >
      <Skeleton className="h-4 w-64 max-w-full" />
      <div className={surfaceVariants({ className: "overflow-hidden" })}>
        {[0, 1, 2].map((index) => {
          return (
            <div key={index}>
              <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-6 w-24 rounded-lg" />
                    </div>
                    <Skeleton className="h-4 w-40 max-w-full" />
                  </div>
                </div>
                <div className="grid gap-2 sm:w-[360px] sm:grid-cols-[1fr_auto]">
                  <Skeleton className="h-9 w-full rounded-md" />
                  <div className="flex items-center justify-end gap-1.5">
                    <Skeleton className="h-9 w-20 rounded-md" />
                    <Skeleton className="h-8 w-8 rounded-md" />
                  </div>
                </div>
              </div>
              {index < 2 ? (
                <div className="mx-5 border-b border-border/50" />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function telegramConnectedUserLabel(bot: TelegramBot): string | null {
  const connectedUser = bot.connectedUser;
  if (!connectedUser) {
    return null;
  }

  const username = connectedUser.telegramUsername?.trim().replace(/^@+/, "");
  if (username) {
    return `@${username}`;
  }

  const displayName = connectedUser.telegramDisplayName?.trim();
  if (displayName) {
    return displayName;
  }

  return connectedUser.telegramUserId;
}

function TelegramStatusBadge({ bot }: { bot: TelegramBot }) {
  const { t } = useTranslation();
  if (bot.tokenStatus === "invalid") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/20 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
        <AlertTriangle className="h-3.5 w-3.5" />
        {t(($) => {
          return $.connectors.providerSettings.telegram.tokenInvalid;
        })}
      </span>
    );
  }

  const connected = bot.isConnected;
  if (connected) {
    const connectedUserLabel = telegramConnectedUserLabel(bot);
    const connectedLabel = connectedUserLabel
      ? t(
          ($) => {
            return $.connectors.providerSettings.works.connectedDetail;
          },
          { detail: connectedUserLabel },
        )
      : t(($) => {
          return $.connectors.providerSettings.works.connected;
        });
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-secondary-foreground">
        <CircleCheck className="h-3.5 w-3.5 text-green-600" />
        <span
          className="min-w-0 truncate"
          title={connectedUserLabel ?? undefined}
        >
          {connectedLabel}
        </span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
      {t(($) => {
        return $.connectors.providerSettings.telegram.notConnected;
      })}
    </span>
  );
}

function TelegramBotIconFallback({ botId }: { botId: string }) {
  return (
    <div
      className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#2AABEE]/10 text-[#2AABEE]"
      data-testid={`telegram-bot-avatar-fallback-${botId}`}
    >
      <Bot className="h-5 w-5" />
    </div>
  );
}

function TelegramBotAvatar({
  bot,
  avatarUrl,
}: {
  bot: TelegramBot;
  avatarUrl: string | null;
}) {
  const avatarKey = `${bot.id}:${avatarUrl ?? ""}`;
  const failedAvatarKeys = useGet(telegramFailedAvatarKeys$);
  const markAvatarFailed = useSet(markTelegramAvatarFailed$);

  if (!avatarUrl || failedAvatarKeys[avatarKey]) {
    return <TelegramBotIconFallback botId={bot.id} />;
  }

  return (
    <img
      src={avatarUrl}
      alt=""
      loading="lazy"
      className="h-10 w-10 shrink-0 rounded-full object-cover"
      data-testid={`telegram-bot-avatar-${bot.id}`}
      onError={() => {
        markAvatarFailed(avatarKey);
      }}
    />
  );
}

function resolveTelegramBotAvatarUrl(
  avatarUrl: string | null | undefined,
  apiBase: string,
): string | null {
  if (!avatarUrl) {
    return null;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(avatarUrl)) {
    return avatarUrl;
  }
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
  const path = avatarUrl.startsWith("/") ? avatarUrl : `/${avatarUrl}`;
  return `${base}${path}`;
}

function TelegramBotAgentSelect({
  bot,
  options,
  defaultAgent,
  disabled,
}: {
  bot: TelegramBot;
  options: TelegramAgentOption[];
  defaultAgent: DefaultAgentLabel;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const setSavingBotId = useSet(setTelegramSavingBotId$);
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateBotAgent] = useLoadableSet(
    updateTelegramBotAgent$,
  );
  const isOfficial = isOfficialTelegramBot(bot);
  const selectedValue = bot.agent?.id ?? "";
  const agentItems = options.map((agent) => {
    return { value: agent.agentId, label: agentLabel(agent, defaultAgent) };
  });
  const changeAgent = onDomEventFn(async (nextAgentId: string) => {
    if (
      nextAgentId === selectedValue ||
      disabled ||
      updateLoadable.state === "loading"
    ) {
      return;
    }
    setSavingBotId(bot.id);
    await bestEffort(
      updateBotAgent(
        isOfficial
          ? { botId: bot.id, selectedAgentId: nextAgentId }
          : { botId: bot.id, defaultAgentId: nextAgentId },
        pageSignal,
      ),
    );
    setSavingBotId(null);
  });

  return (
    <Select
      items={agentItems}
      value={selectedValue}
      disabled={disabled || options.length === 0}
      onValueChange={(nextAgentId, details) => {
        if (
          nextAgentId === null ||
          !agentItems.some((item) => {
            return item.value === nextAgentId;
          })
        ) {
          details.cancel();
          return;
        }
        changeAgent(nextAgentId);
      }}
    >
      <SelectTrigger
        aria-label={t(
          ($) => {
            return $.connectors.providerSettings.telegram.agentAria;
          },
          { bot: bot.username ?? bot.id },
        )}
        className="h-9"
      >
        <SelectValue
          placeholder={t(($) => {
            return $.connectors.providerSettings.telegram.selectAgent;
          })}
        />
      </SelectTrigger>
      <SelectContent>
        {agentItems.map((item) => {
          return (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function TelegramConnectAction({
  bot,
  disabled,
}: {
  bot: TelegramBot;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [connection, connect] = useLoadableSet(authorizeTelegramBot$);
  if (bot.isConnected) {
    return null;
  }

  return (
    <Button
      type="button"
      size="sm"
      disabled={disabled || connection.state === "loading"}
      onClick={() => {
        detach(connect(bot.id, pageSignal), Reason.DomCallback);
      }}
      className="h-9 justify-center"
    >
      {t(($) => {
        return $.connectors.actions.connect;
      })}
    </Button>
  );
}

function TelegramMoreActions({
  bot,
  botLabel,
  disabled,
  unlinking,
}: {
  bot: TelegramBot;
  botLabel: string;
  disabled: boolean;
  unlinking: boolean;
}) {
  const { t } = useTranslation();
  const setUnlinkingBotId = useSet(setTelegramUnlinkingBotId$);
  const pageSignal = useGet(pageSignal$);
  const [, disconnectAccount] = useLoadableSet(disconnectTelegramAccount$);

  if (!bot.isConnected) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            showTooltip
            type="button"
            disabled={disabled}
            variant="quiet"
            size="icon-sm"
            className="shrink-0 disabled:opacity-50"
            aria-label={t(
              ($) => {
                return $.connectors.providerSettings.telegram.moreOptions;
              },
              { bot: botLabel },
            )}
          >
            <EllipsisVertical size={16} />
          </Button>
        }
      />
      <PopoverContent align="end" className="flex w-40 flex-col gap-0.5 p-2">
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.connectors.providerSettings.telegram.disconnectAria;
            },
            { bot: botLabel },
          )}
          disabled={unlinking}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-state-hover hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          onClick={onDomEventFn(async () => {
            setUnlinkingBotId(bot.id);
            await bestEffort(disconnectAccount(bot.id, pageSignal));
            setUnlinkingBotId(null);
          })}
        >
          {unlinking
            ? t(($) => {
                return $.connectors.actions.disconnecting;
              })
            : t(($) => {
                return $.connectors.actions.disconnect;
              })}
        </button>
      </PopoverContent>
    </Popover>
  );
}

function TelegramBotActions({
  bot,
  disabled,
  unlinking,
}: {
  bot: TelegramBot;
  disabled: boolean;
  unlinking: boolean;
}) {
  const { t } = useTranslation();
  const botLabel = bot.username
    ? `@${bot.username}`
    : t(($) => {
        return $.connectors.providerSettings.telegram.botFallback;
      });
  const connectDisabled = disabled || bot.official?.configured === false;

  return (
    <div className="flex items-center justify-end gap-1.5">
      <TelegramConnectAction bot={bot} disabled={connectDisabled} />
      <TelegramMoreActions
        bot={bot}
        botLabel={botLabel}
        disabled={disabled}
        unlinking={unlinking}
      />
    </div>
  );
}

function TelegramBotRow({
  bot,
  agents,
  defaultAgent,
  canManage,
  disabled,
}: {
  bot: TelegramBot;
  agents: AgentResponse[];
  defaultAgent: DefaultAgentLabel;
  canManage: boolean;
  disabled: boolean;
}) {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();
  const savingBotId = useGet(telegramSavingBotId$);
  const unlinkingBotId = useGet(telegramUnlinkingBotId$);
  const apiBase = useLastResolved(apiBase$);
  const saving = savingBotId === bot.id;
  const unlinking = unlinkingBotId === bot.id;
  const actionDisabled = disabled || saving || unlinking;
  const options = buildBotAgentOptions(bot, agents, defaultAgent);
  const avatarUrl = resolveTelegramBotAvatarUrl(bot.avatarUrl, apiBase ?? "");
  const isOfficial = isOfficialTelegramBot(bot);
  const botTitle = isOfficial
    ? bot.username
      ? `@${bot.username}`
      : t(($) => {
          return $.connectors.providerSettings.telegram.officialBot;
        })
    : bot.username
      ? `@${bot.username}`
      : t(($) => {
          return $.connectors.providerSettings.telegram.botFallback;
        });

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <TelegramBotAvatar bot={bot} avatarUrl={avatarUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 truncate text-sm font-medium text-foreground">
              {botTitle}
            </div>
            <TelegramStatusBadge bot={bot} />
          </div>
          {isOfficial ? (
            <div className="mt-1 text-sm text-muted-foreground">
              {t(
                ($) => {
                  return $.connectors.providerSettings.telegram
                    .officialDescription;
                },
                { brandName },
              )}
            </div>
          ) : null}
          {isOfficial && bot.official?.configured === false ? (
            <div className="mt-1 text-sm text-muted-foreground">
              {t(($) => {
                return $.connectors.providerSettings.telegram.officialMissing;
              })}
            </div>
          ) : null}
        </div>
      </div>

      <div
        className={
          canManage
            ? "grid gap-2 sm:w-[360px] sm:grid-cols-[1fr_auto]"
            : "flex justify-end"
        }
      >
        {canManage ? (
          <TelegramBotAgentSelect
            bot={bot}
            options={options}
            defaultAgent={defaultAgent}
            disabled={actionDisabled}
          />
        ) : null}
        <TelegramBotActions
          bot={bot}
          disabled={actionDisabled}
          unlinking={unlinking}
        />
      </div>
    </div>
  );
}

function TelegramBotList({
  bots,
  agents,
  defaultAgent,
  isAdmin,
  agentsLoading,
}: {
  bots: TelegramBot[];
  agents: AgentResponse[];
  defaultAgent: DefaultAgentLabel;
  isAdmin: boolean;
  agentsLoading: boolean;
}) {
  const { t } = useTranslation();
  if (bots.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-[#2AABEE]/10">
          <img src={telegramIconImg} alt="" className="h-8 w-8" />
        </div>
        <div className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings.telegram.emptyTitle;
          })}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.providerSettings.telegram.emptyDescription;
          })}
        </div>
      </div>
    );
  }

  return (
    <div>
      {bots.map((bot, index) => {
        const isOfficial = isOfficialTelegramBot(bot);
        return (
          <div key={bot.id}>
            <TelegramBotRow
              bot={bot}
              agents={agents}
              defaultAgent={defaultAgent}
              canManage={isOfficial || bot.isOwner || isAdmin}
              disabled={agentsLoading}
            />
            {index < bots.length - 1 ? (
              <div className="mx-5 border-b border-border/50" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TelegramBotsCard({
  bots,
  agents,
  defaultAgent,
  isAdmin,
  agentsLoading,
}: {
  bots: TelegramBot[];
  agents: AgentResponse[];
  defaultAgent: DefaultAgentLabel;
  isAdmin: boolean;
  agentsLoading: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className={surfaceVariants({ className: "overflow-hidden" })}>
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings.telegram.bots;
          })}
        </h2>
      </div>
      <TelegramBotList
        bots={bots}
        agents={agents}
        defaultAgent={defaultAgent}
        isAdmin={isAdmin}
        agentsLoading={agentsLoading}
      />
    </section>
  );
}

export function TelegramSettingsPage() {
  const { t } = useTranslation();
  const botsLoadable = useLastLoadable(telegramBots$);
  const agentsLoadable = useLastLoadable(sortedAgents$);
  const defaultAgentIdLoadable = useLastLoadable(defaultAgentId$);
  const defaultAgentNameLoadable = useLastLoadable(defaultAgentName$);
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const bots = botsLoadable.state === "hasData" ? botsLoadable.data : [];
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const defaultAgent: DefaultAgentLabel = {
    agentId:
      defaultAgentIdLoadable.state === "hasData"
        ? defaultAgentIdLoadable.data
        : (agents[0]?.agentId ?? null),
    displayName:
      defaultAgentNameLoadable.state === "hasData"
        ? defaultAgentNameLoadable.data
        : null,
  };
  const loading = botsLoadable.state === "loading" && bots.length === 0;
  const hasError =
    botsLoadable.state === "hasError" || agentsLoadable.state === "hasError";
  const agentsLoading = agentsLoadable.state === "loading";

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 pt-10 pb-3 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <div className="mb-4">
            <Link
              pathname={ROUTES.works}
              title={t(($) => {
                return $.connectors.providerSettings.telegram
                  .backToIntegrations;
              })}
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "h-8 gap-2 px-2 text-muted-foreground hover:text-foreground",
              )}
            >
              <ArrowLeft size={17} />
              {t(($) => {
                return $.connectors.providerSettings.telegram
                  .backToIntegrations;
              })}
            </Link>
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#2AABEE]/10">
                <img src={telegramIconImg} alt="" className="h-7 w-7" />
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                    {t(($) => {
                      return $.connectors.providerSettings.telegram
                        .documentTitle;
                    })}
                  </h1>
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {t(($) => {
                    return $.connectors.providerSettings.telegram
                      .pageDescription;
                  })}
                </p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-safe-or-8 pt-3 sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          {hasError ? (
            <div
              className={surfaceVariants({
                className: "px-6 py-10 text-center text-sm text-destructive",
              })}
            >
              {t(($) => {
                return $.connectors.providerSettings.telegram.loadError;
              })}
            </div>
          ) : loading ? (
            <TelegramSettingsSkeleton />
          ) : (
            <>
              <TelegramBotsCard
                bots={bots}
                agents={agents}
                defaultAgent={defaultAgent}
                isAdmin={isAdmin}
                agentsLoading={agentsLoading}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
