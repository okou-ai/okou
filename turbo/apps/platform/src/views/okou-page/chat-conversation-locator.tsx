import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { cn } from "@okouai/ui";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import {
  BAND_BASE_WIDTH_PX,
  type LocatorRole,
} from "../../signals/chat-page/chat-conversation-locator.ts";
import { AgentAvatarImg } from "./sidebar-shared.tsx";
import { formatChatTimestamp } from "../../i18n/format.ts";

/** Resting tick length per role. Two discrete steps keep the rail regular. */
const TICK_BASE_WIDTH_PX = {
  user: 7,
  assistant: 12,
} as const satisfies Record<LocatorRole, number>;

/** Ticks fade toward an edge that still has turns behind it. */
const EDGE_OPACITY = [1, 0.55, 0.25] as const;

function LocatorPreviewCard({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const previewOnRef = useSet(thread.locator.previewOnRef$);
  const preview = useGet(thread.locator.preview$);

  return (
    <div
      ref={previewOnRef}
      data-conversation-locator-preview
      aria-hidden="true"
      className={cn(
        "pointer-events-none fixed left-0 top-0 z-50 w-[340px] rounded-xl border border-border bg-background px-4 py-3.5 shadow-lg",
        preview ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-[11.5px] font-medium text-muted-foreground">
        {preview?.role === "assistant" ? (
          <AgentAvatarImg
            name={thread.agentId}
            alt=""
            className="h-5 w-5 shrink-0 rounded-full object-cover object-top"
            size={20}
          />
        ) : null}
        <span>
          {preview?.role === "user"
            ? t(($) => {
                return $.chat.thread.locator.you;
              })
            : null}
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
  const railOnRef = useSet(thread.locator.railOnRef$);
  const layout = useGet(thread.locator.layout$);
  const engaged = useGet(thread.locator.engaged$);

  return (
    <>
      <div
        ref={railOnRef}
        data-conversation-locator
        // Pointer-only shortcut to content the thread already exposes in
        // order, so it stays out of the accessibility tree rather than adding
        // an unreachable control to it.
        aria-hidden="true"
        className={cn(
          // Hidden on narrow viewports: the rail needs a gutter the phone
          // layout does not have, and those threads are short enough to scroll.
          // Keep the hit area inside the message content's 24px left gutter.
          "absolute inset-y-0 left-0 z-10 hidden w-6 cursor-pointer md:block",
          !layout.visible && "pointer-events-none opacity-0",
          layout.visible && (engaged ? "opacity-100" : "opacity-[0.68]"),
        )}
      >
        {layout.visible && layout.bandHeight > 0 ? (
          <div
            data-conversation-locator-band
            // Width tracks the magnified ticks and is written per pointer
            // frame by the locator signals, like the ticks themselves.
            className="pointer-events-none absolute left-[7px] rounded-[5px] bg-primary opacity-[0.05]"
            style={{
              top: layout.bandTop,
              height: layout.bandHeight,
              width: BAND_BASE_WIDTH_PX,
            }}
          />
        ) : null}
        {layout.ticks.map((tick) => {
          return (
            <div
              key={tick.turnIndex}
              data-locator-tick={tick.role}
              data-turn-index={tick.turnIndex}
              className={cn(
                // Width is written per pointer frame by the locator signals;
                // React owns everything that only changes with the layout.
                // Magnified ticks must not extend the rail's hit area.
                "pointer-events-none absolute left-[14px] h-0.5 -translate-y-1/2 rounded-full transition-colors duration-150",
                tick.current ? "bg-primary/60" : "bg-divider",
                // The turn under the cursor only changes colour — thickness
                // stays put so the rail keeps one rhythm.
                "[&[data-locator-hot]]:bg-foreground",
              )}
              style={{
                top: tick.y,
                width: TICK_BASE_WIDTH_PX[tick.role],
                opacity: EDGE_OPACITY[tick.edge],
              }}
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
