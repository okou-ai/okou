import { screen, fireEvent, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";
export const firstUrl = "https://example.com",
  nextUrl = "https://other.example";
export function scopedViewer(context: TestContext) {
  const first = "review-example",
    other = "review-other";
  let next: ((socket: { open(): void }) => void) | undefined;
  function nextConnection() {
    const gate = context.mocks.deferred<{ open(): void }>();
    next = gate.resolve;
    return gate.promise;
  }
  const { cdp, openPage } = arrangeNativePage(context, {
    onConnecting(_url, socket) {
      next?.(socket);
      next = undefined;
    },
    targets: [
      { targetId: first, title: "Example", url: firstUrl, windowId: 101 },
      { targetId: other, title: "Other", url: nextUrl, windowId: 101 },
      {
        targetId: "sibling",
        title: "Outside",
        url: "https://sibling.example",
        windowId: 222,
      },
    ],
  });
  async function start(split: boolean) {
    await openPage();
    await expectStreamingAt(firstUrl);
    if (split) {
      click(screen.getByLabelText("Browser settings"));
      fireEvent.keyDown(await screen.findByText("Connection mode"), {
        key: "ArrowRight",
      });
      click(await screen.findByText("Separate image connection"));
      await waitFor(() => {
        const current = cdp.requests
          .filter((r) => {
            return r.method === "Page.startScreencast";
          })
          .at(-1);
        expect(cdp.activeConnections()).toBe(2);
        expect(current?.connectionId).not.toBe(
          cdp.requests
            .filter((r) => {
              return r.method === "Browser.getWindowForTarget";
            })
            .at(-1)?.connectionId,
        );
        expect(current?.sessionId).toBeTruthy();
      });
      await expectStreamingAt(firstUrl);
    }
  }
  function disconnectImage() {
    cdp.disconnect({ code: 1006, reason: "Image socket closed" }, 1);
  }
  function control() {
    return cdp.requests
      .filter((r) => {
        return r.method === "Browser.getWindowForTarget";
      })
      .at(-1)!.connectionId;
  }
  return {
    first,
    other,
    cdp,
    start,
    openPage: openPage,
    nextConnection,
    disconnectImage,
    control,
  };
}
export const input = () => {
  return screen.getByLabelText("Remote browser input");
};
