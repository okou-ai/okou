import type { FeatureGuideConversation } from "@okouai/api-contracts/contracts/feature-guides";
import { Card } from "@okouai/ui/components/ui/card";
import { DiscordMark } from "../okou-page/components/discord-mark.tsx";
import { UserAvatar } from "./avatar.tsx";
import { OkouLogomark } from "./okou-logomark.tsx";

export function FeatureGuideConversationPreview({
  conversation,
}: {
  readonly conversation: FeatureGuideConversation;
}) {
  return (
    <Card role="group" aria-label={conversation.label}>
      <div className="flex items-center gap-3 border-b border-border p-3">
        <DiscordMark size={20} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{conversation.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {conversation.subtitle}
          </p>
        </div>
        <span className="max-w-20 text-right text-xs text-muted-foreground sm:max-w-none">
          {conversation.label}
        </span>
      </div>
      <ol className="flex flex-col gap-4 bg-gray-50 p-4">
        {conversation.messages.map((message) => {
          return (
            <li key={message.id} className="flex gap-3">
              <div aria-hidden="true">
                {message.role === "assistant" ? (
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-brand-text">
                    <OkouLogomark className="size-5" />
                  </div>
                ) : (
                  <UserAvatar
                    imageUrl={null}
                    name={message.author}
                    initial={message.author.charAt(0)}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">{message.author}</p>
                <p className="mt-1 whitespace-pre-line break-words text-sm leading-relaxed">
                  {message.text}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
