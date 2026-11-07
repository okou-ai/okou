import type { BrowserTabOrder } from "@okouai/api-contracts/contracts/browser";
import {
  browserTabOrderStateSchema,
  type BrowserTabOrderState,
} from "@okouai/db/jsonb-contracts/browser-tab-order";
import { array, string } from "zod";

export type TabOrderEntry = BrowserTabOrderState["tabs"][number];
export interface SavedTabUrl {
  readonly tabId: number;
  readonly url: string;
}

export function browserTabOrderState(
  stored: BrowserTabOrderState | null,
  binding: Pick<BrowserTabOrder, "instanceId" | "windowId">,
): BrowserTabOrderState {
  if (stored !== null) {
    const parsed = browserTabOrderStateSchema.parse(stored);
    if (
      parsed.instanceId === binding.instanceId &&
      parsed.windowId === binding.windowId
    ) {
      return parsed;
    }
  }
  return { ...binding, tabs: [], savedTabIds: [] };
}

export function savedBrowserTabUrls(
  state: BrowserTabOrderState,
  value: unknown,
): readonly SavedTabUrl[] {
  const urls = array(string().max(8192)).parse(value);
  if (urls.length !== state.savedTabIds.length) {
    throw new Error("Browser snapshot identities do not match its URL array");
  }
  return urls.map((url, index) => {
    return { tabId: state.savedTabIds[index]!, url };
  });
}

export function publicBrowserTabOrder(
  state: BrowserTabOrderState,
): BrowserTabOrder {
  return {
    instanceId: state.instanceId,
    windowId: state.windowId,
    targetIds: state.tabs.flatMap((tab) => {
      return tab.targetId === null ? [] : [tab.targetId];
    }),
  };
}

interface OrderedTab {
  readonly id: number;
  readonly targetId: string | null;
  readonly url?: string;
  readonly discarded?: boolean;
}

/** Reserve exact identities before filling empty URL positions for discarded tabs.
 * Each saved occurrence is consumed once; URL equality never confers page identity.
 */
export function orderBrowserTabs<T extends OrderedTab>(
  tabs: readonly T[],
  previous: readonly TabOrderEntry[],
  savedUrls: readonly SavedTabUrl[] = [],
): T[] {
  const byNative = new Map(
    tabs.map((tab) => {
      return [tab.id, tab];
    }),
  );
  const byTarget = new Map(
    tabs.flatMap((tab) => {
      return tab.targetId === null ? [] : [[tab.targetId, tab] as const];
    }),
  );
  const resolve = (entry: TabOrderEntry) => {
    return (
      (entry.tabId === null ? undefined : byNative.get(entry.tabId)) ??
      (entry.targetId === null ? undefined : byTarget.get(entry.targetId))
    );
  };
  const reserved = new Set(
    previous.flatMap((entry) => {
      const tab = resolve(entry);
      return tab ? [tab.id] : [];
    }),
  );
  const saved = new Map(
    savedUrls.map((entry) => {
      return [entry.tabId, entry.url];
    }),
  );
  const ordered: T[] = [];
  for (const entry of previous) {
    const url = entry.tabId === null ? undefined : saved.get(entry.tabId);
    const tab =
      resolve(entry) ??
      (url === undefined
        ? undefined
        : tabs.find((candidate) => {
            return (
              candidate.discarded &&
              !reserved.has(candidate.id) &&
              byNative.has(candidate.id) &&
              candidate.url === url
            );
          }));
    if (tab && byNative.delete(tab.id)) {
      ordered.push(tab);
    }
  }
  for (const tab of tabs) {
    if (byNative.delete(tab.id)) {
      ordered.push(tab);
    }
  }
  return ordered;
}
