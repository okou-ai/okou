import { randomUUID } from "node:crypto";
import { ws } from "msw";
import { number, object, record, string, unknown as zUnknown } from "zod";
import type { TestContext } from "../../../../__tests__/test-context";
import { detach, Mechanism } from "../../../utils";

interface NativeTarget {
  readonly targetId: string;
  windowId: number;
}

/** Stateful external CDP provider; no application state or DB access. */
export function createNativeWindowProvider(context: TestContext) {
  const url = `wss://cdp.browser-use.com/${randomUUID()}`;
  const state: {
    readonly url: string;
    readonly targets: Map<string, NativeTarget>;
    readonly created: NativeTarget[];
    readonly closed: string[];
    readonly windowIds: number[];
    beforeCreateReply?: (target: NativeTarget) => Promise<void> | void;
    beforeWindowReply?: (targetId: string) => Promise<void> | void;
    windowError?: string;
    closeSucceeds: boolean;
    createReply: "reply" | "disconnect" | "withhold";
  } = {
    url,
    targets: new Map(),
    created: [],
    closed: [],
    windowIds: [],
    closeSucceeds: true,
    createReply: "reply",
  };
  let nextWindowId = 1;
  const commandSchema = object({
    id: number(),
    method: string(),
    params: record(string(), zUnknown()),
  });
  const handler = ws.link(url).addEventListener("connection", ({ client }) => {
    const reply = async (event: { readonly data: unknown }) => {
      const command = commandSchema.parse(JSON.parse(String(event.data)));
      let result: unknown;
      if (command.method === "Target.createTarget") {
        const target = {
          targetId: randomUUID().replaceAll("-", ""),
          windowId: state.windowIds.shift() ?? nextWindowId++,
        };
        nextWindowId = Math.max(nextWindowId, target.windowId + 1);
        state.targets.set(target.targetId, target);
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
        if (!target || state.windowError) {
          client.send(
            JSON.stringify({
              id: command.id,
              error: { message: state.windowError ?? "No target with this ID" },
            }),
          );
          return;
        }
        result = { windowId: target.windowId };
      } else if (command.method === "Target.getTargets") {
        result = {
          targetInfos: [...state.targets.values()].map((target) => {
            return {
              targetId: target.targetId,
              type: "page",
              url: "about:blank",
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
        throw new Error(`Unhandled external CDP method: ${command.method}`);
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
