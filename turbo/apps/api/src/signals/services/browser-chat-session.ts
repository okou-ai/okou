import type { browserChatSessions } from "@okouai/db/schema/browser-chat-session";

type BrowserChatSession = typeof browserChatSessions.$inferSelect;
type Binding = Pick<
  BrowserChatSession,
  "chatThreadId" | "instanceId" | "state" | "primaryWindowId" | "expiresAt"
>;
export type BrowserChatWindow = Binding & {
  readonly instanceId: string;
  readonly state: "active" | "closing";
  readonly primaryWindowId: number;
  readonly expiresAt: Date;
};

/** The database permits an absent binding, never a partially initialized one. */
export function browserChatWindow(chat: Binding): BrowserChatWindow | null {
  if (chat.state === null) {
    return null;
  }
  const { instanceId, primaryWindowId, expiresAt } = chat;
  if (instanceId === null || primaryWindowId === null || expiresAt === null) {
    throw new Error("Browser chat has an incomplete live binding");
  }
  return { ...chat, instanceId, primaryWindowId, expiresAt, state: chat.state };
}
