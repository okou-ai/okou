import { randomUUID } from "node:crypto";
import { ws } from "msw";
import { number, object, record, string, unknown as zUnknown } from "zod";
import type { TestContext } from "../../../../__tests__/test-context";
import { detach, Mechanism } from "../../../utils";

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
    beforeCreateReply?: (target: NativeTarget) => Promise<void> | void;
    beforeWindowReply?: (targetId: string) => Promise<void> | void;
    windowError?: string;
    closeSucceeds: boolean;
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
    closeSucceeds: true,
    createReply: "reply",
  };
  let nextWindowId = 1;
  const commandSchema = object({
    id: number(),
    method: string(),
    params: record(string(), zUnknown()),
    sessionId: string().optional(),
  });
  const handler = ws.link(url).addEventListener("connection", ({ client }) => {
    const reply = async (event: { readonly data: unknown }) => {
      const command = commandSchema.parse(JSON.parse(String(event.data)));
      let result: unknown;
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
      } else if (command.method === "Browser.getWindowForTarget") {
        const targetId = String(command.params.targetId);
        await state.beforeWindowReply?.(targetId);
        context.signal.throwIfAborted();
        const target = state.targets.get(targetId);
        const error = state.windowErrors.get(targetId) ?? state.windowError;
        if (!target || error) {
          client.send(
            JSON.stringify({
              id: command.id,
              error: { message: error ?? "No target with this ID" },
            }),
          );
          return;
        }
        result = { windowId: target.windowId };
      } else if (command.method === "Browser.setContentsSize") {
        state.contentsSizes.set(Number(command.params.windowId), {
          width: Number(command.params.width),
          height: Number(command.params.height),
        });
        result = {};
      } else if (command.method === "Target.getTargets") {
        result = {
          targetInfos: [...state.targets.values()].map((target) => {
            return {
              targetId: target.targetId,
              type: "page",
              url: target.url ?? "about:blank",
            };
          }),
        };
      } else if (command.method === "Target.closeTarget") {
        const targetId = String(command.params.targetId);
        if (state.closeSucceeds) {
          state.targets.delete(targetId);
          state.closed.push(targetId);
        }
        result = { success: state.closeSucceeds };
      } else {
        if (!state.command) {
          throw new Error(`Unhandled external CDP method: ${command.method}`);
        }
        result = await state.command(command);
        if (result instanceof Error) {
          client.send(
            JSON.stringify({
              id: command.id,
              error: { message: result.message },
            }),
          );
          return;
        }
      }
      client.send(JSON.stringify({ id: command.id, result }));
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
