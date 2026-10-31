import { command, state, type Command } from "ccstate";
import type { OkouBrowserClient } from "@okouai/browser-extension-client";
import type { ViewerTarget } from "../viewer/types.ts";
import type { CdpClient } from "./client.ts";
import { CdpFault, isRecord, requestDetails } from "./errors.ts";
import { nativeFault } from "./native.ts";

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
    title:
      typeof info.title === "string" && info.title.trim()
        ? info.title.slice(0, 512)
        : "",
  });
}

export interface TargetDirectory {
  readonly invalidate$: Command<void, []>;
  readonly assertWindow$: Command<Promise<void>, [AbortSignal]>;
  readonly contains$: Command<Promise<boolean>, [string, AbortSignal]>;
  readonly assertMember$: Command<Promise<void>, [string, AbortSignal]>;
  readonly read$: Command<Promise<readonly ViewerTarget[]>, [AbortSignal]>;
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
        undefined,
        requestDetails(error),
      );
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
  const invalidate$ = command(({ set }) => {
    set(revision$, (revision) => {
      return revision + 1;
    });
  });
  const assertNative$ = command((_context, signal: AbortSignal) => {
    const { native, client } = resources;
    signal.throwIfAborted();
    if (native.signal.aborted || client.signal.aborted) {
      throw nativeFault();
    }
  });
  const assertWindow$ = command(async ({ get, set }, signal: AbortSignal) => {
    set(assertNative$, signal);
    const revision = get(revision$);
    if (scopedWindowId !== null) {
      const observation = await native.call("getWindow", {
        windowId: scopedWindowId,
      });
      signal.throwIfAborted();
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
  return { invalidate$, assertWindow$, contains$, assertMember$, read$ };
}
