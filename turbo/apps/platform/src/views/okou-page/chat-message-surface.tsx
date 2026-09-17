import { cn } from "@okouai/ui";
import type { HTMLAttributes } from "react";

export const CHAT_THREAD_CONTENT_MAIN_CLASS =
  "items-center py-4 pl-4 pr-4 sm:pl-6 sm:pr-6 @container";

// One gap separates the rows of the transcript. Anything that wraps rows and
// interrupts this flex column has to reproduce it, so the value has one home.
export const CHAT_THREAD_MESSAGE_ROW_GAP_CLASS = "gap-6";

export const CHAT_THREAD_MESSAGE_LIST_CLASS = cn(
  "w-full max-w-[900px] mx-auto flex flex-col pb-4 overflow-visible",
  CHAT_THREAD_MESSAGE_ROW_GAP_CLASS,
);

// Turns use 24px, response sections use 8px, and related items within a section
// use 4px. Section spacing must not become the density of a history/list row.
export const CHAT_THREAD_RESPONSE_STACK_CLASS = "flex min-w-0 flex-col gap-2";
export const CHAT_THREAD_RESPONSE_COMPACT_STACK_CLASS =
  "flex min-w-0 flex-col gap-1";

// Response lines use a 36px frame at every width. Follow-up items keep their
// own line metrics.
export const CHAT_THREAD_RESPONSE_LINE_CLASS =
  "h-auto min-h-9 py-[calc((2.25rem-1lh)/2)] leading-[1.59375rem]";

// Rows without a leading icon stay flush with the response column. Icon rows
// put their canonical 16px glyph on that same left edge, then reserve 8px
// before the label.
export const CHAT_THREAD_RESPONSE_FLUSH_CLASS = "min-w-0 pl-0";
export const CHAT_THREAD_RESPONSE_LEADING_ICON_CLASS =
  "inline-flex w-6 shrink-0 items-center justify-start [&_svg]:size-4";

// Supporting rows should read as one quiet unit: the 14px regular label sits
// behind its 16px line icon instead of competing with the final response.
export const CHAT_THREAD_RESPONSE_SUPPORTING_TEXT_CLASS =
  "text-sm font-normal leading-5 text-muted-foreground/80";

// Work-history commentary is supporting context, not the final response.
export const CHAT_THREAD_WORK_HISTORY_TEXT_CLASS =
  "text-sm leading-5 text-muted-foreground";
export const CHAT_THREAD_WORK_HISTORY_MARKDOWN_CLASS = "!text-muted-foreground";

// `transition-none` keeps the responsive margin from animating, which would
// otherwise continue changing layout after resize.
export const CHAT_THREAD_USER_MESSAGE_ROW_CLASS =
  "flex flex-col items-end min-w-0 duration-300 transition-none @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start";

export const CHAT_THREAD_ASSISTANT_MESSAGE_GROUP_CLASS =
  "flex flex-col gap-2 duration-300";

export const CHAT_THREAD_ASSISTANT_MESSAGE_ROW_CLASS =
  "flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start";

// In the stacked mobile layout, inset the response by 6px so the centre of its
// canonical 16px leading icons lines up with the centre of the 28px avatar
// above it. The desktop grid already owns that alignment, so reset the inset
// at that breakpoint.
export const CHAT_THREAD_ASSISTANT_RESPONSE_COLUMN_CLASS =
  "pl-1.5 @[900px]:pl-0";

export const CHAT_THREAD_ASSISTANT_AVATAR_FRAME_CLASS =
  "h-7 w-7 shrink-0 overflow-hidden rounded-xl @[900px]:h-9 @[900px]:w-9";

export const CHAT_THREAD_ASSISTANT_AVATAR_IMAGE_CLASS =
  "h-7 w-7 rounded-full object-cover object-top @[900px]:h-9 @[900px]:w-9";

// Reveal immediately so hover does not create and remove a temporary opacity
// layer in the scrolling transcript beside the assistant's SVG icons. The row
// holds its own height because the stack pull below is measured against it: a
// message that hides its button must not take that space away from the burst.
export const CHAT_THREAD_USER_MESSAGE_ACTIONS_CLASS =
  "flex h-7 justify-end gap-1 mt-1 opacity-0 group-hover:opacity-100";

export const CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_ROW_CLASS =
  "pl-1.5 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:pl-0";

export const CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_CLASS =
  "flex items-center justify-between gap-2";

// Consecutive user messages read as one burst. The copy button already sits
// `mt-1` below its message, so this pull keeps the gap below it equally tight.
// It only ever cancels part of that reserved row, which is why the row above
// has to exist on every user message, in every mode.
export const CHAT_THREAD_MESSAGE_STACK_PULL_CLASS = "-mt-5";

export function ChatUserMessageBubble({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="chat-user-message"
      className={cn(
        "rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden bg-gray-200 text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function ChatAssistantMessageBody({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-chat-selection-source
      className={cn(
        "p-0 text-[0.9375rem] leading-[1.7] min-w-0 [overflow-wrap:anywhere] bg-transparent border-none border-current",
        className,
      )}
      {...props}
    />
  );
}
