type Creation = { sourceTabId: number; windowId?: number };

const pending = new Map<number, Creation>();
let queue = Promise.resolve();

function enqueue(tabId: number) {
  queue = queue
    .then(() => {
      return consolidate(tabId);
    })
    .catch((error: unknown) => {
      // Keep later creation events usable, without logging page content or URLs.
      console.error("Window consolidation event failed", {
        error: error instanceof Error ? error.name : "UnknownError",
      });
    });
}

async function destination(
  sourceTabId: number,
  visited = new Set<number>(),
): Promise<number | undefined> {
  if (visited.has(sourceTabId)) return undefined;
  visited.add(sourceTabId);
  const parent = pending.get(sourceTabId);
  if (parent) {
    const resolved =
      parent.windowId ?? (await destination(parent.sourceTabId, visited));
    parent.windowId ??= resolved;
    return parent.windowId;
  }
  try {
    return (await chrome.tabs.get(sourceTabId)).windowId;
  } catch {
    // Its native removal event can still supply the source window.
    return undefined;
  }
}

function remember(tabId: number, sourceTabId: number) {
  if (pending.has(tabId)) return;
  // Register before awaiting Chrome so removal can reach a pending child.
  pending.set(tabId, { sourceTabId });
  enqueue(tabId);
}

async function consolidate(tabId: number) {
  const entry = pending.get(tabId);
  if (!entry) return;
  const resolved = entry.windowId ?? (await destination(entry.sourceTabId));
  // A removal event may have supplied newer evidence during the lookup.
  entry.windowId ??= resolved;
  if (pending.get(tabId) !== entry) return;
  if (entry.windowId === undefined) {
    console.warn("Window consolidation source unavailable", { tabId });
    return;
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (pending.get(tabId) !== entry) return;
    if (tab.windowId !== entry.windowId) {
      await chrome.tabs.move(tabId, { windowId: entry.windowId, index: -1 });
    }
  } catch {
    // Leave the page available. Unrelated events never retry a failed move.
    console.warn("Window consolidation move failed", { tabId });
  } finally {
    if (pending.get(tabId) === entry) {
      pending.delete(tabId);
    }
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined && tab.openerTabId !== undefined) {
    remember(tab.id, tab.openerTabId);
  }
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(
  ({ tabId, sourceTabId }) => {
    return remember(tabId, sourceTabId);
  },
);

chrome.tabs.onRemoved.addListener((tabId, { windowId }) => {
  const parent = pending.get(tabId);
  for (const [id, entry] of pending) {
    if (entry.sourceTabId !== tabId) continue;
    if (parent) {
      // A nested opener may disappear before reaching its intended window.
      entry.windowId ??= parent.windowId;
      entry.sourceTabId = parent.sourceTabId;
    } else {
      entry.windowId ??= windowId;
    }
    enqueue(id);
  }
  pending.delete(tabId);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  const entry = pending.get(removedTabId);
  pending.delete(removedTabId);
  if (entry) {
    pending.set(addedTabId, entry);
    enqueue(addedTabId);
  }
  for (const [id, child] of pending) {
    if (child.sourceTabId !== removedTabId) continue;
    child.sourceTabId = addedTabId;
    enqueue(id);
  }
});
