// The Workflow pane's artwork: the shape of an automation — something starts
// it, Okou runs it, and two branches carry the result on. The app tiles are
// filled from the connectors this workspace actually has, so the picture is
// the user's own tools rather than a poster of products they may not use. A
// slot with nothing to show keeps the connector icon's own plug fallback,
// which reads as a place another tool can go.
import { useLastLoadable } from "ccstate-react";
import { cn } from "@okouai/ui";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { thinkingSpinnerImg } from "./platform-assets.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";

/*
  A 288x144 drawing at its natural size, which is exactly the pane's content
  width, so nothing is scaled and every coordinate below is a device pixel.
  Coordinates are spelled per slot rather than computed, so Tailwind's scanner
  sees each candidate — the same shape the onboarding diagram's tile stack uses.
*/
const SLOT_POSITION_CLASSES = [
  "top-[72px] left-[42px]",
  "top-[37px] left-[174px]",
  "top-[37px] left-[244px]",
  "top-[107px] left-[174px]",
  "top-[107px] left-[244px]",
] as const;

const TILE_CLASS =
  "absolute flex size-[35px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[10px] border border-border/60 bg-card shadow-[0_3px_9px_-5px_rgba(0,0,0,0.45)]";

/* The grid is the onboarding diagram's, at this drawing's smaller pitch. */
const GRID_CLASS =
  "pointer-events-none absolute inset-x-[10px] inset-y-[8px] [background-image:radial-gradient(hsl(var(--gray-500)/0.45)_1.2px,transparent_1.2px)] [background-size:14px_14px]";

/*
  The connector line keeps its literal brand orange for the same reason the
  onboarding diagram's does: it is artwork, not chrome, and it stays this
  colour in both themes.
*/
const WIRE_CLASS =
  "pointer-events-none absolute inset-0 size-full [&_path]:stroke-[#FEA801] [&_path]:[stroke-width:1.8] [&_path]:[stroke-linecap:round]";

export function SlashWorkflowPaneDiagram() {
  const catalogLoadable = useLastLoadable(connectorCatalogStatus$);
  const connected =
    catalogLoadable.state === "hasData"
      ? catalogLoadable.data.connectors
          .filter((connector) => {
            return connector.connected;
          })
          .slice(0, SLOT_POSITION_CLASSES.length)
      : [];

  return (
    <div
      className="relative mt-[11px] h-[144px] w-full"
      data-slot="slash-workflow-diagram"
      aria-hidden
    >
      <div className={GRID_CLASS} />
      <svg className={WIRE_CLASS} viewBox="0 0 288 144" fill="none">
        <path d="M63.5 72H82.5" />
        <path d="M125.5 68C140 62 146 40 152.5 37" />
        <path d="M125.5 76C140 82 146 104 152.5 107" />
        <path d="M195.5 37H222.5" />
        <path d="M195.5 107H222.5" />
      </svg>
      {/* The line ends on the node it feeds, the way the onboarding diagram marks a waypoint. */}
      <svg
        className="pointer-events-none absolute inset-0 size-full"
        viewBox="0 0 288 144"
        fill="none"
      >
        {[
          [82.5, 72],
          [152.5, 37],
          [152.5, 107],
          [222.5, 37],
          [222.5, 107],
        ].map(([x, y]) => {
          return (
            <circle
              key={`${String(x)}-${String(y)}`}
              cx={x}
              cy={y}
              r="2.6"
              className="fill-foreground stroke-card"
              strokeWidth="1.4"
            />
          );
        })}
      </svg>
      <span
        className={cn(TILE_CLASS, "top-[72px] left-[104px] border-[#FEA801]")}
      >
        <img src={thinkingSpinnerImg} alt="" className="size-[19px]" />
      </span>
      {SLOT_POSITION_CLASSES.map((position, index) => {
        const connector = connected[index];
        return (
          <span
            key={position}
            className={cn(TILE_CLASS, position)}
            data-slot="slash-workflow-diagram-node"
            data-connector={connector?.slug}
          >
            <ConnectorIcon icon={connector?.icon} size={20} />
          </span>
        );
      })}
    </div>
  );
}
