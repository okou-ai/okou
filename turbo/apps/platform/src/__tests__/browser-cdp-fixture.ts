import { z } from "zod";
import type { TestContext } from "../signals/__tests__/test-helpers.ts";

/** A test-owned external CDP browser; the installed viewer runs normally. */
export function mockBrowserCdp(context: TestContext, cdpUrl: string): void {
  context.mocks.browser.canvasRendering();
  context.mocks.browser.uint8ArrayFromBase64();
  context.mocks.browser.webSocket((data, url) => {
    if (url !== cdpUrl) {
      throw new Error("Unexpected viewer endpoint");
    }
    const request = z
      .object({ id: z.number().optional(), method: z.string() })
      .parse(JSON.parse(data));
    if (request.id === undefined) {
      return null;
    }
    let result: unknown = {};
    switch (request.method) {
      case "Target.getTargets": {
        result = {
          targetInfos: [
            {
              targetId: "example-page",
              type: "page",
              title: "Example",
              url: "https://example.com",
              attached: false,
            },
          ],
        };
        break;
      }
      case "Target.attachToTarget": {
        result = { sessionId: "example-session" };
        break;
      }
      case "Page.getFrameTree": {
        result = {
          frameTree: {
            frame: {
              id: "example-frame",
              loaderId: "example-loader",
              url: "https://example.com",
            },
          },
        };
        break;
      }
      case "Page.getLayoutMetrics": {
        result = {
          cssVisualViewport: {
            offsetX: 0,
            offsetY: 0,
            pageX: 0,
            pageY: 0,
            clientWidth: 1440,
            clientHeight: 900,
            scale: 1,
            zoom: 1,
          },
        };
        break;
      }
      case "Page.getNavigationHistory": {
        result = {
          currentIndex: 0,
          entries: [
            {
              id: 1,
              url: "https://example.com",
              userTypedURL: "https://example.com",
              title: "Example",
              transitionType: "typed",
            },
          ],
        };
        break;
      }
    }
    return JSON.stringify({ id: request.id, result });
  });
}
