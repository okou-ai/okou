/** The canonical production App, which a link copied from it names. */
const PRODUCTION_APP_ORIGIN = "https://app.okou.ai";

/**
 * `ROUTES.chat` written out: an optional http(s) origin, then exactly
 * `/chats/<lowercase uuid>` with at most a trailing slash. A query, a hash,
 * credentials, or any deeper path leaves the link external.
 */
const CHAT_THREAD_LINK =
  /^(https?:\/\/[^/?#@\\\s]+)?\/chats\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/u;

/**
 * The chat thread a link opens inside this App, or null for any other link.
 *
 * A relative `/chats/<id>` link resolves against this App. An absolute one
 * counts only when it names this App's own origin or the production App.
 */
export function parseChatThreadLink(
  href: string,
  currentOrigin: string,
): string | null {
  const match = CHAT_THREAD_LINK.exec(href);
  if (!match) {
    return null;
  }
  const [, origin, threadId] = match;
  if (threadId === undefined) {
    return null;
  }
  if (origin === undefined) {
    return threadId;
  }
  if (!URL.canParse(origin)) {
    return null;
  }
  const linkOrigin = new URL(origin).origin;
  return linkOrigin === currentOrigin || linkOrigin === PRODUCTION_APP_ORIGIN
    ? threadId
    : null;
}
