export interface ChatRunReference {
  readonly type: "chat_thread";
  readonly threadId: string;
  readonly titleSnapshot: string;
  readonly runId: string;
}

/** A thread mention carrying the server-verified origin run of a forwarded message. */
export function isChatRunReference(part: {
  readonly type: string;
  readonly runId?: string;
}): part is ChatRunReference {
  return part.type === "chat_thread" && part.runId !== undefined;
}
