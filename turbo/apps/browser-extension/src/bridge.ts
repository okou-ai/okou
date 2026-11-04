import {
  BRIDGE_NAME,
  EVENT_BINDING,
  PROTOCOL_VERSION,
  type BridgeRequest,
  type NativeEvent,
  type NativeTab,
  type NativeWindow,
  type ProbeEvidence,
} from "@okouai/browser-extension-client";

const globals = globalThis as unknown as Record<string, unknown>;
const epoch = crypto.randomUUID();
let sequence = 0;

function tab(value: chrome.tabs.Tab): NativeTab {
  if (value.id === undefined) throw new Error("Tab has no native identity");
  return {
    id: value.id,
    windowId: value.windowId,
    index: value.index,
    active: value.active,
    pinned: value.pinned,
    discarded: value.discarded,
    ...(value.url !== undefined ? { url: value.url } : {}),
    ...(value.pendingUrl !== undefined ? { pendingUrl: value.pendingUrl } : {}),
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.openerTabId !== undefined
      ? { openerTabId: value.openerTabId }
      : {}),
  };
}

function windowInfo(value: chrome.windows.Window): NativeWindow {
  if (value.id === undefined) throw new Error("Window has no native identity");
  return {
    id: value.id,
    focused: value.focused,
    ...(value.type !== undefined ? { type: value.type } : {}),
    ...(value.state !== undefined ? { state: value.state } : {}),
    ...(value.tabs ? { tabs: value.tabs.map(tab) } : {}),
  };
}

async function missing<T>(
  operation: () => Promise<T>,
  resource: "window" | "tab",
  id: number,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `No ${resource} with id: ${id}.`
    )
      return null;
    throw error;
  }
}

function emit(value: Omit<NativeEvent, "epoch" | "sequence">): void {
  const event = { ...value, epoch, sequence: ++sequence };
  const binding = globals[EVENT_BINDING];
  // Runtime.addBinding registrations belong to their native CDP sessions.
  // There is no worker-side per-client registry to leak after a lost socket.
  if (typeof binding === "function") {
    try {
      binding(JSON.stringify(event));
    } catch {
      // A retiring inspector cannot break native routing or later events.
    }
  }
}

interface Probe {
  timer: ReturnType<typeof setTimeout>;
  evidence: ProbeEvidence | null;
}
const probes = new Map<string, Probe>();

function cancelProbe(nonce: string): void {
  const probe = probes.get(nonce);
  if (probe) clearTimeout(probe.timer);
  probes.delete(nonce);
}

async function operation(request: BridgeRequest): Promise<unknown> {
  switch (request.method) {
    case "hello":
      return {
        protocol: PROTOCOL_VERSION,
        capabilities: ["windows", "tabs", "events", "identity-probe"],
      };
    case "getWindow": {
      const value = await missing(
        () => {
          return chrome.windows.get(request.windowId, {
            populate: request.populate ?? false,
          });
        },
        "window",
        request.windowId,
      );
      return value ? windowInfo(value) : null;
    }
    case "listWindows":
      return (
        await chrome.windows.getAll({ populate: request.populate ?? false })
      ).map(windowInfo);
    case "listTabs":
      return (await chrome.tabs.query({ windowId: request.windowId })).map(tab);
    case "getTab": {
      const value = await missing(
        () => {
          return chrome.tabs.get(request.tabId);
        },
        "tab",
        request.tabId,
      );
      return value ? tab(value) : null;
    }
    case "createTab":
      return tab(
        await chrome.tabs.create({
          windowId: request.windowId,
          url: request.url,
          active: request.active ?? true,
        }),
      );
    case "moveTabs": {
      const moved = await chrome.tabs.move([...request.tabIds], {
        windowId: request.windowId,
        index: request.index,
      });
      return (Array.isArray(moved) ? moved : [moved]).map(tab);
    }
    case "activateTab": {
      const value = await chrome.tabs.update(request.tabId, { active: true });
      if (!value) throw new Error("Tab disappeared during activation");
      return tab(value);
    }
    case "closeTab":
      await chrome.tabs.remove(request.tabId);
      return null;
    case "closeWindow":
      // This acknowledges the native request, not completion of Close().
      await chrome.windows.remove(request.windowId);
      return null;
    case "beginProbe": {
      return probeOperation(request);
    }
    case "cancelProbe":
    case "takeProbe":
      return probeOperation(request);
    default:
      throw new Error("Unsupported native operation");
  }
}

function probeOperation(
  request: Extract<
    BridgeRequest,
    { method: "beginProbe" | "takeProbe" | "cancelProbe" }
  >,
): ProbeEvidence | null {
  if (request.method === "beginProbe") {
    if (probes.has(request.nonce)) throw new Error("Probe already pending");
    const timer = setTimeout(() => {
      return cancelProbe(request.nonce);
    }, 10_000);
    probes.set(request.nonce, { timer, evidence: null });
    return null;
  }
  const evidence =
    request.method === "takeProbe"
      ? (probes.get(request.nonce)?.evidence ?? null)
      : null;
  cancelProbe(request.nonce);
  return evidence;
}

globals[BRIDGE_NAME] = Object.freeze({
  async invoke(request: BridgeRequest) {
    const startedSequence = sequence;
    try {
      const value = await operation(request);
      return { ok: true, epoch, startedSequence, sequence, value };
    } catch {
      // Native errors may contain page values. Consumers receive no raw text.
      return { ok: false, epoch, startedSequence, sequence };
    }
  },
});

chrome.runtime.onMessageExternal.addListener(
  (message: unknown, sender, respond) => {
    if (!message || typeof message !== "object") return false;
    const input = message as Record<string, unknown>;
    if (
      input.kind !== "okou-browser-identify" ||
      typeof input.nonce !== "string"
    )
      return false;
    const probe = probes.get(input.nonce);
    // Unregistered page messages do not allocate work or expose any capability.
    if (
      !probe ||
      probe.evidence ||
      sender.frameId !== 0 ||
      sender.tab?.id === undefined
    )
      return false;
    probe.evidence = {
      tabId: sender.tab.id,
      windowId: sender.tab.windowId,
      ...(sender.documentId ? { documentId: sender.documentId } : {}),
    };
    respond(true);
    return false;
  },
);

// Dispatching this event wakes the worker. It performs no tab/window mutation.
chrome.action.onClicked.addListener(() => {});
chrome.tabs.onCreated.addListener((value) => {
  return emit({
    kind: "tab-created",
    tabId: value.id,
    windowId: value.windowId,
  });
});
chrome.tabs.onUpdated.addListener((tabId, _changed, value) => {
  return emit({ kind: "tab-updated", tabId, windowId: value.windowId });
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  return emit({ kind: "tab-activated", tabId, windowId });
});
chrome.tabs.onMoved.addListener((tabId, { windowId }) => {
  return emit({ kind: "tab-moved", tabId, windowId });
});
chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
  return emit({ kind: "tab-detached", tabId, oldWindowId });
});
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  return emit({ kind: "tab-attached", tabId, windowId: newWindowId });
});
chrome.tabs.onRemoved.addListener((tabId, { windowId }) => {
  return emit({ kind: "tab-removed", tabId, windowId });
});
chrome.tabs.onReplaced.addListener((tabId, removedTabId) => {
  return emit({ kind: "tab-replaced", tabId, removedTabId });
});
chrome.windows.onCreated.addListener((value) => {
  return emit({ kind: "window-created", windowId: value.id });
});
chrome.windows.onRemoved.addListener((windowId) => {
  return emit({ kind: "window-removed", windowId });
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  return emit({ kind: "window-focus", windowId });
});
chrome.windows.onBoundsChanged.addListener((value) => {
  return emit({ kind: "window-bounds", windowId: value.id });
});
