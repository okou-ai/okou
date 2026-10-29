import { number, object, string } from "zod";
import type { TestContext } from "../signals/__tests__/test-helpers.ts";

/** A test-owned external CDP browser; the installed viewer runs normally. */
export function mockBrowserCdp(
  context: TestContext,
  cdpUrl: string,
  options: {
    readonly streaming?: boolean;
    readonly targets?: readonly {
      readonly targetId: string;
      readonly title: string;
      readonly url: string;
      readonly windowId?: number;
    }[];
  } = {},
) {
  context.mocks.browser.canvasRendering();
  context.mocks.browser.uint8ArrayFromBase64();
  if (options.streaming) {
    context.mocks.browser.imageBitmap(1440, 900);
  }
  const targets = options.targets ?? [
    { targetId: "example-page", title: "Example", url: "https://example.com" },
  ];
  const socket = context.mocks.browser.webSocket((data, url) => {
    if (url !== cdpUrl) {
      throw new Error("Unexpected viewer endpoint");
    }
    const request = object({
      id: number().optional(),
      method: string(),
      sessionId: string().optional(),
      params: object({ targetId: string().optional() }).loose().optional(),
    }).parse(JSON.parse(data));
    if (request.id === undefined) {
      return null;
    }
    let result: unknown = {};
    switch (request.method) {
      case "Target.getTargets": {
        result = {
          targetInfos: targets.map((target) => {
            return {
              ...target,
              type: "page",
              attached: false,
            };
          }),
        };
        break;
      }
      case "Target.attachToTarget": {
        result = {
          sessionId: `${request.params?.targetId ?? "example-page"}-session`,
        };
        break;
      }
      case "Browser.getWindowForTarget": {
        const target = targets.find((candidate) => {
          return candidate.targetId === request.params?.targetId;
        });
        if (!target) {
          return JSON.stringify({
            id: request.id,
            error: { code: -32_000, message: "No target with given id found" },
          });
        }
        result = { windowId: target.windowId ?? 0 };
        break;
      }
      case "Page.startScreencast": {
        if (options.streaming) {
          queueMicrotask(() => {
            socket.receive(
              cdpUrl,
              JSON.stringify({
                method: "Page.screencastFrame",
                sessionId: request.sessionId,
                params: {
                  data: "AAAA",
                  sessionId: 1,
                  metadata: {
                    offsetTop: 0,
                    pageScaleFactor: 1,
                    deviceWidth: 1440,
                    deviceHeight: 900,
                    scrollOffsetX: 0,
                    scrollOffsetY: 0,
                  },
                },
              }),
            );
          });
        }
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
