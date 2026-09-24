import { cn } from "@okouai/ui/lib/utils";
import { CopyButton, surfaceVariants } from "@okouai/ui";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  EllipsisVertical,
  ExternalLink,
  Key,
  Loader2,
  Plus,
  RefreshCw,
  Bot,
} from "lucide-react";
import {
  type TelegramBot,
  type TelegramSetupStatus,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { Button, buttonVariants } from "@okouai/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@okouai/ui/components/ui/dialog";
import { Input } from "@okouai/ui/components/ui/input";
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
import {
  registerAndConnectTelegramBot$,
  startTelegramConnect$,
} from "../../signals/okou-page/telegram-authorization.ts";
import {
  defaultAgentId$,
  defaultAgentName$,
  sortedAgents$,
} from "../../signals/agent.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  advanceTelegramAddSetupStep$,
  checkTelegramAddSetupStatus$,
  completeTelegramAddDialogClose$,
  completeTelegramReinstallDialogClose$,
  copyTelegramValue$,
  disconnectTelegramAccount$,
  goBackTelegramAddSetupStep$,
  markTelegramAvatarFailed$,
  reinstallTelegramBot$,
  setTelegramAddDialogOpen$,
  setTelegramReinstallDialogBotId$,
  setTelegramReinstallingBotId$,
  setTelegramReinstallTokenForm$,
  setTelegramBotAgentForm$,
  setTelegramBotTokenForm$,
  setTelegramSavingBotId$,
  setTelegramUninstallDialogBotId$,
  setTelegramUninstallingBotId$,
  setTelegramUnlinkingBotId$,
  telegramAddDialogOpen$,
  telegramAddDialogSession$,
  telegramAddSetupState$,
  telegramBotAgentForm$,
  telegramBots$,
  telegramBotTokenForm$,
  telegramFailedAvatarKeys$,
  telegramReinstallDialogBotId$,
  telegramReinstallDialogOpen$,
  telegramReinstallingBotId$,
  telegramReinstallTokenForm$,
  telegramSavingBotId$,
  telegramUninstallDialogBotId$,
  telegramUninstallingBotId$,
  telegramUnlinkingBotId$,
  uninstallTelegramBot$,
  updateTelegramBotAgent$,
  type TelegramAddSetupState,
  type TelegramAddSetupStep,
  type TelegramSetupCheckTarget,
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
import { i18n } from "../../i18n/index.ts";

const telegramIconImg = settingsIconAssetUrl("telegram");

interface DefaultAgentLabel {
  agentId: string | null;
  displayName: string | null;
}

type TelegramAgentOption = Pick<AgentResponse, "agentId" | "displayName">;

const TELEGRAM_COMMAND_CLASS =
  "cursor-pointer rounded border border-border bg-background px-1 py-0.5 font-mono text-xs text-foreground transition-colors hover:bg-state-hover active:bg-state-pressed";
const BOT_FATHER_HANDLE = "@BotFather";

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

function AddTelegramBotButtonSkeleton() {
  return <Skeleton className="h-8 w-[88px] shrink-0 rounded-md" />;
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

function getTelegramLoginDomain(): string {
  return location.hostname;
}

function getTelegramLoginOrigin(): string {
  return location.origin;
}

function CopyableTelegramValue({ value }: { value: string }) {
  const { t } = useTranslation();
  const copyValueCommand = useSet(copyTelegramValue$);
  const pageSignal = useGet(pageSignal$);

  const copyValue = () => {
    return copyValueCommand(value, pageSignal);
  };

  return (
    <CopyButton
      key={value}
      copyAction={copyValue}
      resetDelay={1500}
      render={({ onClick, ref }, { copied }) => {
        return (
          <button
            ref={ref}
            type="button"
            className={TELEGRAM_COMMAND_CLASS}
            aria-label={t(
              ($) => {
                return $.connectors.providerSettings.telegram.copyAria;
              },
              { value },
            )}
            title={t(($) => {
              return $.connectors.providerSettings.telegram.copyTitle;
            })}
            onClick={onClick}
          >
            {copied
              ? t(($) => {
                  return $.connectors.providerSettings.telegram.copied;
                })
              : value}
          </button>
        );
      }}
    />
  );
}

function TelegramCommand({ command }: { command: string }) {
  return <CopyableTelegramValue value={command} />;
}

type AddTelegramStep = TelegramAddSetupStep;
type SetupCheckTarget = TelegramSetupCheckTarget;

const ADD_TELEGRAM_STEPS = [
  "token",
  "domain",
  "privacy",
  "create",
] as const satisfies readonly AddTelegramStep[];

function telegramStepIndex(step: AddTelegramStep): number {
  return ADD_TELEGRAM_STEPS.indexOf(step);
}

function AddTelegramBotProgress({ step }: { step: AddTelegramStep }) {
  const { t } = useTranslation();
  const currentIndex = telegramStepIndex(step);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        {ADD_TELEGRAM_STEPS.map((item, index) => {
          const active = index === currentIndex;
          const complete = index < currentIndex;
          return (
            <div
              key={item}
              className={
                complete || active
                  ? "h-1 flex-1 rounded-full bg-foreground"
                  : "h-1 flex-1 rounded-full bg-muted"
              }
            />
          );
        })}
      </div>
      <div className="grid grid-cols-4 gap-2 text-xs">
        {ADD_TELEGRAM_STEPS.map((item, index) => {
          const active = index === currentIndex;
          const complete = index < currentIndex;
          return (
            <div
              key={item}
              className={
                active || complete
                  ? "truncate font-medium text-foreground"
                  : "truncate text-muted-foreground"
              }
            >
              {t(($) => {
                return $.connectors.providerSettings.telegram.steps[item];
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TelegramSetupStatusLine({
  setupStatus,
}: {
  setupStatus: TelegramSetupStatus | null;
}) {
  const { t } = useTranslation();
  if (!setupStatus) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
        <CircleCheck className="h-4 w-4 text-green-600" />
        {t(($) => {
          return $.connectors.providerSettings.telegram.token.verified;
        })}
      </span>
      <span>
        {setupStatus.username ? `@${setupStatus.username}` : setupStatus.id}
      </span>
    </div>
  );
}

function AddTelegramBotTokenField({
  botToken,
  disabled,
  onBotTokenChange,
}: {
  botToken: string;
  disabled: boolean;
  onBotTokenChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <label
        htmlFor="telegram-bot-token"
        className="mb-2 block text-sm font-medium text-foreground"
      >
        {t(($) => {
          return $.connectors.providerSettings.telegram.botToken;
        })}
      </label>
      <div className="relative">
        <Key
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          id="telegram-bot-token"
          type="password"
          value={botToken}
          disabled={disabled}
          autoComplete="off"
          placeholder={t(($) => {
            return $.connectors.providerSettings.telegram.botTokenPlaceholder;
          })}
          className="pl-9"
          onChange={(event) => {
            onBotTokenChange(event.target.value);
          }}
        />
      </div>
    </div>
  );
}

function AddTelegramBotAgentField({
  agents,
  defaultAgent,
  agentId,
  selectedAgentLabel,
  disabled,
  onAgentChange,
}: {
  agents: AgentResponse[];
  defaultAgent: DefaultAgentLabel;
  agentId: string | undefined;
  selectedAgentLabel: string;
  disabled: boolean;
  onAgentChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const agentItems = agents.map((agent) => {
    return { value: agent.agentId, label: agentLabel(agent, defaultAgent) };
  });
  return (
    <div className="min-w-0">
      <label
        htmlFor="telegram-new-bot-agent"
        className="mb-2 block text-sm font-medium text-foreground"
      >
        {t(($) => {
          return $.connectors.providerSettings.telegram.defaultAgent;
        })}
      </label>
      <Select
        items={agentItems}
        value={agentId ?? ""}
        disabled={disabled || agents.length === 0}
        onValueChange={(value, details) => {
          if (
            value === null ||
            !agentItems.some((item) => {
              return item.value === value;
            })
          ) {
            details.cancel();
            return;
          }
          if (value !== agentId) {
            onAgentChange(value);
          }
        }}
      >
        <SelectTrigger id="telegram-new-bot-agent">
          <SelectValue placeholder={selectedAgentLabel} />
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
    </div>
  );
}

function SetupError({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
      {message}
    </div>
  );
}

function AddTelegramTokenStep({
  botToken,
  disabled,
  checking,
  setupStatus,
  setupError,
  onBotTokenChange,
}: {
  botToken: string;
  disabled: boolean;
  checking: boolean;
  setupStatus: TelegramSetupStatus | null;
  setupError: string | null;
  onBotTokenChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings.telegram.token.title;
          })}
        </div>
        <div className="leading-relaxed">
          {t(($) => {
            return $.connectors.providerSettings.telegram.token.open;
          })}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
          >
            {BOT_FATHER_HANDLE}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          {t(($) => {
            return $.connectors.providerSettings.telegram.token.send;
          })}
          <TelegramCommand command="/newbot" />
          {t(($) => {
            return $.connectors.providerSettings.telegram.token
              .instructionAfter;
          })}
        </div>
      </div>
      <AddTelegramBotTokenField
        botToken={botToken}
        disabled={disabled || checking}
        onBotTokenChange={onBotTokenChange}
      />
      <TelegramSetupStatusLine setupStatus={setupStatus} />
      <SetupError message={setupError} />
    </div>
  );
}

function AddTelegramDomainStep({
  domain,
  confirmed,
  setupError,
}: {
  domain: string;
  confirmed: boolean;
  setupError: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings.telegram.domain.title;
          })}
        </div>
        <div className="leading-relaxed">
          {t(
            ($) => {
              return $.connectors.providerSettings.telegram.domain
                .instructionStart;
            },
            { botFather: BOT_FATHER_HANDLE },
          )}
          <TelegramCommand command="/setdomain" />
          {t(($) => {
            return $.connectors.providerSettings.telegram.domain
              .instructionAfter;
          })}
          <CopyableTelegramValue value={domain} />
          {t(($) => {
            return $.connectors.providerSettings.telegram.domain.instructionEnd;
          })}
        </div>
      </div>
      {confirmed ? (
        <div className="flex items-center gap-2 rounded-lg border border-green-600/20 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-300">
          <CircleCheck className="h-4 w-4" />
          {t(($) => {
            return $.connectors.providerSettings.telegram.domain.detected;
          })}
        </div>
      ) : null}
      <SetupError message={setupError} />
    </div>
  );
}

function AddTelegramPrivacyStep({
  confirmed,
  setupError,
}: {
  confirmed: boolean;
  setupError: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings.telegram.privacy.title;
          })}
        </div>
        <div className="leading-relaxed">
          {t(
            ($) => {
              return $.connectors.providerSettings.telegram.privacy
                .instructionStart;
            },
            { botFather: BOT_FATHER_HANDLE },
          )}
          <TelegramCommand command="/setprivacy" />
          {t(($) => {
            return $.connectors.providerSettings.telegram.privacy
              .instructionAfter;
          })}
        </div>
      </div>
      {confirmed ? (
        <div className="flex items-center gap-2 rounded-lg border border-green-600/20 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-300">
          <CircleCheck className="h-4 w-4" />
          {t(($) => {
            return $.connectors.providerSettings.telegram.privacy.off;
          })}
        </div>
      ) : null}
      <SetupError message={setupError} />
    </div>
  );
}

function AddTelegramCreateStep({
  agents,
  defaultAgent,
  agentId,
  selectedAgentLabel,
  setupStatus,
  disabled,
  onAgentChange,
}: {
  agents: AgentResponse[];
  defaultAgent: DefaultAgentLabel;
  agentId: string | undefined;
  selectedAgentLabel: string;
  setupStatus: TelegramSetupStatus | null;
  disabled: boolean;
  onAgentChange: (value: string) => void;
}) {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings.telegram.create.title;
          })}
        </div>
        <div>
          {setupStatus?.username
            ? t(
                ($) => {
                  return $.connectors.providerSettings.telegram.create
                    .descriptionNamed;
                },
                { bot: `@${setupStatus.username}`, brandName },
              )
            : t(
                ($) => {
                  return $.connectors.providerSettings.telegram.create
                    .description;
                },
                { brandName },
              )}
        </div>
      </div>
      <AddTelegramBotAgentField
        agents={agents}
        defaultAgent={defaultAgent}
        agentId={agentId}
        selectedAgentLabel={selectedAgentLabel}
        disabled={disabled}
        onAgentChange={onAgentChange}
      />
    </div>
  );
}

interface AddTelegramBotSetupFlow {
  step: AddTelegramStep;
  setupStatus: TelegramSetupStatus | null;
  domainConfirmed: boolean;
  privacyConfirmed: boolean;
  setupError: string | null;
  checkingTarget: SetupCheckTarget | null;
  canGoNext: boolean;
  handleBotTokenChange: (value: string) => void;
  goNext: () => void;
  goBack: () => void;
}

function getSelectedAddTelegramAgent({
  agents,
  defaultAgent,
  selectedAgentId,
}: {
  agents: AgentResponse[];
  defaultAgent: DefaultAgentLabel;
  selectedAgentId: string | null | undefined;
}) {
  const preferredAgentId =
    selectedAgentId ?? defaultAgent.agentId ?? agents[0]?.agentId;
  const selectedAgent =
    agents.find((agent) => {
      return agent.agentId === preferredAgentId;
    }) ?? agents[0];

  return {
    agentId: selectedAgent?.agentId,
    selectedAgentLabel: selectedAgent
      ? agentLabel(selectedAgent, defaultAgent)
      : (defaultAgent.displayName ??
        i18n.t(($) => {
          return $.connectors.providerSettings.telegram.selectAgent;
        })),
  };
}

function canAdvanceAddTelegramStep({
  step,
  botToken,
  setupStatus,
}: {
  step: AddTelegramStep;
  botToken: string;
  setupStatus: TelegramSetupStatus | null;
}) {
  switch (step) {
    case "token": {
      return botToken.trim().length > 0 || !!setupStatus;
    }
    case "domain": {
      return true;
    }
    case "privacy": {
      return true;
    }
    case "create": {
      return false;
    }
  }
}

function canSubmitAddTelegramBot({
  botToken,
  setupStatus,
  domainConfirmed,
  privacyConfirmed,
  agentId,
  disabled,
  adding,
}: {
  botToken: string;
  setupStatus: TelegramSetupStatus | null;
  domainConfirmed: boolean;
  privacyConfirmed: boolean;
  agentId: string | undefined;
  disabled: boolean;
  adding: boolean;
}) {
  return (
    botToken.trim().length > 0 &&
    !!setupStatus &&
    domainConfirmed &&
    privacyConfirmed &&
    !!agentId &&
    !disabled &&
    !adding
  );
}

function getPendingSetupCheckTarget({
  step,
  setupStatus,
  domainConfirmed,
  privacyConfirmed,
}: {
  step: AddTelegramStep;
  setupStatus: TelegramSetupStatus | null;
  domainConfirmed: boolean;
  privacyConfirmed: boolean;
}): SetupCheckTarget | null {
  if (step === "token" && !setupStatus) {
    return "token";
  }
  if (step === "domain" && !domainConfirmed) {
    return "domain";
  }
  if (step === "privacy" && !privacyConfirmed) {
    return "privacy";
  }
  return null;
}

function buildAddTelegramBotSetupFlow({
  setupState,
  setupError,
  checkingTarget,
  botToken,
  handleBotTokenChange,
  goNext,
  goBack,
}: {
  setupState: TelegramAddSetupState;
  setupError: string | null;
  checkingTarget: SetupCheckTarget | null;
  botToken: string;
  handleBotTokenChange: (value: string) => void;
  goNext: () => void;
  goBack: () => void;
}): AddTelegramBotSetupFlow {
  return {
    ...setupState,
    setupError,
    checkingTarget,
    canGoNext: canAdvanceAddTelegramStep({
      step: setupState.step,
      botToken,
      setupStatus: setupState.setupStatus,
    }),
    handleBotTokenChange,
    goNext,
    goBack,
  };
}

interface AddTelegramBotDialogInnerProps {
  agents: AgentResponse[];
  defaultAgent: DefaultAgentLabel;
  disabled: boolean;
  botToken: string;
  open: boolean;
  agentId: string | undefined;
  selectedAgentLabel: string;
  setBotToken: (value: string) => void;
  setAgentId: (value: string | null) => void;
  setOpen: (open: boolean) => void;
  registerBot: (
    input: { botToken: string; defaultAgentId?: string },
    signal: AbortSignal,
  ) => Promise<void>;
  adding: boolean;
}

interface AddTelegramBotDialogFrameProps {
  open: boolean;
  disabled: boolean;
  adding: boolean;
  flow: AddTelegramBotSetupFlow;
  canSubmit: boolean;
  botToken: string;
  agents: AgentResponse[];
  defaultAgent: DefaultAgentLabel;
  agentId: string | undefined;
  selectedAgentLabel: string;
  onOpenChange: (open: boolean) => void;
  onAddBot: () => void;
  onCancel: () => void;
  onAgentChange: (value: string | null) => void;
}

function AddTelegramBotDialogFrame({
  open,
  disabled,
  adding,
  flow,
  canSubmit,
  botToken,
  agents,
  defaultAgent,
  agentId,
  selectedAgentLabel,
  onOpenChange,
  onAddBot,
  onCancel,
  onAgentChange,
}: AddTelegramBotDialogFrameProps) {
  const { t } = useTranslation();
  const completeClose = useSet(completeTelegramAddDialogClose$);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          completeClose();
        }
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" size="sm" disabled={disabled}>
            <Plus size={16} />
            {t(($) => {
              return $.connectors.providerSettings.telegram.addBot;
            })}
          </Button>
        }
      />
      <DialogContent smMaxWidth={640}>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.connectors.providerSettings.telegram.addTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.connectors.providerSettings.telegram.addDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          aria-label={t(($) => {
            return $.connectors.providerSettings.telegram.registerAria;
          })}
          onSubmit={(event) => {
            event.preventDefault();
            if (flow.step === "create") {
              if (canSubmit) {
                onAddBot();
              }
            } else if (flow.canGoNext && !flow.checkingTarget && !adding) {
              flow.goNext();
            }
          }}
        >
          <AddTelegramBotProgress step={flow.step} />
          <AddTelegramBotStepContent
            flow={flow}
            domain={getTelegramLoginDomain()}
            botToken={botToken}
            disabled={disabled}
            adding={adding}
            agents={agents}
            defaultAgent={defaultAgent}
            agentId={agentId}
            selectedAgentLabel={selectedAgentLabel}
            onAgentChange={onAgentChange}
          />
          <AddTelegramBotDialogFooter
            step={flow.step}
            adding={adding}
            canGoNext={flow.canGoNext}
            checkingTarget={flow.checkingTarget}
            canSubmit={canSubmit}
            onCancel={onCancel}
            onBack={flow.goBack}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddTelegramBotDialogInner({
  agents,
  defaultAgent,
  disabled,
  botToken,
  open,
  agentId,
  selectedAgentLabel,
  setBotToken,
  setAgentId,
  setOpen,
  registerBot,
  adding,
}: AddTelegramBotDialogInnerProps) {
  const pageSignal = useGet(pageSignal$);
  const setupState = useGet(telegramAddSetupState$);
  const [checkSetupLoadable, checkSetup] = useLoadableSet(
    checkTelegramAddSetupStatus$,
  );
  const advanceStep = useSet(advanceTelegramAddSetupStep$);
  const goBack = useSet(goBackTelegramAddSetupStep$);

  const handleBotTokenChange = (value: string) => {
    setBotToken(value);
  };

  const goNext = () => {
    const target = getPendingSetupCheckTarget(setupState);
    if (target) {
      detach(
        (async () => {
          const verified = await checkSetup(
            target,
            getTelegramLoginOrigin(),
            pageSignal,
          );
          if (verified) {
            advanceStep();
          }
        })(),
        Reason.DomCallback,
      );
      return;
    }

    advanceStep();
  };

  const canSubmit = canSubmitAddTelegramBot({
    botToken,
    setupStatus: setupState.setupStatus,
    domainConfirmed: setupState.domainConfirmed,
    privacyConfirmed: setupState.privacyConfirmed,
    agentId,
    disabled,
    adding,
  });

  const handleOpenChange = (nextOpen: boolean) => {
    if (adding) {
      return;
    }

    setOpen(nextOpen);
  };

  const handleCancel = () => {
    setOpen(false);
  };

  const handleAddBot = () => {
    if (!canSubmit || !agentId) {
      return;
    }

    detach(
      registerBot(
        {
          botToken: botToken.trim(),
          defaultAgentId: agentId,
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  const loadableSetupError =
    checkSetupLoadable.state === "hasError" &&
    checkSetupLoadable.error instanceof Error
      ? checkSetupLoadable.error.message
      : null;
  const pendingSetupTarget = getPendingSetupCheckTarget(setupState);
  const flow = buildAddTelegramBotSetupFlow({
    setupState,
    setupError: setupState.setupError ?? loadableSetupError,
    checkingTarget:
      checkSetupLoadable.state === "loading" ? pendingSetupTarget : null,
    botToken,
    handleBotTokenChange,
    goNext,
    goBack,
  });

  return (
    <AddTelegramBotDialogFrame
      open={open}
      disabled={disabled}
      adding={adding}
      flow={flow}
      canSubmit={canSubmit}
      botToken={botToken}
      agents={agents}
      defaultAgent={defaultAgent}
      agentId={agentId}
      selectedAgentLabel={selectedAgentLabel}
      onOpenChange={handleOpenChange}
      onAddBot={handleAddBot}
      onCancel={handleCancel}
      onAgentChange={setAgentId}
    />
  );
}

function AddTelegramBotStepContent({
  flow,
  domain,
  botToken,
  disabled,
  adding,
  agents,
  defaultAgent,
  agentId,
  selectedAgentLabel,
  onAgentChange,
}: {
  flow: AddTelegramBotSetupFlow;
  domain: string;
  botToken: string;
  disabled: boolean;
  adding: boolean;
  agents: AgentResponse[];
  defaultAgent: DefaultAgentLabel;
  agentId: string | undefined;
  selectedAgentLabel: string;
  onAgentChange: (value: string) => void;
}) {
  switch (flow.step) {
    case "token": {
      return (
        <AddTelegramTokenStep
          botToken={botToken}
          disabled={disabled || adding}
          checking={flow.checkingTarget === "token"}
          setupStatus={flow.setupStatus}
          setupError={flow.setupError}
          onBotTokenChange={flow.handleBotTokenChange}
        />
      );
    }
    case "domain": {
      return (
        <AddTelegramDomainStep
          domain={domain}
          confirmed={flow.domainConfirmed}
          setupError={flow.setupError}
        />
      );
    }
    case "privacy": {
      return (
        <AddTelegramPrivacyStep
          confirmed={flow.privacyConfirmed}
          setupError={flow.setupError}
        />
      );
    }
    case "create": {
      return (
        <AddTelegramCreateStep
          agents={agents}
          defaultAgent={defaultAgent}
          agentId={agentId}
          selectedAgentLabel={selectedAgentLabel}
          setupStatus={flow.setupStatus}
          disabled={disabled || adding}
          onAgentChange={onAgentChange}
        />
      );
    }
  }
}

function AddTelegramBotDialogFooter({
  step,
  adding,
  canGoNext,
  checkingTarget,
  canSubmit,
  onCancel,
  onBack,
}: {
  step: AddTelegramStep;
  adding: boolean;
  canGoNext: boolean;
  checkingTarget: SetupCheckTarget | null;
  canSubmit: boolean;
  onCancel: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const isTokenStep = step === "token";
  const isCreateStep = step === "create";

  return (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        disabled={adding}
        onClick={isTokenStep ? onCancel : onBack}
      >
        {isTokenStep ? (
          t(($) => {
            return $.connectors.actions.cancel;
          })
        ) : (
          <span className="inline-flex items-center gap-2">
            <ArrowLeft size={16} />
            {t(($) => {
              return $.connectors.providerSettings.telegram.steps.back;
            })}
          </span>
        )}
      </Button>
      {isCreateStep ? (
        <Button type="submit" disabled={!canSubmit} className="gap-2">
          {adding ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Plus size={16} />
          )}
          {adding
            ? t(($) => {
                return $.connectors.providerSettings.telegram.adding;
              })
            : t(($) => {
                return $.connectors.providerSettings.telegram.addBot;
              })}
        </Button>
      ) : (
        <Button
          type="submit"
          disabled={!canGoNext || !!checkingTarget || adding}
          className="gap-2"
        >
          {checkingTarget ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              {t(($) => {
                return $.connectors.providerSettings.telegram.checking;
              })}
            </>
          ) : (
            <>
              {t(($) => {
                return $.connectors.providerSettings.telegram.steps.next;
              })}
              <ArrowRight size={16} />
            </>
          )}
        </Button>
      )}
    </DialogFooter>
  );
}

function AddTelegramBotDialog({
  agents,
  defaultAgent,
  disabled,
}: {
  agents: AgentResponse[];
  defaultAgent: DefaultAgentLabel;
  disabled: boolean;
}) {
  const botToken = useGet(telegramBotTokenForm$);
  const open = useGet(telegramAddDialogOpen$);
  const session = useGet(telegramAddDialogSession$);
  const selectedAgentId = useGet(telegramBotAgentForm$);
  const { agentId, selectedAgentLabel } = getSelectedAddTelegramAgent({
    agents,
    defaultAgent,
    selectedAgentId,
  });
  const setBotToken = useSet(setTelegramBotTokenForm$);
  const setAgentId = useSet(setTelegramBotAgentForm$);
  const setOpen = useSet(setTelegramAddDialogOpen$);
  const [registerLoadable, registerBot] = useLoadableSet(
    registerAndConnectTelegramBot$,
  );
  const adding = registerLoadable.state === "loading";

  return (
    <AddTelegramBotDialogInner
      key={session}
      agents={agents}
      defaultAgent={defaultAgent}
      disabled={disabled}
      botToken={botToken}
      open={open}
      agentId={agentId}
      selectedAgentLabel={selectedAgentLabel}
      setBotToken={setBotToken}
      setAgentId={setAgentId}
      setOpen={setOpen}
      registerBot={registerBot}
      adding={adding}
    />
  );
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

function TelegramReinstallAction({
  bot,
  canManage,
  disabled,
  reinstalling,
}: {
  bot: TelegramBot;
  canManage: boolean;
  disabled: boolean;
  reinstalling: boolean;
}) {
  const { t } = useTranslation();
  const setReinstallDialogBotId = useSet(setTelegramReinstallDialogBotId$);
  const isOfficial = isOfficialTelegramBot(bot);
  const tokenInvalid = !isOfficial && bot.tokenStatus === "invalid";

  if (isOfficial || !canManage || !tokenInvalid) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled || reinstalling}
      className="h-9 justify-center gap-2"
      onClick={() => {
        setReinstallDialogBotId(bot.id);
      }}
    >
      {reinstalling ? (
        <Loader2 size={15} className="animate-spin" />
      ) : (
        <RefreshCw size={15} />
      )}
      {reinstalling
        ? t(($) => {
            return $.connectors.providerSettings.telegram.reinstalling;
          })
        : t(($) => {
            return $.connectors.providerSettings.telegram.reinstall;
          })}
    </Button>
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
  const [connection, connect] = useLoadableSet(startTelegramConnect$);
  if (bot.isConnected) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="outline"
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
  canManage,
  disabled,
  unlinking,
  uninstalling,
}: {
  bot: TelegramBot;
  botLabel: string;
  canManage: boolean;
  disabled: boolean;
  unlinking: boolean;
  uninstalling: boolean;
}) {
  const { t } = useTranslation();
  const setUnlinkingBotId = useSet(setTelegramUnlinkingBotId$);
  const setUninstallDialogBotId = useSet(setTelegramUninstallDialogBotId$);
  const pageSignal = useGet(pageSignal$);
  const [, disconnectAccount] = useLoadableSet(disconnectTelegramAccount$);
  const isOfficial = isOfficialTelegramBot(bot);
  const canUninstall = !isOfficial && canManage && !bot.isConnected;

  if (!bot.isConnected && !canUninstall) {
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
        {bot.isConnected ? (
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
        ) : null}
        {canUninstall ? (
          <button
            type="button"
            aria-label={t(
              ($) => {
                return $.connectors.providerSettings.telegram.uninstallAria;
              },
              { bot: botLabel },
            )}
            disabled={uninstalling}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-state-hover hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={() => {
              setUninstallDialogBotId(bot.id);
            }}
          >
            {uninstalling
              ? t(($) => {
                  return $.connectors.actions.uninstalling;
                })
              : t(($) => {
                  return $.connectors.actions.uninstall;
                })}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function TelegramBotActions({
  bot,
  canManage,
  disabled,
  unlinking,
  uninstalling,
  reinstalling,
}: {
  bot: TelegramBot;
  canManage: boolean;
  disabled: boolean;
  unlinking: boolean;
  uninstalling: boolean;
  reinstalling: boolean;
}) {
  const { t } = useTranslation();
  const botLabel = bot.username
    ? `@${bot.username}`
    : t(($) => {
        return $.connectors.providerSettings.telegram.botFallback;
      });
  const isOfficial = isOfficialTelegramBot(bot);
  const tokenInvalid = !isOfficial && bot.tokenStatus === "invalid";
  const connectDisabled =
    disabled ||
    tokenInvalid ||
    (isOfficial && bot.official?.configured === false);

  return (
    <div className="flex items-center justify-end gap-1.5">
      <TelegramReinstallAction
        bot={bot}
        canManage={canManage}
        disabled={disabled}
        reinstalling={reinstalling}
      />
      <TelegramConnectAction bot={bot} disabled={connectDisabled} />
      <TelegramMoreActions
        bot={bot}
        botLabel={botLabel}
        canManage={canManage}
        disabled={disabled}
        unlinking={unlinking}
        uninstalling={uninstalling}
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
  const uninstallingBotId = useGet(telegramUninstallingBotId$);
  const reinstallingBotId = useGet(telegramReinstallingBotId$);
  const apiBase = useLastResolved(apiBase$);
  const saving = savingBotId === bot.id;
  const unlinking = unlinkingBotId === bot.id;
  const uninstalling = uninstallingBotId === bot.id;
  const reinstalling = reinstallingBotId === bot.id;
  const actionDisabled =
    disabled || saving || unlinking || uninstalling || reinstalling;
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
          ) : bot.tokenStatus === "invalid" ? (
            <div className="mt-1 text-sm text-muted-foreground">
              {t(($) => {
                return $.connectors.providerSettings.telegram
                  .invalidTokenDescription;
              })}
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
          canManage={canManage}
          disabled={actionDisabled}
          unlinking={unlinking}
          uninstalling={uninstalling}
          reinstalling={reinstalling}
        />
      </div>
    </div>
  );
}

function TelegramReinstallDialogRoot({
  children,
  open,
  reinstalling,
}: {
  readonly children: ReactNode;
  readonly open: boolean;
  readonly reinstalling: boolean;
}) {
  const close = useSet(setTelegramReinstallDialogBotId$);
  const completeClose = useSet(completeTelegramReinstallDialogClose$);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !reinstalling) {
          close(null);
        }
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          completeClose();
        }
      }}
    >
      {children}
    </Dialog>
  );
}

function TelegramReinstallDialog({ bot }: { bot: TelegramBot | null }) {
  const { t } = useTranslation();
  const open = useGet(telegramReinstallDialogOpen$);
  const token = useGet(telegramReinstallTokenForm$);
  const reinstallingBotId = useGet(telegramReinstallingBotId$);
  const setToken = useSet(setTelegramReinstallTokenForm$);
  const setReinstallDialogBotId = useSet(setTelegramReinstallDialogBotId$);
  const setReinstallingBotId = useSet(setTelegramReinstallingBotId$);
  const pageSignal = useGet(pageSignal$);
  const [, reinstallBot] = useLoadableSet(reinstallTelegramBot$);
  const reinstalling = !!bot && reinstallingBotId === bot.id;
  const canSubmit = !!bot && token.trim().length > 0 && !reinstalling;
  const botLabel = bot?.username
    ? `@${bot.username}`
    : t(($) => {
        return $.connectors.providerSettings.telegram.reinstallTargetFallback;
      });

  return (
    <TelegramReinstallDialogRoot open={open} reinstalling={reinstalling}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.connectors.providerSettings.telegram.reinstallTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.connectors.providerSettings.telegram
                  .reinstallDescription;
              },
              { bot: botLabel },
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={onDomEventFn(async (event) => {
            event.preventDefault();
            if (!bot || !canSubmit) {
              return;
            }
            setReinstallingBotId(bot.id);

            await bestEffort(
              (async () => {
                await reinstallBot(
                  { botId: bot.id, botToken: token.trim() },
                  pageSignal,
                );

                setReinstallDialogBotId(null);
              })(),
            );

            setReinstallingBotId(null);
          })}
        >
          <div>
            <label
              htmlFor="telegram-reinstall-token"
              className="mb-2 block text-sm font-medium text-foreground"
            >
              {t(($) => {
                return $.connectors.providerSettings.telegram.newBotToken;
              })}
            </label>
            <div className="relative">
              <Key
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="telegram-reinstall-token"
                type="password"
                value={token}
                disabled={reinstalling}
                autoComplete="off"
                placeholder={t(($) => {
                  return $.connectors.providerSettings.telegram
                    .botTokenPlaceholder;
                })}
                className="pl-9"
                onChange={(event) => {
                  setToken(event.target.value);
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={reinstalling}
              onClick={() => {
                setReinstallDialogBotId(null);
              }}
            >
              {t(($) => {
                return $.connectors.actions.cancel;
              })}
            </Button>
            <Button type="submit" disabled={!canSubmit} className="gap-2">
              {reinstalling ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <RefreshCw size={16} />
              )}
              {reinstalling
                ? t(($) => {
                    return $.connectors.providerSettings.telegram.reinstalling;
                  })
                : t(($) => {
                    return $.connectors.providerSettings.telegram.reinstall;
                  })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </TelegramReinstallDialogRoot>
  );
}

function TelegramUninstallDialog({ bot }: { bot: TelegramBot | null }) {
  const { t } = useTranslation();
  const setUninstallDialogBotId = useSet(setTelegramUninstallDialogBotId$);
  const setUninstallingBotId = useSet(setTelegramUninstallingBotId$);
  const uninstallingBotId = useGet(telegramUninstallingBotId$);
  const pageSignal = useGet(pageSignal$);
  const [, uninstallBot] = useLoadableSet(uninstallTelegramBot$);
  const uninstalling = !!bot && uninstallingBotId === bot.id;

  return (
    <Dialog
      open={!!bot}
      onOpenChange={(open) => {
        if (!open && !uninstalling) {
          setUninstallDialogBotId(null);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.connectors.providerSettings.telegram.uninstallTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.connectors.providerSettings.telegram
                  .uninstallDescription;
              },
              {
                bot: bot?.username
                  ? `@${bot.username}`
                  : t(($) => {
                      return $.connectors.providerSettings.telegram
                        .uninstallTargetFallback;
                    }),
              },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={uninstalling}
            onClick={() => {
              setUninstallDialogBotId(null);
            }}
          >
            {t(($) => {
              return $.connectors.actions.cancel;
            })}
          </Button>
          <Button
            variant="destructive"
            disabled={!bot || uninstalling}
            onClick={onDomEventFn(async () => {
              if (!bot) {
                return;
              }
              setUninstallingBotId(bot.id);
              await bestEffort(
                (async () => {
                  await uninstallBot(bot.id, pageSignal);
                  setUninstallDialogBotId(null);
                })(),
              );
              setUninstallingBotId(null);
            })}
          >
            {uninstalling
              ? t(($) => {
                  return $.connectors.actions.uninstalling;
                })
              : t(($) => {
                  return $.connectors.actions.uninstall;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  loading,
  hasError,
}: {
  bots: TelegramBot[];
  agents: AgentResponse[];
  defaultAgent: DefaultAgentLabel;
  isAdmin: boolean;
  agentsLoading: boolean;
  loading: boolean;
  hasError: boolean;
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
        {!hasError && loading ? (
          <AddTelegramBotButtonSkeleton />
        ) : !hasError ? (
          <AddTelegramBotDialog
            agents={agents}
            defaultAgent={defaultAgent}
            disabled={agentsLoading}
          />
        ) : null}
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
  const uninstallDialogBotId = useGet(telegramUninstallDialogBotId$);
  const reinstallDialogBotId = useGet(telegramReinstallDialogBotId$);
  const uninstallBot =
    bots.find((bot) => {
      return bot.id === uninstallDialogBotId;
    }) ?? null;
  const reinstallBot =
    bots.find((bot) => {
      return bot.id === reinstallDialogBotId;
    }) ?? null;
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
                loading={loading}
                hasError={hasError}
              />
              <TelegramUninstallDialog bot={uninstallBot} />
              <TelegramReinstallDialog bot={reinstallBot} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
