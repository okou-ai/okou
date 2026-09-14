import { Button } from "@okouai/ui/components/ui/button";
import { Badge } from "@okouai/ui";
import {
  useLastResolved,
  useLoadable,
  useLoadableState,
  useSet,
} from "ccstate-react";
import { ChevronDown, ChevronUp, Database, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber } from "../../../../i18n/format.ts";
import type { IndexedDbDiagnostics } from "../../../../shared-database/computed-key.ts";
import {
  indexedDbDiagnosticsFromWorker$,
  indexedDbSnapshotMeasurementFromWorker$,
  measureIndexedDbSnapshotFromWorker$,
  reloadIndexedDbDiagnosticsFromWorker$,
} from "../../../../signals/shared-database.ts";
import { formatSize } from "../network-badge.tsx";

function totalRecords(diagnostics: IndexedDbDiagnostics): number {
  return diagnostics.stores.reduce((total, store) => {
    return total + store.recordCount;
  }, 0);
}

function IndexedDbDiagnosticsSummary({
  diagnostics,
}: {
  readonly diagnostics: IndexedDbDiagnostics;
}) {
  const { t } = useTranslation();

  return (
    <summary className="flex w-full cursor-pointer list-none items-start gap-4 p-4 text-left transition-colors hover:bg-state-hover [&::-webkit-details-marker]:hidden">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">
        <Database size={22} className="text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span
          id="indexeddb-diagnostics-title"
          className="text-sm font-medium text-foreground"
        >
          {t(($) => {
            return $.settings.preferences.debug.indexedDb.title;
          })}
        </span>
        <span className="text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.preferences.debug.indexedDb.description;
          })}
        </span>
        <span className="flex flex-wrap gap-1.5 font-mono text-[11px] text-foreground">
          <Badge>
            {t(($) => {
              return $.settings.preferences.debug.indexedDb.schema;
            })}
            : {diagnostics.version}
          </Badge>
          <Badge>
            {t(($) => {
              return $.settings.preferences.debug.indexedDb.stores;
            })}
            : {formatLocalizedNumber(diagnostics.stores.length)}
          </Badge>
          <Badge>
            {t(($) => {
              return $.settings.preferences.debug.indexedDb.records;
            })}
            : {formatLocalizedNumber(totalRecords(diagnostics))}
          </Badge>
        </span>
      </span>
      <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground group-open:hidden" />
      <ChevronUp className="mt-1 hidden h-4 w-4 shrink-0 text-muted-foreground group-open:block" />
    </summary>
  );
}

function SnapshotMeasurement() {
  const { t } = useTranslation();
  const measurement = useLoadable(indexedDbSnapshotMeasurementFromWorker$);
  const measure = useSet(measureIndexedDbSnapshotFromWorker$);
  const loading = measurement.state === "loading";
  const result = measurement.state === "hasData" ? measurement.data : undefined;

  return (
    <section
      aria-labelledby="indexeddb-snapshot-title"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3
            id="indexeddb-snapshot-title"
            className="text-sm font-medium text-foreground"
          >
            {t(($) => {
              return $.settings.preferences.debug.indexedDb.snapshotTitle;
            })}
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">
            {t(($) => {
              return $.settings.preferences.debug.indexedDb.snapshotDescription;
            })}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2.5 text-xs"
          disabled={loading}
          onClick={() => {
            measure();
          }}
        >
          {loading
            ? t(($) => {
                return $.settings.preferences.debug.indexedDb.measuring;
              })
            : t(($) => {
                return $.settings.preferences.debug.indexedDb.measureSnapshot;
              })}
        </Button>
      </div>
      {measurement.state === "hasError" && (
        <p role="status" className="text-xs text-destructive">
          {t(($) => {
            return $.settings.preferences.debug.indexedDb
              .measurementUnavailable;
          })}
        </p>
      )}
      {result === null && (
        <p role="status" className="text-xs text-muted-foreground">
          {t(($) => {
            return $.settings.preferences.debug.indexedDb.snapshotEmpty;
          })}
        </p>
      )}
      {result && (
        <dl className="grid gap-3 rounded-md bg-muted/30 p-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">
              {t(($) => {
                return $.settings.preferences.debug.indexedDb.snapshotThreads;
              })}
            </dt>
            <dd className="mt-1 font-mono text-sm text-foreground">
              {formatLocalizedNumber(result.threadCount)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {t(($) => {
                return $.settings.preferences.debug.indexedDb.snapshotPayload;
              })}
            </dt>
            <dd className="mt-1 font-mono text-sm text-foreground">
              {formatSize(result.payloadBytes)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {t(($) => {
                return $.settings.preferences.debug.indexedDb
                  .snapshotReadDuration;
              })}
            </dt>
            <dd className="mt-1 font-mono text-sm text-foreground">
              {formatLocalizedNumber(result.readDurationMs, {
                style: "unit",
                unit: "millisecond",
                maximumFractionDigits: 1,
              })}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

function IndexedDbDiagnosticsContent({
  diagnostics,
  loading,
  failed,
}: {
  readonly diagnostics: IndexedDbDiagnostics;
  readonly loading: boolean;
  readonly failed: boolean;
}) {
  const { t } = useTranslation();
  const reload = useSet(reloadIndexedDbDiagnosticsFromWorker$);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl text-xs leading-5 text-muted-foreground">
          {t(($) => {
            return $.settings.preferences.debug.indexedDb.countExplanation;
          })}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          disabled={loading}
          onClick={() => {
            reload();
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t(($) => {
            return $.settings.preferences.debug.indexedDb.refresh;
          })}
        </Button>
      </div>
      {failed && (
        <p role="status" className="text-xs text-destructive">
          {t(($) => {
            return $.settings.preferences.debug.indexedDb.unavailable;
          })}
        </p>
      )}
      <dl className="overflow-hidden rounded-md bg-muted/30 font-mono text-[11px]">
        {diagnostics.stores.map((store) => {
          return (
            <div
              key={store.name}
              className="flex items-center justify-between gap-4 border-b border-border/60 px-3 py-2.5 last:border-b-0"
            >
              <dt className="min-w-0 break-all text-foreground">
                {store.name}
              </dt>
              <dd className="shrink-0 text-muted-foreground">
                {formatLocalizedNumber(store.recordCount)}
              </dd>
            </div>
          );
        })}
      </dl>
      <SnapshotMeasurement />
    </div>
  );
}

export function IndexedDbDiagnosticsBlock() {
  const { t } = useTranslation();
  const diagnostics = useLastResolved(indexedDbDiagnosticsFromWorker$);
  const loadableState = useLoadableState(indexedDbDiagnosticsFromWorker$);
  const loading = loadableState === "loading";
  const reload = useSet(reloadIndexedDbDiagnosticsFromWorker$);

  return (
    <section
      aria-labelledby="indexeddb-diagnostics-title"
      className="overflow-hidden rounded-xl bg-card border border-surface-border"
    >
      {diagnostics ? (
        <details className="group">
          <IndexedDbDiagnosticsSummary diagnostics={diagnostics} />
          <div className="border-t border-border/60 p-4">
            <IndexedDbDiagnosticsContent
              diagnostics={diagnostics}
              loading={loading}
              failed={loadableState === "hasError"}
            />
          </div>
        </details>
      ) : (
        <div className="flex items-start gap-4 p-4">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center">
            <Database size={22} className="text-muted-foreground" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div
              id="indexeddb-diagnostics-title"
              className="text-sm font-medium text-foreground"
            >
              {t(($) => {
                return $.settings.preferences.debug.indexedDb.title;
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                {loading
                  ? t(($) => {
                      return $.settings.preferences.debug.indexedDb.loading;
                    })
                  : t(($) => {
                      return $.settings.preferences.debug.indexedDb.unavailable;
                    })}
              </div>
              {!loading && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={() => {
                    reload();
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t(($) => {
                    return $.settings.preferences.debug.indexedDb.refresh;
                  })}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
