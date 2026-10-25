interface BrowserOwnerWindow {
  readonly chatThreadId: string;
  readonly state: "creating" | "active" | "closing";
  readonly expiresAt: number;
  readonly primaryWindowId: number | null;
  readonly primaryTargetId: string | null;
}

/** Keys are immutable window-generation UUIDs, including unfinished cleanup. */
export type BrowserOwnerWindows = Record<string, BrowserOwnerWindow>;

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const fields = new Set([
  "chatThreadId",
  "state",
  "expiresAt",
  "primaryWindowId",
  "primaryTargetId",
]);

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Browser owner window state");
  }
  return value as Record<string, unknown>;
}

function primaryPage(window: Record<string, unknown>) {
  const { primaryWindowId, primaryTargetId } = window;
  if (
    (primaryWindowId !== null &&
      (typeof primaryWindowId !== "number" ||
        !Number.isSafeInteger(primaryWindowId) ||
        primaryWindowId <= 0)) ||
    (primaryTargetId !== null &&
      (typeof primaryTargetId !== "string" ||
        primaryTargetId.length === 0 ||
        primaryTargetId.length > 256)) ||
    (primaryWindowId === null) !== (primaryTargetId === null)
  ) {
    throw new Error("Invalid Browser owner primary page");
  }
  return { primaryWindowId, primaryTargetId };
}

function decodeWindow(raw: unknown): BrowserOwnerWindow {
  const window = object(raw);
  const primary = primaryPage(window);
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
    (window.state === "active" && primary.primaryWindowId === null) ||
    (window.state === "creating" && primary.primaryWindowId !== null)
  ) {
    throw new Error("Invalid Browser owner window state");
  }
  return {
    chatThreadId: window.chatThreadId,
    state: window.state,
    expiresAt: window.expiresAt,
    ...primary,
  };
}

/** Database JSON is decoded at the authority boundary, never trusted by type. */
export function parseBrowserOwnerWindows(value: unknown): BrowserOwnerWindows {
  const windows: BrowserOwnerWindows = {};
  const liveChats = new Set<string>();
  for (const [generation, raw] of Object.entries(object(value))) {
    if (!uuid.test(generation)) {
      throw new Error("Invalid Browser owner window generation");
    }
    const window = decodeWindow(raw);
    if (window.state !== "closing") {
      if (liveChats.has(window.chatThreadId)) {
        throw new Error("Ambiguous Browser owner chat lifetime");
      }
      liveChats.add(window.chatThreadId);
    }
    windows[generation] = window;
  }
  return windows;
}
