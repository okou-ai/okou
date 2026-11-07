import type {
  CdpTransport,
  OkouBrowserClient,
} from "@okouai/browser-extension-client";
import {
  array,
  boolean,
  number,
  object,
  string,
  type infer as zInfer,
} from "zod";

const nativeTab = object({
  id: number().int().nonnegative().safe(),
  windowId: number().int().nonnegative().safe(),
  index: number().int().nonnegative().safe(),
  discarded: boolean(),
  url: string().optional(),
});
const nativeWindow = object({
  id: number().int().nonnegative().safe(),
  tabs: array(nativeTab),
});
const tabTarget = object({
  targetId: string().min(1),
  type: string(),
  embedderData: object({ tabStripIndex: number().int().nonnegative().safe() }),
});
const pageTarget = object({
  targetId: string().min(1),
  type: string(),
  subtype: string().optional(),
});

async function readTabPage(
  transport: CdpTransport,
  info: zInfer<typeof tabTarget>,
  before: readonly zInfer<typeof nativeWindow>[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const location = object({ windowId: number().int().safe() }).parse(
    await transport.request("Browser.getWindowForTarget", {
      targetId: info.targetId,
    }),
  );
  const tab = before
    .find((window) => {
      return window.id === location.windowId;
    })
    ?.tabs.find((tab) => {
      return tab.index === info.embedderData.tabStripIndex;
    });
  // Attaching a debugger can wake a discarded tab and replace its identity.
  if (!tab || tab.discarded) {
    return null;
  }
  const attached = object({ sessionId: string().min(1) }).parse(
    await transport.request("Target.attachToTarget", {
      targetId: info.targetId,
      flatten: true,
    }),
  );
  const [captured] = await Promise.allSettled([
    (async () => {
      const children: string[] = [];
      let invalidChild = false;
      using _events = {
        [Symbol.dispose]: transport.onEvent((event) => {
          if (
            event.sessionId === attached.sessionId &&
            event.method === "Target.attachedToTarget"
          ) {
            const parsed = pageTarget.safeParse(event.params.targetInfo);
            if (!parsed.success) {
              invalidChild = true;
            } else if (
              parsed.data.type === "page" &&
              parsed.data.subtype !== "prerender"
            ) {
              children.push(parsed.data.targetId);
            }
          }
        }),
      };
      await transport.request(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "page", exclude: false }, { exclude: true }],
        },
        attached.sessionId,
      );
      if (invalidChild || children.length > 1) {
        throw new Error("Browser snapshot has ambiguous tab identity");
      }
      return children[0] ? ([tab.id, children[0]] as const) : null;
    })(),
  ]);
  // This socket's bounded owner also releases late/unconfirmed sessions.
  await Promise.allSettled([
    transport.request("Target.detachFromTarget", {
      sessionId: attached.sessionId,
    }),
  ]);
  if (captured.status === "rejected") {
    throw captured.reason;
  }
  return captured.value;
}

/** Snapshot-only identity correlation; the viewer never invokes this scan. */
export async function readBrowserTabInventory(
  client: OkouBrowserClient,
  transport: CdpTransport,
  signal: AbortSignal,
  windowId?: number,
) {
  let changed = false;
  using _native = {
    [Symbol.dispose]: client.onEvent((event) => {
      if (
        [
          "tab-created",
          "tab-moved",
          "tab-detached",
          "tab-attached",
          "tab-removed",
          "tab-replaced",
          "window-created",
          "window-removed",
        ].includes(event.kind) &&
        (windowId === undefined ||
          event.windowId === windowId ||
          event.oldWindowId === windowId)
      ) {
        changed = true;
      }
    }),
  };
  const windows = async () => {
    signal.throwIfAborted();
    const observed =
      windowId === undefined
        ? await client.call("listWindows", { populate: true })
        : await client.call("getWindow", { windowId, populate: true });
    signal.throwIfAborted();
    const result = array(nativeWindow).parse(
      windowId === undefined
        ? observed.value
        : observed.value === null
          ? []
          : [observed.value],
    );
    if (
      result.some((window) => {
        return (
          (windowId !== undefined && window.id !== windowId) ||
          window.tabs.some((tab) => {
            return tab.windowId !== window.id;
          })
        );
      })
    ) {
      throw new Error("Browser snapshot crossed its native window");
    }
    return result;
  };
  const before = await windows();
  if (before.length === 0) {
    return [];
  }
  const targets = object({ targetInfos: array(tabTarget) }).parse(
    await transport.request("Target.getTargets", {
      filter: [{ type: "tab", exclude: false }, { exclude: true }],
    }),
  ).targetInfos;
  const pages = new Map<number, string>();
  for (let offset = 0; offset < targets.length; offset += 4) {
    const results = await Promise.allSettled(
      targets.slice(offset, offset + 4).map((info) => {
        return readTabPage(transport, info, before, signal);
      }),
    );
    signal.throwIfAborted();
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
      if (result.value) {
        pages.set(result.value[0], result.value[1]);
      }
    }
  }
  const after = await windows();
  const structure = (windows: typeof before) => {
    return JSON.stringify(
      [...windows]
        .sort((a, b) => {
          return a.id - b.id;
        })
        .map((window) => {
          return [
            window.id,
            [...window.tabs]
              .sort((a, b) => {
                return a.index - b.index;
              })
              .map((tab) => {
                return [tab.id, tab.index];
              }),
          ];
        }),
    );
  };
  if (changed || structure(before) !== structure(after)) {
    throw new Error("Browser tab structure changed during snapshot");
  }
  return after.map((window) => {
    return {
      ...window,
      tabs: window.tabs.map((tab) => {
        return {
          ...tab,
          targetId: pages.get(tab.id) ?? null,
        };
      }),
    };
  });
}
