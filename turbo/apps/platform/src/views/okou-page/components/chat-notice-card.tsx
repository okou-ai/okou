import type { ComponentProps } from "react";
import { cn } from "@okouai/ui";

import { ChatCard } from "./chat-card.tsx";

export const CHAT_NOTICE_CARD_HEIGHT_CLASS = "h-[136px] @[640px]:h-[88px]";

/** Reserve the transcript footprint before any notice data resolves. */
export function ChatNoticeCard({
  className,
  size = "compact",
  ...props
}: ComponentProps<typeof ChatCard> & {
  readonly size?: "compact" | "offer";
}) {
  return (
    <ChatCard
      {...props}
      className={cn(
        "w-full",
        size === "offer"
          ? "h-[176px] @[640px]:h-[128px]"
          : CHAT_NOTICE_CARD_HEIGHT_CLASS,
        className,
      )}
    />
  );
}
