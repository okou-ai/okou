import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@okouai/ui";
import type {
  FrameRatePoint,
  FrameRateSignals,
} from "../../signals/browser/frame-rate.ts";

export function BrowserFrameRateMenu({
  signals,
}: {
  readonly signals: FrameRateSignals;
}) {
  const { t } = useTranslation();
  const available = useGet(signals.available$);
  const enabled = useGet(signals.enabled$);
  const change = useSet(signals.changeEnabled$);
  if (!available) {
    return null;
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {t(($) => {
          return $.browserViewer.fps;
        })}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent side="left">
        <DropdownMenuRadioGroup value={enabled ? "on" : "off"}>
          {([false, true] as const).map((value) => {
            return (
              <DropdownMenuRadioItem
                closeOnClick
                key={String(value)}
                value={value ? "on" : "off"}
                onClick={() => {
                  change(value);
                }}
              >
                <span className="flex-1">
                  {value
                    ? t(($) => {
                        return $.browserViewer.fpsOn;
                      })
                    : t(($) => {
                        return $.browserViewer.fpsOff;
                      })}
                </span>
                {enabled === value && <Check size={14} />}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function chartPaths(
  history: readonly FrameRatePoint[],
  at: number,
  ceiling: number,
) {
  const segments: { line: string; area: string }[] = [];
  let points: { x: number; y: number }[] = [];
  const flush = () => {
    const first = points[0];
    const last = points.at(-1);
    if (first && last && points.length > 1) {
      const line = points
        .map((point, index) => {
          return `${index === 0 ? "M" : "L"}${point.x},${point.y}`;
        })
        .join(" ");
      segments.push({ line, area: `${line} L${last.x},48 L${first.x},48 Z` });
    }
    points = [];
  };
  for (const point of history) {
    if (point.value === null) {
      flush();
    } else {
      points.push({
        x: ((point.at - at + 30_000) / 30_000) * 84,
        y: 48 * (1 - point.value / ceiling),
      });
    }
  }
  flush();
  return segments;
}

function FrameRateDisplay({ signals }: { readonly signals: FrameRateSignals }) {
  const { t } = useTranslation();
  const snapshot = useGet(signals.snapshot$);
  const position = useGet(signals.position$);
  const ref = useSet(signals.ref$);
  const paths = chartPaths(snapshot.history, snapshot.at, snapshot.ceiling);
  return (
    <svg
      data-browser-fps-overlay
      role="img"
      aria-label={t(
        ($) => {
          return $.browserViewer.fpsReading;
        },
        { value: snapshot.value ?? "—" },
      )}
      className="pointer-events-none absolute inset-0 z-10 h-full w-full"
    >
      <foreignObject x={position.x} y={position.y} width={128} height={48}>
        <div
          ref={snapshot.active ? ref : undefined}
          className="flex h-12 w-32 bg-browser-fps-background/60 font-mono text-browser-fps-foreground tabular-nums"
        >
          <div className="flex w-11 shrink-0 flex-col items-center justify-center px-0.5">
            <span className="text-xl leading-6">{snapshot.value ?? "—"}</span>
            <span className="text-xs leading-4">
              {t(($) => {
                return $.browserViewer.fps;
              })}
            </span>
          </div>
          <svg
            viewBox="0 0 84 48"
            preserveAspectRatio="none"
            aria-hidden="true"
            className="h-full w-21 shrink-0 overflow-hidden"
          >
            {paths.map((path) => {
              return (
                <g key={path.line}>
                  <path
                    d={path.area}
                    className="fill-browser-fps-foreground/25"
                  />
                  <path
                    d={path.line}
                    fill="none"
                    strokeWidth={1}
                    className="stroke-browser-fps-foreground"
                  />
                </g>
              );
            })}
          </svg>
        </div>
      </foreignObject>
    </svg>
  );
}

export function BrowserFrameRate({
  signals,
}: {
  readonly signals: FrameRateSignals;
}) {
  const enabled = useGet(signals.enabled$);
  return enabled ? <FrameRateDisplay signals={signals} /> : null;
}
