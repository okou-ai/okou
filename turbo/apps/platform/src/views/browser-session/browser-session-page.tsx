import { useGet, useLastLoadable } from "ccstate-react";

import {
  browserSessionPageSignals$,
  type BrowserSessionPageSignals,
} from "../../signals/browser-session/browser-session-page-state.ts";
import {
  BrowserSessionLoading,
  BrowserSessionNotFound,
  BrowserSessionPanel,
  BrowserSessionUnavailable,
} from "../okou-page/browser-session-panel.tsx";

function BrowserSessionPageContent({
  signals,
}: {
  readonly signals: BrowserSessionPageSignals;
}) {
  const threadAccessible = useLastLoadable(signals.threadAccessible$);
  if (threadAccessible.state === "loading") {
    return <BrowserSessionLoading />;
  }
  if (threadAccessible.state === "hasError") {
    return <BrowserSessionUnavailable />;
  }
  return threadAccessible.data ? (
    <BrowserSessionPanel signals={signals.browser} />
  ) : (
    <BrowserSessionNotFound />
  );
}

export function BrowserSessionPage() {
  const signals = useGet(browserSessionPageSignals$);
  return (
    // A fixed cover is positioned against the viewport, so it inherits none of
    // the insets `#root` applies and owns all four itself. It also pins its own
    // height, because a percentage would resolve against the viewport rather
    // than the `100dvh` the rest of the app measures, and
    // `@media (display-mode: standalone)` moves that variable to `100lvh`.
    // The shell class stays on `StandaloneLayout`, which this page renders
    // inside: custom properties inherit through the DOM, which `position:
    // fixed` does not change.
    <main
      className="fixed inset-0 box-border flex h-viewport max-h-viewport min-h-viewport flex-col overflow-hidden bg-background p-safe"
      data-testid="browser-session-page"
    >
      {signals ? (
        <BrowserSessionPageContent signals={signals} />
      ) : (
        <BrowserSessionNotFound />
      )}
    </main>
  );
}
