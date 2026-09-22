import { useGet, useSet, useLastResolved } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Search, ChartLine, Upload } from "lucide-react";
import {
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
  buttonVariants,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { triggerSourceSchema } from "@okouai/api-contracts/contracts/logs";
import type {
  LogStatus,
  TriggerSource,
} from "../../signals/okou-page/log-types.ts";
import {
  formatLogTime,
  formatDuration,
} from "../../signals/activity-page/activity-signals.ts";
import { eventGroupMatchesSearch } from "../../signals/activity-page/log-detail-utils";
import {
  ActivityHeaderCard,
  StepsList,
} from "../okou-page/activity-detail-page.tsx";
import {
  inspectLogData$,
  inspectLogLoadError$,
  inspectStepSearch$,
  inspectVisibleGroups$,
  loadInspectLogFile$,
  setInspectStepSearch$,
  type InspectLogData,
} from "../../signals/activity-page/inspect-log-signals.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { searchParams$, updateSearchParams$ } from "../../signals/route.ts";
import { ContextContent } from "../okou-page/components/context-content.tsx";
import { NetworkContent } from "../okou-page/components/network-content.tsx";
import { formatAppNumber } from "../../i18n/format.ts";

type InspectTab = "steps" | "context" | "network";

const LOG_STATUSES = [
  "queued",
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancelled",
] as const satisfies readonly LogStatus[];

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isLogStatus(value: unknown): value is LogStatus {
  return (
    typeof value === "string" &&
    LOG_STATUSES.some((status) => {
      return status === value;
    })
  );
}

function isTriggerSource(value: unknown): value is TriggerSource {
  return triggerSourceSchema.safeParse(value).success;
}

function logStatusValue(value: unknown): LogStatus {
  return isLogStatus(value) ? value : "completed";
}

function triggerSourceValue(value: unknown): TriggerSource | null {
  return isTriggerSource(value) ? value : null;
}

function isInspectTab(value: string): value is InspectTab {
  return value === "steps" || value === "context" || value === "network";
}

function InspectBreadcrumb({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
      <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5">
        <ChartLine size={14} className="shrink-0" />
        {t(($) => {
          return $.activity.detail.activity;
        })}
      </span>
      <span className="text-muted-foreground/40 select-none">/</span>
      <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate">
        {title}
      </span>
    </nav>
  );
}

function InspectEmptyState() {
  const { t } = useTranslation();
  const loadFile = useSet(loadInspectLogFile$);
  const pageSignal = useGet(pageSignal$);
  const loadError = useGet(inspectLogLoadError$);

  return (
    <div className="h-full flex flex-col min-h-0">
      <InspectBreadcrumb
        title={t(($) => {
          return $.activity.inspect.inspect;
        })}
      />
      <div className="flex-1 flex flex-col items-center justify-center gap-3 pb-20">
        <Upload size={48} className="" />
        <h2 className="text-lg font-semibold text-foreground">
          {t(($) => {
            return $.activity.inspect.noLog.title;
          })}
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          {t(($) => {
            return $.activity.inspect.noLog.description;
          })}
        </p>
        {loadError && (
          <p className="text-sm text-destructive text-center max-w-sm">
            {loadError}
          </p>
        )}
        <label
          className={cn(
            buttonVariants({ variant: "outline" }),
            "cursor-pointer",
          )}
        >
          <Upload size={16} />
          {t(($) => {
            return $.activity.inspect.noLog.upload;
          })}
          <input
            type="file"
            accept=".json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                detach(loadFile(file, pageSignal), Reason.DomCallback);
              }
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}

function buildInspectDetail(meta: InspectLogData["meta"]) {
  return {
    id: stringValue(meta?.id) ?? "inspect",
    modelProvider: nullableStringValue(meta?.modelProvider),
    selectedModel: nullableStringValue(meta?.selectedModel),
    framework: nullableStringValue(meta?.framework),
    error: nullableStringValue(meta?.error),
  };
}

function prepareInspectData(data: InspectLogData, fallbackName: string) {
  const { meta, events } = data;
  const detail = buildInspectDetail(meta);
  const createdAt = stringValue(meta?.createdAt);

  return {
    events,
    displayName: stringValue(meta?.displayName) ?? fallbackName,
    status: logStatusValue(meta?.status),
    triggerSource: triggerSourceValue(meta?.triggerSource),
    detail,
    duration: formatDuration(
      nullableStringValue(meta?.startedAt),
      nullableStringValue(meta?.completedAt),
    ),
    time: createdAt ? formatLogTime(createdAt) : "—",
    startedAt: nullableStringValue(meta?.startedAt),
    prompt: stringValue(meta?.prompt) ?? "",
    appendSystemPrompt: stringValue(meta?.appendSystemPrompt) ?? "",
  };
}

function StepsTab({
  prepared,
}: {
  prepared: ReturnType<typeof prepareInspectData>;
}) {
  const { t } = useTranslation();
  const stepSearch = useGet(inspectStepSearch$);
  const setStepSearch = useSet(setInspectStepSearch$);
  const visibleGroups = useGet(inspectVisibleGroups$);
  const { prompt, appendSystemPrompt } = prepared;
  const showSystemPrompt = appendSystemPrompt.trim().length > 0;

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
              onChange={(e) => {
                return setStepSearch(e.target.value);
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
        isLoading={false}
        startedAt={prepared.startedAt}
      />
    </div>
  );
}

function InspectMissingPanel({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <p className="text-sm text-muted-foreground text-center max-w-sm">
        {description}
      </p>
    </div>
  );
}

function InspectContextTab({ data }: { data: InspectLogData }) {
  const { t } = useTranslation();
  if (!data.context) {
    return (
      <InspectMissingPanel
        title={t(($) => {
          return $.activity.inspect.contextUnavailable.title;
        })}
        description={t(($) => {
          return $.activity.inspect.contextUnavailable.description;
        })}
      />
    );
  }
  return <ContextContent context={data.context} />;
}

function InspectNetworkTab({ data }: { data: InspectLogData }) {
  const { t } = useTranslation();
  if (!data.networkLogs) {
    return (
      <InspectMissingPanel
        title={t(($) => {
          return $.activity.inspect.networkUnavailable.title;
        })}
        description={t(($) => {
          return $.activity.inspect.networkUnavailable.description;
        })}
      />
    );
  }
  return <NetworkContent networkLogs={data.networkLogs} />;
}

function InspectLogContent({ data }: { data: InspectLogData }) {
  const { t } = useTranslation();
  const features = useLastResolved(featureSwitch$);
  const showDebugTabs = features?.[FeatureSwitchKey.OkouDebug] ?? false;

  const params = useGet(searchParams$);
  const updateParams = useSet(updateSearchParams$);
  const rawTab = params.get("tab");
  const activeTab: InspectTab =
    showDebugTabs && (rawTab === "context" || rawTab === "network")
      ? rawTab
      : "steps";
  const setActiveTab = (tab: InspectTab) => {
    const next = new URLSearchParams(params);
    if (tab === "steps") {
      next.delete("tab");
    } else {
      next.set("tab", tab);
    }
    detach(updateParams(next), Reason.DomCallback);
  };

  const prepared = prepareInspectData(
    data,
    t(($) => {
      return $.activity.inspect.fallbackName;
    }),
  );
  const { displayName, status, triggerSource, detail, duration, time, events } =
    prepared;

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        <InspectBreadcrumb title={displayName} />
        <div className="mx-auto w-full max-w-[900px] px-4 sm:px-6 pt-4 pb-safe-or-8">
          <ActivityHeaderCard
            displayName={displayName}
            status={status}
            triggerSource={triggerSource}
            detail={detail}
            duration={duration}
            time={time}
            events={events}
            showModelDetail={Boolean(detail.selectedModel)}
          />

          {showDebugTabs && (
            <div className="mt-4">
              <Tabs
                value={activeTab}
                onValueChange={(v) => {
                  if (isInspectTab(v)) {
                    setActiveTab(v);
                  }
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
            {activeTab === "steps" && <StepsTab prepared={prepared} />}
            {activeTab === "context" && <InspectContextTab data={data} />}
            {activeTab === "network" && <InspectNetworkTab data={data} />}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ActivityInspectPage() {
  const data = useGet(inspectLogData$);

  if (!data) {
    return <InspectEmptyState />;
  }

  return <InspectLogContent data={data} />;
}
