import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "../../signals/chat-page/chat-thread-pane-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

function ChatScrollCommitMarker({
  thread,
  measureWidth,
}: {
  readonly thread: ChatPanelSignals;
  readonly measureWidth: boolean;
}) {
  const restore = useSet(thread.restoreScrollPosition$);
  const measure = useSet(thread.resources.measure$);
  const signal = useGet(pageSignal$);
  return (
    <span
      hidden
      aria-hidden="true"
      // This one-shot commit notification intentionally gets a fresh ref on
      // each render. It owns no listeners or cleanup, and does not remount
      // the content. Lifecycle refs continue to use stable onRef commands.
      ref={(element) => {
        if (element) {
          if (measureWidth) {
            measure();
          }
          detach(restore(signal), Reason.DomCallback);
        }
      }}
    />
  );
}

function ChatScrollLayout({
  children,
  measureWidth,
}: {
  readonly children: ReactNode;
  readonly measureWidth: boolean;
}) {
  const left = useGet(currentLeftThread$);
  const right = useGet(currentRightThread$);
  return (
    <>
      {children}
      {left && (
        <ChatScrollCommitMarker thread={left} measureWidth={measureWidth} />
      )}
      {right && right !== left && (
        <ChatScrollCommitMarker thread={right} measureWidth={measureWidth} />
      )}
    </>
  );
}

/** Wrap a layout owner's output to acknowledge its committed geometry. */
export function withChatScrollLayout(
  children: ReactNode,
  { measureWidth = false }: { readonly measureWidth?: boolean } = {},
) {
  return (
    <ChatScrollLayout measureWidth={measureWidth}>{children}</ChatScrollLayout>
  );
}
