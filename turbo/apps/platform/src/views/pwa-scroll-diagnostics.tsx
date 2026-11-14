import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { isPwaScrollDiagnosticsPreview } from "../lib/pwa-scroll-diagnostics.ts";
import {
  pwaScrollDiagnosticsOnRef$,
  pwaScrollDiagnosticsStatus$,
  pwaScrollDiagnosticsOutput$,
  pwaScrollDiagnosticsSummary$,
  pwaScrollDiagnosticsPage$,
  pwaScrollDiagnosticsPageCount$,
  startPwaScrollDiagnostics$,
  markPwaScrollDiagnostics$,
  stopPwaScrollDiagnostics$,
  readPwaScrollDiagnostics$,
} from "../signals/pwa-scroll-diagnostics.ts";

export function PwaScrollDiagnostics() {
  const { t } = useTranslation();
  const ref = useSet(pwaScrollDiagnosticsOnRef$);
  const status = useGet(pwaScrollDiagnosticsStatus$);
  const start = useSet(startPwaScrollDiagnostics$);
  const mark = useSet(markPwaScrollDiagnostics$);
  const stop = useSet(stopPwaScrollDiagnostics$);
  const read = useSet(readPwaScrollDiagnostics$);
  if (!isPwaScrollDiagnosticsPreview()) {
    return null;
  }
  const recording = status === "Recording";
  return (
    <section
      ref={ref}
      aria-label={t(($) => {
        return $.pwaScrollDiagnostics.label;
      })}
      className="fixed right-2 bottom-2 z-50 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-background p-2 text-xs text-foreground shadow-lg"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {t(
            ($) => {
              return $.pwaScrollDiagnostics.status;
            },
            {
              status: recording
                ? t(($) => {
                    return $.pwaScrollDiagnostics.recording;
                  })
                : status === "Stopped"
                  ? t(($) => {
                      return $.pwaScrollDiagnostics.stopped;
                    })
                  : t(($) => {
                      return $.pwaScrollDiagnostics.idle;
                    }),
            },
          )}
        </span>
        <button
          type="button"
          disabled={recording}
          onClick={() => {
            return start();
          }}
        >
          {t(($) => {
            return $.pwaScrollDiagnostics.start;
          })}
        </button>
        <button
          type="button"
          disabled={!recording}
          onClick={() => {
            return mark();
          }}
        >
          {t(($) => {
            return $.pwaScrollDiagnostics.mark;
          })}
        </button>
        <button
          type="button"
          disabled={!recording}
          onClick={() => {
            return stop();
          }}
        >
          {t(($) => {
            return $.pwaScrollDiagnostics.stop;
          })}
        </button>
        <button
          type="button"
          disabled={recording}
          onClick={() => {
            return read(0);
          }}
        >
          {t(($) => {
            return $.pwaScrollDiagnostics.readSnapshot;
          })}
        </button>
      </div>
      {!recording && <PwaScrollReadout />}
    </section>
  );
}

function PwaScrollReadout() {
  const { t } = useTranslation();
  const output = useGet(pwaScrollDiagnosticsOutput$);
  const summary = useGet(pwaScrollDiagnosticsSummary$);
  const page = useGet(pwaScrollDiagnosticsPage$);
  const pages = useGet(pwaScrollDiagnosticsPageCount$);
  const read = useSet(readPwaScrollDiagnostics$);
  if (!output) {
    return null;
  }
  return (
    <div className="mt-2 flex max-h-[60dvh] w-80 max-w-full flex-col gap-1 overflow-y-auto">
      <p>
        {t(($) => {
          return $.pwaScrollDiagnostics.notice;
        })}
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => {
            return read(-1);
          }}
        >
          {t(($) => {
            return $.featureGuide.previous;
          })}
        </button>
        <span>
          {page + 1}/{pages}
        </span>
        <button
          type="button"
          disabled={page + 1 >= pages}
          onClick={() => {
            return read(1);
          }}
        >
          {t(($) => {
            return $.featureGuide.next;
          })}
        </button>
      </div>
      <pre className="whitespace-pre-wrap break-all font-mono text-[10px]">
        {summary}
      </pre>
      <textarea
        aria-label={t(($) => {
          return $.pwaScrollDiagnostics.stoppedJson;
        })}
        readOnly
        value={output}
        className="h-24 w-full resize-none border border-border bg-background font-mono text-[10px]"
      />
    </div>
  );
}
