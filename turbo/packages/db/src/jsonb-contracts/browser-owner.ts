interface BrowserOwnerWindow {
  readonly chatThreadId: string;
  readonly state: "creating" | "active" | "closing";
  readonly expiresAt: number;
  readonly primaryWindowId: number | null;
  readonly auxiliaryWindowIds: readonly number[];
}

/** Keys are immutable window-session UUIDs, including unfinished cleanup. */
export type BrowserOwnerWindows = Record<string, BrowserOwnerWindow>;

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const fields = new Set([
  "chatThreadId",
  "state",
  "expiresAt",
  "primaryWindowId",
  "auxiliaryWindowIds",
]);

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Browser owner window state");
  }
  return value as Record<string, unknown>;
}

function nativeWindowId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function windowBindings(window: Record<string, unknown>) {
  const { primaryWindowId, auxiliaryWindowIds } = window;
  if (
    (primaryWindowId !== null && !nativeWindowId(primaryWindowId)) ||
    !Array.isArray(auxiliaryWindowIds)
  ) {
    throw new Error("Invalid Browser owner window bindings");
  }
  const auxiliary: number[] = [];
  const seen = new Set<number>();
  for (const id of auxiliaryWindowIds) {
    if (!nativeWindowId(id) || id === primaryWindowId || seen.has(id)) {
      throw new Error("Invalid Browser owner auxiliary window");
    }
    seen.add(id);
    auxiliary.push(id);
  }
  if (primaryWindowId === null && auxiliary.length > 0) {
    throw new Error("Auxiliary Browser windows require a primary window");
  }
  return { primaryWindowId, auxiliaryWindowIds: auxiliary };
}

function decodeWindow(raw: unknown): BrowserOwnerWindow {
  const window = object(raw);
  const bindings = windowBindings(window);
  if (
    Object.keys(window).length !== fields.size ||
    Object.keys(window).some((key) => {
      return !fields.has(key);
    }) ||
    typeof window.chatThreadId !== "string" ||
    !uuid.test(window.chatThreadId) ||
    (window.state !== "creating" &&
      window.state !== "active" &&
      window.state !== "closing") ||
    typeof window.expiresAt !== "number" ||
    !Number.isSafeInteger(window.expiresAt) ||
    window.expiresAt < 0 ||
    (window.state === "active" && bindings.primaryWindowId === null) ||
    (window.state === "creating" && bindings.primaryWindowId !== null)
  ) {
    throw new Error("Invalid Browser owner window state");
  }
  return {
    chatThreadId: window.chatThreadId,
    state: window.state,
    expiresAt: window.expiresAt,
    ...bindings,
  };
}

/** Database JSON is decoded at the authority boundary, never trusted by type. */
export function parseBrowserOwnerWindows(value: unknown): BrowserOwnerWindows {
  const windows: BrowserOwnerWindows = {};
  const liveChats = new Set<string>();
  const nativeWindows = new Set<number>();
  for (const [windowSessionId, raw] of Object.entries(object(value))) {
    if (!uuid.test(windowSessionId)) {
      throw new Error("Invalid Browser owner window session");
    }
    const window = decodeWindow(raw);
    if (window.state !== "closing") {
      if (liveChats.has(window.chatThreadId)) {
        throw new Error("Ambiguous Browser owner chat lifetime");
      }
      liveChats.add(window.chatThreadId);
    }
    for (const id of [window.primaryWindowId, ...window.auxiliaryWindowIds]) {
      if (id !== null) {
        if (nativeWindows.has(id)) {
          throw new Error("Ambiguous Browser owner native window");
        }
        nativeWindows.add(id);
      }
    }
    windows[windowSessionId] = window;
  }
  return windows;
}
