import { computed } from "ccstate";
import { StoreProvider } from "ccstate-react";
import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { BrowserViewer } from "../../../views/browser-viewer/browser-viewer.tsx";
import { createBrowserViewerSignals } from "../browser-viewer.ts";

const context = testContext();
const connection$ = computed(() => {
  return { cdpUrl: "wss://browser.example/never-started", windowId: 0 };
});

test("a synchronous unmount during mount publication releases the original runtime", async () => {
  await setupPage({ context, path: "/" });
  context.mocks.browser.canvasRendering();
  const signals = createBrowserViewerSignals(connection$);
  const released = context.mocks.deferred<void>();
  let unmount: () => void = () => {
    throw new Error("Viewer was not rendered");
  };
  const stop = context.store.watch(signals.mounted$, () => {
    if (context.store.get(signals.mounted$)) {
      unmount();
      released.resolve();
    }
  });
  const rendered = render(
    <StoreProvider value={context.store}>
      <BrowserViewer
        signals={signals}
        connectionKey="owned"
        actions={null}
        presence={null}
      />
    </StoreProvider>,
  );
  unmount = rendered.unmount;
  await released.promise;
  expect(context.store.get(signals.mounted$)).toBeFalsy();
  expect(context.store.get(signals.controls$).canCreate).toBeFalsy();
  stop();
});
