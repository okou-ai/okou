import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  AlertCircle,
  ArrowLeft,
  CircleCheck,
  DatabaseBackup,
  Download,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { UserExportStatusResponse } from "@okouai/api-contracts/contracts/user-export";
import { surfaceVariants, Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { now } from "../../lib/time.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  startUserExport$,
  userExportStartError$,
  userExportStatus$,
  userExportStatusPollingRef$,
} from "../../signals/export-page/export-page-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { Link } from "../router/link.tsx";

type ExportViewState =
  | "loading"
  | "ready"
  | "in-progress"
  | "download"
  | "expired"
  | "failed"
  | "rate-limited";

const PRIMARY_ACTION_BUTTON_CLASS =
  "h-9 w-full gap-2 bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed";

function formatDuration(dateStr: string, locale: string, soon: string): string {
  const diffMs = new Date(dateStr).getTime() - now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return soon;
  }

  const totalMinutes = Math.ceil(diffMs / (1000 * 60));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes % 60;
  const formatUnit = (
    value: number,
    unit: "day" | "hour" | "minute",
  ): string => {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "narrow",
    }).format(value);
  };
  const values: string[] = [];
  if (days > 0) {
    values.push(formatUnit(days, "day"));
    if (hours > 0) {
      values.push(formatUnit(hours, "hour"));
    }
  } else if (hours > 0) {
    values.push(formatUnit(hours, "hour"));
    if (minutes > 0) {
      values.push(formatUnit(minutes, "minute"));
    }
  } else {
    values.push(formatUnit(minutes, "minute"));
  }
  return new Intl.ListFormat(locale, {
    style: "narrow",
    type: "unit",
  }).format(values);
}

function deriveViewState(
  data: UserExportStatusResponse | null,
  loading: boolean,
): ExportViewState {
  if (loading) {
    return "loading";
  }

  const job = data?.job;
  if (!job) {
    return data?.canExport ? "ready" : "rate-limited";
  }

  if (job.status === "pending" || job.status === "running") {
    return "in-progress";
  }

  if (job.status === "failed") {
    return "failed";
  }

  if (job.status === "completed") {
    const expired =
      job.expiresAt !== null && new Date(job.expiresAt).getTime() <= now();
    if (expired) {
      return "expired";
    }
    if (job.downloadUrl) {
      return "download";
    }
  }

  return data?.canExport ? "ready" : "rate-limited";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function StatusIcon({ viewState }: { readonly viewState: ExportViewState }) {
  if (viewState === "loading" || viewState === "in-progress") {
    return <Loader2 size={22} className="animate-spin" />;
  }
  if (viewState === "download") {
    return <CircleCheck size={22} />;
  }
  if (viewState === "failed") {
    return <AlertCircle size={22} />;
  }
  return <DatabaseBackup size={22} />;
}

function StatusCopy({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="text-sm leading-6 text-muted-foreground">{description}</p>
    </>
  );
}

function StatusText({
  viewState,
  data,
}: {
  readonly viewState: ExportViewState;
  readonly data: UserExportStatusResponse | null;
}) {
  const { t, i18n } = useTranslation();
  const duration = (date: string) => {
    return formatDuration(
      date,
      i18n.resolvedLanguage ?? i18n.language,
      t(($) => {
        return $.settings.export.duration.soon;
      }),
    );
  };

  if (viewState === "loading") {
    return (
      <StatusCopy
        title={t(($) => {
          return $.settings.export.status.checkingTitle;
        })}
        description={t(($) => {
          return $.settings.export.status.checkingDescription;
        })}
      />
    );
  }

  if (viewState === "in-progress") {
    return (
      <StatusCopy
        title={t(($) => {
          return $.settings.export.status.preparingTitle;
        })}
        description={t(($) => {
          return $.settings.export.status.preparingDescription;
        })}
      />
    );
  }

  if (viewState === "download") {
    const description = data?.job?.expiresAt
      ? t(
          ($) => {
            return $.settings.export.status.downloadExpires;
          },
          {
            duration: duration(data.job.expiresAt),
          },
        )
      : t(($) => {
          return $.settings.export.status.downloadNoExpiry;
        });
    return (
      <StatusCopy
        title={t(($) => {
          return $.settings.export.status.downloadTitle;
        })}
        description={description}
      />
    );
  }

  if (viewState === "expired") {
    return (
      <StatusCopy
        title={t(($) => {
          return $.settings.export.status.expiredTitle;
        })}
        description={t(($) => {
          return $.settings.export.status.expiredDescription;
        })}
      />
    );
  }

  if (viewState === "failed") {
    return (
      <StatusCopy
        title={t(($) => {
          return $.settings.export.status.failedTitle;
        })}
        description={t(($) => {
          return $.settings.export.status.failedDescription;
        })}
      />
    );
  }

  if (viewState === "rate-limited") {
    const description = data?.nextExportAt
      ? t(
          ($) => {
            return $.settings.export.status.rateLimitedUntil;
          },
          {
            duration: duration(data.nextExportAt),
          },
        )
      : t(($) => {
          return $.settings.export.status.rateLimitedFallback;
        });
    return (
      <StatusCopy
        title={t(($) => {
          return $.settings.export.status.rateLimitedTitle;
        })}
        description={description}
      />
    );
  }

  return (
    <StatusCopy
      title={t(($) => {
        return $.settings.export.status.readyTitle;
      })}
      description={t(($) => {
        return $.settings.export.status.readyDescription;
      })}
    />
  );
}

function ExportActions({
  viewState,
  data,
  triggering,
  onTrigger,
}: {
  readonly viewState: ExportViewState;
  readonly data: UserExportStatusResponse | null;
  readonly triggering: boolean;
  readonly onTrigger: () => void;
}) {
  const { t } = useTranslation();
  const canExport = data?.canExport ?? false;
  const downloadUrl = data?.job?.downloadUrl;

  if (viewState === "download" && downloadUrl) {
    return (
      <div className="flex w-full flex-col gap-2">
        <Button asChild className={PRIMARY_ACTION_BUTTON_CLASS}>
          <a href={downloadUrl} download>
            <Download size={16} />
            {t(($) => {
              return $.settings.export.actions.download;
            })}
          </a>
        </Button>
        {canExport && (
          <Button
            type="button"
            variant="neutral"
            className="h-9 w-full gap-2 rounded-lg"
            disabled={triggering}
            onClick={onTrigger}
          >
            {triggering ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <RefreshCw size={16} />
            )}
            {t(($) => {
              return $.settings.export.actions.again;
            })}
          </Button>
        )}
      </div>
    );
  }

  if (viewState === "loading" || viewState === "in-progress") {
    return null;
  }

  if (!canExport) {
    return null;
  }

  return (
    <Button
      type="button"
      className={PRIMARY_ACTION_BUTTON_CLASS}
      disabled={triggering}
      onClick={onTrigger}
    >
      {triggering ? (
        <Loader2 size={16} className="animate-spin" />
      ) : (
        <DatabaseBackup size={16} />
      )}
      {triggering
        ? t(($) => {
            return $.settings.export.actions.starting;
          })
        : t(($) => {
            return $.settings.export.actions.start;
          })}
    </Button>
  );
}

function ExportScopeList() {
  const { t } = useTranslation();
  const items = [
    t(($) => {
      return $.settings.export.scope.agentInstructions;
    }),
    t(($) => {
      return $.settings.export.scope.workflowInstructions;
    }),
    t(($) => {
      return $.settings.export.scope.memoryFiles;
    }),
    t(($) => {
      return $.settings.export.scope.chatMessages;
    }),
  ];

  return (
    <div className="grid gap-2 rounded-xl border border-border/70 bg-gray-50 p-3 text-sm dark:bg-gray-900/30">
      {items.map((item) => {
        return (
          <div key={item} className="flex items-center gap-2 text-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
            <span>{item}</span>
          </div>
        );
      })}
      <p className="pt-1 text-xs leading-5 text-muted-foreground">
        {t(($) => {
          return $.settings.export.scope.artifactsExcluded;
        })}
      </p>
    </div>
  );
}

function iconTone(viewState: ExportViewState): string {
  if (viewState === "failed") {
    return "bg-destructive/10 text-destructive";
  }
  if (viewState === "download") {
    return "bg-emerald-500/10 text-emerald-600";
  }
  return "bg-gray-50 text-muted-foreground";
}

export function ExportPage() {
  const { t } = useTranslation();
  const statusLoadable = useLoadable(userExportStatus$);
  const data = statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const loading = statusLoadable.state === "loading";
  const loadError =
    statusLoadable.state === "hasError"
      ? errorMessage(
          statusLoadable.error,
          t(($) => {
            return $.settings.export.errors.loadFailed;
          }),
        )
      : null;
  const startError = useGet(userExportStartError$);
  const [startLoadable, startExport] = useLoadableSet(startUserExport$);
  const statusPollingRef = useSet(userExportStatusPollingRef$);
  const pageSignal = useGet(pageSignal$);
  const triggering = startLoadable.state === "loading";
  const startActionError =
    startLoadable.state === "hasError"
      ? errorMessage(
          startLoadable.error,
          t(($) => {
            return $.settings.export.errors.startFailed;
          }),
        )
      : null;
  const error = startError ?? startActionError ?? loadError;
  const viewState = deriveViewState(data, loading);
  const handleTrigger = () => {
    detach(startExport(pageSignal), Reason.DomCallback);
  };

  return (
    <div className="okou-app okou-viewport-shell flex w-full bg-background okou-workspace-bg">
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-4 py-8">
        <section
          className={surfaceVariants({
            className: "w-full max-w-[440px] p-5 sm:p-7",
          })}
        >
          <div className="mb-6 flex items-center justify-between gap-4">
            <Link
              pathname="/"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline transition-colors hover:text-foreground"
            >
              <ArrowLeft size={14} />
              {t(($) => {
                return $.settings.export.backToAssistant;
              })}
            </Link>
            <ProductBrandMark size="small" />
          </div>

          <div className="space-y-6">
            <div className="space-y-2">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                {t(($) => {
                  return $.settings.export.title;
                })}
              </h1>
              <p className="text-sm leading-6 text-muted-foreground">
                {t(($) => {
                  return $.settings.export.description;
                })}
              </p>
            </div>

            <ExportScopeList />

            {viewState === "in-progress" ? (
              <span ref={statusPollingRef} hidden />
            ) : null}

            <div className="rounded-xl border border-border/70 bg-card p-4">
              <div
                className="flex items-start gap-3"
                aria-live={viewState === "in-progress" ? "polite" : undefined}
              >
                <div
                  className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${iconTone(
                    viewState,
                  )}`}
                >
                  <StatusIcon viewState={viewState} />
                </div>
                <div className="min-w-0 flex-1">
                  <StatusText viewState={viewState} data={data} />
                </div>
              </div>

              {error ? (
                <div className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <div className="mt-4">
                <ExportActions
                  viewState={viewState}
                  data={data}
                  triggering={triggering}
                  onTrigger={handleTrigger}
                />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
