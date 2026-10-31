import { randomUUID } from "node:crypto";
import { ws } from "msw";
import { number, object, record, string, unknown as zUnknown } from "zod";
import type { TestContext } from "../../../../__tests__/test-context";
import { detach, Mechanism } from "../../../utils";
import {
  TEST_EXTENSION_TARGETS,
  browserExtensionBootstrap,
  browserExtensionBootstrapEvents,
  browserExtensionRequest,
  browserExtensionReply,
} from "../../../../__tests__/browser-extension";

interface NativeTarget {
  readonly targetId: string;
  windowId: number;
  url?: string;
}

/** Stateful external CDP provider; no application state or DB access. */
export function createNativeWindowProvider(context: TestContext) {
  const url = `wss://cdp.browser-use.com/${randomUUID()}`;
  const state: {
    readonly url: string;
    readonly targets: Map<string, NativeTarget>;
    readonly contentsSizes: Map<
      number,
      { readonly width: number; readonly height: number }
    >;
    readonly created: NativeTarget[];
    readonly closed: string[];
    readonly windowIds: number[];
    readonly windowErrors: Map<string, string>;
    readonly nativeWindowErrors: Map<number, string>;
    readonly commands: {
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
      readonly sessionId?: string;
    }[];
    beforeNativeWindowReply?: (windowId: number) => Promise<void> | void;
    afterNativeWindowReply?: (windowId: number) => Promise<void> | void;
    beforeCloseWindowReply?: (windowId: number) => Promise<void> | void;
    beforeWindowForTargetReply?: (targetId: string) => Promise<void> | void;
    windowBoundsError?: { readonly code: number; readonly message: string };
    bridgeAvailable: boolean;
    snapshotEventWindowId?: number;
    emptySnapshot: boolean;
    beforeCreateReply?: (target: NativeTarget) => Promise<void> | void;
    onSocketClose?: () => void;
    windowError?: string;
    closeSucceeds: boolean;
    closeReply: "reply" | "withhold" | "disconnect";
    seedCloseError?: string;
    windowReply: "reply" | "withhold";
    createReply: "reply" | "disconnect" | "withhold";
    command?: (command: {
      readonly id: number;
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
      readonly sessionId?: string;
    }) => unknown;
  } = {
    url,
    targets: new Map(),
    contentsSizes: new Map(),
    created: [],
    closed: [],
    windowIds: [],
    windowErrors: new Map(),
    nativeWindowErrors: new Map(),
    commands: [],
    bridgeAvailable: true,
    emptySnapshot: false,
    closeSucceeds: true,
    closeReply: "reply",
    windowReply: "reply",
    createReply: "reply",
  };
  let nextWindowId = 1;
  let nextTabId = 1;
  let nativeSequence = 0;
  const tabIds = new Map<string, number>();
  function windowInfo(windowId: number, populate: boolean) {
    const targets = [...state.targets.values()].filter((target) => {
      return target.windowId === windowId;
    });
    if (targets.length === 0) {
      return null;
    }
    return {
      id: windowId,
      focused: true,
      ...(populate
        ? {
            tabs: targets.map((target, index) => {
              let id = tabIds.get(target.targetId);
              if (id === undefined) {
                id = nextTabId++;
                tabIds.set(target.targetId, id);
              }
              return {
                id,
                windowId,
                index,
                active: index === 0,
                pinned: false,
                discarded: false,
                url: target.url ?? "about:blank",
              };
            }),
          }
        : {}),
    };
  }
  async function readNativeWindows(
    request: NonNullable<ReturnType<typeof browserExtensionRequest>>,
  ): Promise<unknown> {
    await state.beforeNativeWindowReply?.(Number(request.windowId));
    context.signal.throwIfAborted();
    const error =
      state.nativeWindowErrors.get(Number(request.windowId)) ??
      state.windowError;
    if (error) {
      return new Error(error);
    }
    if (
      request.populate &&
      state.emptySnapshot &&
      request.method === "getWindow"
    ) {
      return { id: request.windowId, focused: true, tabs: [] };
    }
    const value =
      request.method === "getWindow"
        ? windowInfo(Number(request.windowId), request.populate === true)
        : [
            ...new Set(
              [...state.targets.values()].map((target) => {
                return target.windowId;
              }),
            ),
          ].map((id) => {
            return windowInfo(id, request.populate === true);
          });
    if (request.method === "getWindow" && request.populate) {
      await state.afterNativeWindowReply?.(Number(request.windowId));
      context.signal.throwIfAborted();
    }
    return value;
  }
  async function invokeNative(
    request: NonNullable<ReturnType<typeof browserExtensionRequest>>,
  ): Promise<unknown> {
    switch (request.method) {
      case "hello": {
        return {
          protocol: 1,
          capabilities: ["windows", "tabs", "events", "identity-probe"],
        };
      }
      case "getWindow":
      case "listWindows": {
        return await readNativeWindows(request);
      }
      case "closeWindow": {
        await state.beforeCloseWindowReply?.(Number(request.windowId));
        context.signal.throwIfAborted();
        if (state.closeSucceeds) {
          for (const target of state.targets.values()) {
            if (target.windowId === request.windowId) {
              state.targets.delete(target.targetId);
              state.closed.push(target.targetId);
            }
          }
        }
        return null;
      }
      case "createTab": {
        if (!windowInfo(Number(request.windowId), false)) {
          throw new Error("Restore window missing");
        }
        const target = {
          targetId: randomUUID(),
          windowId: Number(request.windowId),
          url: string().parse(request.url),
        };
        state.targets.set(target.targetId, target);
        return windowInfo(target.windowId, true)?.tabs?.at(-1);
      }
      default: {
        throw new Error(`Unexpected native request: ${request.method}`);
      }
    }
  }
  const commandSchema = object({
    id: number(),
    method: string(),
    params: record(string(), zUnknown()),
    sessionId: string().optional(),
  });
  const handler = ws.link(url).addEventListener("connection", ({ client }) => {
    const sendResult = (
      id: number,
      result: unknown,
      events: readonly Readonly<Record<string, unknown>>[] = [],
    ) => {
      for (const event of events) {
        client.send(JSON.stringify(event));
      }
      client.send(
        JSON.stringify(
          result instanceof Error
            ? { id, error: { code: -32_000, message: result.message } }
            : { id, result },
        ),
      );
    };
    client.addEventListener("close", () => {
      state.onSocketClose?.();
    });
    const replyBridge = async (
      command: ReturnType<typeof commandSchema.parse>,
    ): Promise<boolean> => {
      const bootstrap = browserExtensionBootstrap(command);
      const request = browserExtensionRequest(command);
      if (!request && bootstrap === undefined) {
        return false;
      }
      if (
        !state.bridgeAvailable &&
        command.method === "Extensions.triggerAction"
      ) {
        client.send(
          JSON.stringify({
            id: command.id,
            error: { message: "Required extension unavailable" },
          }),
        );
        return true;
      }
      if (
        request &&
        (((request.method === "getWindow" ||
          request.method === "listWindows") &&
          state.windowReply === "withhold") ||
          (request.method === "closeWindow" && state.closeReply === "withhold"))
      ) {
        return true;
      }
      const startedSequence = nativeSequence;
      const value = request ? await invokeNative(request) : bootstrap;
      if (request?.populate && state.snapshotEventWindowId !== undefined) {
        nativeSequence++;
        client.send(
          JSON.stringify({
            method: "Runtime.bindingCalled",
            sessionId: "extension-worker-session",
            params: {
              name: "__okouBrowserEvent",
              payload: JSON.stringify({
                epoch: "fixture-worker",
                sequence: nativeSequence,
                kind: "tab-updated",
                windowId: state.snapshotEventWindowId,
              }),
            },
          }),
        );
      }
      if (
        request?.method === "closeWindow" &&
        state.closeReply === "disconnect"
      ) {
        client.close(1011);
        return true;
      }
      const result =
        request && !(value instanceof Error)
          ? browserExtensionReply(value, nativeSequence, startedSequence)
          : value;
      sendResult(
        command.id,
        result,
        browserExtensionBootstrapEvents(command, state.bridgeAvailable),
      );
      return true;
    };
    const replyWindowLookup = async (
      command: ReturnType<typeof commandSchema.parse>,
    ): Promise<boolean> => {
      if (
        command.method !== "Browser.getWindowForTarget" &&
        command.method !== "Browser.getWindowBounds"
      ) {
        return false;
      }
      if (state.windowReply === "withhold") {
        return true;
      }
      if (command.method === "Browser.getWindowForTarget") {
        const targetId = String(command.params.targetId);
        await state.beforeWindowForTargetReply?.(targetId);
        context.signal.throwIfAborted();
        const target = state.targets.get(targetId);
        const error = state.windowErrors.get(targetId) ?? state.windowError;
        sendResult(
          command.id,
          !target || error
            ? new Error(error ?? "No target with this ID")
            : { windowId: target.windowId },
        );
        return true;
      }
      const windowId = Number(command.params.windowId);
      await state.beforeNativeWindowReply?.(windowId);
      context.signal.throwIfAborted();
      if (state.windowBoundsError) {
        client.send(
          JSON.stringify({ id: command.id, error: state.windowBoundsError }),
        );
        return true;
      }
      const error = state.nativeWindowErrors.get(windowId) ?? state.windowError;
      sendResult(
        command.id,
        error
          ? new Error(error)
          : windowInfo(windowId, false)
            ? {
                bounds: {
                  left: 0,
                  top: 0,
                  width: 800,
                  height: 600,
                  windowState: "normal",
                },
              }
            : new Error("Browser window not found"),
      );
      return true;
    };
    const reply = async (event: { readonly data: unknown }) => {
      const command = commandSchema.parse(JSON.parse(String(event.data)));
      state.commands.push(command);
      let result: unknown;
      if (await replyBridge(command)) {
        return;
      }
      if (await replyWindowLookup(command)) {
        return;
      }
      if (command.method === "Target.createTarget") {
        const target = {
          targetId: randomUUID().replaceAll("-", ""),
          windowId: state.windowIds.shift() ?? nextWindowId++,
          url: string().parse(command.params.url),
        };
        nextWindowId = Math.max(nextWindowId, target.windowId + 1);
        state.targets.set(target.targetId, target);
        state.contentsSizes.set(target.windowId, { width: 800, height: 600 });
        state.created.push(target);
        await state.beforeCreateReply?.(target);
        context.signal.throwIfAborted();
        if (state.createReply === "disconnect") {
          client.close(1011);
          return;
        }
        if (state.createReply === "withhold") {
          return;
        }
        result = { targetId: target.targetId };
      } else if (command.method === "Browser.setContentsSize") {
        state.contentsSizes.set(Number(command.params.windowId), {
          width: Number(command.params.width),
          height: Number(command.params.height),
        });
        result = {};
      } else if (command.method === "Target.getTargets") {
        result = {
          targetInfos: [...state.targets.values()]
            .map((target) => {
              return {
                targetId: target.targetId,
                type: "page",
                url: target.url ?? "about:blank",
              };
            })
            .concat(
              TEST_EXTENSION_TARGETS.filter((target) => {
                return (
                  state.bridgeAvailable || target.type !== "service_worker"
                );
              }),
            ),
        };
      } else if (command.method === "Target.closeTarget") {
        const targetId = String(command.params.targetId);
        if (state.seedCloseError) {
          result = new Error(state.seedCloseError);
        } else {
          state.targets.delete(targetId);
          state.closed.push(targetId);
          result = { success: true };
        }
      } else {
        if (!state.command) {
          throw new Error(`Unhandled external CDP method: ${command.method}`);
        }
        result = await state.command(command);
      }
      sendResult(command.id, result);
    };
    client.addEventListener("message", (event) => {
      detach(
        reply(event),
        Mechanism.Deferred,
        "External native CDP fixture reply",
      );
    });
  });
  return Object.assign(state, { handler });
}

export function installBrowserWindowContentCommands(
  native: ReturnType<typeof createNativeWindowProvider>,
) {
  const sizes = native.contentsSizes;
  native.command = (command) => {
    const targetId = command.sessionId?.replace(/^page-/u, "");
    if (command.method === "Target.attachToTarget") {
      return { sessionId: `page-${String(command.params.targetId)}` };
    }
    if (command.method === "Page.getFrameTree") {
      return {
        frameTree: {
          frame: { id: "frame", loaderId: "loader", url: "about:blank" },
        },
      };
    }
    if (command.method === "Page.createIsolatedWorld") {
      return { executionContextId: 1 };
    }
    if (command.method === "Runtime.evaluate") {
      return { result: { value: true } };
    }
    if (command.method === "Page.getLayoutMetrics") {
      return {
        cssVisualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 1440,
          clientHeight: 900,
        },
      };
    }
    if (command.method === "Page.captureScreenshot") {
      return { data: Buffer.from(`preview:${targetId}`).toString("base64") };
    }
    throw new Error(`Unexpected external CDP operation: ${command.method}`);
  };
  return { sizes };
}
