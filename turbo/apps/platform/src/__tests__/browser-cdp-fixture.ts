import { array, number, object, string, unknown } from "zod";
import type { TestContext } from "../signals/__tests__/test-helpers.ts";

interface BrowserTarget {
  readonly targetId: string;
  title: string;
  url: string;
  readonly windowId?: number;
}

/** A test-owned external CDP browser; the Platform viewer runs normally. */
export function mockBrowserCdp(
  context: TestContext,
  cdpUrl: string,
  options: {
    readonly streaming?: boolean;
    readonly targets?: readonly BrowserTarget[];
    readonly unavailableTargets?: readonly string[];
  } = {},
) {
  context.mocks.browser.canvasRendering();
  context.mocks.browser.uint8ArrayFromBase64();
  const bitmap =
    options.streaming === false
      ? null
      : context.mocks.browser.imageBitmap(1440, 900);
  const viewport = { width: 1440, height: 900 };
  const targets: BrowserTarget[] = (
    options.targets ?? [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
      },
    ]
  ).map((target) => {
    return { ...target };
  });
  let created = 0;
  const input: { method: string; params: unknown; sessionId?: string }[] = [];
  const detached: string[] = [];
  const captures: unknown[] = [];
  const heldReplies = new Map<string, (response: string) => void>();
  function event(method: string, params: unknown, sessionId?: string) {
    socket.receive(cdpUrl, JSON.stringify({ method, params, sessionId }));
  }
  function frame(data: string, sessionId = "example-page-session") {
    event(
      "Page.screencastFrame",
      {
        data,
        sessionId: 1,
        metadata: {
          timestamp: 2,
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: viewport.width,
          deviceHeight: viewport.height,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
      },
      sessionId,
    );
  }
  function addTarget(url: string, windowId?: number) {
    const target = {
      targetId: `created-${++created}`,
      title: "about:blank",
      url,
      windowId,
    };
    targets.push(target);
    event("Target.targetCreated", { targetInfo: { ...target, type: "page" } });
    return target;
  }
  function targetForSession(sessionId: string | undefined) {
    const target = targets.find((candidate) => {
      return `${candidate.targetId}-session` === sessionId;
    });
    if (!target) {
      throw new Error("Unknown viewer target session");
    }
    return target;
  }
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
      case "Target.createTarget": {
        const { url } = object({ url: string() }).parse(request.params);
        result = { targetId: addTarget(url).targetId };
        break;
      }
      case "Page.createIsolatedWorld": {
        result = { executionContextId: 1 };
        break;
      }
      case "Runtime.callFunctionOn": {
        const params = object({
          arguments: array(object({ value: unknown() })).optional(),
        }).parse(request.params);
        const url = params.arguments?.[0]?.value;
        if (typeof url === "string" && url.startsWith("about:blank#cdpv-")) {
          addTarget(url, targetForSession(request.sessionId).windowId);
          result = { result: { type: "boolean", value: true } };
        }
        break;
      }
      case "Runtime.evaluate": {
        const { expression } = object({ expression: string() }).parse(
          request.params,
        );
        result = {
          result: expression.includes("const fence =")
            ? { type: "object", value: { fence: 1000, now: 1001 } }
            : expression.includes("devicePixelRatio")
              ? { type: "object", value: { ...viewport, dpr: 1 } }
              : { type: "undefined" },
        };
        break;
      }
      case "Page.navigate": {
        const { url } = object({ url: string() }).parse(request.params);
        const target = targetForSession(request.sessionId);
        target.url = url;
        target.title = url === "about:blank" ? url : new URL(url).hostname;
        event(
          "Page.frameNavigated",
          { frame: { id: "example-frame", loaderId: "navigated-loader", url } },
          request.sessionId,
        );
        event("Target.targetInfoChanged", {
          targetInfo: { ...target, type: "page" },
        });
        event("Page.loadEventFired", { timestamp: 2 }, request.sessionId);
        result = { frameId: "example-frame" };
        break;
      }
      case "Target.closeTarget": {
        const index = targets.findIndex((target) => {
          return target.targetId === request.params?.targetId;
        });
        if (index === -1) {
          throw new Error("Unknown tab to close");
        }
        const [target] = targets.splice(index, 1);
        if (!target) {
          throw new Error("Unknown tab to close");
        }
        event("Target.targetDestroyed", { targetId: target.targetId });
        result = { success: true };
        break;
      }
      case "Input.insertText":
      case "Input.dispatchKeyEvent":
      case "Input.imeSetComposition": {
        input.push({
          method: request.method,
          params: request.params,
          sessionId: request.sessionId,
        });
        break;
      }
      case "Target.detachFromTarget": {
        detached.push(
          object({ sessionId: string() }).parse(request.params).sessionId,
        );
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
        if (!target || options.unavailableTargets?.includes(target.targetId)) {
          return JSON.stringify({
            id: request.id,
            error: { code: -32_000, message: "No target with given id found" },
          });
        }
        result = {
          windowId: target.windowId ?? 0,
          bounds: { ...viewport, windowState: "normal" },
        };
        break;
      }
      case "Browser.setContentsSize": {
        const size = object({ width: number(), height: number() }).parse(
          request.params,
        );
        viewport.width = size.width;
        viewport.height = size.height;
        bitmap?.resize(size.width, size.height);
        break;
      }
      case "Page.startScreencast": {
        captures.push(request.params);
        if (options.streaming !== false) {
          queueMicrotask(() => {
            frame("AAAA", request.sessionId);
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
              url: targetForSession(request.sessionId).url,
            },
          },
        };
        break;
      }
      case "Page.getLayoutMetrics": {
        result = {
          visualViewport: {
            clientWidth: viewport.width,
            clientHeight: viewport.height,
          },
          cssVisualViewport: {
            offsetX: 0,
            offsetY: 0,
            pageX: 0,
            pageY: 0,
            clientWidth: viewport.width,
            clientHeight: viewport.height,
            scale: 1,
            zoom: 1,
          },
        };
        break;
      }
      case "Page.getNavigationHistory": {
        const target = targetForSession(request.sessionId);
        result = {
          currentIndex: 0,
          entries: [
            {
              id: 1,
              url: target.url,
              userTypedURL: target.url,
              title: target.title,
              transitionType: "typed",
            },
          ],
        };
        break;
      }
    }
    const response = JSON.stringify({ id: request.id, result });
    const held = heldReplies.get(request.method);
    if (held) {
      heldReplies.delete(request.method);
      held(response);
      return null;
    }
    return response;
  });
  return {
    event,
    frame,
    targets,
    input,
    detached,
    captures,
    viewport,
    holdNext(method: string) {
      const response = context.mocks.deferred<string>();
      heldReplies.set(method, response.resolve);
      return {
        received: response.promise,
        async release() {
          socket.receive(cdpUrl, await response.promise);
        },
      };
    },
  };
}
