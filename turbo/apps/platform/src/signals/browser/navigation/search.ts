import { command } from "ccstate";
import type { OkouBrowserClient } from "@okouai/browser-extension-client";
import type { TargetDirectory } from "../cdp/targets.ts";
import { CdpFault } from "../cdp/errors.ts";
import { nativeFault } from "../cdp/native.ts";

export class SearchUnavailableFault extends CdpFault {
  constructor() {
    super(
      "unsupported-capability",
      "Search is unavailable in this Browser. Reopen it to enable search.",
    );
  }
}

/** Native search uses Chrome's TemplateURLService, not a replicated engine URL. */
export function createNativeSearch(
  targetId: string,
  windowId: number,
  native: OkouBrowserClient,
  directory: TargetDirectory,
) {
  const prepare$ = command(async ({ set }, signal: AbortSignal) => {
    if (!native.supports("search")) {
      throw new SearchUnavailableFault();
    }
    await set(directory.assertMember$, targetId, signal);
    const target = await native.identifyFocusedTarget(
      targetId,
      windowId,
      signal,
    );
    await set(directory.assertMember$, targetId, signal);
    if (!target) {
      throw new CdpFault("scope", "The search target could not be verified.");
    }
    return target.id;
  });
  const request$ = command(
    async (_context, tabId: number, text: string, signal: AbortSignal) => {
      const [result] = await Promise.allSettled([
        native.call("search", { tabId, windowId, text }),
      ]);
      signal.throwIfAborted();
      if (result.status === "rejected") {
        throw nativeFault(result.reason);
      }
    },
  );
  return { prepare$, request$ };
}

export type NativeSearch = ReturnType<typeof createNativeSearch>;
