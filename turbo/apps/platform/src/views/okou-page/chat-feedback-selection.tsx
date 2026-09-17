import { Copy, Forward, MessageCircle } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  getShortcutParts,
  Kbd,
  KbdGroup,
  Popover,
  PopoverContent,
} from "@okouai/ui";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type {
  ChatThreadFeedbackSelection,
  ChatThreadFeedbackSignals,
} from "../../signals/chat-page/chat-thread-feedback.ts";
import { ChatForwardDialog } from "./chat-forward-dialog.tsx";

function selectionAnchor(selection: ChatThreadFeedbackSelection) {
  return {
    getBoundingClientRect() {
      const { left, top, width, height } = selection.rect;
      return new DOMRect(left, top, width, height);
    },
  };
}

function ShortcutHint({ shortcut }: { readonly shortcut: string }) {
  return (
    <KbdGroup aria-hidden="true">
      {getShortcutParts(shortcut).map((part) => {
        return (
          <Kbd key={part}>{part.length === 1 ? part.toUpperCase() : part}</Kbd>
        );
      })}
    </KbdGroup>
  );
}

function FeedbackToolbar({
  onCopy,
  onProvideFeedback,
  onForward,
}: {
  onCopy: () => void;
  onProvideFeedback: () => void;
  onForward?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-0.5">
      <Button
        type="button"
        variant="quiet"
        size="xs"
        onClick={onCopy}
        aria-keyshortcuts="c"
        className="text-foreground"
      >
        <Copy />
        {t(($) => {
          return $.chat.actions.copy;
        })}
        <ShortcutHint shortcut="c" />
      </Button>
      <div className="h-4 w-px bg-divider" />
      <Button
        type="button"
        variant="quiet"
        size="xs"
        onClick={onProvideFeedback}
        aria-keyshortcuts="q"
        className="text-foreground"
      >
        <MessageCircle />
        {t(($) => {
          return $.chat.feedback.quote;
        })}
        <ShortcutHint shortcut="q" />
      </Button>
      {onForward ? (
        <>
          <div className="h-4 w-px bg-divider" />
          <Button
            type="button"
            variant="quiet"
            size="xs"
            onClick={onForward}
            aria-keyshortcuts="f"
            className="text-foreground"
          >
            <Forward />
            {t(($) => {
              return $.chat.forward.action;
            })}
            <ShortcutHint shortcut="f" />
          </Button>
        </>
      ) : null}
    </div>
  );
}

// Mounts the selection listeners and the floating Copy / Quote / Forward
// toolbar anchored to the selected passage. Picking "Quote"
// drops the quoted passage straight into the composer (see the feedback rows in
// chat-composer.tsx) — there is no separate feedback panel.
export function ChatFeedbackSelection({
  feedback,
  sourceAgentId,
  sourceThreadTitle,
}: {
  readonly feedback: ChatThreadFeedbackSignals;
  readonly sourceAgentId: string;
  readonly sourceThreadTitle: string;
}) {
  const selection = useGet(feedback.selection$);
  const forwardSelection = useGet(feedback.forwardSelection$);
  const rootSignal = useGet(rootSignal$);
  const setFeedbackSelectionListenersRef = useSet(feedback.setListenersRef$);
  const setFeedbackSelectionToolbarRef = useSet(feedback.setToolbarRef$);
  const startFeedback = useSet(feedback.start$);
  const closeSelectionToolbar = useSet(feedback.close$);
  const copy = useSet(feedback.copy$);
  const startForward = useSet(feedback.startForward$);
  const closeForward = useSet(feedback.closeForward$);

  return (
    <>
      <span ref={setFeedbackSelectionListenersRef} hidden />
      {selection ? (
        <Popover
          open
          onOpenChange={(next, eventDetails) => {
            if (!next) {
              const eventTarget = eventDetails.event.target;
              if (
                eventTarget instanceof Element &&
                eventTarget.closest("[data-chat-selection-interaction]")
              ) {
                eventDetails.cancel();
                return;
              }
              closeSelectionToolbar();
            }
          }}
        >
          <span ref={setFeedbackSelectionToolbarRef} hidden />
          <PopoverContent
            anchor={selectionAnchor(selection)}
            data-chat-selection-interaction
            side="top"
            align="center"
            sideOffset={8}
            initialFocus={false}
            finalFocus={false}
            className="w-auto rounded-xl border border-[hsl(var(--gray-400))] bg-[hsl(var(--card)/0.85)] p-1 text-foreground shadow-lg"
          >
            <FeedbackToolbar
              onCopy={() => {
                return detach(copy(rootSignal), Reason.DomCallback);
              }}
              onProvideFeedback={startFeedback}
              onForward={
                selection.threadId && selection.runId ? startForward : undefined
              }
            />
          </PopoverContent>
        </Popover>
      ) : null}
      {forwardSelection ? (
        <ChatForwardDialog
          selection={forwardSelection}
          feedback={feedback}
          sourceAgentId={sourceAgentId}
          sourceThreadTitle={sourceThreadTitle}
          onDismiss={() => {
            closeForward();
          }}
        />
      ) : null}
    </>
  );
}
