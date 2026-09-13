// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import type { ReactNode } from "react";
import { Search, Loader2, Download, ChartLine } from "lucide-react";
import {
  surfaceVariants,
  Button,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import {
  MODEL_PROVIDER_TYPES,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { RUN_ERROR_GUIDANCE } from "@okouai/api-contracts/contracts/errors";
import type {
  SandboxReuseResult,
  WorkspaceReuseResult,
} from "@okouai/api-contracts/contracts/runner-primitives";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  getFrameworkDisplayName,
  isSupportedFramework,
} from "@okouai/core/frameworks";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { fetchDownloadExtra$ } from "../../signals/activity-page/activity-download.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$, updateSearchParams$ } from "../../signals/route.ts";
import { Link } from "../router/link.tsx";
import {
  getTriggerSourceLabel,
  type LogStatus,
  type TriggerSource,
  type AgentEvent,
  type LogDetail,
} from "../../signals/okou-page/log-types.ts";
import { StatusBadge } from "./components/log-views/status-badge.tsx";
import {
  activityDetail$,
  activityEvents$,
  activityVisibleGroups$,
  activityStepSearch$,
  setActivityStepSearch$,
  formatLogTime,
  formatDuration,
  currentRunId$,
} from "../../signals/activity-page/activity-signals.ts";
import {
  eventGroupKey,
  eventGroupMatchesSearch,
  type EventGroup,
} from "../../signals/activity-page/log-detail-utils";
import { EventGroupCard } from "./components/log-views/event-group-card.tsx";
import { StatusDot } from "./components/log-views/status-dot.tsx";
import { activityContext$ } from "../../signals/activity-page/activity-context-signals.ts";
import { activityRunner$ } from "../../signals/activity-page/activity-runner-signals.ts";
import {
  activityNetworkLogs$,
  loadNetworkLogsNextPage$,
} from "../../signals/activity-page/activity-network-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { setActivityDetailScrollContainer$ } from "../../signals/activity-page/activity-detail-scroll.ts";
import {
  ContextContent,
  KeyValueTable,
  SectionHeader,
} from "./components/context-content.tsx";
import { NetworkContent } from "./components/network-content.tsx";
import { Markdown } from "../components/markdown.tsx";
import { NoPermissionIllustration } from "./components/no-permission-illustration.tsx";
import { formatAppNumber } from "../../i18n/format.ts";

// ---------------------------------------------------------------------------
// Error Banner
// ---------------------------------------------------------------------------

function getErrorGuidance(error: string) {
  for (const [code, guidance] of Object.entries(RUN_ERROR_GUIDANCE)) {
    if (error.toLowerCase().includes(guidance.title.toLowerCase())) {
      return { code, guidance };
    }
  }
  return null;
}

function RunErrorBanner({ error }: { error: string }) {
  const { t } = useTranslation();
  const match = getErrorGuidance(error);
  if (match) {
    let localized = {
      title: match.guidance.title,
      guidance: match.guidance.guidance,
    };
    switch (match.code) {
      case "COMPUTER_USE_AUTHORIZATION_REQUIRED": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance
              .computerUseAuthorizationRequired.title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance
              .computerUseAuthorizationRequired.guidance;
          }),
        };
        break;
      }
      case "NO_MODEL_PROVIDER": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance.noModelProvider.title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance.noModelProvider.guidance;
          }),
        };
        break;
      }
      case "INSUFFICIENT_CREDITS": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance.creditsDepleted.title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance.creditsDepleted.guidance;
          }),
        };
        break;
      }
      case "PRO_REQUIRED": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance.paidPlanRequired.title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance.paidPlanRequired.guidance;
          }),
        };
        break;
      }
      case "PROVIDER_INCOMPATIBLE": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance.providerIncompatible.title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance.providerIncompatible
              .guidance;
          }),
        };
        break;
      }
      case "PROVIDER_UNAVAILABLE": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance
              .providerTemporarilyUnavailable.title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance
              .providerTemporarilyUnavailable.guidance;
          }),
        };
        break;
      }
      case "PROVIDER_DELETED": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance.modelProviderUnavailable
              .title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance.modelProviderUnavailable
              .guidance;
          }),
        };
        break;
      }
      case "TOO_MANY_REQUESTS": {
        localized = {
          title: t(($) => {
            return $.activity.detail.errorGuidance.concurrentRunLimitReached
              .title;
          }),
          guidance: t(($) => {
            return $.activity.detail.errorGuidance.concurrentRunLimitReached
              .guidance;
          }),
        };
        break;
      }
    }
    return (
      <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <div className="font-medium">{localized.title}</div>
        <div className="mt-1 text-destructive/80">{localized.guidance}</div>
        {match.guidance.cliHint && (
          <div className="mt-1 font-mono text-xs text-destructive/60">
            $ {match.guidance.cliHint}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive break-words whitespace-pre-wrap">
      {error}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function ActivityBreadcrumbLabel() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5">
      <ChartLine size={14} className="shrink-0" />
      {t(($) => {
        return $.activity.detail.activity;
      })}
    </span>
  );
}

function ActivityNotFound() {
  const { t } = useTranslation();
  const features = useLastResolved(featureSwitch$);
  return (
    <div className="h-full flex flex-col min-h-0">
      <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        {features?.[FeatureSwitchKey.OkouDebug] && (
          <>
            <ActivityBreadcrumbLabel />
            <span className="text-muted-foreground/40 select-none">/</span>
          </>
        )}
        <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium">
          {t(($) => {
            return $.activity.detail.log;
          })}
        </span>
      </nav>
      <div className="flex-1 flex flex-col items-center justify-center gap-3 pb-20">
        <NoPermissionIllustration />
        <h2 className="text-lg font-semibold text-foreground">
          {t(($) => {
            return $.activity.detail.notFound.title;
          })}
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          {t(($) => {
            return $.activity.detail.notFound.description;
          })}
        </p>
        <Button
          asChild
          variant="neutral"
          className="mt-2 h-auto rounded-md px-3 py-1.5 no-underline text-inherit hover:bg-control-surface active:bg-control-surface"
        >
          <Link pathname="/">
            {t(($) => {
              return $.activity.detail.notFound.back;
            })}
          </Link>
        </Button>
      </div>
    </div>
  );
}

export function ActivityHeaderCard({
  displayName,
  status,
  triggerSource,
  detail,
  logDetail,
  duration,
  time,
  events,
  showModelDetail,
  onDownload,
}: {
  displayName: string;
  status: LogStatus;
  triggerSource: TriggerSource | null;
  detail: {
    id: string;
    modelProvider?: string | null;
    selectedModel?: string | null;
    framework?: string | null;
    error?: string | null;
  };
  logDetail?: LogDetail;
  duration: string | null | undefined;
  time: string;
  events: AgentEvent[];
  showModelDetail: boolean;
  onDownload?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={surfaceVariants({ className: "shrink-0 px-4 py-3" })}>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight text-foreground truncate min-w-0 flex-1">
            {displayName}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-y-1 text-sm">
          <div className="flex items-center gap-1.5 pr-3">
            <span className="text-muted-foreground shrink-0">
              {t(($) => {
                return $.activity.detail.fields.status;
              })}
            </span>
            <StatusBadge status={status} shellStyle />
          </div>
          <span
            className="w-px h-3.5 shrink-0 bg-divider self-center"
            aria-hidden
          />
          {triggerSource && (
            <>
              <div className="flex items-center gap-1.5 px-3">
                <span className="text-muted-foreground shrink-0">
                  {t(($) => {
                    return $.activity.detail.fields.source;
                  })}
                </span>
                <span className="text-foreground whitespace-nowrap">
                  {getTriggerSourceLabel(triggerSource)}
                </span>
              </div>
              <span
                className="w-px h-3.5 shrink-0 bg-divider self-center"
                aria-hidden
              />
            </>
          )}
          {(detail.modelProvider || detail.framework) && (
            <>
              <div className="flex items-center gap-1.5 px-3">
                <span className="text-muted-foreground shrink-0">
                  {t(($) => {
                    return $.activity.detail.fields.model;
                  })}
                </span>
                {showModelDetail && detail.selectedModel ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-foreground whitespace-nowrap cursor-default">
                          {detail.selectedModel}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t(
                          ($) => {
                            return $.activity.detail.modelProvidedBy;
                          },
                          {
                            model: detail.selectedModel,
                            provider: detail.modelProvider
                              ? (MODEL_PROVIDER_TYPES[
                                  detail.modelProvider as ModelProviderType
                                ]?.label ?? detail.modelProvider)
                              : detail.framework,
                          },
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <span className="text-foreground whitespace-nowrap">
                    {detail.modelProvider
                      ? (MODEL_PROVIDER_TYPES[
                          detail.modelProvider as ModelProviderType
                        ]?.label ?? detail.modelProvider)
                      : detail.framework}
                  </span>
                )}
              </div>
              <span
                className="w-px h-3.5 shrink-0 bg-divider self-center"
                aria-hidden
              />
            </>
          )}
          <div className="flex items-center gap-1.5 px-3">
            <span className="text-muted-foreground shrink-0">
              {t(($) => {
                return $.activity.detail.fields.duration;
              })}
            </span>
            <span className="text-foreground whitespace-nowrap">
              {duration ?? "—"}
            </span>
          </div>
          <span
            className="w-px h-3.5 shrink-0 bg-divider self-center"
            aria-hidden
          />
          <div className="flex items-center gap-1.5 px-3">
            <span className="text-muted-foreground shrink-0">
              {t(($) => {
                return $.activity.detail.fields.time;
              })}
            </span>
            <span className="text-foreground whitespace-nowrap">{time}</span>
          </div>
          <div className="ml-auto flex items-center gap-1 shrink-0">
            {(logDetail || onDownload) && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t(($) => {
                        return $.activity.detail.downloadRawData;
                      })}
                      className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground p-0"
                      onClick={() => {
                        if (onDownload) {
                          onDownload();
                        } else if (logDetail) {
                          downloadJson(events, detail.id, logDetail);
                        }
                      }}
                    >
                      <Download size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p className="text-xs">
                      {t(($) => {
                        return $.activity.detail.downloadRawData;
                      })}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
      </div>
      {detail.error && status === "failed" && (
        <RunErrorBanner error={detail.error} />
      )}
    </div>
  );
}

function prepareRenderData(
  detail: {
    prompt: string | null;
    appendSystemPrompt: string | null;
  },
  features: Record<FeatureSwitchKey, boolean> | undefined,
) {
  const prompt = detail.prompt ?? "";
  const appendSystemPrompt = detail.appendSystemPrompt ?? "";
  const showSystemPrompt =
    (features?.[FeatureSwitchKey.OkouDebug] ?? false) &&
    appendSystemPrompt.trim().length > 0;
  return { prompt, appendSystemPrompt, showSystemPrompt };
}

function resolveDisplayName(
  detail: { displayName: string | null; agentId: string | null } | null,
  isStale: boolean,
  fallback: string,
): string {
  if (!detail || isStale) {
    return fallback;
  }
  return detail.displayName ?? detail.agentId ?? fallback;
}

type ActivityTab = "steps" | "context" | "runner" | "network";

function ActivityStepsContent({
  detail,
  features,
}: {
  detail: LogDetail;
  features: Record<FeatureSwitchKey, boolean> | undefined;
}) {
  const { t } = useTranslation();
  const stepSearch = useGet(activityStepSearch$);
  const setStepSearch = useSet(setActivityStepSearch$);
  const visibleGroupsLoadable = useLastLoadable(activityVisibleGroups$);
  const visibleGroupsData =
    visibleGroupsLoadable.state === "hasData" &&
    visibleGroupsLoadable.data.runId === detail.id
      ? visibleGroupsLoadable.data
      : null;
  const visibleGroups =
    visibleGroupsData === null ? [] : visibleGroupsData.groups;
  const visibleGroupsLoading =
    visibleGroupsLoadable.state === "loading" ||
    (visibleGroupsLoadable.state === "hasData" &&
      (visibleGroupsLoadable.data.runId !== detail.id ||
        visibleGroupsLoadable.data.loading));
  const { prompt, showSystemPrompt, appendSystemPrompt } = prepareRenderData(
    detail,
    features,
  );
  const searchTerm = stepSearch.trim();
  const groups = visibleGroups.filter((group) => {
    return eventGroupMatchesSearch(group, searchTerm);
  });

  return (
    <div className="flex flex-col gap-4 pb-8 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-base font-medium text-foreground whitespace-nowrap">
            {t(($) => {
              return $.activity.detail.steps.title;
            })}
          </span>
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {stepSearch.trim()
              ? t(
                  ($) => {
                    return $.activity.detail.steps.matched;
                  },
                  {
                    matched: formatAppNumber(groups.length),
                    total: formatAppNumber(visibleGroups.length),
                  },
                )
              : t(
                  ($) => {
                    return $.activity.detail.steps.total;
                  },
                  { total: formatAppNumber(visibleGroups.length) },
                )}
          </span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="relative flex-1 sm:flex-none sm:w-44">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t(($) => {
                return $.activity.detail.steps.search;
              })}
              value={stepSearch}
              onChange={(event) => {
                return setStepSearch(event.target.value);
              }}
              className="pl-9"
            />
          </div>
        </div>
      </div>

      <StepsList
        prompt={prompt}
        appendSystemPrompt={showSystemPrompt ? appendSystemPrompt : ""}
        groups={groups}
        stepSearch={stepSearch}
        isLoading={visibleGroupsLoading}
        startedAt={detail.startedAt}
      />
    </div>
  );
}

function ActivityContextTab({ detail }: { detail: LogDetail }) {
  const { t } = useTranslation();
  const contextLoadable = useLastLoadable(activityContext$);
  const modelRoute =
    detail.modelRuntimeProvider && detail.modelRuntimeModel ? (
      <section className="mb-6">
        <SectionHeader
          title={t(($) => {
            return $.activity.context.modelRoute;
          })}
        />
        <KeyValueTable
          data={{
            [t(($) => {
              return $.activity.context.selectedModel;
            })]: detail.selectedModel ?? "—",
            [t(($) => {
              return $.activity.context.modelProvider;
            })]: detail.modelProvider ?? "—",
            [t(($) => {
              return $.activity.context.runtimeProvider;
            })]: detail.modelRuntimeProvider,
            [t(($) => {
              return $.activity.context.runtimeModel;
            })]: detail.modelRuntimeModel,
          }}
        />
      </section>
    ) : null;

  let contextContent: ReactNode;
  if (
    contextLoadable.state === "loading" ||
    contextLoadable.state === "hasError" ||
    (contextLoadable.state === "hasData" &&
      contextLoadable.data?.runId !== detail.id)
  ) {
    contextContent = (
      <div className="flex flex-col gap-2 py-4">
        {["prompt", "system-prompt", "environment"].map((section) => {
          return (
            <div key={section} className="flex flex-col gap-2">
              <div className="h-4 w-24 rounded bg-muted/50 animate-pulse" />
              <div className="h-20 w-full rounded bg-muted/50 animate-pulse" />
            </div>
          );
        })}
      </div>
    );
  } else {
    const context = contextLoadable.data?.context ?? null;
    contextContent = context ? (
      <ContextContent context={context} />
    ) : (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <h2 className="text-lg font-semibold text-foreground">
          {t(($) => {
            return $.activity.detail.contextUnavailable.title;
          })}
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          {t(($) => {
            return $.activity.detail.contextUnavailable.description;
          })}
        </p>
      </div>
    );
  }

  return (
    <>
      {modelRoute}
      {contextContent}
    </>
  );
}

type RunnerStartupPath = "sandbox" | "workspace" | "cold" | "unknown";

interface ReuseOutcomeInfo {
  readonly label: string;
  readonly description: string;
}

function isCurrentSandboxMiss(result: SandboxReuseResult | null): boolean {
  return (
    result === "noReuseKey" ||
    result === "poolMiss" ||
    result === "profileMismatch" ||
    result === "deviceLimitMismatch" ||
    result === "unparkFailed"
  );
}

function isWorkspaceMiss(result: WorkspaceReuseResult | null): boolean {
  return result !== null && result !== "reused" && result !== "sandboxReused";
}

function runnerStartupPath(
  sandbox: SandboxReuseResult | null,
  workspace: WorkspaceReuseResult | null,
): RunnerStartupPath {
  if (sandbox === "reused" && workspace === "sandboxReused") {
    return "sandbox";
  }
  if (isCurrentSandboxMiss(sandbox) && workspace === "reused") {
    return "workspace";
  }
  if (isCurrentSandboxMiss(sandbox) && isWorkspaceMiss(workspace)) {
    return "cold";
  }
  return "unknown";
}

function isActiveRunnerStatus(status: LogStatus | undefined): boolean {
  return status === "queued" || status === "pending" || status === "running";
}

function sandboxOutcomeInfo(
  result: SandboxReuseResult | null,
  descriptions: Record<SandboxReuseResult, string>,
  labels: {
    readonly missing: string;
    readonly missingDescription: string;
    readonly notReused: string;
    readonly reused: string;
  },
): ReuseOutcomeInfo {
  if (result === null) {
    return {
      label: labels.missing,
      description: labels.missingDescription,
    };
  }
  return {
    label: result === "reused" ? labels.reused : labels.notReused,
    description: descriptions[result],
  };
}

function workspaceOutcomeInfo(
  result: WorkspaceReuseResult | null,
  descriptions: Record<WorkspaceReuseResult, string>,
  labels: {
    readonly missing: string;
    readonly missingDescription: string;
    readonly notReused: string;
    readonly reused: string;
  },
): ReuseOutcomeInfo {
  if (result === null) {
    return {
      label: labels.missing,
      description: labels.missingDescription,
    };
  }
  const wasReused = result === "reused" || result === "sandboxReused";
  return {
    label: wasReused ? labels.reused : labels.notReused,
    description: descriptions[result],
  };
}

function RunnerEnvironmentCard({
  title,
  info,
}: {
  readonly title: string;
  readonly info: ReuseOutcomeInfo;
}) {
  return (
    <article className="rounded-lg border bg-card p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <span className="inline-flex items-center rounded-md border bg-muted/50 px-2 py-0.5 text-xs font-medium">
          {info.label}
        </span>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {info.description}
      </p>
    </article>
  );
}

function RunnerAttributionCell({
  label,
  value,
  missing,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly missing: string;
}) {
  return (
    <div className="min-w-0 border-t px-4 py-3 first:border-t-0 sm:even:border-l sm:[&:nth-child(2)]:border-t-0 lg:border-t-0 lg:border-l lg:first:border-l-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`mt-1 break-all font-mono text-sm ${
          value === null ? "text-muted-foreground" : "text-foreground"
        }`}
      >
        {value ?? missing}
      </dd>
    </div>
  );
}

interface RunnerAttribution {
  readonly runnerHostname: string | null;
  readonly runnerVersion: string | null;
  readonly runnerId: string | null;
  readonly runnerHeartbeatGeneration: number | null;
}

function RunnerAttributionGrid({
  runner,
  framework,
  missing,
}: {
  readonly runner: RunnerAttribution | null;
  readonly framework: string | null;
  readonly missing: string;
}) {
  const { t } = useTranslation();
  const frameworkDisplayName =
    framework !== null && isSupportedFramework(framework)
      ? getFrameworkDisplayName(framework)
      : framework;
  return (
    <dl className="grid grid-cols-1 overflow-hidden rounded-lg border bg-card sm:grid-cols-2 lg:grid-cols-5">
      <RunnerAttributionCell
        label={t(($) => {
          return $.activity.detail.runner.framework;
        })}
        value={frameworkDisplayName}
        missing={t(($) => {
          return $.activity.detail.runner.unavailable;
        })}
      />
      <RunnerAttributionCell
        label={t(($) => {
          return $.activity.detail.runner.hostname;
        })}
        value={runner?.runnerHostname ?? null}
        missing={missing}
      />
      <RunnerAttributionCell
        label={t(($) => {
          return $.activity.detail.runner.version;
        })}
        value={runner?.runnerVersion ?? null}
        missing={missing}
      />
      <RunnerAttributionCell
        label={t(($) => {
          return $.activity.detail.runner.runnerId;
        })}
        value={runner?.runnerId ?? null}
        missing={missing}
      />
      <RunnerAttributionCell
        label={t(($) => {
          return $.activity.detail.runner.generation;
        })}
        value={runner?.runnerHeartbeatGeneration?.toString() ?? null}
        missing={missing}
      />
    </dl>
  );
}

function ActivityRunnerTab({ detail }: { detail: LogDetail }) {
  const { t } = useTranslation();
  const runnerLoadable = useLastLoadable(activityRunner$);

  if (
    runnerLoadable.state === "loading" ||
    runnerLoadable.state === "hasError" ||
    (runnerLoadable.state === "hasData" &&
      runnerLoadable.data?.runId !== detail.id)
  ) {
    return (
      <div className="flex flex-col gap-2 py-4">
        <div className="h-4 w-24 rounded bg-muted/50 animate-pulse" />
        <div className="h-8 w-64 rounded bg-muted/50 animate-pulse" />
      </div>
    );
  }

  const runner = runnerLoadable.data?.runner ?? null;
  const sandboxReuse = runner?.sandboxReuseResult ?? null;
  const workspaceReuse = runner?.workspaceReuseResult ?? null;
  const missing = isActiveRunnerStatus(runnerLoadable.data?.status)
    ? t(($) => {
        return $.activity.detail.runner.provisioning;
      })
    : t(($) => {
        return $.activity.detail.runner.unavailable;
      });
  const notReused = t(($) => {
    return $.activity.detail.runner.notReused;
  });
  const reused = t(($) => {
    return $.activity.detail.runner.reused;
  });
  const missingDescription = t(($) => {
    return $.activity.detail.runner.outcomeUnavailableDescription;
  });
  const sandboxDescriptions = {
    reused: t(($) => {
      return $.activity.detail.runner.reusedDescription;
    }),
    featureDisabled: t(($) => {
      return $.activity.detail.runner.featureDisabled;
    }),
    noSessionId: t(($) => {
      return $.activity.detail.runner.noSessionId;
    }),
    noReuseKey: t(($) => {
      return $.activity.detail.runner.noReuseKey;
    }),
    poolMiss: t(($) => {
      return $.activity.detail.runner.poolMiss;
    }),
    profileMismatch: t(($) => {
      return $.activity.detail.runner.profileMismatch;
    }),
    deviceLimitMismatch: t(($) => {
      return $.activity.detail.runner.deviceLimitMismatch;
    }),
    unparkFailed: t(($) => {
      return $.activity.detail.runner.unparkFailed;
    }),
  } satisfies Record<SandboxReuseResult, string>;
  const workspaceDescriptions = {
    reused: t(($) => {
      return $.activity.detail.runner.workspaceReusedDescription;
    }),
    sandboxReused: t(($) => {
      return $.activity.detail.runner.sandboxReusedDescription;
    }),
    cacheMiss: t(($) => {
      return $.activity.detail.runner.cacheMiss;
    }),
    noReuseKey: t(($) => {
      return $.activity.detail.runner.workspaceNoReuseKey;
    }),
    invalidWorkingDir: t(($) => {
      return $.activity.detail.runner.invalidWorkingDir;
    }),
    lockBusy: t(($) => {
      return $.activity.detail.runner.lockBusy;
    }),
    invalidMetadata: t(($) => {
      return $.activity.detail.runner.invalidMetadata;
    }),
    diskPressure: t(($) => {
      return $.activity.detail.runner.diskPressure;
    }),
    notConfigured: t(($) => {
      return $.activity.detail.runner.notConfigured;
    }),
    sandboxPrepareFallback: t(($) => {
      return $.activity.detail.runner.sandboxPrepareFallback;
    }),
  } satisfies Record<WorkspaceReuseResult, string>;
  const labels = { missing, missingDescription, notReused, reused };
  const sandboxInfo = sandboxOutcomeInfo(
    sandboxReuse,
    sandboxDescriptions,
    labels,
  );
  const workspaceInfo = workspaceOutcomeInfo(
    workspaceReuse,
    workspaceDescriptions,
    labels,
  );
  const startupLabels = {
    sandbox: t(($) => {
      return $.activity.detail.runner.startupSandbox;
    }),
    workspace: t(($) => {
      return $.activity.detail.runner.startupWorkspace;
    }),
    cold: t(($) => {
      return $.activity.detail.runner.startupCold;
    }),
    unknown: t(($) => {
      return $.activity.detail.runner.startupUnknown;
    }),
  } satisfies Record<RunnerStartupPath, string>;
  const startupDescriptions = {
    sandbox: t(($) => {
      return $.activity.detail.runner.startupSandboxDescription;
    }),
    workspace: t(($) => {
      return $.activity.detail.runner.startupWorkspaceDescription;
    }),
    cold: t(($) => {
      return $.activity.detail.runner.startupColdDescription;
    }),
    unknown: t(($) => {
      return $.activity.detail.runner.startupUnknownDescription;
    }),
  } satisfies Record<RunnerStartupPath, string>;
  const startupPath = runnerStartupPath(sandboxReuse, workspaceReuse);
  const startupInfo = {
    label: startupLabels[startupPath],
    description: startupDescriptions[startupPath],
  };

  return (
    <div className="flex flex-col gap-6 pb-8">
      <RunnerAttributionGrid
        runner={runner}
        framework={detail.framework}
        missing={missing}
      />
      <section>
        <SectionHeader
          title={t(($) => {
            return $.activity.detail.runner.environment;
          })}
        />
        <div className="grid gap-3 lg:grid-cols-3">
          <RunnerEnvironmentCard
            title={t(($) => {
              return $.activity.detail.runner.startup;
            })}
            info={startupInfo}
          />
          <RunnerEnvironmentCard
            title={t(($) => {
              return $.activity.detail.runner.sandbox;
            })}
            info={sandboxInfo}
          />
          <RunnerEnvironmentCard
            title={t(($) => {
              return $.activity.detail.runner.workspace;
            })}
            info={workspaceInfo}
          />
        </div>
      </section>
    </div>
  );
}

function ActivityNetworkTab({ detailId }: { detailId: string }) {
  const { t } = useTranslation();
  const logsLoadable = useLastLoadable(activityNetworkLogs$);
  const loadNextPage = useSet(loadNetworkLogsNextPage$);
  const pageSignal = useGet(pageSignal$);

  if (
    logsLoadable.state === "loading" ||
    logsLoadable.state === "hasError" ||
    (logsLoadable.state === "hasData" && logsLoadable.data.runId !== detailId)
  ) {
    return (
      <div className="flex flex-col gap-2 py-4">
        {Array.from({ length: 5 }, (_, i) => {
          return (
            <div
              key={i}
              className="h-8 w-full rounded bg-muted/50 animate-pulse"
            />
          );
        })}
      </div>
    );
  }

  const data = logsLoadable.data;
  if (!data || data.networkLogs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <h2 className="text-lg font-semibold text-foreground">
          {t(($) => {
            return $.activity.detail.networkEmpty.title;
          })}
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          {t(($) => {
            return $.activity.detail.networkEmpty.description;
          })}
        </p>
      </div>
    );
  }

  const handleLoadMore = () => {
    detach(loadNextPage(pageSignal), Reason.DomCallback);
  };

  return (
    <NetworkContent
      networkLogs={data.networkLogs}
      hasMore={data.hasMore}
      loading={data.loading}
      onLoadMore={handleLoadMore}
    />
  );
}

function ActivityTabContent({
  activeTab,
  detail,
  features,
}: {
  activeTab: ActivityTab;
  detail: LogDetail;
  features: Record<FeatureSwitchKey, boolean> | undefined;
}) {
  if (activeTab === "steps") {
    return <ActivityStepsContent detail={detail} features={features} />;
  }
  if (activeTab === "context") {
    return <ActivityContextTab detail={detail} />;
  }
  if (activeTab === "runner") {
    return <ActivityRunnerTab detail={detail} />;
  }
  return <ActivityNetworkTab detailId={detail.id} />;
}

function ActivityDetailContent({
  detail,
  displayName,
  events,
  features,
}: {
  detail: LogDetail;
  displayName: string;
  events: AgentEvent[];
  features: Record<FeatureSwitchKey, boolean> | undefined;
}) {
  const { t } = useTranslation();
  const params = useGet(searchParams$);
  const updateParams = useSet(updateSearchParams$);
  const showDebugTabs = features?.[FeatureSwitchKey.OkouDebug] ?? false;
  const rawTab = params.get("tab");
  const activeTab: ActivityTab =
    showDebugTabs &&
    (rawTab === "context" || rawTab === "runner" || rawTab === "network")
      ? rawTab
      : "steps";
  const setActiveTab = (tab: ActivityTab) => {
    const next = new URLSearchParams(params);
    if (tab === "steps") {
      next.delete("tab");
    } else {
      next.set("tab", tab);
    }
    detach(updateParams(next), Reason.DomCallback);
  };
  const fetchExtra = useSet(fetchDownloadExtra$);
  const pageSignal = useGet(pageSignal$);
  const setScrollContainer = useSet(setActivityDetailScrollContainer$);

  const status: LogStatus = detail.status;
  const time = formatLogTime(detail.createdAt);
  const duration = formatDuration(detail.startedAt, detail.completedAt);

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <div
        ref={setScrollContainer}
        className="flex-1 flex flex-col min-h-0 overflow-auto"
      >
        <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
          {features?.[FeatureSwitchKey.OkouDebug] && (
            <>
              <ActivityBreadcrumbLabel />
              <span className="text-muted-foreground/40 select-none">/</span>
            </>
          )}
          <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate">
            {displayName}
          </span>
        </nav>
        <div className="mx-auto w-full max-w-[900px] px-4 sm:px-6 pt-4 pb-[max(2rem,var(--sab))]">
          <ActivityHeaderCard
            displayName={displayName}
            status={status}
            triggerSource={detail.triggerSource ?? null}
            detail={detail}
            logDetail={detail}
            duration={duration}
            time={time}
            events={events}
            showModelDetail
            onDownload={() => {
              detach(
                (async () => {
                  const extra = await fetchExtra(detail.id, pageSignal);
                  downloadJson(events, detail.id, detail, extra);
                })(),
                Reason.DomCallback,
              );
            }}
          />

          {showDebugTabs && (
            <div className="mt-4">
              <Tabs
                value={activeTab}
                onValueChange={(v) => {
                  setActiveTab(v as ActivityTab);
                }}
              >
                <TabsList>
                  <TabsTrigger value="steps">
                    {t(($) => {
                      return $.activity.detail.tabs.steps;
                    })}
                  </TabsTrigger>
                  <TabsTrigger value="context">
                    {t(($) => {
                      return $.activity.detail.tabs.context;
                    })}
                  </TabsTrigger>
                  <TabsTrigger value="runner">
                    {t(($) => {
                      return $.activity.detail.tabs.runner;
                    })}
                  </TabsTrigger>
                  <TabsTrigger value="network">
                    {t(($) => {
                      return $.activity.detail.tabs.network;
                    })}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          )}

          <div className="mt-6">
            <ActivityTabContent
              activeTab={activeTab}
              detail={detail}
              features={features}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ActivityDetailPage() {
  const { t } = useTranslation();
  const currentRunId = useGet(currentRunId$);
  const detailLoadable = useLastLoadable(activityDetail$);
  const eventsLoadable = useLastLoadable(activityEvents$);
  // Resolve agent display name from the detail response
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  // Detect stale detail from previous navigation (useLastLoadable keeps old data)
  const isStale = detail !== null && detail.id !== currentRunId;
  const displayName = resolveDisplayName(
    detail,
    isStale,
    t(($) => {
      return $.activity.detail.fallbackAgent;
    }),
  );

  const features = useLastResolved(featureSwitch$);
  const events =
    eventsLoadable.state === "hasData" &&
    eventsLoadable.data?.runId === currentRunId
      ? eventsLoadable.data.events
      : [];

  if (!detail || isStale) {
    if (detailLoadable.state === "hasError") {
      return <ActivityNotFound />;
    }
    return <ActivitySkeleton />;
  }

  return (
    <ActivityDetailContent
      detail={detail}
      displayName={displayName}
      events={events}
      features={features}
    />
  );
}

function ActivitySkeleton() {
  const features = useLastResolved(featureSwitch$);
  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
          {features?.[FeatureSwitchKey.OkouDebug] && (
            <>
              <ActivityBreadcrumbLabel />
              <span className="text-muted-foreground/40 select-none">/</span>
            </>
          )}
          <div className="h-4 w-20 rounded bg-muted/50 animate-pulse" />
        </nav>
        <div className="mx-auto max-w-[900px] px-4 sm:px-6 pt-4 pb-[max(2rem,var(--sab))] w-full">
          {/* Header card skeleton */}
          <div className={surfaceVariants({ className: "shrink-0 px-4 py-3" })}>
            <div className="flex flex-wrap items-center gap-y-2 gap-x-3">
              <div className="h-5 w-28 rounded bg-muted/50 animate-pulse" />
              <span
                className="w-px h-3.5 shrink-0 bg-divider self-center"
                aria-hidden
              />
              <div className="h-4 w-20 rounded bg-muted/50 animate-pulse" />
              <div className="h-4 w-16 rounded bg-muted/50 animate-pulse" />
              <div className="h-4 w-24 rounded bg-muted/50 animate-pulse" />
            </div>
          </div>

          {/* Steps skeleton */}
          <div className="flex flex-col gap-4 flex-1 min-h-0 mt-6">
            <div className="flex items-center gap-3">
              <div className="h-5 w-12 rounded bg-muted/50 animate-pulse" />
            </div>
            <div className="flex flex-col gap-3">
              {["sk-1", "sk-2", "sk-3"].map((id) => {
                return (
                  <div
                    key={id}
                    className="rounded-lg border border-border/40 p-4"
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <div className="h-2 w-2 rounded-full bg-muted/50 animate-pulse" />
                      <div className="h-4 w-16 rounded bg-muted/50 animate-pulse" />
                    </div>
                    <div className="space-y-2 ml-4">
                      <div className="h-3 w-full rounded bg-muted/30 animate-pulse" />
                      <div className="h-3 w-3/4 rounded bg-muted/30 animate-pulse" />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function StepsList({
  prompt,
  appendSystemPrompt,
  groups,
  stepSearch,
  isLoading,
  startedAt,
}: {
  prompt: string;
  appendSystemPrompt: string;
  groups: EventGroup[];
  stepSearch: string;
  isLoading: boolean;
  startedAt?: string | null;
}) {
  const { t } = useTranslation();
  const normalizedStepSearch = stepSearch.trim();
  const hasSystemPrompt = appendSystemPrompt.trim().length > 0;
  const hasPrompt = prompt.trim().length > 0;
  const hasContent = hasSystemPrompt || hasPrompt || groups.length > 0;
  return (
    <div className="min-w-0">
      {hasSystemPrompt && (
        <PromptCard
          label={t(($) => {
            return $.activity.detail.steps.systemPrompt;
          })}
          prompt={appendSystemPrompt}
          showConnector={hasPrompt || groups.length > 0}
        />
      )}
      {hasPrompt && (
        <PromptCard
          label={t(($) => {
            return $.activity.detail.steps.userPrompt;
          })}
          prompt={prompt}
          showConnector={groups.length > 0}
        />
      )}
      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
        </div>
      ) : groups.length === 0 && !hasContent ? (
        <div className="py-8 text-center text-muted-foreground">
          {t(($) => {
            return $.activity.detail.steps.noEvents;
          })}
        </div>
      ) : (
        groups.map((group, index) => {
          return (
            <EventGroupCard
              key={eventGroupKey(group)}
              group={group}
              searchTerm={normalizedStepSearch}
              showConnector={index < groups.length - 1}
              startedAt={startedAt}
            />
          );
        })
      )}
    </div>
  );
}

function downloadJson(
  events: AgentEvent[],
  logId: string,
  detail: LogDetail,
  extra?: { context?: unknown; networkLogs?: unknown },
) {
  const runtimeFramework = runtimeFrameworkFromContext(extra?.context);
  const data: Record<string, unknown> = {
    meta: {
      id: detail.id,
      displayName: detail.displayName,
      status: detail.status,
      triggerSource: detail.triggerSource,
      modelProvider: detail.modelProvider,
      selectedModel: detail.selectedModel,
      modelRuntimeProvider: detail.modelRuntimeProvider,
      modelRuntimeModel: detail.modelRuntimeModel,
      framework: runtimeFramework ?? detail.framework,
      prompt: detail.prompt,
      appendSystemPrompt: detail.appendSystemPrompt,
      error: detail.error,
      createdAt: detail.createdAt,
      startedAt: detail.startedAt,
      completedAt: detail.completedAt,
      agentId: detail.agentId,
      sessionId: detail.sessionId,
    },
    events,
  };
  if (extra?.context) {
    data.context = extra.context;
  }
  if (extra?.networkLogs) {
    data.networkLogs = extra.networkLogs;
  }
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${logId}-logs.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function runtimeFrameworkFromContext(context: unknown): string | null {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return null;
  }

  const cliAgentType = (context as { readonly cliAgentType?: unknown })
    .cliAgentType;
  return typeof cliAgentType === "string" && cliAgentType.length > 0
    ? cliAgentType
    : null;
}

function summarizePrompt(prompt: string): string {
  const lines = prompt.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (
      line.length > 0 &&
      !line.startsWith("#") &&
      !line.startsWith("---") &&
      !line.startsWith("- ") &&
      !line.startsWith("[file]") &&
      !line.startsWith("[Web file]") &&
      !line.startsWith("[Slack file]") &&
      !line.startsWith("[ID]") &&
      !line.startsWith("[Dimensions]") &&
      !line.startsWith("[URL]")
    ) {
      return line.length > 80 ? `${line.slice(0, 77)}...` : line;
    }
  }
  const first =
    lines
      .find((l) => {
        return l.trim().length > 0;
      })
      ?.trim() ?? "";
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

function PromptCard({
  label,
  prompt,
  showConnector,
}: {
  label?: string;
  prompt: string;
  showConnector: boolean;
}) {
  const summary = summarizePrompt(prompt);

  return (
    <div className="relative">
      {showConnector && (
        <div
          className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-divider/70"
          aria-hidden="true"
        />
      )}
      <details className="group relative py-2">
        <summary className="cursor-pointer list-none">
          <div className="flex gap-2 items-center">
            <StatusDot variant="neutral" />
            <span className="font-semibold text-sm text-foreground shrink-0">
              {label}
            </span>
            <span className="text-sm text-muted-foreground truncate">
              {summary}
            </span>
          </div>
        </summary>
        <div className="absolute left-[2px] top-[2.25rem] bottom-0 w-[1px] bg-divider/70 group-open:block hidden" />
        <div className="ml-[18px] mt-2">
          <Markdown source={prompt} />
        </div>
      </details>
    </div>
  );
}
