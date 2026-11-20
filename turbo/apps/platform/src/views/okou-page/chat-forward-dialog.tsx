import type { ChatThreadFeedbackSignals } from "../../signals/chat-page/chat-thread-feedback.ts";
import { Loader2 } from "lucide-react";
import { useGet, useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  OkouAvatar,
} from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type { ChatForwardTarget } from "../../signals/chat-page/chat-forward.ts";
import { ChatComposer } from "./composer.tsx";

function ForwardTargetContent({
  target,
}: {
  readonly target: ChatForwardTarget;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <OkouAvatar size={32} />
      <span className="truncate text-foreground">{target.title}</span>
    </span>
  );
}

function ForwardComposerSurface({
  composer,
}: {
  readonly composer: ComposerSignals;
}) {
  return (
    <div className="w-full min-w-0" data-chat-composer>
      <ChatComposer signals={composer} showPendingItems={false} />
    </div>
  );
}

export function ChatForwardDialog({
  feedback,
  onDismiss,
}: {
  readonly feedback: ChatThreadFeedbackSignals;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();

  const target = useGet(feedback.forwardTarget$);
  const prepared = useLoadable(feedback.forwardComposer$);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
    >
      <DialogContent
        smMaxWidth="xl"
        contentClassName="grid-cols-[minmax(0,1fr)] gap-4 overflow-hidden p-5"
      >
        <DialogHeader className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 pr-8">
            <DialogTitle className="min-w-0 flex-1 overflow-hidden text-base font-semibold">
              {target ? (
                <ForwardTargetContent target={target} />
              ) : (
                t(($) => {
                  return $.chat.forward.title;
                })
              )}
            </DialogTitle>
          </div>
          <DialogDescription className={target ? "sr-only" : undefined}>
            {t(($) => {
              return $.chat.fork.description;
            })}
          </DialogDescription>
        </DialogHeader>
        {prepared.state === "hasData" && prepared.data ? (
          <ForwardComposerSurface composer={prepared.data.composer} />
        ) : prepared.state === "hasError" ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {prepared.error instanceof Error
              ? prepared.error.message
              : t(($) => {
                  return $.global.errors.requestFailed;
                })}
          </p>
        ) : (
          <div className="flex min-h-40 items-center justify-center text-muted-foreground">
            <Loader2 size={16} className="animate-spin" aria-hidden />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
