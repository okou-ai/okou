import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@okouai/ui";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import {
  RAIL_PADDING_PX,
  type LocatorPreview,
} from "../../signals/chat-page/chat-conversation-locator.ts";
import { onDomEventFn } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { formatChatTimestamp } from "../../i18n/format.ts";

const TICK_PITCH_PX = 10;
const TICK_MIN_PITCH_PX = 3;

/** Keep the original compact, pixel-aligned scale without measuring it. */
function trackLength(count: number): string {
  const gaps = Math.max(count - 1, 1);
  return `(${String(gaps)} * clamp(${String(TICK_MIN_PITCH_PX)}px, round(down, (100% - ${String(RAIL_PADDING_PX * 2)}px) / ${String(gaps)}, 1px), ${String(TICK_PITCH_PX)}px))`;
}

function trackTop(fraction: number, count: number): string {
  const track = trackLength(count);
  return `calc(round(nearest, 50% - ${track} / 2, 1px) + round(nearest, ${track} * ${fraction.toFixed(4)}, 1px))`;
}

/**
 * Where the pointer sits along the track, 0 at the first tick and 1 at the
 * last. Reading the rail's own rect in its handler keeps the element out of
 * the signal graph: the command only ever receives numbers.
 */
function pointerFraction(
  event: React.PointerEvent<HTMLElement>,
  count: number,
): number {
  const rect = event.currentTarget.getBoundingClientRect();
  const gaps = Math.max(count - 1, 1);
  const pitch = Math.max(
    TICK_MIN_PITCH_PX,
    Math.min(
      TICK_PITCH_PX,
      Math.floor((rect.height - RAIL_PADDING_PX * 2) / gaps),
    ),
  );
  const track = pitch * gaps;
  const origin = Math.round((rect.height - track) / 2);
  return (event.clientY - rect.top - origin) / track;
}

function LocatorPreviewCard({
  preview,
  tickCount,
}: {
  preview: LocatorPreview;
  tickCount: number;
}) {
  const { t } = useTranslation();

  return (
    <Popover open modal={false}>
      <PopoverTrigger asChild nativeButton={false} tabIndex={-1}>
        {/* The shared positioner owns the tick's geometry and edge avoidance. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-[14px] h-0.5 -translate-y-1/2"
          style={{
            top: trackTop(preview.tick.fraction, tickCount),
            width: preview.tick.width,
          }}
        />
      </PopoverTrigger>
      <PopoverContent
        data-conversation-locator-preview
        aria-hidden="true"
        side="right"
        align="center"
        sideOffset={12}
        hideWhenDetached
        initialFocus={false}
        finalFocus={false}
        className="pointer-events-none w-[340px] rounded-xl border-border bg-background px-4 py-3.5"
      >
        <div className="mb-2 flex items-center gap-2 text-[11.5px] font-medium text-muted-foreground">
          <span>
            {t(($) => {
              return $.chat.thread.locator.you;
            })}
          </span>
          <span className="tabular-nums">
            {preview.createdAt ? formatChatTimestamp(preview.createdAt) : null}
          </span>
        </div>
        <p className="line-clamp-2 text-sm leading-[1.62] text-muted-foreground [overflow-wrap:anywhere]">
          {preview.text}
        </p>
      </PopoverContent>
    </Popover>
  );
}

function ConversationLocatorRail({ thread }: { thread: ChatPanelSignals }) {
  const layout = useGet(thread.locator.layout$);
  const engaged = useGet(thread.locator.engaged$);
  const preview = useGet(thread.locator.preview$);
  const trackPointer = useSet(thread.locator.trackPointer$);
  const leaveRail = useSet(thread.locator.leaveRail$);
  const jumpToPointer = useSet(thread.locator.jumpToPointer$);
  const pageSignal = useGet(pageSignal$);

  return (
    <div
      data-conversation-locator
      // Pointer-only shortcut to content the thread already exposes in
      // order, so it stays out of the accessibility tree rather than adding
      // an unreachable control to it.
      aria-hidden="true"
      onPointerMove={(event) => {
        trackPointer(pointerFraction(event, layout.ticks.length));
      }}
      onPointerLeave={() => {
        leaveRail();
      }}
      onClick={onDomEventFn(async () => {
        await jumpToPointer(pageSignal);
      })}
      className={cn(
        // Hidden on narrow viewports: the rail needs a gutter the phone
        // layout does not have, and those threads are short enough to scroll.
        // Rest inside the gutter, then include the magnified ticks and a
        // little breathing room while the reader interacts with the scale.
        "absolute inset-y-0 left-0 z-10 hidden cursor-pointer md:block",
        engaged ? "w-14" : "w-6",
        !layout.visible && "pointer-events-none opacity-0",
        layout.visible && (engaged ? "opacity-100" : "opacity-[0.68]"),
      )}
    >
      {layout.visible ? (
        <div
          data-conversation-locator-band
          className="pointer-events-none absolute left-[7px] rounded-[5px] bg-primary opacity-[0.05]"
          style={{
            top: trackTop(layout.bandStart, layout.ticks.length),
            height: `calc(${trackLength(layout.ticks.length)} * ${layout.bandSize.toFixed(4)})`,
            width: layout.bandWidth,
          }}
        />
      ) : null}
      {layout.ticks.map((tick) => {
        return (
          <div
            key={tick.eventId}
            data-locator-tick=""
            data-turn-index={tick.turnIndex}
            className={cn(
              "pointer-events-none absolute left-[14px] h-0.5 -translate-y-1/2 rounded-full transition-colors duration-150",
              preview?.turnIndex === tick.turnIndex
                ? "bg-foreground"
                : tick.current
                  ? "bg-primary/60"
                  : "bg-divider",
            )}
            style={{
              top: trackTop(tick.fraction, layout.ticks.length),
              width: tick.width,
            }}
          />
        );
      })}
      {preview ? (
        <LocatorPreviewCard preview={preview} tickCount={layout.ticks.length} />
      ) : null}
    </div>
  );
}

export function ChatConversationLandingHighlight({
  thread,
  eventId,
}: {
  thread: ChatPanelSignals;
  eventId: string | undefined;
}) {
  const landing = useGet(thread.locator.landing$);
  if (landing.eventId !== eventId) {
    return null;
  }

  return (
    <div
      key={landing.revision}
      aria-hidden="true"
      data-locator-landed
      className="pointer-events-none absolute inset-0 rounded-xl motion-safe:animate-locator-landed"
    />
  );
}

/** Tick rail beside a long thread: hover to preview a turn, click to jump. */
export function ChatConversationLocator({
  thread,
}: {
  thread: ChatPanelSignals;
}) {
  return <ConversationLocatorRail thread={thread} />;
}
