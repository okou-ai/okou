import { useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { RefreshCw, RadioTower } from "lucide-react";
import { Button } from "@okouai/ui/components/ui/button";

import {
  connectionDiagnosticsFromWorker$,
  reloadConnectionDiagnosticsFromWorker$,
} from "../../../../signals/shared-database.ts";
import { ConnectionDiagnosticsPanel } from "./connection-diagnostics-block.tsx";

/**
 * The shared Worker owns the realtime connection every tab reads from, so its
 * capture is a separate recording from the one this tab makes for itself.
 */
export function WorkerConnectionDiagnosticsBlock() {
  const { t } = useTranslation();
  // A refresh replaces the pending read, and the previous capture keeps the
  // panel expanded instead of collapsing back to the placeholder.
  const diagnostics = useLastResolved(connectionDiagnosticsFromWorker$);
  const loadable = useLoadable(connectionDiagnosticsFromWorker$);
  const reload = useSet(reloadConnectionDiagnosticsFromWorker$);

  if (diagnostics) {
    return (
      <ConnectionDiagnosticsPanel
        actions={
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
              return $.settings.preferences.debug.connectionDiagnostics.refresh;
            })}
          </Button>
        }
        description={t(($) => {
          return $.settings.preferences.debug.connectionDiagnostics
            .workerDescription;
        })}
        diagnostics={diagnostics}
        title={t(($) => {
          return $.settings.preferences.debug.connectionDiagnostics.workerTitle;
        })}
      />
    );
  }

  return (
    <div className="flex items-start gap-4 rounded-xl bg-card p-4 border border-surface-border">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">
        <RadioTower size={22} className="text-muted-foreground" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.settings.preferences.debug.connectionDiagnostics
              .workerTitle;
          })}
        </div>
        <div className="text-sm text-muted-foreground">
          {loadable.state === "loading"
            ? t(($) => {
                return $.settings.preferences.debug.connectionDiagnostics
                  .workerLoading;
              })
            : t(($) => {
                return $.settings.preferences.debug.connectionDiagnostics
                  .workerUnavailable;
              })}
        </div>
      </div>
    </div>
  );
}
