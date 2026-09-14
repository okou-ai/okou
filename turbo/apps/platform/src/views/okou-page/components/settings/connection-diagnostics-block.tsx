import { useGet, useSet } from "ccstate-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  RadioTower,
  Trash2,
} from "lucide-react";
import { Button } from "@okouai/ui/components/ui/button";
import { Badge } from "@okouai/ui";

import { now } from "../../../../lib/time.ts";
import {
  connectionDiagnostics$,
  writeConnectionDiagnostic$,
  type ConnectionDiagnosticEvent,
  type ConnectionDiagnostics,
} from "../../../../signals/connection-diagnostics.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }
  return `${(durationMs / 1000).toFixed(3)} s`;
}

function ConnectionDiagnosticsSummary({
  description,
  diagnostics,
  title,
}: {
  readonly description: string;
  readonly diagnostics: ConnectionDiagnostics;
  readonly title: string;
}) {
  const { t } = useTranslation();
  const unavailable = t(($) => {
    return $.settings.preferences.debug.connectionDiagnostics.unavailable;
  });
  const connectionState = diagnostics.snapshot.connectionState ?? unavailable;
  const channelState = diagnostics.snapshot.channelState ?? unavailable;

  return (
    <summary className="flex w-full cursor-pointer list-none items-start gap-4 p-4 text-left transition-colors hover:bg-state-hover [&::-webkit-details-marker]:hidden">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">
        <RadioTower size={22} className="text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-sm text-muted-foreground">{description}</span>
        <span className="flex flex-wrap gap-1.5 font-mono text-[11px] text-foreground">
          <Badge>
            {t(($) => {
              return $.settings.preferences.debug.connectionDiagnostics
                .connection;
            })}
            : {connectionState}
          </Badge>
          <Badge>
            {t(($) => {
              return $.settings.preferences.debug.connectionDiagnostics.channel;
            })}
            : {channelState}
          </Badge>
        </span>
      </span>
      <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground group-open:hidden" />
      <ChevronUp className="mt-1 hidden h-4 w-4 shrink-0 text-muted-foreground group-open:block" />
    </summary>
  );
}

function ConnectionDiagnosticEventLog({
  events,
}: {
  readonly events: readonly ConnectionDiagnosticEvent[];
}) {
  const { t } = useTranslation();
  if (events.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-xs text-muted-foreground">
        {t(($) => {
          return $.settings.preferences.debug.connectionDiagnostics.empty;
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col-reverse gap-1">
      {events.map((event) => {
        const details = event.details ? JSON.stringify(event.details) : null;
        return (
          <div
            key={event.sequence}
            className="rounded-md bg-background/70 px-2.5 py-2 font-mono text-[11px] leading-4 text-foreground"
          >
            <div className="break-all">
              #{event.sequence} +{formatDuration(event.elapsedMs)} ·{" "}
              {event.event}
              {" · "}
              {event.phase}
              {event.durationMs === undefined
                ? ""
                : ` · ${formatDuration(event.durationMs)}`}
            </div>
            <div className="break-all text-muted-foreground">
              {event.timestamp}
              {details ? ` · ${details}` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConnectionDiagnosticsDetails({
  actions,
  diagnostics,
}: {
  readonly actions: ReactNode;
  readonly diagnostics: ConnectionDiagnostics;
}) {
  const { t } = useTranslation();
  const handleCopy = (): void => {
    detach(
      navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2)),
      Reason.DomCallback,
      "copy-connection-diagnostics",
    );
  };
  return (
    <div className="flex flex-col gap-4 border-t border-border/60 p-4">
      <div className="rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px]">
        {t(($) => {
          return $.settings.preferences.debug.connectionDiagnostics.events;
        })}
        : {diagnostics.events.length} / {diagnostics.capacity}
      </div>

      {diagnostics.activeWaits.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium text-foreground">
            {t(($) => {
              return $.settings.preferences.debug.connectionDiagnostics
                .activeWaits;
            })}
          </div>
          <div className="flex flex-col gap-1 font-mono text-[11px]">
            {diagnostics.activeWaits.map((wait) => {
              return (
                <div
                  key={wait.spanId}
                  className="rounded-md bg-amber-500/10 px-3 py-2 text-foreground"
                >
                  {wait.event} · {formatDuration(now() - wait.startedAtMs)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-medium text-foreground">
          {t(($) => {
            return $.settings.preferences.debug.connectionDiagnostics.log;
          })}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={handleCopy}
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
            {t(($) => {
              return $.settings.preferences.debug.connectionDiagnostics
                .copyJson;
            })}
          </Button>
          {actions}
        </div>
      </div>

      <div className="max-h-96 overflow-y-auto rounded-md bg-muted/30 p-2">
        <ConnectionDiagnosticEventLog events={diagnostics.events} />
      </div>
    </div>
  );
}

/** One expandable diagnostics capture: this tab's, or the Worker's. */
export function ConnectionDiagnosticsPanel({
  actions,
  description,
  diagnostics,
  title,
}: {
  readonly actions: ReactNode;
  readonly description: string;
  readonly diagnostics: ConnectionDiagnostics;
  readonly title: string;
}) {
  return (
    <details className="group overflow-hidden rounded-xl bg-card border border-surface-border">
      <ConnectionDiagnosticsSummary
        description={description}
        diagnostics={diagnostics}
        title={title}
      />
      <ConnectionDiagnosticsDetails
        actions={actions}
        diagnostics={diagnostics}
      />
    </details>
  );
}

export function ConnectionDiagnosticsBlock() {
  const { t } = useTranslation();
  const diagnostics = useGet(connectionDiagnostics$);
  const writeDiagnostic = useSet(writeConnectionDiagnostic$);

  return (
    <ConnectionDiagnosticsPanel
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          onClick={() => {
            writeDiagnostic({ action: "clear" });
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t(($) => {
            return $.settings.preferences.debug.connectionDiagnostics.clear;
          })}
        </Button>
      }
      description={t(($) => {
        return $.settings.preferences.debug.connectionDiagnostics.description;
      })}
      diagnostics={diagnostics}
      title={t(($) => {
        return $.settings.preferences.debug.connectionDiagnostics.title;
      })}
    />
  );
}
