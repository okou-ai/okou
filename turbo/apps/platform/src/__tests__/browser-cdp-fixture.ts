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
  pendingUrl?: string;
  windowId?: number;
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
    readonly extensionAvailable?: boolean;
    readonly extensionRuntimeId?: string;
  } = {},
) {
  context.mocks.browser.canvasRendering();
  context.mocks.browser.uint8ArrayFromBase64();
  const bitmap =
    options.streaming === false
      ? null
      : context.mocks.browser.imageBitmap(1440, 900);
  const viewport = { width: 1440, height: 900 };
  let focusedEditing: unknown;
  let editingTarget = "focused-field";
  let editingRevision = 1;
  let editingSequence = 0;
  const editingProbes = new Set<string>();
  const editingWatches = new Map<
    string,
    { id: string; sessionId: string; contextId: number }
  >();
  const editingContexts = new Map<string, number>();
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
  let corruptPageAttachment = false;
  let updateBeforeTabRead = false;
  let sessionSequence = 0;
  let nativeSequence = 0;
  let nativeEpoch = "fixture-worker";
  const bindings = new Set<string>();
  const nativeIds = new Map<string, number>();
  let nextNativeId = 1;
  const requests: BrowserRequest[] = [];
  const input: { method: string; params: unknown; sessionId?: string }[] = [];
  const detached: string[] = [];
  const captures: unknown[] = [];
  const heldReplies = new Map<string, (response: string) => void>();
  const heldFrames = new Map<string, () => void>();
  const nextResponses = new Map<
    string,
    (request: BrowserRequest) => BrowserResponse
  >();

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
    nativeEvent("tab-created", target);
    return target;
  }

  function nativeTab(target: BrowserTarget) {
    let id = nativeIds.get(target.targetId);
    if (id === undefined) {
      id = nextNativeId++;
      nativeIds.set(target.targetId, id);
    }
    return {
      id,
      windowId: target.windowId ?? 0,
      index: targets.indexOf(target),
      active: true,
      pinned: false,
      discarded: false,
      url: target.url,
      ...(target.pendingUrl ? { pendingUrl: target.pendingUrl } : {}),
      title: target.title,
    };
  }

  function nativeEvent(
    kind: string,
    target?: BrowserTarget,
    extra: Record<string, unknown> = {},
  ) {
    const payload = JSON.stringify({
      epoch: nativeEpoch,
      sequence: ++nativeSequence,
      kind,
      ...(target
        ? { tabId: nativeTab(target).id, windowId: target.windowId ?? 0 }
        : {}),
      ...extra,
    });
    for (const session of bindings) {
      event(
        "Runtime.bindingCalled",
        { name: "__okouBrowserEvent", payload },
        session,
      );
    }
  }

  function nativeResult(expression: string) {
    const raw = expression.slice(expression.indexOf(".invoke(") + 8, -1);
    const request = object({
      method: string(),
      windowId: number().optional(),
      tabId: number().optional(),
      url: string().optional(),
    }).parse(JSON.parse(raw));
    if (request.method === "getTab" && updateBeforeTabRead) {
      updateBeforeTabRead = false;
      const target = targets.find((target) => {
        return nativeTab(target).id === request.tabId;
      });
      if (target) {
        nativeEvent("tab-updated", target);
      }
    }
    const startedSequence = nativeSequence;
    let value: unknown;
    switch (request.method) {
      case "hello": {
        value = { protocol: 1, capabilities: ["windows", "tabs", "events"] };
        break;
      }
      case "getWindow": {
        value = { id: request.windowId, focused: false };
        break;
      }
      case "createTab": {
        value = {
          ...nativeTab(addTarget(request.url!, request.windowId ?? 0)),
          url: "",
          pendingUrl: request.url,
        };
        break;
      }
      case "getTab": {
        value =
          targets.map(nativeTab).find((tab) => {
            return tab.id === request.tabId;
          }) ?? null;
        break;
      }
      case "closeTab": {
        const index = targets.findIndex((target) => {
          return nativeTab(target).id === request.tabId;
        });
        if (index !== -1) {
          const target = targets.splice(index, 1)[0]!;
          event("Target.targetDestroyed", { targetId: target.targetId });
          nativeEvent("tab-removed", target);
        }
        value = null;
        break;
      }
      default: {
        throw new Error("Unknown native browser operation");
      }
    }
    return {
      result: {
        type: "object",
        value: {
          ok: true,
          epoch: nativeEpoch,
          startedSequence,
          sequence: nativeSequence,
          value,
        },
      },
    };
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
          targetInfos: request.sessionId
            ? [
                {
                  type: "service_worker",
                  targetId: "okou-worker",
                  url: `chrome-extension://${options.extensionRuntimeId ?? TEST_BROWSER_EXTENSION.runtimeId}/background.js`,
                },
                { type: "tab", targetId: "browser-tab", url: "about:blank" },
              ]
            : targets.map((target) => {
                return { ...target, type: "page", attached: false };
              }),
        };
      }
      case "Target.createTarget": {
        const { url } = object({ url: string() }).parse(request.params);
        return { targetId: addTarget(url).targetId };
      }
      case "Target.getTargetInfo": {
        const target = targets.find((target) => {
          return target.targetId === request.params?.targetId;
        });
        if (!target) {
          throw new Error("Unknown browser target");
        }
        return { targetInfo: { ...target, type: "page", attached: false } };
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
        nativeEvent("tab-removed", target);
        return { success: true };
      }
      case "Target.detachFromTarget": {
        detached.push(
          object({ sessionId: string() }).parse(request.params).sessionId,
        );
        return {};
      }
      case "Target.attachToTarget": {
        if (
          request.params?.targetId !== "okou-worker" &&
          corruptPageAttachment
        ) {
          corruptPageAttachment = false;
          return { sessionId: "" };
        }
        return {
          sessionId:
            request.params?.targetId === "okou-worker"
              ? `worker-${++sessionSequence}`
              : `${request.params?.targetId ?? "example-page"}-session`,
        };
      }
      case "Target.attachToBrowserTarget": {
        return { sessionId: `native-browser-${++sessionSequence}` };
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

  function editingResult(validating: boolean, expected: unknown): unknown {
    if (validating) {
      return {
        result: {
          type: "boolean",
          value: focusedEditing !== null && expected === editingRevision,
        },
      };
    }
    return {
      result: {
        type: "object",
        value: {
          kind:
            focusedEditing === undefined
              ? "unknown"
              : focusedEditing === null
                ? "inactive"
                : "editable",
          revision: editingRevision,
          ...(typeof focusedEditing === "object" && focusedEditing !== null
            ? focusedEditing
            : {}),
        },
      },
    };
  }

  function editingCall(
    objectId: string,
    declaration: string | undefined,
    id: unknown,
    sessionId: string,
  ): unknown {
    if (declaration?.includes("this.begin(") && typeof id === "string") {
      editingWatches.set(objectId, {
        id,
        sessionId,
        contextId: editingContexts.get(sessionId)!,
      });
    } else if (
      declaration?.includes("this.stop(") ||
      declaration?.includes("this.dispose(")
    ) {
      if (id === undefined || editingWatches.get(objectId)?.id === id) {
        editingWatches.delete(objectId);
      }
      return { result: { type: "undefined" } };
    }
    return editingResult(declaration?.includes("this.valid(") === true, id);
  }

  function runtimeResult(request: BrowserRequest): unknown {
    if (request.method === "Runtime.releaseObject") {
      const { objectId } = object({ objectId: string() }).parse(request.params);
      editingProbes.delete(objectId);
      editingWatches.delete(objectId);
      return {};
    }
    if (
      ["Runtime.addBinding", "Runtime.removeBinding"].includes(request.method)
    ) {
      return runtimeBinding(request);
    }
    if (request.method === "Runtime.callFunctionOn") {
      const params = object({
        objectId: string().optional(),
        functionDeclaration: string().optional(),
        arguments: array(object({ value: unknown() })).optional(),
      }).parse(request.params);
      if (params.objectId && editingProbes.has(params.objectId)) {
        return editingCall(
          params.objectId,
          params.functionDeclaration,
          params.arguments?.[0]?.value,
          request.sessionId!,
        );
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
      if (expression.startsWith("globalThis.__okouBrowser?.invoke(")) {
        return options.extensionAvailable === false
          ? { result: { type: "undefined" } }
          : nativeResult(expression);
      }
      if (expression.startsWith("/* okou-browser editing */")) {
        const { contextId } = object({ contextId: number() }).parse(
          request.params,
        );
        editingContexts.set(request.sessionId!, contextId);
        const objectId = `editing-probe-${++editingSequence}`;
        editingProbes.add(objectId);
        return { result: { type: "object", objectId } };
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

  function runtimeBinding(request: BrowserRequest): unknown {
    if (request.params?.name !== "__okouEditingChanged") {
      if (request.method === "Runtime.addBinding") {
        bindings.add(request.sessionId!);
      } else {
        bindings.delete(request.sessionId!);
      }
    }
    return {};
  }

  function revokeEditing(sessionId?: string) {
    if (
      sessionId &&
      ![...editingWatches.values()].some(
        (watch) => watch.sessionId === sessionId,
      )
    ) {
      return;
    }
    editingRevision++;
    for (const [objectId, watch] of editingWatches) {
      if (!sessionId || watch.sessionId === sessionId) {
        editingWatches.delete(objectId);
        event(
          "Runtime.bindingCalled",
          {
            name: "__okouEditingChanged",
            payload: watch.id,
            executionContextId: watch.contextId,
          },
          watch.sessionId,
        );
      }
    }
  }

  function navigate(request: BrowserRequest, url: string) {
    const target = targetForSession(request.sessionId);
    target.url = url;
    delete target.pendingUrl;
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

  function pageResult(request: BrowserRequest): unknown {
    switch (request.method) {
      case "Page.createIsolatedWorld": {
        return { executionContextId: 1 };
      }
      case "Page.navigate": {
        const { url } = object({ url: string() }).parse(request.params);
        return navigate(request, url);
      }
      case "Page.startScreencast": {
        captures.push(request.params);
        if (options.streaming !== false) {
          queueMicrotask(() => {
            const sessionId = request.sessionId ?? "example-page-session";
            const held = heldFrames.get(sessionId);
            if (held) {
              held();
            } else {
              frame("AAAA", sessionId);
            }
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
    const next = nextResponses.get(request.method);
    if (next) {
      nextResponses.delete(request.method);
      return next(request);
    }
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
          if (request.method === "Input.insertText") {
            revokeEditing(request.sessionId);
          }
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
    requests.push(request);
    if (request.id === undefined) {
      return null;
    }
    // Native effects and notifications precede a held protocol receipt.
    const response = JSON.stringify({ id: request.id, ...respond(request) });
    let receiptKey = request.method;
    if (request.method === "Runtime.evaluate") {
      const { expression } = object({ expression: string() }).parse(
        request.params,
      );
      if (expression.startsWith("globalThis.__okouBrowser?.invoke(")) {
        const raw = expression.slice(expression.indexOf(".invoke(") + 8, -1);
        const { method } = object({ method: string() }).parse(JSON.parse(raw));
        if (heldReplies.has(`native:${method}`)) {
          receiptKey = `native:${method}`;
        }
      }
    } else if (
      request.method === "Browser.getWindowForTarget" &&
      heldReplies.has(`membership:${request.params?.targetId}`)
    ) {
      receiptKey = `membership:${request.params?.targetId}`;
    }
    const held = heldReplies.get(receiptKey);
    if (
      held &&
      !(request.method === "Target.getTargets" && request.sessionId)
    ) {
      heldReplies.delete(receiptKey);
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
    setFocusedEditing(value: unknown, target = "focused-field") {
      if (
        target !== editingTarget ||
        (value === null) !== (focusedEditing === null)
      ) {
        revokeEditing();
      }
      editingTarget = target;
      focusedEditing = value;
    },
    connections: socket.connections,
    failNext(method: string, message: string, code = -32_000) {
      nextResponses.set(method, () => {
        return { error: { code, message } };
      });
    },
    downloadNextNavigation() {
      nextResponses.set("Page.navigate", () => {
        // CDP accepts the download without replacing the current document.
        return { result: { frameId: "example-frame", isDownload: true } };
      });
    },
    redirectNextNavigation(url: string) {
      nextResponses.set("Page.navigate", (request) => {
        return { result: navigate(request, url) };
      });
    },
    holdFrames(sessionId: string) {
      const requested = context.mocks.deferred<void>();
      heldFrames.set(sessionId, requested.resolve);
      return {
        received: requested.promise,
        release(data = "AAAA") {
          heldFrames.delete(sessionId);
          frame(data, sessionId);
        },
      };
    },
    requests,
    nativeEvent,
    resetWorker() {
      nativeEpoch = "replacement-worker";
      nativeEvent("tab-updated");
    },
    skipNativeEvent() {
      nativeSequence++;
    },
    move(targetId: string, windowId: number) {
      const target = targets.find((target) => {
        return target.targetId === targetId;
      })!;
      const oldWindowId = target.windowId ?? 0;
      target.windowId = windowId;
      nativeEvent("tab-detached", target, { oldWindowId });
      nativeEvent("tab-attached", target);
    },
    beginNavigation(targetId: string, url: string) {
      const target = targets.find((target) => {
        return target.targetId === targetId;
      })!;
      target.pendingUrl = url;
      nativeEvent("tab-updated", target);
    },
    duplicate(targetId: string) {
      const target = targets.find((target) => {
        return target.targetId === targetId;
      })!;
      addTarget(target.url, target.windowId);
    },
    corruptNextPageAttachment() {
      corruptPageAttachment = true;
    },
    updateBeforeNextTabRead() {
      updateBeforeTabRead = true;
    },
    holdNextNative(method: string) {
      const response = context.mocks.deferred<string>();
      heldReplies.set(`native:${method}`, response.resolve);
      return {
        received: response.promise,
        async release() {
          socket.receive(cdpUrl, await response.promise);
        },
      };
    },
    holdNextMembership(targetId: string) {
      const response = context.mocks.deferred<string>();
      heldReplies.set(`membership:${targetId}`, response.resolve);
      return {
        received: response.promise,
        async release() {
          socket.receive(cdpUrl, await response.promise);
        },
        async releaseFailure(
          message = "Target no longer exists",
          code = -32_000,
        ) {
          const { id } = object({ id: number() }).parse(
            JSON.parse(await response.promise),
          );
          socket.receive(
            cdpUrl,
            JSON.stringify({ id, error: { code, message } }),
          );
        },
      };
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
