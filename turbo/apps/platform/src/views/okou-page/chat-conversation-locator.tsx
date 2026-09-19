import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { cn } from "@okouai/ui";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { RAIL_PADDING_PX } from "../../signals/chat-page/chat-conversation-locator.ts";
import { onDomEventFn } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { formatChatTimestamp } from "../../i18n/format.ts";

/** How far the preview card sits from the rail. */
const PREVIEW_OFFSET_X_PX = 40;

/** Track length expressed against the rail box, so no height reaches JS. */
const TRACK = `(100% - ${String(RAIL_PADDING_PX * 2)}px)`;

function trackTop(fraction: number): string {
  return `calc(${String(RAIL_PADDING_PX)}px + ${TRACK} * ${fraction.toFixed(4)})`;
}

/**
 * Where the pointer sits along the track, 0 at the first tick and 1 at the
 * last. Reading the rail's own rect in its handler keeps the element out of
 * the signal graph: the command only ever receives numbers.
 */
function pointerFraction(event: React.PointerEvent<HTMLElement>): number {
  const rect = event.currentTarget.getBoundingClientRect();
  const track = rect.height - RAIL_PADDING_PX * 2;
  if (track <= 0) {
    return 0;
  }
  return (event.clientY - rect.top - RAIL_PADDING_PX) / track;
}

function LocatorPreviewCard({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const preview = useGet(thread.locator.preview$);

  return (
    <div
      data-conversation-locator-preview
      aria-hidden="true"
      className={cn(
        "pointer-events-none fixed left-0 top-0 z-50 w-[340px] rounded-xl border border-border bg-background px-4 py-3.5 shadow-lg",
        // The card trails the cursor instead of tracking it exactly, which is
        // what makes it read as floating beside the pointer rather than pinned
        // to it. CSS owns the easing; the signals only publish the target.
        "transition-[transform,opacity] duration-150 ease-out",
        preview ? "opacity-100" : "opacity-0",
      )}
      style={{
        transform: `translate3d(${String(PREVIEW_OFFSET_X_PX)}px, calc(${String(preview?.pointerClientY ?? 0)}px - 50%), 0)`,
      }}
    >
      <div className="mb-2 flex items-center gap-2 text-[11.5px] font-medium text-muted-foreground">
        <span>
          {t(($) => {
            return $.chat.thread.locator.you;
          })}
        </span>
        <span className="tabular-nums">
          {preview?.createdAt ? formatChatTimestamp(preview.createdAt) : null}
        </span>
      </div>
      <p className="line-clamp-2 text-sm leading-[1.62] text-muted-foreground [overflow-wrap:anywhere]">
        {preview?.text}
      </p>
    </div>
  );
}

function ConversationLocatorRail({ thread }: { thread: ChatPanelSignals }) {
  const layout = useGet(thread.locator.layout$);
  const engaged = useGet(thread.locator.engaged$);
  const trackPointer = useSet(thread.locator.trackPointer$);
  const leaveRail = useSet(thread.locator.leaveRail$);
  const jumpToPointer = useSet(thread.locator.jumpToPointer$);
  const pageSignal = useGet(pageSignal$);

  return (
    <>
      <div
        data-conversation-locator
        // Pointer-only shortcut to content the thread already exposes in
        // order, so it stays out of the accessibility tree rather than adding
        // an unreachable control to it.
        aria-hidden="true"
        onPointerMove={(event) => {
          trackPointer(pointerFraction(event), event.clientY);
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
          // Keep the hit area inside the message content's 24px left gutter.
          "absolute inset-y-0 left-0 z-10 hidden w-6 cursor-pointer md:block",
          !layout.visible && "pointer-events-none opacity-0",
          layout.visible && (engaged ? "opacity-100" : "opacity-[0.68]"),
        )}
      >
        {layout.visible ? (
          <div
            data-conversation-locator-band
            className="pointer-events-none absolute left-[7px] rounded-[5px] bg-primary opacity-[0.05]"
            style={{
              top: trackTop(layout.bandStart),
              height: `calc(${TRACK} * ${layout.bandSize.toFixed(4)})`,
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
                // Magnified ticks must not extend the rail's hit area.
                "pointer-events-none absolute left-[14px] h-0.5 -translate-y-1/2 rounded-full transition-colors duration-150",
                tick.current ? "bg-primary/60" : "bg-divider",
              )}
              style={{ top: trackTop(tick.fraction), width: tick.width }}
            />
          );
        })}
      </div>
      <LocatorPreviewCard thread={thread} />
    </>
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
