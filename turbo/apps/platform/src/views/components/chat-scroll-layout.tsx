import type { ReactNode } from "react";
import { emitPwaScrollSource } from "../../lib/pwa-scroll-diagnostics.ts";
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
}: {
  readonly thread: ChatPanelSignals;
}) {
  const restore = useSet(thread.restoreScrollPosition$);
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
          emitPwaScrollSource({ kind: "generic-commit", element });
          detach(restore(signal), Reason.DomCallback);
        }
      }}
    />
  );
}

function ChatScrollLayout({ children }: { readonly children: ReactNode }) {
  const left = useGet(currentLeftThread$);
  const right = useGet(currentRightThread$);
  return (
    <>
      {children}
      {left && <ChatScrollCommitMarker thread={left} />}
      {right && right !== left && <ChatScrollCommitMarker thread={right} />}
    </>
  );
}

/** Wrap a layout owner's output to acknowledge its committed geometry. */
export function withChatScrollLayout(children: ReactNode) {
  return <ChatScrollLayout>{children}</ChatScrollLayout>;
}
