import { array, number, object, string, unknown } from "zod";

import type { TestContext } from "../signals/__tests__/test-helpers.ts";
import type { BrowserWebSocketPeer } from "../signals/__tests__/test-mocks.ts";

export const TEST_BROWSER_EXTENSION = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  runtimeId: "abcdefghijklmnopabcdefghijklmnop",
  version: "0.3.0",
});

interface BrowserTarget {
  readonly targetId: string;
  title: string;
  url: string;
  faviconUrl?: string;
  pendingUrl?: string;
  windowId?: number;
}

const requestSchema = object({
  id: number().optional(),
  method: string(),
  sessionId: string().optional(),
  params: object({ targetId: string().optional() }).loose().optional(),
});
type BrowserRequest = ReturnType<typeof requestSchema.parse> & {
  readonly connectionId: number;
};
interface ProtocolReply {
  readonly message: string;
  readonly peer: BrowserWebSocketPeer;
}
type BrowserResponse =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

/** A test-owned external CDP browser; the Platform viewer runs normally. */
export function mockBrowserCdp(
  context: TestContext,
  cdpUrl: string,
  options: {
    readonly autoOpen?: boolean;
    readonly onConnecting?: (url: string, socket: { open(): void }) => void;
    readonly streaming?: boolean;
    readonly targets?: readonly BrowserTarget[];
    readonly unavailableTargets?: readonly string[];
    readonly crashedTargets?: readonly string[];
    readonly extensionAvailable?: boolean;
    readonly extensionRuntimeId?: string;
    readonly nativeBase64?: boolean;
    readonly endpointAliases?: readonly string[];
    readonly enforceFrameWindow?: boolean;
    readonly onVersionProbe?: (connectionId: number) => void;
  } = {},
) {
  context.mocks.browser.nativeTextInsertion();
  const endpoints = new Set([cdpUrl, ...(options.endpointAliases ?? [])]);
  const connectionEndpoints = new Map<number, string>();
  const canvas = context.mocks.browser.canvasRendering();
  context.mocks.browser.uint8ArrayFromBase64(options.nativeBase64 ?? true);
  const bitmap =
    options.streaming === false
      ? null
      : context.mocks.browser.imageBitmap(1440, 900);
  const viewport = { width: 1440, height: 900 };
  let focusedEditing: unknown = null;
  const windowStates = new Map<number, string>();
  const closedWindows = new Set<number>();
  const restoredSizes = new Map<number, { width: number; height: number }>();
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
  let updateBeforeTabRead: ((targetId: string) => void) | undefined;
  let sessionSequence = 0;
  let nativeSequence = 0;
  let nativeEpoch = "fixture-worker";
  const bindings = new Set<string>();
  const nativeIds = new Map<string, number>();
  let nextNativeId = 1;
  const requests: BrowserRequest[] = [];
  const input: Pick<BrowserRequest, "method" | "params" | "sessionId">[] = [];
  const detached: string[] = [];
  const retiredSessions = new Set<string>();
  const sessionTargets = new Map<string, string>();
  const sessionPeers = new Map<string, BrowserWebSocketPeer>();
  const discoveryPeers = new Set<BrowserWebSocketPeer>();
  const capturing = new Set<string>();
  const frameWindows = new Map<
    string,
    { limit: number; outstanding: number }
  >();
  let frameAcksHeld = false;
  const crashedTargets = new Set(options.crashedTargets);
  const captures: unknown[] = [];
  const heldCloses = new Map<string, (complete: () => void) => void>();
  const heldReplies = new Map<string, (response: ProtocolReply) => void>();
  const heldFrames = new Map<string, (sessionId: string) => void>();
  const nextResponses = new Map<
    string,
    (request: BrowserRequest) => BrowserResponse
  >();

  function event(method: string, params: unknown, sessionId?: string) {
    if (method === "Target.detachedFromTarget") {
      const detached = object({ sessionId: string() }).parse(params);
      retiredSessions.add(detached.sessionId);
      capturing.delete(detached.sessionId);
      bindings.delete(detached.sessionId);
      const peer = sessionPeers.get(detached.sessionId);
      if (peer) {
        const message = JSON.stringify({ method, params, sessionId });
        const key = `detach:${detached.sessionId}`;
        const held = heldReplies.get(key);
        if (held) {
          heldReplies.delete(key);
          held({ message, peer });
        } else {
          peer.receive(message);
        }
      }
      return;
    }
    const destroyed: string[] = [];
    if (method === "Target.targetDestroyed") {
      const { targetId } = object({ targetId: string() }).parse(params);
      const index = targets.findIndex((target) => target.targetId === targetId);
      if (index !== -1) {
        targets.splice(index, 1);
      }
      for (const [id, target] of sessionTargets) {
        if (target === targetId && !retiredSessions.has(id)) {
          retiredSessions.add(id);
          capturing.delete(id);
          destroyed.push(id);
        }
      }
    }
    const message = JSON.stringify({ method, params, sessionId });
    if (sessionId) {
      sessionPeers.get(sessionId)?.receive(message);
    } else if (method.startsWith("Target.target")) {
      for (const peer of discoveryPeers) {
        peer.receive(message);
      }
    } else {
      for (const endpoint of endpoints) {
        socket.receive(endpoint, message);
      }
    }
    for (const sessionId of destroyed) {
      event("Target.detachedFromTarget", { sessionId });
    }
  }

  function frame(
    data: string,
    sessionId?: string,
    rasterWidth?: number,
    frameNumber = 1,
  ) {
    sessionId ??= [...capturing].reverse().find((id) => {
      return sessionTargets.get(id) === "example-page";
    });
    if (!sessionId) {
      throw new Error("No current frame session for the example target");
    }
    const target = targets.find((candidate) => {
      return candidate.targetId === sessionTargets.get(sessionId);
    });
    if (target && crashedTargets.has(target.targetId)) {
      return false;
    }
    if (target && windowStates.get(target.windowId ?? 0) === "minimized") {
      return false;
    }
    const window = frameWindows.get(sessionId);
    if (options.enforceFrameWindow && window) {
      if (window.outstanding >= window.limit) {
        return false;
      }
      window.outstanding++;
    }
    if (rasterWidth !== undefined) {
      bitmap?.resize(rasterWidth, viewport.height);
    }
    event(
      "Page.screencastFrame",
      {
        data,
        sessionId: frameNumber,
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
    return true;
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
      const updated = updateBeforeTabRead;
      updateBeforeTabRead = undefined;
      const target = targets.find((target) => {
        return nativeTab(target).id === request.tabId;
      });
      if (target) {
        target.title = "Preparing new tab";
        nativeEvent("tab-updated", target);
        updated(target.targetId);
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
        value = closedWindows.has(request.windowId!)
          ? null
          : { id: request.windowId, focused: false };
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
          removeTarget(index);
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

  function removeTarget(index: number) {
    const target = targets.splice(index, 1)[0]!;
    event("Target.targetDestroyed", { targetId: target.targetId });
    nativeEvent("tab-removed", target);
    const windowId = target.windowId ?? 0;
    if (
      !targets.some((remaining) => {
        return (remaining.windowId ?? 0) === windowId;
      })
    ) {
      closedWindows.add(windowId);
      nativeEvent("window-removed", undefined, { windowId });
    }
  }

  function targetForSession(sessionId: string | undefined) {
    const target = targets.find((candidate) => {
      return (
        candidate.targetId === (sessionId && sessionTargets.get(sessionId))
      );
    });
    if (!target) {
      throw new Error("Unknown viewer target session");
    }
    return target;
  }

  function attachTarget(
    request: BrowserRequest,
    peer: BrowserWebSocketPeer,
  ): unknown {
    if (request.params?.targetId !== "okou-worker" && corruptPageAttachment) {
      corruptPageAttachment = false;
      return { sessionId: "" };
    }
    if (request.params?.targetId === "okou-worker") {
      const sessionId = `worker-${++sessionSequence}`;
      sessionPeers.set(sessionId, peer);
      return { sessionId };
    }
    const targetId = request.params?.targetId ?? "example-page";
    const original = `${targetId}-session`;
    let sessionId = original;
    while (sessionPeers.has(sessionId)) {
      sessionId = `${original}-${++sessionSequence}`;
    }
    sessionTargets.set(sessionId, targetId);
    sessionPeers.set(sessionId, peer);
    return { sessionId };
  }

  function targetResult(
    request: BrowserRequest,
    peer: BrowserWebSocketPeer,
  ): unknown {
    switch (request.method) {
      case "Target.setDiscoverTargets": {
        if (request.params?.discover === true) {
          discoveryPeers.add(peer);
        } else {
          discoveryPeers.delete(peer);
        }
        return {};
      }
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
        removeTarget(index);
        return { success: true };
      }
      case "Target.detachFromTarget": {
        const { sessionId } = object({ sessionId: string() }).parse(
          request.params,
        );
        detached.push(sessionId);
        retiredSessions.add(sessionId);
        capturing.delete(sessionId);
        bindings.delete(sessionId);
        queueMicrotask(() => {
          event("Target.detachedFromTarget", { sessionId }, request.sessionId);
        });
        return {};
      }
      case "Target.attachToTarget": {
        return attachTarget(request, peer);
      }
      case "Target.attachToBrowserTarget": {
        const sessionId = `native-browser-${++sessionSequence}`;
        sessionPeers.set(sessionId, peer);
        return { sessionId };
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
          bounds: {
            ...viewport,
            windowState: windowStates.get(target.windowId ?? 0) ?? "normal",
          },
        },
      };
    }
    if (request.method === "Browser.setWindowBounds") {
      const { windowId, bounds } = object({
        windowId: number(),
        bounds: object({ windowState: string() }),
      }).parse(request.params);
      windowStates.set(windowId, bounds.windowState);
      const restored = restoredSizes.get(windowId);
      if (bounds.windowState === "normal" && restored) {
        viewport.width = restored.width;
        viewport.height = restored.height;
        bitmap?.resize(restored.width, restored.height);
        restoredSizes.delete(windowId);
      }
      return { result: {} };
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
    if (request.method === "Runtime.addBinding") {
      bindings.add(request.sessionId!);
      return {};
    }
    if (request.method === "Runtime.removeBinding") {
      bindings.delete(request.sessionId!);
      return {};
    }
    if (request.method === "Runtime.callFunctionOn") {
      const params = object({
        arguments: array(object({ value: unknown() })).optional(),
      }).parse(request.params);
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
      if (expression.includes("/* okou-browser favicon */")) {
        const favicon = targetForSession(request.sessionId).faviconUrl;
        return {
          result: favicon
            ? { type: "string", value: favicon }
            : { type: "object", subtype: "null", value: null },
        };
      }
      return {
        result:
          expression.includes("doc.activeElement") &&
          expression.includes("offsetX:")
            ? { type: "object", value: focusedEditing }
            : expression.includes("const fence =")
              ? { type: "object", value: { fence: 1000, now: 1001 } }
              : expression.includes("devicePixelRatio")
                ? { type: "object", value: { ...viewport, dpr: 1 } }
                : { type: "undefined" },
      };
    }
    return {};
  }

  function navigate(sessionId: string | undefined, url: string) {
    const target = targetForSession(sessionId);
    target.url = url;
    delete target.pendingUrl;
    target.title = url === "about:blank" ? url : new URL(url).hostname;
    event(
      "Page.frameNavigated",
      { frame: { id: "example-frame", loaderId: "navigated-loader", url } },
      sessionId,
    );
    event("Target.targetInfoChanged", {
      targetInfo: { ...target, type: "page" },
    });
    event("Page.loadEventFired", { timestamp: 2 }, sessionId);
    return { frameId: "example-frame" };
  }

  function pageResult(request: BrowserRequest): unknown {
    switch (request.method) {
      case "Page.reload": {
        const target = targetForSession(request.sessionId);
        if (crashedTargets.delete(target.targetId)) {
          navigate(request.sessionId, target.url);
        }
        return {};
      }
      case "Page.createIsolatedWorld": {
        return { executionContextId: 1 };
      }
      case "Page.navigate": {
        const { url } = object({ url: string() }).parse(request.params);
        return navigate(request.sessionId, url);
      }
      case "Page.startScreencast": {
        captures.push(request.params);
        capturing.add(request.sessionId!);
        const { maxFramesInFlight } = object({
          maxFramesInFlight: number().optional(),
        }).parse(request.params);
        frameWindows.set(request.sessionId!, {
          limit: maxFramesInFlight ?? 3,
          outstanding: 0,
        });
        if (options.streaming !== false) {
          queueMicrotask(() => {
            const sessionId = request.sessionId ?? "example-page-session";
            if (!capturing.has(sessionId)) {
              return;
            }
            const held =
              heldFrames.get(sessionId) ??
              heldFrames.get(`target:${targetForSession(sessionId).targetId}`);
            if (held) {
              held(sessionId);
            } else {
              frame("AAAA", sessionId);
            }
          });
        }
        return {};
      }
      case "Page.stopScreencast": {
        capturing.delete(request.sessionId!);
        frameWindows.delete(request.sessionId!);
        return {};
      }
      case "Page.screencastFrameAck": {
        const window = frameWindows.get(request.sessionId!);
        if (window && !frameAcksHeld) {
          window.outstanding = Math.max(0, window.outstanding - 1);
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

  function respond(
    request: BrowserRequest,
    peer: BrowserWebSocketPeer,
  ): BrowserResponse {
    const addressed =
      request.method === "Target.detachFromTarget"
        ? object({ sessionId: string() }).parse(request.params).sessionId
        : request.sessionId;
    if (
      addressed &&
      (retiredSessions.has(addressed) || sessionPeers.get(addressed) !== peer)
    ) {
      return {
        error: { code: -32_001, message: "Session with given id not found." },
      };
    }
    const next = nextResponses.get(request.method);
    if (next) {
      nextResponses.delete(request.method);
      return next(request);
    }
    switch (request.method.split(".")[0]) {
      case "Inspector": {
        if (
          request.method === "Inspector.enable" &&
          request.sessionId &&
          crashedTargets.has(targetForSession(request.sessionId).targetId)
        ) {
          queueMicrotask(() => {
            event("Inspector.targetCrashed", {}, request.sessionId);
          });
        }
        return { result: {} };
      }
      case "Target": {
        return { result: targetResult(request, peer) };
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

  function heldReplyKey(request: BrowserRequest) {
    let receiptKey = request.method;
    if (request.method === "Runtime.evaluate") {
      const { expression } = object({ expression: string() }).parse(
        request.params,
      );
      if (
        expression.includes("doc.activeElement") &&
        expression.includes("offsetX:") &&
        heldReplies.has("editing-context")
      ) {
        return "editing-context";
      }
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
    const targeted =
      request.params?.targetId && `${receiptKey}:${request.params.targetId}`;
    if (targeted && heldReplies.has(targeted)) {
      receiptKey = targeted;
    }
    return receiptKey;
  }

  const socketOptions = {
    autoOpen: options.autoOpen,
    onConnecting: options.onConnecting,
  };
  const socket = context.mocks.browser.webSocket((data, url, peer) => {
    if (!endpoints.has(url)) {
      throw new Error("Unexpected viewer endpoint");
    }
    connectionEndpoints.set(peer.id, url);
    const request = {
      ...requestSchema.parse(JSON.parse(data)),
      connectionId: peer.id,
    };
    requests.push(request);
    if (request.method === "Browser.getVersion") {
      options.onVersionProbe?.(peer.id);
    }
    if (request.id === undefined) {
      return null;
    }
    if (request.method === "Target.closeTarget" && request.params?.targetId) {
      const targetId = request.params.targetId;
      const hold = heldCloses.get(targetId);
      if (hold) {
        heldCloses.delete(targetId);
        hold(() =>
          peer.receive(
            JSON.stringify({ id: request.id, ...respond(request, peer) }),
          ),
        );
        return null;
      }
    }
    // Native effects and notifications precede a held protocol receipt.
    const response = JSON.stringify({
      id: request.id,
      ...respond(request, peer),
    });
    const receiptKey = heldReplyKey(request);
    const held = heldReplies.get(receiptKey);
    if (
      held &&
      !(request.method === "Target.getTargets" && request.sessionId)
    ) {
      heldReplies.delete(receiptKey);
      held({ message: response, peer });
      return null;
    }
    return response;
  }, socketOptions);

  function holdFrames(key: string) {
    const requested = context.mocks.deferred<void>();
    let receivedSession: string | null = null;
    heldFrames.set(key, (sessionId) => {
      receivedSession = sessionId;
      if (!requested.settled()) {
        requested.resolve();
      }
    });
    return {
      received: requested.promise,
      release(data = "AAAA", frameNumber = 1) {
        if (!receivedSession) {
          throw new Error("No screencast request received for the held frame");
        }
        heldFrames.delete(key);
        frame(data, receivedSession, undefined, frameNumber);
        return receivedSession;
      },
    };
  }

  return {
    event,
    navigate,
    canvas,
    crash(
      targetId: string,
      notification: "session" | "target" | "both" | "none" = "both",
    ) {
      crashedTargets.add(targetId);
      for (const [sessionId, target] of sessionTargets) {
        if (target !== targetId || retiredSessions.has(sessionId)) {
          continue;
        }
        capturing.delete(sessionId);
        if (notification === "session" || notification === "both") {
          event("Inspector.targetCrashed", {}, sessionId);
        }
      }
      if (notification === "target" || notification === "both") {
        event("Target.targetCrashed", {
          targetId,
          status: "crashed",
          errorCode: 5,
        });
      }
    },
    frame,
    holdFrameAcks() {
      frameAcksHeld = true;
    },
    targets,
    input,
    inputForTarget(targetId: string) {
      return input.filter(
        ({ sessionId }) =>
          sessionId !== undefined && sessionTargets.get(sessionId) === targetId,
      );
    },
    detached,
    captures,
    viewport,
    pageSession(targetId: string) {
      const request = [...requests].reverse().find((request) => {
        return (
          request.method === "Page.enable" &&
          request.sessionId &&
          sessionTargets.get(request.sessionId) === targetId &&
          !retiredSessions.has(request.sessionId)
        );
      });
      if (!request?.sessionId) {
        throw new Error(`No current page session for ${targetId}`);
      }
      return request.sessionId;
    },
    setFocusedEditing(value: unknown) {
      focusedEditing = value;
    },
    setWindowState(
      state: string,
      windowId = 0,
      restoredSize?: { width: number; height: number },
    ) {
      windowStates.set(windowId, state);
      if (restoredSize) {
        restoredSizes.set(windowId, restoredSize);
      }
    },
    windowState(windowId = 0) {
      return windowStates.get(windowId) ?? "normal";
    },
    ignoreNextWindowRestore() {
      nextResponses.set("Browser.setWindowBounds", () => {
        return { result: {} };
      });
    },
    connections(endpoint?: string) {
      return endpoint === undefined
        ? socket.connections()
        : [...connectionEndpoints.values()].filter((url) => {
            return url === endpoint;
          }).length;
    },
    activeConnections: socket.activeConnections,
    setAutoOpen(autoOpen: boolean) {
      socketOptions.autoOpen = autoOpen;
    },
    openConnection() {
      socket.open(cdpUrl);
    },
    failConnection() {
      socket.fail(cdpUrl);
    },
    disconnect(event: CloseEventInit, connectionIndex?: number) {
      socket.disconnect(cdpUrl, event, connectionIndex);
    },
    failNext(method: string, message: string, code = -32_000) {
      nextResponses.set(method, () => {
        return { error: { code, message } };
      });
    },
    rejectNextNavigation(errorText: string) {
      nextResponses.set("Page.navigate", () => {
        return { result: { frameId: "example-frame", errorText } };
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
        return { result: navigate(request.sessionId, url) };
      });
    },
    holdFrames,
    holdTargetFrames(targetId: string) {
      return holdFrames(`target:${targetId}`);
    },
    requests,
    nativeEvent,
    closeWindow(windowId: number) {
      const closing = targets.filter(
        (page) => (page.windowId ?? 0) === windowId,
      );
      for (const page of closing) {
        removeTarget(targets.indexOf(page));
      }
    },
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
      const updated = context.mocks.deferred<string>();
      updateBeforeTabRead = updated.resolve;
      return updated.promise;
    },
    holdNextNative(method: string) {
      const response = context.mocks.deferred<ProtocolReply>();
      heldReplies.set(`native:${method}`, response.resolve);
      return {
        get received() {
          return response.promise.then((reply) => reply.message);
        },
        async release() {
          const reply = await response.promise;
          reply.peer.receive(reply.message);
        },
      };
    },
    holdClose(targetId: string) {
      const arrival = context.mocks.deferred<() => void>();
      heldCloses.set(targetId, arrival.resolve);
      return {
        received: arrival.promise,
        async release() {
          const complete = await arrival.promise;
          complete();
        },
      };
    },
    holdNextDetach(sessionId: string) {
      const response = context.mocks.deferred<ProtocolReply>();
      heldReplies.set(`detach:${sessionId}`, response.resolve);
      return {
        get received() {
          return response.promise.then((reply) => reply.message);
        },
        async release() {
          const reply = await response.promise;
          reply.peer.receive(reply.message);
        },
      };
    },
    holdNextMembership(targetId: string) {
      const response = context.mocks.deferred<ProtocolReply>();
      heldReplies.set(`membership:${targetId}`, response.resolve);
      return {
        get received() {
          return response.promise.then((reply) => reply.message);
        },
        async release() {
          const reply = await response.promise;
          reply.peer.receive(reply.message);
        },
        async releaseFailure(
          message = "Target no longer exists",
          code = -32_000,
        ) {
          const reply = await response.promise;
          const { id } = object({ id: number() }).parse(
            JSON.parse(reply.message),
          );
          reply.peer.receive(JSON.stringify({ id, error: { code, message } }));
        },
      };
    },
    holdNext(method: string, targetId?: string) {
      const response = context.mocks.deferred<ProtocolReply>();
      heldReplies.set(
        targetId === undefined ? method : `${method}:${targetId}`,
        response.resolve,
      );
      return {
        get received() {
          return response.promise.then((reply) => reply.message);
        },
        async release(result?: unknown) {
          const reply = await response.promise;
          if (result === undefined) {
            reply.peer.receive(reply.message);
          } else {
            const { id } = object({ id: number() }).parse(
              JSON.parse(reply.message),
            );
            reply.peer.receive(JSON.stringify({ id, result }));
          }
        },
      };
    },
  };
}
