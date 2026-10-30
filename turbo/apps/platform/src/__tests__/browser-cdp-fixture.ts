import { array, number, object, string, unknown } from "zod";
import type { TestContext } from "../signals/__tests__/test-helpers.ts";

export const TEST_BROWSER_EXTENSION = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  runtimeId: "abcdefghijklmnopabcdefghijklmnop",
  version: "0.3.0",
});

interface BrowserTarget {
  readonly targetId: string;
  title: string;
  url: string;
  readonly windowId?: number;
}

const requestSchema = object({
  id: number().optional(),
  method: string(),
  sessionId: string().optional(),
  params: object({ targetId: string().optional() }).loose().optional(),
});
type BrowserRequest = ReturnType<typeof requestSchema.parse>;
type BrowserResponse =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

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
  const canvas = context.mocks.browser.canvasRendering();
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
  let selectedText = "";
  let selectionSnapshot = "";
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

  function targetResult(request: BrowserRequest): unknown {
    switch (request.method) {
      case "Target.getTargets": {
        return {
          targetInfos: targets.map((target) => {
            return { ...target, type: "page", attached: false };
          }),
        };
      }
      case "Target.createTarget": {
        const { url } = object({ url: string() }).parse(request.params);
        return { targetId: addTarget(url).targetId };
      }
      case "Target.closeTarget": {
        const index = targets.findIndex((target) => {
          return target.targetId === request.params?.targetId;
        });
        if (index === -1) {
          throw new Error("Unknown tab to close");
        }
        const target = targets.splice(index, 1)[0]!;
        event("Target.targetDestroyed", { targetId: target.targetId });
        return { success: true };
      }
      case "Target.detachFromTarget": {
        detached.push(
          object({ sessionId: string() }).parse(request.params).sessionId,
        );
        return {};
      }
      case "Target.attachToTarget": {
        return {
          sessionId: `${request.params?.targetId ?? "example-page"}-session`,
        };
      }
      default: {
        return {};
      }
    }
  }

  function browserResponse(request: BrowserRequest): BrowserResponse {
    if (request.method === "Browser.getWindowForTarget") {
      const target = targets.find((candidate) => {
        return candidate.targetId === request.params?.targetId;
      });
      if (!target || options.unavailableTargets?.includes(target.targetId)) {
        return {
          error: { code: -32_000, message: "No target with given id found" },
        };
      }
      return {
        result: {
          windowId: target.windowId ?? 0,
          bounds: { ...viewport, windowState: "normal" },
        },
      };
    }
    if (request.method === "Browser.setContentsSize") {
      const size = object({ width: number(), height: number() }).parse(
        request.params,
      );
      viewport.width = size.width;
      viewport.height = size.height;
      bitmap?.resize(size.width, size.height);
    }
    return { result: {} };
  }

  function runtimeResult(request: BrowserRequest): unknown {
    if (request.method === "Runtime.callFunctionOn") {
      const params = object({
        arguments: array(object({ value: unknown() })).optional(),
        objectId: string().optional(),
      }).parse(request.params);
      if (params.objectId === "clipboard-selection") {
        return {
          result: {
            type: "object",
            value: { status: "ok", text: selectionSnapshot },
          },
        };
      }
      const url = params.arguments?.[0]?.value;
      if (typeof url === "string" && url.startsWith("about:blank#cdpv-")) {
        addTarget(url, targetForSession(request.sessionId).windowId);
        return { result: { type: "boolean", value: true } };
      }
    } else if (request.method === "Runtime.evaluate") {
      const { expression } = object({ expression: string() }).parse(
        request.params,
      );
      if (expression.includes("/* okou-browser selection */")) {
        selectionSnapshot = selectedText;
        return { result: { type: "object", objectId: "clipboard-selection" } };
      }
      return {
        result: expression.includes("const fence =")
          ? { type: "object", value: { fence: 1000, now: 1001 } }
          : expression.includes("devicePixelRatio")
            ? { type: "object", value: { ...viewport, dpr: 1 } }
            : { type: "undefined" },
      };
    }
    return {};
  }

  function pageResult(request: BrowserRequest): unknown {
    switch (request.method) {
      case "Page.createIsolatedWorld": {
        return { executionContextId: 1 };
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
        return { frameId: "example-frame" };
      }
      case "Page.startScreencast": {
        captures.push(request.params);
        if (options.streaming !== false) {
          queueMicrotask(() => {
            frame("AAAA", request.sessionId);
          });
        }
        return {};
      }
      case "Page.getFrameTree": {
        return {
          frameTree: {
            frame: {
              id: "example-frame",
              loaderId: "example-loader",
              url: targetForSession(request.sessionId).url,
            },
          },
        };
      }
      case "Page.getLayoutMetrics": {
        return {
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
      }
      case "Page.getNavigationHistory": {
        const target = targetForSession(request.sessionId);
        return {
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
      }
      default: {
        return {};
      }
    }
  }

  function respond(request: BrowserRequest): BrowserResponse {
    switch (request.method.split(".")[0]) {
      case "Target": {
        return { result: targetResult(request) };
      }
      case "Browser": {
        return browserResponse(request);
      }
      case "Runtime": {
        return { result: runtimeResult(request) };
      }
      case "Page": {
        return { result: pageResult(request) };
      }
      case "Input": {
        if (
          [
            "Input.insertText",
            "Input.dispatchKeyEvent",
            "Input.dispatchMouseEvent",
            "Input.imeSetComposition",
          ].includes(request.method)
        ) {
          input.push({
            method: request.method,
            params: request.params,
            sessionId: request.sessionId,
          });
        }
      }
    }
    return { result: {} };
  }

  const socket = context.mocks.browser.webSocket((data, url) => {
    if (url !== cdpUrl) {
      throw new Error("Unexpected viewer endpoint");
    }
    const request = requestSchema.parse(JSON.parse(data));
    if (request.id === undefined) {
      return null;
    }
    const response = JSON.stringify({ id: request.id, ...respond(request) });
    const held = heldReplies.get(request.method);
    if (held) {
      heldReplies.delete(request.method);
      held(response);
      return null;
    }
    return response;
  });

  return {
    canvas,
    event,
    frame,
    targets,
    input,
    detached,
    captures,
    viewport,
    selectText(text: string) {
      selectedText = text;
    },
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
