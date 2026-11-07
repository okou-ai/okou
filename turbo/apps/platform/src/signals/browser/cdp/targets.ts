import { command, state, type Command, type State } from "ccstate";
import { createDeferredPromise } from "../../utils.ts";
import type { OkouBrowserClient } from "@okouai/browser-extension-client";
import type { ViewerTarget } from "../viewer/types.ts";
import type { CdpClient } from "./client.ts";
import {
  CdpFault,
  isRecord,
  isRecoverableReadFailure,
  requestDetails,
} from "./errors.ts";
import { nativeFault, nativeReadFault } from "./native.ts";

export function pageTarget(info: unknown): ViewerTarget | null {
  if (!isRecord(info) || info.type !== "page" || info.subtype === "prerender") {
    return null;
  }
  if (typeof info.targetId !== "string" || !info.targetId) {
    throw new CdpFault(
      "protocol",
      "The browser returned an invalid page target.",
    );
  }
  return Object.freeze({
    id: info.targetId,
    blank: info.url === "about:blank",
    title:
      typeof info.title === "string" && info.title.trim()
        ? info.title.slice(0, 512)
        : "",
  });
}

export type TargetResolution =
  | { readonly kind: "present" | "absent" }
  | {
      readonly kind: "window-error" | "inventory-error";
      readonly error: unknown;
    };

export interface TargetDirectory {
  readonly invalidate$: Command<void, []>;
  readonly invalidateOrder$: Command<void, []>;
  readonly assertWindow$: Command<Promise<void>, [AbortSignal]>;
  readonly contains$: Command<Promise<boolean>, [string, AbortSignal]>;
  readonly assertMember$: Command<Promise<void>, [string, AbortSignal]>;
  readonly read$: Command<Promise<readonly ViewerTarget[]>, [AbortSignal]>;
  readonly readOrder$: Command<
    Promise<readonly string[] | null>,
    [() => boolean, AbortSignal]
  >;
  readonly resolve$: Command<Promise<TargetResolution>, [string, AbortSignal]>;
}

function nativeTabIndex(data: unknown): number {
  if (
    !isRecord(data) ||
    typeof data.tabStripIndex !== "number" ||
    !Number.isSafeInteger(data.tabStripIndex) ||
    data.tabStripIndex < 0
  ) {
    throw new CdpFault(
      "unsupported-capability",
      "The browser did not provide native tab positions.",
    );
  }
  return data.tabStripIndex;
}

async function readTabPages(
  client: CdpClient,
  info: unknown,
  windowId: number | null,
  current: () => boolean,
  signal: AbortSignal,
) {
  if (!current()) {
    return [];
  }
  if (
    !isRecord(info) ||
    info.type !== "tab" ||
    typeof info.targetId !== "string" ||
    !info.targetId
  ) {
    throw new CdpFault("protocol", "Invalid native tab target.");
  }
  const [lookup] = await Promise.allSettled([
    client.request(
      "Browser.getWindowForTarget",
      { targetId: info.targetId },
      undefined,
      undefined,
      signal,
    ),
  ]);
  signal.throwIfAborted();
  if (!current()) {
    return [];
  }
  if (lookup.status === "rejected") {
    if (isRecoverableReadFailure(lookup.reason)) {
      // A missing background tab cannot revoke another page's membership proof.
      return [];
    }
    throw lookup.reason;
  }
  const window: unknown = lookup.value;
  if (
    !isRecord(window) ||
    typeof window.windowId !== "number" ||
    !Number.isSafeInteger(window.windowId)
  ) {
    throw new CdpFault("protocol", "Invalid native tab window.");
  }
  if (windowId !== null && window.windowId !== windowId) {
    return [];
  }
  const index = nativeTabIndex(info.embedderData);
  const nativeWindowId = window.windowId;
  const detach = (value: unknown) => {
    if (
      isRecord(value) &&
      typeof value.sessionId === "string" &&
      value.sessionId
    ) {
      client.notify("Target.detachFromTarget", { sessionId: value.sessionId });
    }
  };
  const attached: unknown = await client.request(
    "Target.attachToTarget",
    { targetId: info.targetId, flatten: true },
    undefined,
    detach,
    signal,
  );
  if (
    !isRecord(attached) ||
    typeof attached.sessionId !== "string" ||
    !attached.sessionId
  ) {
    throw new CdpFault("protocol", "Invalid native tab attachment.");
  }
  const sessionId = attached.sessionId;
  using _session = {
    [Symbol.dispose]: () => {
      // Detaching the parent also releases its auto-attached child sessions.
      detach(attached);
    },
  };
  signal.throwIfAborted();
  if (!current()) {
    return [];
  }
  const pages: string[] = [];
  using _events = {
    [Symbol.dispose]: client.onEvent((event) => {
      if (
        event.sessionId === sessionId &&
        event.method === "Target.attachedToTarget"
      ) {
        const page = pageTarget(event.params.targetInfo);
        if (page) {
          pages.push(page.id);
        }
      }
    }),
  };
  // Chrome announces existing children before acknowledging auto-attachment.
  // This session never pauses a target or owns another inspector's attachment.
  await client.request(
    "Target.setAutoAttach",
    {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "page", exclude: false }, { exclude: true }],
    },
    sessionId,
    undefined,
    signal,
  );
  signal.throwIfAborted();
  return pages.map((id) => {
    return { id, windowId: nativeWindowId, index };
  });
}

async function readNativeOrder(
  client: CdpClient,
  windowId: number | null,
  current: () => boolean,
  signal: AbortSignal,
): Promise<readonly string[] | null> {
  if (!current()) {
    return null;
  }
  const raw: unknown = await client.request(
    "Target.getTargets",
    { filter: [{ type: "tab", exclude: false }, { exclude: true }] },
    undefined,
    undefined,
    signal,
  );
  if (!isRecord(raw) || !Array.isArray(raw.targetInfos)) {
    throw new CdpFault("protocol", "Invalid native tab list.");
  }
  const tabs = raw.targetInfos as unknown[];
  const pages: { id: string; windowId: number; index: number }[] = [];
  for (let offset = 0; offset < tabs.length; offset += 4) {
    signal.throwIfAborted();
    if (!current()) {
      return null;
    }
    const results = await Promise.allSettled(
      tabs.slice(offset, offset + 4).map((tab) => {
        return readTabPages(client, tab, windowId, current, signal);
      }),
    );
    // Wait for every sibling's cleanup before propagating a failed observation.
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
      pages.push(...result.value);
    }
  }
  return pages
    .sort((a, b) => {
      return a.windowId - b.windowId || a.index - b.index;
    })
    .map((page) => {
      return page.id;
    });
}

function createWindowLookup(client: CdpClient) {
  return command(
    async (
      _context,
      targetId: string,
      signal: AbortSignal,
    ): Promise<unknown> => {
      const [result] = await Promise.allSettled([
        client.request(
          "Browser.getWindowForTarget",
          { targetId },
          undefined,
          undefined,
          signal,
        ),
      ]);
      signal.throwIfAborted();
      if (result.status === "fulfilled") {
        return result.value;
      }
      const error: unknown = result.reason;
      throw new CdpFault(
        error instanceof CdpFault && error.code === -32_601
          ? "unsupported-capability"
          : "scope",
        "Window membership could not be verified. Scoped viewing is unavailable.",
        error instanceof CdpFault ? error.code : undefined,
        requestDetails(error),
        { readOnly: isRecoverableReadFailure(error) },
      );
    },
  );
}

function createWindowAssertion(
  native: OkouBrowserClient,
  scopedWindowId: number | null,
  revision$: State<number>,
  assertNative$: Command<void, [AbortSignal]>,
): TargetDirectory["assertWindow$"] {
  return command(async ({ get, set }, signal: AbortSignal) => {
    set(assertNative$, signal);
    const revision = get(revision$);
    if (scopedWindowId !== null) {
      const interrupted = createDeferredPromise<never>(
        { rejection: "owner" },
        signal,
      );
      using _observer = {
        [Symbol.dispose]() {
          if (!interrupted.settled()) {
            interrupted.reject(
              new DOMException(
                "Window verification observer ended.",
                "AbortError",
              ),
            );
          }
        },
      };
      const [read] = await Promise.allSettled([
        Promise.race([
          native.call("getWindow", { windowId: scopedWindowId }),
          interrupted.promise,
        ]),
      ]);
      signal.throwIfAborted();
      if (read.status === "rejected") {
        throw nativeReadFault(read.reason);
      }
      const observation = read.value;
      set(assertNative$, signal);
      if (revision !== get(revision$)) {
        throw new CdpFault(
          "scope",
          "Window membership changed during verification.",
        );
      }
      if (observation.value?.id !== scopedWindowId) {
        throw new CdpFault(
          "scope",
          "The assigned browser window is unavailable.",
        );
      }
    }
  });
}

function createTargetResolution(
  read$: TargetDirectory["read$"],
  assertWindow$: TargetDirectory["assertWindow$"],
): TargetDirectory["resolve$"] {
  return command(
    async (
      { set },
      targetId: string,
      signal: AbortSignal,
    ): Promise<TargetResolution> => {
      // These are independent proofs; neither a lookup error nor native IDs prove absence.
      const [targets, window] = await Promise.allSettled([
        set(read$, signal),
        set(assertWindow$, signal),
      ]);
      signal.throwIfAborted();
      if (window.status === "rejected") {
        return { kind: "window-error", error: window.reason };
      }
      if (targets.status === "rejected") {
        return { kind: "inventory-error", error: targets.reason };
      }
      return {
        kind: targets.value.some((target) => {
          return target.id === targetId;
        })
          ? "present"
          : "absent",
      };
    },
  );
}

/** Native invalidations revoke observations, never replace authoritative CDP IDs. */
export function createTargetDirectory(
  client: CdpClient,
  windowId: number | null | undefined,
  native: OkouBrowserClient,
): TargetDirectory {
  const scopedWindowId = windowId ?? null;
  if (scopedWindowId !== null && !Number.isSafeInteger(scopedWindowId)) {
    throw new CdpFault("configuration", "windowId must be an integer.");
  }
  const resources = { native, client };
  const revision$ = state(0);
  const orderRevision$ = state(0);
  const invalidateOrder$ = command(({ set }) => {
    set(orderRevision$, (revision) => {
      return revision + 1;
    });
  });
  const invalidate$ = command(({ set }) => {
    set(revision$, (revision) => {
      return revision + 1;
    });
    set(invalidateOrder$);
  });
  const assertNative$ = command((_context, signal: AbortSignal) => {
    const { native, client } = resources;
    signal.throwIfAborted();
    if (native.signal.aborted || client.signal.aborted) {
      throw nativeFault(native.signal.reason);
    }
  });
  const assertWindow$ = createWindowAssertion(
    native,
    scopedWindowId,
    revision$,
    assertNative$,
  );
  const lookup$ = createWindowLookup(client);
  const contains$ = command(
    async ({ get, set }, targetId: string, signal: AbortSignal) => {
      set(assertNative$, signal);
      if (scopedWindowId === null) {
        return true;
      }
      const revision = get(revision$);
      const result = await set(lookup$, targetId, signal);
      set(assertNative$, signal);
      if (revision !== get(revision$)) {
        throw new CdpFault(
          "scope",
          "Window membership changed during verification.",
        );
      }
      if (!isRecord(result) || !Number.isSafeInteger(result.windowId)) {
        throw new CdpFault(
          "scope",
          "The browser returned invalid window membership.",
        );
      }
      return result.windowId === scopedWindowId;
    },
  );
  const assertMember$ = command(
    async ({ set }, targetId: string, signal: AbortSignal) => {
      if (!(await set(contains$, targetId, signal))) {
        throw new CdpFault(
          "scope",
          "This target is outside the selected window.",
        );
      }
    },
  );
  const read$ = command(
    async ({ set }, signal: AbortSignal): Promise<readonly ViewerTarget[]> => {
      set(assertNative$, signal);
      const raw: unknown = await client.request(
        "Target.getTargets",
        undefined,
        undefined,
        undefined,
        signal,
      );
      set(assertNative$, signal);
      if (!isRecord(raw) || !Array.isArray(raw.targetInfos)) {
        throw new CdpFault("protocol", "Invalid browser target list.");
      }
      const pages: ViewerTarget[] = [];
      for (const info of raw.targetInfos as unknown[]) {
        const page = pageTarget(info);
        if (page) {
          pages.push(page);
        }
      }
      return Object.freeze(pages);
    },
  );
  const resolve$ = createTargetResolution(read$, assertWindow$);
  const readOrder$ = command(
    async ({ get, set }, readable: () => boolean, signal: AbortSignal) => {
      set(assertNative$, signal);
      const revision = get(orderRevision$);
      const current = () => {
        return readable() && revision === get(orderRevision$);
      };
      const [result] = await Promise.allSettled([
        readNativeOrder(client, scopedWindowId, current, signal),
      ]);
      signal.throwIfAborted();
      set(assertNative$, signal);
      if (!current()) {
        return null;
      }
      if (result.status === "rejected") {
        throw result.reason;
      }
      return result.value;
    },
  );
  return {
    invalidate$,
    invalidateOrder$,
    assertWindow$,
    contains$,
    assertMember$,
    read$,
    readOrder$,
    resolve$,
  };
}
